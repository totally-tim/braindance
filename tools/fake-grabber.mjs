#!/usr/bin/env node
// A grabber with no Kinect behind it: real KNCT framing and real sensor depth looped out of a
// capture, on stdout, at a cadence this file controls. Not a sensor simulator.
//
//   tools/fake-grabber.mjs --source captures/sample.knct --fps 60 --frames 40
//   tools/fake-grabber.mjs --die-after 12      # exits, so the server respawns it
//   tools/fake-grabber.mjs --hd --key          # type 3 and the keyed depth beside it

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR, TYPE_KEY, encodeMessage } from '../server/protocol.js';
// Read from where the band that reads it lives rather than copied: a second producer with its own
// literal would go on stamping last year's generation into every take the suite plants.
import { CAPTURE_FORMAT } from '../web/format.js';
// The quantisation the page at /key inverts, so the fixture is built through the shipped one
// rather than through a second copy of the arithmetic.
import { encodeKeyPayload, quantiseDepthMm } from '../web/key-stream.js';

const argv = process.argv.slice(2);

// One table of every argument this fixture knows. `value` says whether an entry takes a following
// token; `ignored` marks one it reads and deliberately does nothing with, because refusing it would
// reject a spawn the server legitimately performs.
const ARGUMENTS = {
  '--source': { value: true },
  '--fps': { value: true },
  '--die-after': { value: true },
  '--burst': { value: true },
  '--frames': { value: true },
  '--tag': { value: true },
  '--emit-log': { value: true },
  '--hd': { value: false },
  '--key': { value: false },
  '--no-color': { value: false },
  '--no-low-light': { value: false },
  '--pipeline': { value: true, ignored: true },
  '--log': { value: true, ignored: true },
  '--quality': { value: true, ignored: true },
  '--min-depth': { value: true, ignored: true },
  '--max-depth': { value: true, ignored: true },
};

