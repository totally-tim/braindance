// The keyed output's wire, called directly: what a depth reading becomes as one byte, and the two
// buffer layouts the server writes and the page at /key reads.
//
// The quantisation arm is about the two values that are not readings - 0, which means the sensor
// saw nothing, and anything past the range, which has to clamp rather than wrap onto a plausible
// near reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_DEPTH_LEVELS, KEY_HEADER_BYTES, PAIR_HEADER_BYTES,
  quantiseDepthMm, dequantiseDepth, encodeKeyPayload, decodeKeyPayload, encodePair, decodePair,
} from '../web/key-stream.js';

const RANGE = 9; // the grabber's own default max depth, in metres

test('a reading survives the round trip to within one quantisation step', () => {
  const step = RANGE / KEY_DEPTH_LEVELS;
  for (let mm = 1; mm <= RANGE * 1000; mm += 7) {
    const back = dequantiseDepth(quantiseDepthMm(mm, RANGE), RANGE);
    assert.ok(Math.abs(back - mm / 1000) <= step, `${mm}mm came back as ${back}m`);
  }
});

test('0 means no reading at both ends, and stays 0', () => {
  assert.equal(quantiseDepthMm(0, RANGE), 0);
  assert.equal(quantiseDepthMm(-1, RANGE), 0);
  assert.equal(dequantiseDepth(0, RANGE), 0);
});

test('the smallest positive reading is 1, so a real reading is never mistaken for no reading', () => {
  assert.equal(quantiseDepthMm(1, RANGE), 1);
  assert.equal(quantiseDepthMm(0.0001, RANGE), 1);
  // Without the floor this is where it would land, which is the value that means nothing was seen.
  assert.equal(Math.round((KEY_DEPTH_LEVELS * 1) / (RANGE * 1000)), 0);
});

test('past the range it clamps to no reading, and never wraps onto a near one', () => {
  assert.equal(quantiseDepthMm(RANGE * 1000, RANGE), KEY_DEPTH_LEVELS);
  assert.equal(quantiseDepthMm(RANGE * 1000 + 1, RANGE), 0);
  // 10588mm scales to 300, which a naive `& 0xff` would land on 44 - a confident reading at 1.55m
  // where the sensor saw something 10.6 metres away.
  assert.equal(Math.round((KEY_DEPTH_LEVELS * 10588) / (RANGE * 1000)) & 0xff, 44);
  assert.equal(quantiseDepthMm(10588, RANGE), 0);
  assert.equal(quantiseDepthMm(Infinity, RANGE), 0);
  assert.equal(quantiseDepthMm(NaN, RANGE), 0);
  // A range that is not a range cannot quantise anything, and NaN written into a byte array is 0
  // silently - so it is refused here where the answer is still readable.
  assert.equal(quantiseDepthMm(1000, 0), 0);
  assert.equal(quantiseDepthMm(1000, NaN), 0);
});

const INTRINSICS = { fx: 1081.37, fy: 1081.37, cx: 959.5, cy: 539.5, rangeM: RANGE };
const f32 = (v) => Math.fround(v);
const jpegLike = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

test('a key payload round-trips byte for byte, and the JPEG comes back without a copy', () => {
  const jpeg = jpegLike(600, 7);
  const bytes = encodeKeyPayload({ ts: 1750000123456, colourTs: 1750000123423, ...INTRINSICS, jpeg });
  assert.equal(bytes.length, KEY_HEADER_BYTES + jpeg.length);

  const got = decodeKeyPayload(bytes);
  assert.equal(got.ts, 1750000123456);
  assert.equal(got.colourTs, 1750000123423);
  assert.equal(got.fx, f32(1081.37));
  assert.equal(got.fy, f32(1081.37));
  assert.equal(got.cx, 959.5);
  assert.equal(got.cy, 539.5);
  assert.equal(got.rangeM, RANGE);
  assert.deepEqual(got.jpeg, jpeg);
  assert.equal(got.jpeg.buffer, bytes.buffer, 'the JPEG is a view of the payload, not a copy of it');

  assert.deepEqual(encodeKeyPayload({ ts: got.ts, ...got }), bytes);
});

test('a payload read out of the middle of a larger buffer decodes as itself', () => {
  const jpeg = jpegLike(120, 3);
  const bytes = encodeKeyPayload({ ts: 42, colourTs: 41, ...INTRINSICS, jpeg });
  // What the server actually hands the decoder: a Buffer whose bytes start partway into a pool.
  const pooled = Buffer.allocUnsafe(bytes.length + 300);
  pooled.set(bytes, 300);
  const got = decodeKeyPayload(pooled.subarray(300, 300 + bytes.length));
  assert.equal(got.ts, 42);
  assert.equal(got.cx, 959.5);
  assert.deepEqual(Uint8Array.from(got.jpeg), jpeg);
});

