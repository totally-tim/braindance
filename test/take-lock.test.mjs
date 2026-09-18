// A marks merge against renames of the same take, called directly: the merge reads the take's log
// before it appends, and two renames that land inside that read move the name onto another take.
// No wire drive can put two renames inside one read, so this stages the interleaving in-process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marksPathFor, mergeMarkLog, readMarkLog, renameTake } from '../server/library.js';
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
