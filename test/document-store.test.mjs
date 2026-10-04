// The document name rule and the revision a write is made against, called directly. It supplements
// the proof tools rather than replacing any of them: what it catches that a wire drive cannot is
// the interleaving - two writes started in one tick, which no sequence of curl calls can stage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore, ABSENT_REV } from '../server/library.js';
import { DOCUMENT_VERSIONS, documentNameRefusal, MAX_DOCUMENT_NAME_BYTES } from '../web/format.js';

const store = async (opts = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'braindance-store-'));
  return new DocumentStore(join(root, 'projects'), 'project', opts.builtin ? join(root, 'shipped') : null);
};

const refused = async (run) => {
  try {
    await run();
  } catch (err) {
    return err.message;
  }
  return null;
};

test('a document name allows a space, which is the whole reason it is a second rule', () => {
  for (const name of ['Untitled 1', 'Beach shoot', '__working__', 'a.b', 'a-b', 'Café']) {
    assert.equal(documentNameRefusal('project', name), null, `${name} was refused`);
  }
});

test('a document name is refused for one reason at a time, and each reason says what it is', () => {
  const cases = [
    ['', /needs a name/],
    [null, /needs a name/],
    ['../escape', /walks out of the/],
    ['a..b', /walks out of the/],
    ['.hidden', /starts with a dot/],
    ['a/b', /carries a slash/],
    ['a\\b', /carries a slash/],
    ['a\nb', /control character/],
    ['a\u0000b', /control character/],
    ['a\u007fb', /control character/],
    [' leading', /starts or ends with a space/],
    ['trailing ', /starts or ends with a space/],
  ];
  for (const [name, shape] of cases) {
    const why = documentNameRefusal('project', name);
    assert.ok(why !== null, `${JSON.stringify(name)} was allowed`);
    assert.match(why, shape);
  }
});

test('the byte cap is on the file the name makes, so the longest name still opens a file', async () => {
  assert.equal(MAX_DOCUMENT_NAME_BYTES, 250);
  assert.equal(documentNameRefusal('project', 'a'.repeat(MAX_DOCUMENT_NAME_BYTES)), null);
  assert.match(documentNameRefusal('project', 'a'.repeat(MAX_DOCUMENT_NAME_BYTES + 1)), /bytes and 250 is the most/);
  // Counted in bytes and not in characters: a name of 126 two-byte characters is 252 bytes.
  assert.match(documentNameRefusal('project', 'é'.repeat(126)), /is 252 bytes/);

  const s = await store();
  const longest = 'a'.repeat(MAX_DOCUMENT_NAME_BYTES);
  await s.write(longest, { clips: [] }, ABSENT_REV);
  assert.equal((await s.read(longest)).name, longest);
});

test('pathFor checks the path as well as the name, so a name rule that thinned still holds', async () => {
  const s = await store();
  // The rule refuses this first; the join check behind it is what catches a name the rule missed.
  assert.match(await refused(() => s.write('../escape', {}, ABSENT_REV)), /walks out of the/);
  assert.ok(s.pathFor('Beach shoot').endsWith('/projects/Beach shoot.json'));
});

test('a write with no revision at all is refused, because a bypass is the class left open', async () => {
  const s = await store();
  for (const rev of [undefined, null, '', 0]) {
    assert.match(await refused(() => s.write('Untitled 1', { clips: [] }, rev)),
      /names no revision it was made against/);
  }
  assert.deepEqual(await s.list(), []);
});

test('a create names the revision absent, and a second create of the name is refused', async () => {
  const s = await store();
  const first = await s.write('Untitled 1', { clips: [] }, ABSENT_REV);
  assert.match(first.rev, /^sha256:[0-9a-f]{64}$/);
  assert.match(await refused(() => s.write('Untitled 1', { clips: [] }, ABSENT_REV)),
    /there is already a project named Untitled 1/);
  // The refused create left the first one's bytes alone.
  assert.equal((await s.read('Untitled 1')).rev, first.rev);
});

test('an update carries the revision it read, and the same one twice does not land', async () => {
  const s = await store();
  const first = await s.write('Beach shoot', { clips: [] }, ABSENT_REV);
  const second = await s.write('Beach shoot', { clips: ['a'] }, first.rev);
  assert.notEqual(second.rev, first.rev);
  const why = await refused(() => s.write('Beach shoot', { clips: ['b'] }, first.rev));
  assert.match(why, /somebody else has this project open and this write did not land/);
  assert.deepEqual((await s.read('Beach shoot')).body.clips, ['a']);
});

