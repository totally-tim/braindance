// Wire format shared by the native grabber, the recorder and the replayer.
//
// ---- the .knct decoder specification ---------------------------------------
//
// A recorded take is this wire verbatim, written to disk in arrival order.
//
//   MAGIC              0x4b4e4354   'KNCT' read as a little-endian u32
//   HEADER_BYTES       12           three u32s: magic, type, payloadLen
//   TYPE_HELLO         1            the sensor record, once, before any frame
//   TYPE_FRAME         2            one depth grid and at most one JPEG
//   TYPE_COLOR         3            live only - the recorder never writes one
//   TYPE_KEY           4            live only - the colour picture's depth, for keying
//   MAX_PAYLOAD_BYTES  8388608      a longer declared payload is a desync, not a frame
//
// Message: `[u32 magic][u32 type][u32 payloadLen][payload]`, little-endian, one after
// another to EOF. A short final payload is a take cut off mid-write, so a reader stops at
// the tail rather than refusing the take. Type 1 is UTF-8 JSON carrying this device's own
// `fx`, `fy`, `cx`, `cy`, `width` and `height` - unproject with those rather than any
// constant. Type 2 is `[u32 depthBytes][u32 colorBytes][u64 stampMs][depth][jpeg]`, the
// depth `width * height` u16 millimetres row-major with 0 meaning no reading; `colorBytes`
// may be zero, and the JPEG is the registered colour, sharing the grid pixel for pixel.
//
// Type 4 is `[u64 stampMs][u64 colourTs][f32 fx][f32 fy][f32 cx][f32 cy][f32 rangeM][jpeg]`, the colour camera's
// own depth at 1920x1080 as a greyscale JPEG, so the four intrinsics are the colour camera's and
// not the depth camera's. A pixel of 0 is no reading; anything else is `v / 255 * rangeM` metres,
// which `web/key-stream.js` is the one implementation of at both ends.
//
// Unprojection, libfreenect2's pinhole model, metres, right-handed, camera down -z:
//
//     z = mm / 1000
//     X = -(col + 0.5 - cx) / fx * z
//     Y = -(row + 0.5 - cy) / fy * z
//     Z = -z
//
// X is negated, one sign away from `Registration::getPointXYZ`; do not "correct" it back.
// libfreenect2 mirrors depth and colour horizontally and every take was written through
// that mirror, so mirroring the sample indices instead moves the colour off the geometry.
//
// ---- end of the .knct decoder specification --------------------------------

export const MAGIC = 0x4b4e4354;
export const TYPE_HELLO = 1;
export const TYPE_FRAME = 2;
// The colour camera's own 1920x1080 picture for the webcam output, not type 2's registered
// colour. Live only: a type 3 in a capture would move every take's content hash, which is
// the key the library joins two machines on.
export const TYPE_COLOR = 3;
// The same picture's depth, quantised to one byte a pixel and JPEG-compressed, so a browser can key
// the colour against it. Live only for the same reason type 3 is, and it arrives only while a key
// client is attached - `key on` implies the colour encode, so a type 4 never travels without one.
export const TYPE_KEY = 4;
export const HEADER_BYTES = 12;

// `payloadLen` is a u32 off the wire, so a desynced stream can declare four gigabytes and
// the parser would buffer toward a message that is never going to be whole.
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Reassembles whole messages from arbitrary chunk boundaries: a 500KB frame is always
 * split across many `data` events, so one chunk never equals one frame.
 */
export class MessageParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {Array<{type: number, payload: Buffer, raw: Buffer}>} */
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];

    while (this.buf.length >= HEADER_BYTES) {
      const magic = this.buf.readUInt32LE(0);
      if (magic !== MAGIC) {
        throw new Error(`stream desync: expected magic KNCT, got 0x${magic.toString(16)}`);
      }
      const type = this.buf.readUInt32LE(4);
      const len = this.buf.readUInt32LE(8);
      // Refused before a byte of it is buffered: the loop below waits for `total` and
      // concatenates every chunk, so a declared 0xffffffff grows this process toward 4 GiB.
      if (len > MAX_PAYLOAD_BYTES) {
        throw new Error(
          `a message declares ${len} payload bytes, past the ${MAX_PAYLOAD_BYTES} this format allows: `
          + 'refusing rather than buffering toward it',
        );
      }
      const total = HEADER_BYTES + len;
      if (this.buf.length < total) break; // wait for the rest

      out.push({
        type,
        payload: this.buf.subarray(HEADER_BYTES, total),
        raw: this.buf.subarray(0, total),
      });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

export function encodeMessage(type, payload) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(type, 4);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}
