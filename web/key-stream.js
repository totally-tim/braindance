// The keyed colour output's wire, in one place because both ends read it: the server builds these
// buffers and the page at /key decodes them. Imports nothing and touches no global, so it runs in
// the browser and under node.
//
// Depth travels as a greyscale JPEG rather than as the u16 grid a type 2 frame carries: the keying
// happens against the 1920x1080 colour picture, and a JPEG is what a browser can put on the GPU
// without decoding it by hand.

// Levels a quantised reading has above "no reading". `native/grabber.cpp` declares the same number
// for the encoder it writes, and syntax-check's key/ row holds the two together.
export const KEY_DEPTH_LEVELS = 255;

// [u64 ts][f32 fx][f32 fy][f32 cx][f32 cy][f32 rangeM], then the JPEG.
export const KEY_HEADER_BYTES = 28;

// [u64 depthTs][u64 colourTs][f32 fx][f32 fy][f32 cx][f32 cy][f32 rangeM][u32 colourBytes]
// [u32 depthBytes], then the colour JPEG and the depth JPEG.
export const PAIR_HEADER_BYTES = 44;

// A Node Buffer is a window onto a pooled ArrayBuffer, so a view built without the offset and the
// length reads the pool from zero instead of this message.
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * A depth reading in millimetres as one byte, where 0 means no reading. Clamped to 0 rather than
 * wrapped: a reading past the range is absent, and `& 0xff` would land it on a plausible near one.
 */
export function quantiseDepthMm(mm, rangeM) {
  const ceiling = rangeM * 1000;
  if (!(ceiling > 0)) return 0;
  if (!Number.isFinite(mm) || mm <= 0 || mm > ceiling) return 0;
  // The floor of 1 is what keeps a real reading out of the value that means there is none.
  return Math.max(1, Math.round((KEY_DEPTH_LEVELS * mm) / ceiling));
}

/** The metres a quantised byte stands for. 0 is no reading and stays 0 rather than becoming a plane. */
export function dequantiseDepth(v, rangeM) {
  return v === 0 ? 0 : (v / KEY_DEPTH_LEVELS) * rangeM;
}

export function encodeKeyPayload({ ts, fx, fy, cx, cy, rangeM, jpeg }) {
  const out = new Uint8Array(KEY_HEADER_BYTES + jpeg.length);
  const dv = view(out);
  dv.setBigUint64(0, BigInt(ts), true);
  dv.setFloat32(8, fx, true);
  dv.setFloat32(12, fy, true);
  dv.setFloat32(16, cx, true);
  dv.setFloat32(20, cy, true);
  dv.setFloat32(24, rangeM, true);
  out.set(jpeg, KEY_HEADER_BYTES);
  return out;
}

export function decodeKeyPayload(bytes) {
  if (bytes.length < KEY_HEADER_BYTES) {
    throw new Error(`a key payload carries a ${KEY_HEADER_BYTES}-byte header and this one is ${bytes.length} bytes long`);
  }
  const dv = view(bytes);
  return {
    ts: Number(dv.getBigUint64(0, true)),
    fx: dv.getFloat32(8, true),
    fy: dv.getFloat32(12, true),
    cx: dv.getFloat32(16, true),
    cy: dv.getFloat32(20, true),
    rangeM: dv.getFloat32(24, true),
    jpeg: bytes.subarray(KEY_HEADER_BYTES),
  };
}

/** `colour` may be null, which is how a socket that already holds this `colourTs` is sent nothing. */
export function encodePair({ depthTs, colourTs, fx, fy, cx, cy, rangeM, colour, depth }) {
  const colourBytes = colour ? colour.length : 0;
  const out = new Uint8Array(PAIR_HEADER_BYTES + colourBytes + depth.length);
  const dv = view(out);
  dv.setBigUint64(0, BigInt(depthTs), true);
  dv.setBigUint64(8, BigInt(colourTs), true);
  dv.setFloat32(16, fx, true);
  dv.setFloat32(20, fy, true);
  dv.setFloat32(24, cx, true);
  dv.setFloat32(28, cy, true);
  dv.setFloat32(32, rangeM, true);
  dv.setUint32(36, colourBytes, true);
  dv.setUint32(40, depth.length, true);
  if (colourBytes) out.set(colour, PAIR_HEADER_BYTES);
  out.set(depth, PAIR_HEADER_BYTES + colourBytes);
  return out;
}

export function decodePair(bytes) {
  if (bytes.length < PAIR_HEADER_BYTES) {
    throw new Error(`a key pair carries a ${PAIR_HEADER_BYTES}-byte header and this one is ${bytes.length} bytes long`);
  }
  const dv = view(bytes);
  const colourBytes = dv.getUint32(36, true);
  const depthBytes = dv.getUint32(40, true);
  const want = PAIR_HEADER_BYTES + colourBytes + depthBytes;
  if (bytes.length < want) {
    throw new Error(`a key pair declares ${colourBytes} colour and ${depthBytes} depth bytes, `
      + `so it needs ${want} bytes, and this one is ${bytes.length} bytes long`);
  }
  return {
    depthTs: Number(dv.getBigUint64(0, true)),
    colourTs: Number(dv.getBigUint64(8, true)),
    fx: dv.getFloat32(16, true),
    fy: dv.getFloat32(20, true),
    cx: dv.getFloat32(24, true),
    cy: dv.getFloat32(28, true),
    rangeM: dv.getFloat32(32, true),
    // Null rather than an empty array, because "keep the frame you have" and "here is nothing to
    // draw" are different instructions to the page.
    colour: colourBytes ? bytes.subarray(PAIR_HEADER_BYTES, PAIR_HEADER_BYTES + colourBytes) : null,
    depth: bytes.subarray(PAIR_HEADER_BYTES + colourBytes, want),
  };
}