test('a revision naming a file that is gone says so rather than recreating it', async () => {
  const s = await store();
  const made = await s.write('Gone', { clips: [] }, ABSENT_REV);
  await s.remove('Gone', made.rev);
  assert.match(await refused(() => s.write('Gone', { clips: [] }, made.rev)),
    /there is no project named Gone any more/);
});

test('two writes started in one tick: one lands and the other is refused', async () => {
  const s = await store();
  const base = await s.write('Race', { clips: [] }, ABSENT_REV);
  const [a, b] = await Promise.allSettled([
    s.write('Race', { clips: ['a'] }, base.rev),
    s.write('Race', { clips: ['b'] }, base.rev),
  ]);
  const won = [a, b].filter((r) => r.status === 'fulfilled');
  const lost = [a, b].filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, `both writes landed: ${JSON.stringify([a, b])}`);
  assert.equal(lost.length, 1);
  assert.match(lost[0].reason.message, /somebody else has this project open/);
  // The winner's bytes are what is on disk, whole: the loser neither landed nor half-landed.
  const kept = await s.read('Race');
  assert.equal(kept.rev, won[0].value.rev);
  assert.equal(kept.body.clips.length, 1);
});

test('two creates started in one tick: one lands and the other is refused', async () => {
  const s = await store();
  const [a, b] = await Promise.allSettled([
    s.write('Both', { clips: ['a'] }, ABSENT_REV),
    s.write('Both', { clips: ['b'] }, ABSENT_REV),
  ]);
  assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify([a, b]));
  assert.match([a, b].find((r) => r.status === 'rejected').reason.message, /there is already a project named Both/);
});

test('a create and a rename aimed at one name cannot both land on it', async () => {
  const s = await store();
  const held = await s.write('Held', { clips: ['held'] }, ABSENT_REV);
  // The rename holds `Held` and `Target`; the create holds `Target`. Whichever runs second sees what
  // the first did, so `Held`'s document is never quietly written over by the other one.
  const settled = await Promise.allSettled([
    s.rename('Held', 'Target', held.rev),
    s.write('Target', { clips: ['create'] }, ABSENT_REV),
  ]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(settled));
  const names = (await s.list()).map((d) => d.name).sort();
  const survived = (await s.list()).some((d) => d.body.clips[0] === 'held');
  assert.ok(survived, `the document that was being renamed is gone: ${JSON.stringify(names)}`);
});

test('a reserved name is refused by the store that was handed it, and by nothing else', async () => {
  const s = await store();
  const other = await store();
  s.reserve([['all', '/projects/all']]);
  const why = await refused(() => s.write('all', { clips: [] }, ABSENT_REV));
  assert.match(why, /\/projects\/all is a route of this server/);
  assert.match(await refused(() => s.remove('all', ABSENT_REV)), /is a route of this server/);
  assert.match(await refused(() => s.rename('Untitled 1', 'all', ABSENT_REV)), /is a route of this server/);
  // A store nobody handed the name to still takes it: the collision is one namespace's, not the
  // name rule's, and a take id called `all` collides with nothing.
  assert.equal(documentNameRefusal('project', 'all'), null);
  assert.equal((await other.write('all', { clips: [] }, ABSENT_REV)).name, 'all');
});

test('a refused change says it is stale and what the file holds, or says neither', async () => {
  const s = await store();
  const made = await s.write('Marked', { clips: [] }, ABSENT_REV);
  const moved = await s.write('Marked', { clips: ['a'] }, made.rev);
  const stale = await s.write('Marked', { clips: ['b'] }, made.rev).catch((e) => e);
  assert.equal(stale.stale, true);
  assert.equal(stale.rev, moved.rev);
  // A client that never sent a revision is not stale: reading the file again does not fix it.
  const bare = await s.write('Marked', { clips: ['b'] }, '').catch((e) => e);
  assert.equal(bare.stale, undefined);
  // Nor is a document this build cannot read, which is answered by a different build and not by a
  // reload - the two share a status code and must not share a field.
  const old = await s.write('Marked', { version: 6 }, moved.rev).catch((e) => e);
  assert.equal(old.stale, undefined);
});

test('a delete carries a revision too, and a stale one keeps the file', async () => {
  const s = await store();
  const made = await s.write('Doomed', { clips: [] }, ABSENT_REV);
  const moved = await s.write('Doomed', { clips: ['a'] }, made.rev);
  assert.match(await refused(() => s.remove('Doomed', made.rev)),
    /somebody else has this project open and this delete did not land/);
  assert.match(await refused(() => s.remove('Doomed', '')), /names no revision/);
  assert.deepEqual(await s.remove('Doomed', moved.rev), { removed: 'Doomed' });
});

