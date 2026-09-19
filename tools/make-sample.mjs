#!/usr/bin/env node
// A capture, synthesised, so a clone with no Kinect can run the suite. Written to the shape of the
// capture this repo actually holds: a nine-key hello with no `format` (so it is a generation-zero
// take) and no `startedAt` (so `describeTake` dates it by mtime), and a real JPEG in every frame,
// because the decimation row needs the colour block to be more than 35% of a divisor-4 message. The
// depth is synthesised geometry rather than noise - a back wall, a floor, a sphere crossing the
// frame, and a band of zeroes, since `0 = no reading` is a value every reader has to handle. It is
// written mirrored, because the wire format is.
//
// It is a stand-in rather than footage: no depth jitter, no confidence gate chattering, no dropped
// frames, no colour camera halving its rate. Say which sample a number came from.

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeMessage, TYPE_HELLO, TYPE_FRAME } from '../server/protocol.js';
import { DEPTH_W, DEPTH_H } from '../web/format.js';

const argv = process.argv.slice(2);

// The option names are a table rather than string literals scattered down the file: `--framse 10`
// put `10` into the positional list, left `--frames` on its default and wrote a perfectly valid
// capture nobody asked for, which `--if-missing` then kept forever. Splitting the two kinds also
// keeps the positional count honest.
const VALUED = ['--frames', '--fps', '--quality'];
const BOOLEAN = ['--force', '--if-missing'];

const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.includes(a)) {
    // A valued option at the end of the line has no value, and skipping past it made `--frames`
    // alone read as `--frames 284` - the same class as a misspelling, arriving with the
    // name spelled right.
    if (i + 1 >= argv.length) {
      console.error(`[make-sample] ${a} takes a value and none followed it. Nothing was written.`);
      process.exit(2);
    }
    i++;
    continue;
  }
  if (BOOLEAN.includes(a)) continue;
  if (a.startsWith('-')) {
    console.error(`[make-sample] ${a} is not an option this tool has`
      + ` - it takes ${[...VALUED, ...BOOLEAN].join(', ')}. Nothing was written.`);
    process.exit(2);
  }
  positional.push(a);
}
if (positional.length > 1) {
  console.error(`[make-sample] one output path, and ${positional.length} were given:`
    + ` ${positional.join(' ')}. Nothing was written.`);
  process.exit(2);
}

const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const OUT = positional[0];
if (!OUT) {
  console.error('usage: make-sample.mjs <out.knct> [--frames N] [--fps F] [--quality Q] [--force]');
  console.error('  writes a synthetic generation-zero capture: real geometry, a real JPEG per frame,');
  console.error('  and no sensor required. See the header for which rows a stand-in cannot answer.');
  console.error('  refuses to overwrite an existing capture unless --force.');
  process.exit(2);
}

// It refuses to overwrite, because the path this tool is run at is where a machine with a Kinect
// keeps real footage, and a capture cannot be shot again. Refusing by default rather than
// prompting: the case that needs protecting is the unattended one. Three spellings, because there
// are three different things somebody means - `--force` replaces, `--if-missing` leaves an existing
// capture alone so `npm run fixtures` still builds the loop, and the bare default stops.
if (existsSync(OUT) && !argv.includes('--force')) {
  const st = statSync(OUT);
  if (argv.includes('--if-missing')) {
    console.log(`[make-sample] ${OUT} already exists (${(st.size / 1024 / 1024).toFixed(1)}MB), leaving it alone`);
    process.exit(0);
  }
  console.error(`[make-sample] refusing to overwrite ${OUT}`);
  console.error(`[make-sample]   ${(st.size / 1024 / 1024).toFixed(1)}MB, last written ${st.mtime.toISOString()}`);
  console.error('[make-sample] a capture cannot be shot again. Move it aside, or pass --force if it is a stand-in,');
  console.error('[make-sample] or --if-missing if you only wanted one to exist.');
  process.exit(2);
}
// 284 frames at 30fps, the count and the rate the capture in this tree carries. Sized by frame
// count rather than by duration, because duration is the thing that differs between two files
// nobody committed.
const FRAMES = Number(flag('--frames', '284'));
const FPS = Number(flag('--fps', '30'));
const QUALITY = Number(flag('--quality', '82'));

