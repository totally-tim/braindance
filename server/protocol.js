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
//   TYPE_COLOR         3            the colour camera's own picture, in a take recorded with colour on
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
// Type 3 is `[u64 stampMs][jpeg]`, the colour camera's own 1920x1080 picture, on the same clock as
// type 2's stamp and at the colour camera's own rate, so it lines up with no frame in particular.
// A take recorded with colour on carries one per colour frame the grabber encoded; a take recorded
// with colour off carries none. A reader skips any type it does not know.
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
// The colour camera's own 1920x1080 picture, not type 2's registered colour: served to the
// webcam output, and written into every take recorded with colour on.
export const TYPE_COLOR = 3;
// The same picture's depth, quantised to one byte a pixel and JPEG-compressed, so a browser can key
// the colour against it. Live only: a take never carries one, so a replayed take has no key. It
// arrives only while a key client is attached - `key on` implies the colour encode, so a type 4
// never travels without one.
export const TYPE_KEY = 4;
export const HEADER_BYTES = 12;

// `payloadLen` is a u32 off the wire, so a desynced stream can declare four gigabytes and
// the parser would buffer toward a message that is never going to be whole.
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Reassembles whole messages from arbitrary chunk boundaries: a 500KB frame is always
 * split across many `data` events, so one chunk never equals one frame.
 */
const EMPTY_BUF = Buffer.alloc(0);

export class MessageParser {
  constructor() {
    this.chunks = [];
    this.buffered = 0;
  }

  get buf() {
    if (this.buffered === 0) return EMPTY_BUF;
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
  }

  #peekUInt32LE(offset) {
    let pos = offset;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (pos + 4 <= c.length) return c.readUInt32LE(pos);
      if (pos < c.length) {
        const scratch = Buffer.allocUnsafe(4);
        let written = 0;
        let ci = i;
        let co = pos;
        while (written < 4) {
          const cur = this.chunks[ci];
          const take = Math.min(4 - written, cur.length - co);
          cur.copy(scratch, written, co, co + take);
          written += take;
          ci++;
          co = 0;
        }
        return scratch.readUInt32LE(0);
      }
      pos -= c.length;
    }
    return 0;
  }

  /** @returns {Array<{type: number, payload: Buffer, raw: Buffer}>} */
  push(chunk) {
    if (!chunk || chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered < HEADER_BYTES) return [];

    const firstMagic = this.#peekUInt32LE(0);
    if (firstMagic !== MAGIC) {
      throw new Error(`stream desync: expected magic KNCT, got 0x${firstMagic.toString(16)}`);
    }
    const firstLen = this.#peekUInt32LE(8);
    if (firstLen > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `a message declares ${firstLen} payload bytes, past the ${MAX_PAYLOAD_BYTES} this format allows: `
        + 'refusing rather than buffering toward it',
      );
    }
    if (this.buffered < HEADER_BYTES + firstLen) return [];

    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    let offset = 0;
    const out = [];

    while (buf.length - offset >= HEADER_BYTES) {
      const magic = buf.readUInt32LE(offset);
      if (magic !== MAGIC) {
        throw new Error(`stream desync: expected magic KNCT, got 0x${magic.toString(16)}`);
      }
      const type = buf.readUInt32LE(offset + 4);
      const len = buf.readUInt32LE(offset + 8);
      // Refused before a byte of it is buffered: the loop below waits for `total` and
      // concatenates every chunk, so a declared 0xffffffff grows this process toward 4 GiB.
      if (len > MAX_PAYLOAD_BYTES) {
        throw new Error(
          `a message declares ${len} payload bytes, past the ${MAX_PAYLOAD_BYTES} this format allows: `
          + 'refusing rather than buffering toward it',
        );
      }
      const total = HEADER_BYTES + len;
      if (buf.length - offset < total) break; // wait for the rest

      const start = offset;
      const end = offset + total;
      out.push({
        type,
        payload: buf.subarray(start + HEADER_BYTES, end),
        raw: buf.subarray(start, end),
      });
      offset = end;
    }

    const rem = buf.length - offset;
    if (rem === 0) {
      this.chunks = [];
      this.buffered = 0;
    } else {
      // Copy small trailing partials when slicing out of a much larger slab so a partial header
      // cannot keep a multi-megabyte pipe buffer alive across idle periods.
      const tail = buf.subarray(offset);
      if (tail.buffer.byteLength > Math.max(16 * 1024, rem * 4)) {
        const copy = Buffer.allocUnsafeSlow(rem);
        tail.copy(copy);
        this.chunks = [copy];
      } else {
        this.chunks = [tail];
      }
      this.buffered = rem;
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