test('a rename moves the file, and a taken destination is refused before it does', async () => {
  const s = await store();
  const made = await s.write('Untitled 1', { clips: [] }, ABSENT_REV);
  const taken = await s.write('Beach shoot', { clips: ['x'] }, ABSENT_REV);
  assert.match(await refused(() => s.rename('Untitled 1', 'Beach shoot', made.rev)), /Beach shoot is taken/);
  assert.match(await refused(() => s.rename('Untitled 1', 'Cliff', 'sha256:nope')), /not the sha256:nope/);
  assert.match(await refused(() => s.rename('Untitled 1', 'Untitled 1', made.rev)), /already its name/);
  assert.match(await refused(() => s.rename('Untitled 1', 'a/b', made.rev)), /carries a slash/);

  const done = await s.rename('Untitled 1', 'Cliff', made.rev);
  assert.equal(done.name, 'Cliff');
  assert.equal(done.rev, made.rev);
  assert.deepEqual((await s.list()).map((d) => d.name).sort(), ['Beach shoot', 'Cliff']);
  assert.equal((await s.read('Beach shoot')).rev, taken.rev);
});

test('a shipped document forks under the revision it was read at, and is never moved', async () => {
  const s = await store({ builtin: true });
  await mkdir(s.builtinDir, { recursive: true });
  await writeFile(join(s.builtinDir, 'Look.json'), `${JSON.stringify({ version: DOCUMENT_VERSIONS.project, clips: [] }, null, 2)}\n`);
  const shipped = await s.read('Look');
  assert.equal(shipped.builtin, true);
  // A shipped document is not moved, because the copy this build ships is not the store's to move.
  assert.match(await refused(() => s.rename('Look', 'Other', shipped.rev)), /this build ships/);
  // The revision a read handed back is the one the fork is made against, even though no user file
  // exists yet - which is what stops a fork being an unversioned create.
  assert.match(await refused(() => s.write('Look', { clips: [] }, ABSENT_REV)), /there is already a project named Look/);
  assert.match(await refused(() => s.write('Look', { clips: [] }, 'sha256:nope')), /somebody else has this project open/);
  const fork = await s.write('Look', { clips: ['mine'] }, shipped.rev);
  assert.equal((await s.read('Look')).builtin, false);
  assert.deepEqual((await s.read('Look')).body.clips, ['mine']);
  // Removing the fork brings the shipped one back, and it reads as shipped again.
  await s.remove('Look', fork.rev);
  assert.equal((await s.read('Look')).builtin, true);
  assert.equal((await s.read('Look')).rev, shipped.rev);
});

test('two tabs forking one shipped document: exactly one fork lands', async () => {
  const s = await store({ builtin: true });
  await mkdir(s.builtinDir, { recursive: true });
  await writeFile(join(s.builtinDir, 'Look.json'), `${JSON.stringify({ version: DOCUMENT_VERSIONS.project, clips: [] }, null, 2)}\n`);
  const shipped = await s.read('Look');
  // Both read the shipped revision, because that is what a read of this name returns while no fork
  // exists. The first fork makes the second one's revision the shipped one that is no longer there.
  const settled = await Promise.allSettled([
    s.write('Look', { clips: ['first'] }, shipped.rev),
    s.write('Look', { clips: ['second'] }, shipped.rev),
  ]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(settled));
  const lost = settled.find((r) => r.status === 'rejected').reason;
  assert.equal(lost.stale, true);
  assert.equal((await s.read('Look')).builtin, false);
});

test('a version this build does not write is refused before anything reaches the disk', async () => {
  const s = await store();
  assert.match(await refused(() => s.write('Old', { version: 6 }, ABSENT_REV)), /refused rather than restamped/);
  assert.deepEqual(await s.list(), []);
});

test('a refused write does not refuse the writes queued behind it', async () => {
  const s = await store();
  const base = await s.write('Queued', { clips: [] }, ABSENT_REV);
  // Three writes started in one tick against one revision: the first lands, and the two behind it
  // are each refused with a reason rather than left hanging on the failure in front of them.
  const settled = await Promise.allSettled([
    s.write('Queued', { clips: ['a'] }, base.rev),
    s.write('Queued', { clips: ['b'] }, base.rev),
    s.write('Queued', { clips: ['c'] }, base.rev),
  ]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(settled));
  for (const r of settled.filter((x) => x.status === 'rejected')) {
    assert.match(r.reason.message, /somebody else has this project open/);
  }
  // And the name is writable again straight after, so nothing was left holding the queue.
  const now = await s.read('Queued');
  assert.equal((await s.write('Queued', { clips: ['d'] }, now.rev)).bytes > 0, true);
});
