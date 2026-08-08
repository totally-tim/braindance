// Wire format shared by the native grabber, the recorder and the replayer.
//
// ---- the .knct decoder specification ---------------------------------------
//
// **A recorded take is this wire verbatim** - the framing below, written to disk in
// arrival order, with nothing added and nothing wrapped around it. So this is both the
// live protocol and the archive format, and it is written out here rather than left
// implied because the archive outlives the stack that recorded it: a Kinect v2
// discontinued for years, a libfreenect2 that is minimally maintained, and a depth solve
// on an OpenCL that Apple has deprecated. Issue #45 asked whether a take's exit from this
// program should be a point-cloud export or a specification, and settled on this: an
// export costs a measured 4.10x the take as xyz and does not replace it, since the take
// is kept anyway for the native JPEG and the sensor stamps, while a page here is enough
// for somebody to write a reader in an afternoon.
//
// The numbers in the table are checked against this module's own exports by
// `tools/syntax-check.mjs`, which fails when a constant moves and the prose does not, and
// which enumerates the exports rather than a list so a constant added later is asked by
// existing. A specification nobody checks is a document that drifts, which is the failure
// this repository deleted its design document to avoid.
//
//   MAGIC              0x4b4e4354   'KNCT' read as a little-endian u32
//   HEADER_BYTES       12           three u32s: magic, type, payloadLen
//   TYPE_HELLO         1            the sensor record, once, before any frame
//   TYPE_FRAME         2            one depth grid and at most one JPEG
//   TYPE_COLOR         3            live only - the recorder never writes one
//   MAX_PAYLOAD_BYTES  8388608      a longer declared payload is a desync, not a frame
//
// **Container.** Every message is `[u32 magic][u32 type][u32 payloadLen][payload]`, all
// integers little-endian, `payloadLen` counting the payload alone. A file is one message
// after another to EOF. A final message whose payload falls short of its declared length
// is a take that was cut off mid-write rather than a corrupt file, and every frame before
// it is still good - which is why a reader should stop at a short tail instead of
// refusing the take.
//
// **Type 1, the hello.** UTF-8 JSON, once, ahead of every frame. `fx`, `fy`, `cx`, `cy`
// are the depth camera's intrinsics *as this device reported them*, and they are what a
// reader must unproject with rather than any constant: they are per-device, and the
// viewer's own boot defaults of 366/366/256/212 sit about 45mm from a real sensor's at
// three metres. `width` and `height` are the depth grid. Not every take carries every
// key - the list has grown, and one recorded before a key existed simply lacks it.
//
// **Type 2, the frame.** `[u32 depthBytes][u32 colorBytes][u64 stampMs][depth][jpeg]`,
// little-endian again, `stampMs` a wall clock in milliseconds from the recording machine.
// The depth is `width * height` u16 millimetres, row-major, top row first, so
// `depthBytes` is `width * height * 2`. `colorBytes` may be zero: the colour camera runs
// at about half the depth rate, and a frame carrying no JPEG means the previous picture
// still stands rather than that anything was lost. The JPEG, where present, is the
// *registered* colour - `Registration::apply`'s resample into the depth camera's
// viewpoint - so it shares the depth grid pixel for pixel and a per-vertex colour is a
// direct lookup at the same row and column.
//
// **A depth of 0 is not a point.** It is the solve returning no reading along that ray,
// and a reader that unprojects it anyway puts a vertex at the sensor origin - a wall of
// geometry that was never in the room. Measured over all 284 frames of the sample take,
// 76.5% of the 512x424 grid carries a reading: mean 166,148 samples, range 146,129 to
// 170,134.
//
// **Unprojection**, libfreenect2's pinhole model, the same one the vertex shader in
// `web/main.js` uses. For the sample at column `col` and row `row` holding `mm`
// millimetres, in metres, in a right-handed frame with the camera looking down -z:
//
//     z = mm / 1000
//     X = -(col + 0.5 - cx) / fx * z
//     Y = -(row + 0.5 - cy) / fy * z
//     Z = -z
//
// The half pixel is the sample's centre, and Y is negated because image space grows
// downward. That is the whole of it: those four lines against the four intrinsics out of
// the hello turn a take into geometry with none of this program running.
//
// **X is negated, and that is one sign away from `Registration::getPointXYZ`. Do not
// "correct" it back.** The depth grid in this file is the sensor's frame verbatim, and
// libfreenect2 delivers depth, IR and colour horizontally mirrored on purpose, to match
// the Microsoft SDK's selfie-view convention. Microsoft pairs that mirrored image with a
// camera space whose x grows to the sensor's *left*, which makes their 3D output chirally
// correct; `getPointXYZ` pairs the same mirrored image with an x that grows right, so
// copying it gives a cloud that is a mirror image of the room - a raised right hand on
// the right of the picture. Every take in this format was written through that mirror, so
// the negation belongs in the reader and every take old and new decodes upright with it.
//
// The half-pixel and the principal point are unaffected: for a mirrored pixel the true
// column is `W - (col + 0.5)` and the true principal point is `W - cx`, the grid width
// cancels out of the difference, and `-(col + 0.5 - cx)` is what remains. So `cx` is used
// exactly as the hello reports it. **Mirroring the sample indices instead of negating X
// is a different and wrong fix**, because the registered colour shares the depth grid
// pixel for pixel and is mirrored the same way - move the sampling and the colour comes
// off the geometry.
//
// **Nothing in the file says which generation of grabber wrote it.** That is issue #44's
// to fix rather than this specification's, and it is recorded here because a reader that
// assumes one geometry model across an archive holding more than one gets a silently
// wrong answer - and here is where somebody writing that reader will be looking.
//
// ---- end of the .knct decoder specification --------------------------------