// Refused here rather than trusted to fail somewhere useful, because none of these fail anywhere at
// all: `Number('nope')` is NaN, `i < NaN` is false on the first test, and `--frames nope` wrote a
// 162-byte file holding only the hello and exited 0. `npm run fixtures` then sees an existing
// capture and adopts the wreck. The output is not opened until this has passed, so a refused run
// leaves whatever was at that path untouched.
for (const [name, value, ok, wants] of [
  ['--frames', FRAMES, Number.isInteger(FRAMES) && FRAMES > 0, 'a whole number of frames above zero'],
  ['--fps', FPS, Number.isFinite(FPS) && FPS > 0, 'a rate above zero'],
  ['--quality', QUALITY, Number.isInteger(QUALITY) && QUALITY >= 1 && QUALITY <= 100, 'a JPEG quality from 1 to 100'],
]) {
  if (!ok) {
    console.error(`[make-sample] ${name} needs ${wants}, and was given ${JSON.stringify(flag(name, ''))}`
      + ` - which reads as ${value}. Nothing was written.`);
    process.exit(2);
  }
}

// The sensor's own intrinsics, taken from the capture this stands in for. Hardcoded intrinsics skew
// the cloud in a way that is hard to spot and hard to attribute, which is why the hello
// carries them at all.
const FX = 366.031494;
const FY = 366.031494;
const CX = 257.775909;
const CY = 206.784195;

// Depth in millimetres on the sensor's grid, `0` meaning no reading. Every surface is analytic, so
// what the file contains is known rather than measured.

/**
 * One frame of depth, at phase `t` in [0, 1). The column-to-world-X step is the mirrored one and it
 * is the whole reason this is not the obvious loop: `worldX = -(col + 0.5 - CX) / FX * z`, so a
 * positive world X is a low column, and the sphere is placed by solving that for `col`.
 */
function depthFrame(t) {
  const depth = new Uint16Array(DEPTH_W * DEPTH_H);
  // The sphere crosses left to right and back, so a check reading a signed displacement cannot pass
  // on a fixture that only ever moves one way.
  const sweep = Math.sin(t * Math.PI * 2);
  const ballX = sweep * 0.55;          // metres, world, +X is the room's right
  const ballY = 0.12 * Math.cos(t * Math.PI * 4);
  const ballZ = 1.55 + 0.18 * sweep;
  const BALL_R = 0.28;

  for (let row = 0; row < DEPTH_H; row++) {
    // The vertical axis is not mirrored - only the horizontal is - so this is the plain
    // unprojection with y growing up.
    const ny = -(row + 0.5 - CY) / FY;
    for (let col = 0; col < DEPTH_W; col++) {
      const nx = -(col + 0.5 - CX) / FX;
      let z = 3.2;
      if (ny < -1e-6) {
        const floorZ = -1.05 / ny;
        if (floorZ < z) z = floorZ;
      }
      // The sphere, solved along the ray rather than drawn as a disc, so its depth really is a
      // curved surface and a normal fit over it means something.
      const dx = nx;
      const dy = ny;
      const len = Math.hypot(dx, dy, 1);
      const ux = dx / len;
      const uy = dy / len;
      const uz = 1 / len;
      const ocx = -ballX;
      const ocy = -ballY;
      const ocz = -ballZ;
      const b = 2 * (ux * ocx + uy * ocy + uz * ocz);
      const c = ocx * ocx + ocy * ocy + ocz * ocz - BALL_R * BALL_R;
      const disc = b * b - 4 * c;
      if (disc > 0) {
        const hit = (-b - Math.sqrt(disc)) / 2;
        if (hit > 0.3) {
          const hz = uz * hit;
          if (hz < z) z = hz;
        }
      }
      // A band of no-reading, placed on the wall rather than over the sphere so it cannot be
      // confused with an occlusion.
      const shadow = row > 70 && row < 96 && col > 300 && col < 470 && z > 3.0;
      depth[row * DEPTH_W + col] = shadow ? 0 : Math.round(Math.min(z, 8.0) * 1000);
    }
  }
  return depth;
}

