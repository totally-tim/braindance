// Which files the recorder owns while more than one take is closing, called directly. It
// supplements library-check rather than replacing it: what it stages that a wire drive cannot is
// the order in which two closes finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../server/recorder.js';
import { encodeMessage, TYPE_FRAME } from '../server/protocol.js';

const HELLO = Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 }));
const frame = (n, bytes) => {
  const payload = Buffer.alloc(bytes);
  payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
  return encodeMessage(TYPE_FRAME, payload);
};

test('a take whose close finishes first gives up its own file and no other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-recorder-'));
  try {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    const first = recorder.take.path;
    const closingFirst = recorder.close('first');
    // The second take opens while the first is closing, the way a grabber restart opens one, and
    // carries enough to keep its own close running after the first's has finished.
    recorder.open(HELLO);
    const second = recorder.take.path;
    for (let n = 0; n < 48; n++) recorder.write(frame(n, 1 << 20));
    const closingSecond = recorder.close('second');
    let secondDone = false;
    closingSecond.then(() => { secondDone = true; }, () => { secondDone = true; });

    assert.ok(recorder.owns(first) && recorder.owns(second), 'both closes are running, so both files are owned');
    await closingFirst;
    assert.equal(secondDone, false, 'the second close was still running when the first finished, which is the order under test');
    assert.equal(recorder.owns(first), false, 'the first take is released when its own close finishes');
    assert.equal(recorder.owns(second), true, 'and the second is still the recorder\'s, because its close has not finished');
    await closingSecond;
    assert.equal(recorder.owns(second), false, 'and it is released when its own close does');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