export const MAGIC = 0x4b4e4354;
export const TYPE_HELLO = 1;
export const TYPE_FRAME = 2;
// The colour camera's own picture, at its native 1920x1080, for the webcam output.
//
// **A separate message rather than a second field on the frame, because it is a
// different picture of a different thing.** Type 2 carries the *registered* colour:
// `Registration::apply`'s resample of the colour camera into the depth camera's
// viewpoint, which is a texture for the point cloud - it wears the depth camera's
// 70.6 degree frustum instead of the colour camera's 84.1, and it is punched through
// with holes wherever the depth solve returned nothing for a ray to carry colour on.
// Useful for shading a cloud, useless as a picture of a room.
//
// **It is live-only: the recorder never writes one.** A capture file is the wire
// verbatim, so a type 3 landing in one would move every take's content hash, and that
// hash is the key the library joins two machines on. `vcam-check --mutate
// hd-reaches-recorder` is the arm that fails if this ever stops being true. Recording
// it is a decision nobody has taken - see issue #9.
//
// Emitted only while something is subscribed, because at roughly 215KB a frame it is
// another ~50Mbit/s on a pipe whose backpressure reaches the grabber and costs the
// take. The server asks for it over the grabber's stdin command channel.
export const TYPE_COLOR = 3;
export const HEADER_BYTES = 12;

// The largest payload this format admits, and the reason it needs one at all:
// `payloadLen` is a u32 off the wire, so a desynced stream can declare four
// gigabytes and the reassembly below would buffer toward it a chunk at a time,
// holding every byte for a message that is never going to be whole. A frame is a
// 512x424 depth grid plus a JPEG - 486KB measured on this sensor - a hello is a few
// hundred bytes of JSON, and a 1080p colour message measures about 215KB, so eight
// megabytes is more than an order of magnitude of headroom over anything this format
// has ever carried, and a length past it is a lie rather than a large frame. Named
// here rather than in either reader, because the live parser and the sidecar index
// are both bounded by the same fact about the format.
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Reassembles whole messages from arbitrary chunk boundaries. A 500KB frame is
 * always split across many `data` events, so one chunk never equals one frame.
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
      // Refused before a byte of it is buffered, which is the whole point of
      // checking here rather than where the payload is used. The loop below waits
      // for `total` bytes and concatenates every chunk until it has them, so a
      // declared length of 0xffffffff is this process growing toward 4 GiB while the
      // sender goes quiet - no error, no frame, just a buffer nobody bounds. A
      // desynced stream that landed on plausible magic is the ordinary way to arrive
      // here, and the caller treats a throw as a reason to restart the grabber,
      // which is what rebuilds the framing.
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