/** The same scene as an RGB image, so the colour and the depth agree about the room. */
function colorFrame(depth, t) {
  const rgb = new Uint8Array(DEPTH_W * DEPTH_H * 3);
  for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
    const mm = depth[i];
    const row = Math.floor(i / DEPTH_W);
    const col = i % DEPTH_W;
    let r;
    let g;
    let b;
    if (mm === 0) {
      r = 10; g = 12; b = 16;
    } else if (mm > 3100) {
      // A stripe pattern, so the JPEG carries real high-frequency content rather than compressing
      // to almost nothing.
      const stripe = ((col >> 4) + (row >> 5)) & 1 ? 24 : 0;
      r = 96 + stripe + (row >> 3);
      g = 104 + stripe + (row >> 4);
      b = 118 + stripe;
    } else if (mm > 1900) {
      const check = ((col >> 5) ^ (row >> 5)) & 1 ? 30 : 0;
      r = 70 + check; g = 62 + check; b = 54 + check;
    } else {
      // Lit from the upper left of the room, which after the mirror is the upper right of the
      // buffer. Same sign the depth used, so the two cannot disagree about which side
      // the light is on.
      const shade = 1 - Math.min(1, (mm - 1200) / 900);
      r = Math.round(40 + 200 * shade);
      g = Math.round(60 + 150 * shade);
      b = Math.round(90 + 90 * shade);
    }
    // Fine texture, here for the size rather than the look: a room of flat regions encodes to
    // 13.7KB a frame against the real capture's 58KB, and the decimation row fails under about
    // 14.6KB. Deterministic rather than random, so two runs of this tool produce the same file.
    const h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
    const grain = ((h >>> 24) & 31) - 16;
    // A slow global drift so consecutive frames are not byte-identical - a take whose frames all
    // hash the same cannot tell a reader that seeks from one that does not.
    const drift = Math.round(6 * Math.sin(t * Math.PI * 2));
    rgb[i * 3] = Math.max(0, Math.min(255, r + drift + grain));
    rgb[i * 3 + 1] = Math.max(0, Math.min(255, g + drift + grain));
    rgb[i * 3 + 2] = Math.max(0, Math.min(255, b + grain));
  }
  return rgb;
}

// Written here rather than shelled out to ffmpeg, because this tool is the bootstrap: a generator
// needing a system package would fail exactly the person it exists for, and one that used ffmpeg
// when present would produce different bytes on different machines. Baseline sequential, 4:4:4, one
// Huffman table pair shared by all three components, with JPEG Annex K's published tables.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const QUANT_BASE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const DC_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** `bits`/`values` to a `code -> [length, bits]` map, by the standard canonical walk. */
function huffTable(bits, values) {
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) table.set(values[k++], [len, code++]);
    code <<= 1;
  }
  return table;
}
const DC_TABLE = huffTable(DC_BITS, DC_VALS);
const AC_TABLE = huffTable(AC_BITS, AC_VALS);

/** The quantisation table at this quality, by the conventional libjpeg scaling. */
function quantAt(quality) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return QUANT_BASE.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

/** A growable bit sink that byte-stuffs `0xFF`, which entropy-coded JPEG data requires. */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.bits = 0;
  }

  write(length, value) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.bits++;
      if (this.bits === 8) {
        this.bytes.push(this.acc & 0xff);
        // A literal 0xFF inside the scan would be read as the start of a marker, so the format
        // requires a zero byte after it.
        if ((this.acc & 0xff) === 0xff) this.bytes.push(0x00);
        this.acc = 0;
        this.bits = 0;
      }
    }
  }

  /** Pad the final partial byte with ones, which is what the format specifies. */
  flush() {
    while (this.bits) this.write(1, 1);
  }
}

/** The magnitude category of a coefficient, and the value bits the format wants with it. */
function magnitude(v) {
  const a = Math.abs(v);
  let size = 0;
  while (size < 16 && a >= (1 << size)) size++;
  // A negative coefficient is written as the one's complement of its magnitude in `size` bits,
  // which is the format's own encoding and not a sign bit.
  return [size, v < 0 ? v + (1 << size) - 1 : v];
}

/** Forward DCT over one 8x8 block, written directly from the definition. */
const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) t[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();
function fdct(block, out) {
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS[u * 8 + x] * COS[v * 8 + y];
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      out[v * 8 + u] = 0.25 * cu * cv * sum;
    }
  }
}

/**
 * An RGB image to a baseline JPEG. Not subsampled: 4:2:0 halves the chroma resolution and needs a
 * second block geometry, and what this file is for is a colour block of realistic size that decodes
 * to the room the depth describes.
 */
