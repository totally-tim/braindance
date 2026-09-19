// A marks merge against renames of the same take, called directly: the merge reads the take's log
// before it appends, and two renames that land inside that read move the name onto another take.
// No wire drive can put two renames inside one read, so this stages the interleaving in-process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMarks, marksPathFor, mergeMarkLog, readMarkLog, removeTake, renameTake } from '../server/library.js';
import { cachedIndex } from '../server/capture.js';
import { encodeMessage, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';

const capture = (seed) => Buffer.concat([
  encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212, seed }))),
  ...Array.from({ length: 4 }, (_, n) => {
    const payload = Buffer.alloc(64, seed);
    payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
    return encodeMessage(TYPE_FRAME, payload);
  }),
]);

// Long enough that reading it back takes longer than two renames: the window under test.
const LOG_RECORDS = 400_000;

test('a marks merge lands in the take it checked, never in the take renamed into its name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-take-lock-'));
  try {
    const x = join(dir, 'shot-x.knct');
    const z = join(dir, 'shot-z.knct');
    await writeFile(x, capture(1));
    await writeFile(z, capture(2));
    const hashA = (await cachedIndex(x)).hash;
    const hashB = (await cachedIndex(z)).hash;
    const log = Array.from({ length: LOG_RECORDS }, (_, n) => `${JSON.stringify({ id: `m${n}`, sourceMs: n, at: n })}\n`);
    await mkdir(join(dir, 'marks'), { recursive: true });
    await writeFile(marksPathFor(dir, hashA), log.join(''));

    const fromNode = { id: 'm-from-the-node', sourceMs: 1, label: 'for take A', at: 1e12 };
    let mergeSettled = false;
    const merging = mergeMarkLog(dir, hashA, [fromNode]).finally(() => { mergeSettled = true; });
    // A leaves the name and B takes it, both through the library's own rename.
    let renamesSettledFirst = null;
    const renames = renameTake(dir, 'shot-x', 'shot-y', { hash: hashA })
      .then(() => renameTake(dir, 'shot-z', 'shot-x', { hash: hashB }))
      .then(() => { renamesSettledFirst = !mergeSettled; });
    const [merged] = await Promise.all([merging, renames]);

    const underB = await readMarkLog(dir, (await cachedIndex(join(dir, 'shot-x.knct'))).hash);
    const underA = await readMarkLog(dir, (await cachedIndex(join(dir, 'shot-y.knct'))).hash);
    assert.equal(underB.some((r) => r.id === fromNode.id), false,
      `take B, now under take A's old name, gained take A's mark (the renames ${renamesSettledFirst ? 'finished inside' : 'waited for'} the merge)`);
    assert.equal(merged, 1, 'and the merge wrote the one record it was given');
    assert.ok(underA.some((r) => r.id === fromNode.id), 'into take A, under its new name');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reclaim keeps the node\'s copy when a mark was added to it after the other machine read its log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-take-reclaim-'));
  try {
    const path = join(dir, 'shot.knct');
    await writeFile(path, capture(7));
    const hash = (await cachedIndex(path)).hash;
    await appendMarks(dir, hash, [{ id: 'old', at: 1, sourceMs: 1 }]);
    // The node's side in the two machines' order: the log is read, a mark is pressed, the delete arrives.
    const read = await readMarkLog(dir, hash);
    assert.equal(await appendMarks(dir, hash, [{ id: 'new-on-node', at: 2, sourceMs: 5 }]), true,
      'the mark pressed after the read was written, which is the order under test');
    const refused = await removeTake(dir, 'shot', { hash, verifiedElsewhere: hash, marksRead: read.length }).then(() => null, (err) => err.message);
    assert.match(refused ?? 'REMOVED', /a mark was added here since/, 'the removal is refused');
    assert.equal((await readMarkLog(dir, hash)).some((r) => r.id === 'new-on-node'), true, 'and the mark is still on the copy');
    const removed = await removeTake(dir, 'shot', { hash, verifiedElsewhere: hash, marksRead: read.length + 1 });
    assert.equal(removed.removed, 'shot.knct', 'and a removal naming every record the log holds goes through');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a merge lands in the log of the hash it was given, not the take under the name that hash was read from', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-take-aba-'));
  try {
    const at = (id) => join(dir, `${id}.knct`);
    await writeFile(at('shot'), capture(2));
    await writeFile(at('other'), capture(1));
    const hashB = (await cachedIndex(at('shot'))).hash;
    const hashA = (await cachedIndex(at('other'))).hash;
    // The sync's order: B leaves, A takes the name, and the listing reads A's hash under it.
    await renameTake(dir, 'shot', 'aside', { hash: hashB });
    await renameTake(dir, 'other', 'shot', { hash: hashA });
    const listed = (await cachedIndex(at('shot'))).hash;
    // A leaves again and B returns: the name holds B again, but the merge names content, not a name.
    await renameTake(dir, 'shot', 'other', { hash: hashA });
    await renameTake(dir, 'aside', 'shot', { hash: hashB });
    const merged = await mergeMarkLog(dir, listed, [{ id: 'mark-of-a', at: 9, sourceMs: 3 }]);
    assert.equal(listed, hashA, 'the listing read A under the name, which is the order under test');
    assert.equal(merged, 1, 'the merge wrote the one record it was given');
    assert.equal((await readMarkLog(dir, hashB)).some((r) => r.id === 'mark-of-a'), false,
      'and B, back under the name, did not gain it: the log is the hash\'s, not the name\'s');
    assert.ok((await readMarkLog(dir, hashA)).some((r) => r.id === 'mark-of-a'), 'it is on A under whatever name A now has');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
