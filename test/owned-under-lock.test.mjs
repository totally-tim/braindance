// A request queued behind a rename on the take lock, called directly: the rename frees the name,
// the recorder opens its next take under it, and the queued request must not read that take. No wire
// drive can put the recorder's open between a lock release and the next holder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markLogFor, removeTake, renameTake } from '../server/library.js';
import { cachedIndex } from '../server/capture.js';
import { Recorder } from '../server/recorder.js';
import { encodeMessage, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';

const frame = (n) => {
  const payload = Buffer.alloc(64, 1);
  payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
  return encodeMessage(TYPE_FRAME, payload);
};
const HELLO = Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 }));

const queuedBehindARename = (name, queue) => test(`${name} queued behind a rename never reads the take the recorder opened under the freed name`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-owned-'));
  const recorder = new Recorder({ dir });
  try {
    const now = new Date();
    const id = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-take1`;
    const path = join(dir, `${id}.knct`);
    await writeFile(path, Buffer.concat([encodeMessage(TYPE_HELLO, HELLO), ...[0, 1, 2, 3].map(frame)]));
    const hash = (await cachedIndex(path)).hash;
    const ownsFile = (identity) => recorder.ownsFile(identity);
    const renaming = renameTake(dir, id, 'keeper', { hash, ownsFile });
    const queued = queue({ dir, id, path, hash, ownsFile }).then((v) => v, (err) => err);
    while (existsSync(path)) await new Promise((done) => { setImmediate(done); });
    recorder.open(HELLO);
    for (let n = 0; n < 8; n++) recorder.write(frame(n));
    await renaming;
    const answer = await queued;
    assert.equal(recorder.take?.id, id, 'the recorder took the freed name, which is the order under test');
    assert.equal(existsSync(join(dir, `${id}.idx`)), false, 'nothing scanned the take being recorded');
    assert.ok(answer === null || /being recorded/.test(answer?.message ?? ''),
      `and the queued request refused it: ${answer?.message ?? JSON.stringify(answer)}`);
  } finally {
    if (recorder.take) await recorder.close('done');
    await rm(dir, { recursive: true, force: true });
  }
});

queuedBehindARename('a marks log read', ({ path, hash, ownsFile }) => markLogFor(path, hash, { ownsFile }));
queuedBehindARename('a second rename', ({ dir, id, hash, ownsFile }) => renameTake(dir, id, 'other', { hash, ownsFile }));
queuedBehindARename('a removal', ({ dir, id, hash, ownsFile }) => removeTake(dir, id, { hash, ownsFile }));