function encodeJpeg(rgb, width, height, quality) {
  const quant = quantAt(quality);
  const out = [];
  const u8 = (b) => out.push(b & 0xff);
  const u16 = (v) => { out.push((v >> 8) & 0xff, v & 0xff); };
  const marker = (m) => { u8(0xff); u8(m); };

  marker(0xd8);                                   // SOI
  // A JFIF APP0, with no EXIF anywhere - the mirror question was settled off a frame carrying JFIF
  // and no orientation tag that anything downstream could have been applying.
  marker(0xe0); u16(16);
  u8(0x4a); u8(0x46); u8(0x49); u8(0x46); u8(0x00);
  u8(1); u8(1); u8(0); u16(1); u16(1); u8(0); u8(0);

  marker(0xdb); u16(67); u8(0);                   // DQT, one table, all components share it
  for (let i = 0; i < 64; i++) u8(quant[ZIGZAG[i]]);

  marker(0xc0); u16(17); u8(8);                   // SOF0, 8-bit
  u16(height); u16(width); u8(3);
  for (let c = 1; c <= 3; c++) { u8(c); u8(0x11); u8(0); }

  marker(0xc4); u16(2 + 1 + 16 + DC_VALS.length); u8(0x00);
  for (let i = 1; i <= 16; i++) u8(DC_BITS[i]);
  for (const v of DC_VALS) u8(v);
  marker(0xc4); u16(2 + 1 + 16 + AC_VALS.length); u8(0x10);
  for (let i = 1; i <= 16; i++) u8(AC_BITS[i]);
  for (const v of AC_VALS) u8(v);

  marker(0xda); u16(12); u8(3);
  for (let c = 1; c <= 3; c++) { u8(c); u8(0x00); }
  u8(0); u8(63); u8(0);

  // Colour conversion up front rather than per block, because a block straddling the right or
  // bottom edge repeats the last real pixel and doing that on the planes keeps the edge
  // rule in one place.
  const planes = [new Float64Array(width * height), new Float64Array(width * height), new Float64Array(width * height)];
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    planes[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    planes[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  const bw = new BitWriter();
  const block = new Float64Array(64);
  const coef = new Float64Array(64);
  const prevDc = [0, 0, 0];
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let c = 0; c < 3; c++) {
        const plane = planes[c];
        for (let y = 0; y < 8; y++) {
          const sy = Math.min(height - 1, by + y);
          for (let x = 0; x < 8; x++) {
            const sx = Math.min(width - 1, bx + x);
            block[y * 8 + x] = plane[sy * width + sx];
          }
        }
        fdct(block, coef);
        const q = new Int32Array(64);
        for (let i = 0; i < 64; i++) q[i] = Math.round(coef[ZIGZAG[i]] / quant[ZIGZAG[i]]);

        const diff = q[0] - prevDc[c];
        prevDc[c] = q[0];
        const [dcSize, dcBits] = magnitude(diff);
        const [dcLen, dcCode] = DC_TABLE.get(dcSize);
        bw.write(dcLen, dcCode);
        if (dcSize) bw.write(dcSize, dcBits);

        let run = 0;
        for (let i = 1; i < 64; i++) {
          if (q[i] === 0) { run++; continue; }
          // A run of more than fifteen zeroes is written as ZRL blocks: the run length in a
          // coefficient symbol is four bits, and truncating it silently produces a file that
          // decodes to the wrong image.
          while (run > 15) { const [l, cc] = AC_TABLE.get(0xf0); bw.write(l, cc); run -= 16; }
          const [size, bits] = magnitude(q[i]);
          const [len, code] = AC_TABLE.get((run << 4) | size);
          bw.write(len, code);
          bw.write(size, bits);
          run = 0;
        }
        if (run > 0) { const [l, cc] = AC_TABLE.get(0x00); bw.write(l, cc); }
      }
    }
  }
  bw.flush();
  const head = Buffer.from(out);
  const scan = Buffer.from(bw.bytes);
  return Buffer.concat([head, scan, Buffer.from([0xff, 0xd9])]);
}