// Both readers go through the table, so a name absent from it is a mistake in this file rather
// than in the argv.
const argument = (name) => {
  if (!Object.hasOwn(ARGUMENTS, name)) throw new Error(`[fake-grabber] ${name} is read but missing from ARGUMENTS`);
  return ARGUMENTS[name];
};
const flag = (name, fallback = null) => {
  argument(name);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const given = (name) => { argument(name); return argv.includes(name); };

// Reported, never refused: `buildArgs` may append a flag this fixture cannot honour and that spawn
// must not fail, but a flag silently dropped is how the colour-off half of the live path stayed
// unreachable by every proof tool here.
for (let i = 0; i < argv.length; i++) {
  const known = Object.hasOwn(ARGUMENTS, argv[i]) ? ARGUMENTS[argv[i]] : null;
  if (!known) {
    process.stderr.write(`[fake-grabber] ignoring ${argv[i]}, which this fixture does not know\n`);
    continue;
  }
  if (known.value) i++;
}

const SOURCE = flag('--source', 'captures/sample.knct');
const FPS = Number(flag('--fps', '60'));
// Exits of its own accord, so the restart-splits-the-take rule has a writer that really goes away.
const DIE_AFTER = Number(flag('--die-after', '0'));
// Frames written back to back behind the hello, before the cadence starts. Spaced by a timer every
// frame is its own turn of the event loop, so a recorder that opened its file one turn late would
// still catch all but the first.
const BURST = Number(flag('--burst', '0'));
const FRAMES = Number(flag('--frames', '0'));
const TAG = flag('--tag', '');
// One line per message, `type length sha256-of-payload`, so a take can be checked against the
// writer rather than against the reader - polling the library would make it scan the take being
// written and measure an artifact its own question created.
const EMIT_LOG = flag('--emit-log', '');
// Whether this writer can produce type 3, the native-resolution colour the webcam output reads. The
// frame is the registered image upscaled plus a marker in the outer margin: the colour camera sees
// 84.1 degrees where the registered frustum sees 70.6, so an implementation that cheats by scaling
// type 2 matches almost the whole picture and still cannot produce the margin.
const HD = given('--hd');
// The keyed depth output. Needs `--hd`, because `key on` implies the colour encode and the colour
// this pairs with is the type 3 frame.
const KEY = given('--key');
const COLOR = !given('--no-color');
const LOW_LIGHT = !given('--no-low-light');
// 0.12 is wide enough to survive 4:2:0 chroma subsampling and JPEG ringing at the boundary, and
// narrow enough that the middle is still most of the picture.
const HD_MARGIN = 0.12;

if (KEY && !HD) {
  process.stderr.write('[fake-grabber] --key needs --hd: the keyed output pairs depth with the colour camera frame\n');
  process.exit(1);
}

const parser = new MessageParser();
const frames = [];
let sourceHello = null;
for (const msg of parser.push(readFileSync(SOURCE))) {
  if (msg.type === TYPE_HELLO) sourceHello ??= JSON.parse(msg.payload.toString('utf8'));
  else if (msg.type === TYPE_FRAME) frames.push(Buffer.from(msg.payload));
}
if (!sourceHello || frames.length === 0) {
  process.stderr.write(`[fake-grabber] ${SOURCE} carries no hello or no frames\n`);
  process.exit(1);
}

let hdFrame = null;
if (HD) {
  const first = frames[0];
  const depthBytes = first.readUInt32LE(0);
  const colorBytes = first.readUInt32LE(4);
  if (!colorBytes) {
    process.stderr.write(`[fake-grabber] ${SOURCE} carries no colour, so there is no HD frame to build from\n`);
    process.exit(1);
  }
  const registered = first.subarray(16 + depthBytes, 16 + depthBytes + colorBytes);
  const margin = Math.round(1920 * HD_MARGIN);
  try {
    hdFrame = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0',
      '-vf', `scale=1920:1080,`
        + `drawbox=x=0:y=0:w=${margin}:h=1080:color=magenta@1.0:t=fill,`
        + `drawbox=x=${1920 - margin}:y=0:w=${margin}:h=1080:color=cyan@1.0:t=fill`,
      '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
    ], { input: registered, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    process.stderr.write(`[fake-grabber] cannot build the HD fixture frame: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[fake-grabber] HD fixture ready: ${hdFrame.length} bytes, `
    + `${margin}px magenta left margin and cyan right\n`);
}

// What the grabber would clip at, so the fixture quantises against the range a real one would send.
// The sample's hello carries no `maxDepth`, and 9 metres is `native/grabber.cpp`'s own default.
const RANGE_M = Number(sourceHello.maxDepth ?? 9);
const KEY_INTRINSICS = { fx: 1081.37, fy: 1081.37, cx: 959.5, cy: 539.5, rangeM: RANGE_M };

let keyFrame = null;
if (KEY) {
  const margin = Math.round(1920 * HD_MARGIN);
  // A depth picture with something at every distance the page has to tell apart: two margins that
  // land either side of a wall, a subject in front of it, and a hole that is no reading at all.
  const grey = Buffer.alloc(1920 * 1080);
  const put = (x0, y0, w, h, value) => {
    for (let y = y0; y < y0 + h; y++) grey.fill(value, y * 1920 + x0, y * 1920 + x0 + w);
  };
  put(0, 0, 1920, 1080, quantiseDepthMm(3000, RANGE_M));
  put(0, 0, margin, 1080, quantiseDepthMm(1000, RANGE_M));
  put(1920 - margin, 0, margin, 1080, quantiseDepthMm(4000, RANGE_M));
  put(760, 340, 400, 400, quantiseDepthMm(1500, RANGE_M));
  put(940, 520, 40, 40, 0);
  try {
    // The mjpeg encoder has no greyscale profile, so it writes yuvj444p from a gray input and the
    // luma comes back exactly - measured at q:v 2 on this fixture, every flat region byte for byte.
    keyFrame = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '1920x1080', '-i', 'pipe:0',
      '-pix_fmt', 'gray', '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1',
    ], { input: grey, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    process.stderr.write(`[fake-grabber] cannot build the key fixture frame: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`[fake-grabber] key fixture ready: ${keyFrame.length} bytes over ${RANGE_M}m, `
    + `margins at 1.0m and 4.0m, a 3.0m wall, a 400x400 subject at 1.5m and a 40x40 hole\n`);
}

// `handleFrame` only reaches `pumpColorDecode` when a frame declares `colorBytes > 0`, so the
// frames decide whether the colour path runs at all. Both edits are needed or nothing parses -
// `server/capture.js` refuses a frame whose two declared lengths do not describe it. After the HD
// build and before anything emits: the build reads the source's colour block, and `encode()` reads
// the truncated array.
if (!COLOR) {
  for (let i = 0; i < frames.length; i++) {
    const payload = frames[i];
    const depthBytes = payload.readUInt32LE(0);
    const trimmed = Buffer.from(payload.subarray(0, 16 + depthBytes));
    trimmed.writeUInt32LE(0, 4);
    frames[i] = trimmed;
  }
  process.stderr.write(`[fake-grabber] colour off: ${frames.length} frames carry depth only, `
    + `${frames[0].length} bytes each\n`);
}
let hdOn = false;
let keyOn = false;

// One command per line on stdin. `low-light` is accepted and ignored because there is no device
// here to apply it to, and refusing it would reject a command the server legitimately sends.
let stdinPending = '';
process.stdin.on('data', (chunk) => {
  stdinPending += chunk.toString('utf8');
  let nl;
  while ((nl = stdinPending.indexOf('\n')) !== -1) {
    const line = stdinPending.slice(0, nl).replace(/\r$/, '');
    stdinPending = stdinPending.slice(nl + 1);
    if (line === 'hd-color on' || line === 'hd-color off') {
      // Mirrors `requestHdColor`, which never sends either command to a colour-off grabber: type 3
      // is the colour camera's own picture, so answering would manufacture the thing
      // `--no-color` removes.
      if (!COLOR) {
        process.stderr.write('[fake-grabber] refusing hd colour: colour is off on this grabber\n');
        continue;
      }
      if (!HD) {
        process.stderr.write('[fake-grabber] refusing hd colour: started without --hd\n');
        continue;
      }
      hdOn = line === 'hd-color on';
      process.stderr.write(`[fake-grabber] hd colour ${hdOn ? 'on' : 'off'}\n`);
    }
    if (line === 'key on' || line === 'key off') {
      // The same two refusals `hd-color` makes, for the same reason: the keyed output is the colour
      // camera's own depth, so a grabber with no colour has nothing to key.
      if (!COLOR) {
        process.stderr.write('[fake-grabber] refusing key: colour is off on this grabber\n');
        continue;
      }
      if (!KEY) {
        process.stderr.write('[fake-grabber] refusing key: started without --key\n');
        continue;
      }
      keyOn = line === 'key on';
      process.stderr.write(`[fake-grabber] key ${keyOn ? 'on' : 'off'}\n`);
    }
  }
});
process.stdin.resume();

// The wall clock goes in the hello and nowhere else; every frame stamp below is monotonic.
// `lowLight` is the conjunction and not the negation of its own flag - `native/grabber.cpp` reports
// `(wantColor && lowLight)`, so `--no-color` alone says false - and it is written only when
// something settles it, because adding a key the sample's hello does not carry would move every
// take's content hash.
const lowLightSettled = !COLOR || !LOW_LIGHT || 'lowLight' in sourceHello;
const hello = Buffer.from(JSON.stringify({
  ...sourceHello,
  format: CAPTURE_FORMAT,
  ...(COLOR ? {} : { color: false }),
  ...(lowLightSettled ? { lowLight: COLOR && LOW_LIGHT && (sourceHello.lowLight ?? true) } : {}),
  startedAt: Date.now(),
  ...(TAG ? { tag: TAG } : {}),
}));
// A real grabber sees EPIPE when the reader goes away first and it is not an error; unhandled it
// exits with a stack trace that reads as the grabber having failed.
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
// Monotonic and strictly ascending - the index, the retime curve and `mixT` rest on it. Started
// from the process clock so two takes in one session do not begin at the same stamp.
const origin = Math.round(performance.now());
let n = 0;
process.stderr.write(`[fake-grabber] streaming ${frames.length} looped frames at ${FPS}fps${TAG ? ` tag=${TAG}` : ''}\n`);

// Appended synchronously and before the bytes go out, so a writer killed mid-take has logged
// everything the reader could have received and never less. The fourth column hashes the body a
// reader downstream receives - a colour message's JPEG without the stamp in front of it - which the
// payload hash cannot serve as, because the stamp moves per frame.
const note = (type, payload, body = null) => {
  if (!EMIT_LOG) return;
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  appendFileSync(EMIT_LOG, `${type} ${payload.length} ${sha(payload)} ${body ? sha(body) : '-'}\n`);
};

const encode = () => {
  const payload = Buffer.from(frames[n % frames.length]);
  // Only the u64 at payload offset 8 moves, so the depth and the JPEG are real bytes
  // off a real sensor.
  payload.writeBigUInt64LE(BigInt(origin + Math.round((n * 1000) / FPS)), 8);
  n++;
  note(TYPE_FRAME, payload);
  return encodeMessage(TYPE_FRAME, payload);
};

const encodeHd = () => {
  const payload = Buffer.alloc(8 + hdFrame.length);
  payload.writeBigUInt64LE(BigInt(origin + Math.round((n * 1000) / FPS)), 0);
  hdFrame.copy(payload, 8);
  note(TYPE_COLOR, payload, hdFrame);
  return encodeMessage(TYPE_COLOR, payload);
};

const encodeKey = () => {
  const payload = Buffer.from(encodeKeyPayload({
    ts: origin + Math.round((n * 1000) / FPS),
    ...KEY_INTRINSICS,
    jpeg: keyFrame,
  }));
  note(TYPE_KEY, payload, keyFrame);
  return encodeMessage(TYPE_KEY, payload);
};

const emit = () => {
  const parts = [encode()];
  // `key on` implies the colour encode, the way the real grabber's does: type 3 flows whenever
  // type 4 does, whether or not `hd-color` asked for it separately.
  if ((hdOn || keyOn) && hdFrame) parts.push(encodeHd());
  // After the colour it belongs to, because the server pairs a type 4 with the colour frame it is
  // holding when the type 4 lands - and both carry the same stamp.
  if (keyOn && keyFrame) parts.push(encodeKey());
  process.stdout.write(parts.length === 1 ? parts[0] : Buffer.concat(parts));
};

// The hello and the burst leave in one write, so they arrive in one chunk and the reader's parser
// hands them to the recorder inside a single turn.
note(TYPE_HELLO, hello);
const opening = [encodeMessage(TYPE_HELLO, hello)];
for (let i = 0; i < BURST; i++) opening.push(encode());
process.stdout.write(Buffer.concat(opening));

const tick = () => {
  emit();

  if (DIE_AFTER > 0 && n >= DIE_AFTER) {
    process.stderr.write(`[fake-grabber] exiting after ${n} frames\n`);
    // Flushed before exiting, or the last messages die in the pipe and the take ends mid-frame.
    process.stdout.write('', () => process.exit(0));
    return;
  }
  if (FRAMES > 0 && n >= FRAMES) return;
  setTimeout(tick, 1000 / FPS);
};

if (DIE_AFTER > 0 && n >= DIE_AFTER) {
  process.stderr.write(`[fake-grabber] exiting after ${n} frames\n`);
  process.stdout.write('', () => process.exit(0));
} else if (!(FRAMES > 0 && n >= FRAMES)) {
  setTimeout(tick, 1000 / FPS);
}
process.on('SIGTERM', () => process.exit(0));
