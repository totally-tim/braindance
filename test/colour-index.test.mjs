// The colour camera's messages in a take: the scan lists them apart from the frames, a type it does
// not know is walked past, a replay puts each after the frame it followed, and a run of frames is
// the frames' own bytes with nothing that lay between them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, colourAfterFrames, openCapture, forgetCapture } from '../server/capture.js';
import { encodeMessage, TYPE_COLOR, TYPE_FRAME, TYPE_HELLO, HEADER_BYTES } from '../server/protocol.js';

const frame = (n) => {
  const payload = Buffer.alloc(64, n);
  payload.writeUInt32LE(40, 0);
  payload.writeUInt32LE(8, 4);
  payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
  return encodeMessage(TYPE_FRAME, payload);
};
const colour = (stamp, tag) => {
  const payload = Buffer.alloc(8 + 20, tag);
  payload.writeBigUInt64LE(BigInt(stamp), 0);
  return encodeMessage(TYPE_COLOR, payload);
};

// A colour message before the first frame, two between frames 1 and 2, none after frame 2, one after
// the last frame, and a type 9 after frame 0.
const take = () => Buffer.concat([
  encodeMessage(TYPE_HELLO, Buffer.from('{"fx":366,"fy":366,"cx":256,"cy":212}')),
  colour(990, 1),
  frame(0),
  encodeMessage(9, Buffer.from('unknown')),
  frame(1),
  colour(1033, 2),
  colour(1040, 3),
  frame(2),
  frame(3),
  colour(1100, 4),
]);

test('the scan lists colour apart from frames, and the replay order follows the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-colour-index-'));
  try {
    const path = join(dir, 'colour.knct');
    await writeFile(path, take());
    const index = await buildIndex(path);
    assert.equal(index.frames.offset.length, 4);
    assert.deepEqual(index.frames.stampMs, [1000, 1033, 1066, 1099]);
    assert.deepEqual(index.colour.stampMs, [990, 1033, 1040, 1100]);
    assert.ok(index.colour.length.every((len) => len === 28));
    assert.equal(index.truncated, false);
    // Frame 0 carries the early colour and frame 1 the two after it; frame 2 none; frame 3 the last.
    assert.deepEqual(colourAfterFrames(index), [0, 1, 3, 3, 4]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run of frames skips what lies between them and stays one range where nothing does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-colour-run-'));
  try {
    const path = join(dir, 'colour.knct');
    await writeFile(path, take());
    const capture = await openCapture(path);
    try {
      const { spans, bytes } = capture.frameRunSpans(0, 3);
      // Frame 0, then frame 1 after the unknown type, frames 2 and 3 adjacent after the colour.
      assert.equal(spans.length, 3);
      assert.equal(bytes, 4 * (HEADER_BYTES + 64));
      const chunks = [];
      for await (const chunk of capture.createFrameRunStream(0, 3)) chunks.push(chunk);
      const run = Buffer.concat(chunks);
      assert.equal(run.length, bytes);
      assert.ok(run.equals(Buffer.concat([frame(0), frame(1), frame(2), frame(3)])));
      assert.equal(capture.frameRunSpans(2, 3).spans.length, 1);
    } finally {
      forgetCapture(path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