// Nine keys, in the order the real capture carries them. `JSON.stringify` over a literal rather
// than a hand-built string, because a hello that is not JSON is a take nothing can parse.
const hello = JSON.stringify({
  serial: '000000000000',
  firmware: 'synthetic',
  width: DEPTH_W,
  height: DEPTH_H,
  fx: FX,
  fy: FY,
  cx: CX,
  cy: CY,
  color: true,
});

// Generated beside the target and renamed onto it, so a run that dies leaves nothing that looks
// like a capture: opening `OUT` directly truncates it at the first byte, and the next `npm run
// fixtures` sees a file, exits 0 and adopts the wreck permanently. It also makes `--force` honest,
// which used to destroy the old capture before a single frame was encoded.
const TEMP = `${OUT}.part`;
// `captures/` is gitignored, so a fresh clone has no directory to write into.
mkdirSync(dirname(OUT), { recursive: true });
const stream = createWriteStream(TEMP);
// Removed on any failure, including the ones nothing here catches: `exit` covers the ordinary
// throw, and the signals do not fire `exit` on their own.
const discard = () => { try { rmSync(TEMP, { force: true }); } catch { /* going away anyway */ } };
let installed = false;
process.on('exit', () => { if (!installed) discard(); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { discard(); process.exit(130); });
// One error handler for the stream rather than one per write: a `once('error')` armed inside
// `write` is only ever removed by an error, so 284 frames armed 284 of them. A plain `on('error')`
// with no rejection would be worse than the leak - it would turn a full disk into a `drain`
// that never comes.
let writeFailure = null;
const waiting = new Set();
stream.on('error', (err) => {
  writeFailure = err;
  for (const rej of waiting) rej(err);
  waiting.clear();
});
const write = (buf) => new Promise((res, rej) => {
  // Awaited rather than fired and forgotten: a 138MB file written without watching the drain
  // buffers the whole thing in memory.
  if (writeFailure) { rej(writeFailure); return; }
  if (stream.write(buf)) { res(); return; }
  waiting.add(rej);
  stream.once('drain', () => { waiting.delete(rej); res(); });
});

await write(encodeMessage(TYPE_HELLO, Buffer.from(hello, 'utf8')));

// Monotonic milliseconds from an arbitrary origin, which is what the sensor's `steady_clock` gives;
// they are not a wall clock. The origin is fixed rather than `Date.now()`, so two runs produce
// byte-identical files.
const STAMP_ORIGIN = 875_649_822;
let colorTotal = 0;
for (let i = 0; i < FRAMES; i++) {
  const t = i / FRAMES;
  const depth = depthFrame(t);
  const jpeg = encodeJpeg(colorFrame(depth, t), DEPTH_W, DEPTH_H, QUALITY);
  colorTotal += jpeg.length;
  const depthBytes = depth.byteLength;
  const payload = Buffer.alloc(16 + depthBytes + jpeg.length);
  payload.writeUInt32LE(depthBytes, 0);
  payload.writeUInt32LE(jpeg.length, 4);
  payload.writeBigUInt64LE(BigInt(STAMP_ORIGIN + Math.round((i * 1000) / FPS)), 8);
  Buffer.from(depth.buffer, depth.byteOffset, depthBytes).copy(payload, 16);
  jpeg.copy(payload, 16 + depthBytes);
  await write(encodeMessage(TYPE_FRAME, payload));
  if ((i + 1) % 50 === 0 || i + 1 === FRAMES) {
    process.stderr.write(`[make-sample] ${i + 1}/${FRAMES} frames\n`);
  }
}

// `end`'s callback receives the error when the final flush or close fails, and a resolve that
// ignored it renamed a truncated `.part` onto `OUT` with a success message over it.
await new Promise((res, rej) => stream.end((err) => (err ? rej(err) : res())));
if (writeFailure) throw writeFailure;
renameSync(TEMP, OUT);
installed = true;
// `FRAMES - 1` frame gaps, not `FRAMES`: the stamps run from index 0, so the span the server and
// the editor read off the file is one frame period shorter than the count times the rate.
console.log(`[make-sample] ${OUT}: ${FRAMES} frames at ${FPS}fps spanning `
  + `${((FRAMES - 1) / FPS).toFixed(2)}s, mean colour ${(colorTotal / FRAMES / 1024).toFixed(1)}KB a frame`);
console.log('[make-sample] generation zero, no startedAt - a stand-in, not footage; say so when reporting a number from it');