test('a pair round-trips byte for byte, colour and depth in the right order', () => {
  const colour = jpegLike(900, 11);
  const depth = jpegLike(400, 23);
  const bytes = encodePair({ depthTs: 900071, colourTs: 900070, ...INTRINSICS, colour, depth });
  assert.equal(bytes.length, PAIR_HEADER_BYTES + colour.length + depth.length);

  const got = decodePair(bytes);
  assert.equal(got.depthTs, 900071);
  assert.equal(got.colourTs, 900070);
  assert.equal(got.fx, f32(1081.37));
  assert.equal(got.cy, 539.5);
  assert.equal(got.rangeM, RANGE);
  assert.deepEqual(got.colour, colour);
  assert.deepEqual(got.depth, depth);

  assert.deepEqual(encodePair({ ...got }), bytes);
});

test('an elided colour is null on the way back, and both ways of saying it write the same bytes', () => {
  const depth = jpegLike(256, 5);
  const bytes = encodePair({ depthTs: 5, colourTs: 4, ...INTRINSICS, colour: null, depth });
  assert.equal(bytes.length, PAIR_HEADER_BYTES + depth.length);

  const got = decodePair(bytes);
  assert.equal(got.colour, null);
  assert.deepEqual(got.depth, depth);
  assert.deepEqual(encodePair({ ...got }), bytes);
  assert.deepEqual(encodePair({ depthTs: 5, colourTs: 4, ...INTRINSICS, colour: new Uint8Array(0), depth }), bytes);
});

test('a pair out of the middle of a larger buffer decodes as itself', () => {
  const colour = jpegLike(64, 1);
  const depth = jpegLike(64, 2);
  const bytes = encodePair({ depthTs: 2, colourTs: 1, ...INTRINSICS, colour, depth });
  const pooled = Buffer.allocUnsafe(bytes.length + 17);
  pooled.set(bytes, 17);
  const got = decodePair(pooled.subarray(17, 17 + bytes.length));
  assert.equal(got.depthTs, 2);
  assert.equal(got.colourTs, 1);
  assert.deepEqual(Uint8Array.from(got.colour), colour);
  assert.deepEqual(Uint8Array.from(got.depth), depth);
});

// Each refusal with the buffer one byte short and the same buffer whole, because a decoder that
// threw on everything would pass the first half of every one of these on its own.
test('key and pair decoders require a complete header and nonempty depth', () => {
  const key = encodeKeyPayload({ ts: 1, colourTs: 1, ...INTRINSICS, jpeg: new Uint8Array([7]) });
  assert.throws(() => decodeKeyPayload(key.subarray(0, KEY_HEADER_BYTES - 1)), /header/);
  assert.throws(() => decodeKeyPayload(key.subarray(0, KEY_HEADER_BYTES)), /JPEG/);
  assert.equal(decodeKeyPayload(key).jpeg.length, 1);
  const pair = encodePair({ depthTs: 1, colourTs: 1, ...INTRINSICS, colour: null, depth: new Uint8Array([7]) });
  assert.throws(() => decodePair(pair.subarray(0, PAIR_HEADER_BYTES - 1)), /header/);
  const empty = encodePair({ depthTs: 1, colourTs: 1, ...INTRINSICS, colour: null, depth: new Uint8Array(0) });
  assert.throws(() => decodePair(empty), /declares/);
  assert.equal(decodePair(pair).depth.length, 1);
});

test('nonfinite intrinsics and unsafe identities are refused at both live decoders', () => {
  for (const patch of [{ fx: NaN }, { fy: 0 }, { cx: Infinity }, { rangeM: NaN }, { colourTs: Number.MAX_SAFE_INTEGER + 1 }]) {
    const key = encodeKeyPayload({ ts: 1, colourTs: 1, ...INTRINSICS, ...patch, jpeg: new Uint8Array([7]) });
    assert.throws(() => decodeKeyPayload(key), /invalid key header/);
    const pair = encodePair({ depthTs: 1, colourTs: 1, ...INTRINSICS, ...patch, depth: new Uint8Array([7]) });
    assert.throws(() => decodePair(pair), /invalid key pair header/);
  }
});

test('a pair cut short of what its own lengths declare is refused, naming both', () => {
  const colour = jpegLike(100, 9);
  const depth = jpegLike(50, 8);
  const bytes = encodePair({ depthTs: 1, colourTs: 1, ...INTRINSICS, colour, depth });
  assert.throws(() => decodePair(bytes.subarray(0, bytes.length - 1)), {
    message: `a key pair declares 100 colour and 50 depth bytes, so it needs ${bytes.length} bytes, `
      + `and this one is ${bytes.length - 1} bytes long`,
  });
  // The cut that removes only the last depth byte is the one a length check catches and a header
  // check cannot, so the header-sized prefix must fail for the other reason.
  assert.throws(() => decodePair(bytes.subarray(0, PAIR_HEADER_BYTES + 1)), /declares 100 colour/);
  assert.deepEqual(decodePair(bytes).depth, depth);
});
