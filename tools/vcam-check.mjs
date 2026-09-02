#!/usr/bin/env node
// OBS receives the point-cloud program, the live colour camera, and the colour camera keyed by
// live depth. They have different failure modes, so this file has different arms for them and for
// the take that must never receive either live-only stream.
//
// The discriminator is geometric rather than perceptual. The wire already carries colour - type 2's
// registered 512x424 JPEG - and an implementation that upscaled that to 1080p would look almost
// right, so dimensions are the convenient probe and the wrong one. The colour camera sees 84.1
// degrees where the registered frustum sees 70.6, and `fake-grabber --hd` plants a magenta left
// margin and a cyan right one in that difference, which no upscale can invent.
//
// It spawns its own server and needs none running; the stream is `tools/fake-grabber.mjs`, so no
// sensor is required, and ffmpeg builds and decodes the fixture. Sections 5 and 9 need a GPU browser
// and `--no-browser` drops them. Sections 6 and 7 need a non-internal IPv4 and exit 2 as UNPROVEN
// rather than passing quietly without one. What it does not prove is OBS: that a browser source
// renders WebGL at 1080p and that OBS samples it at canvas rate require OBS in front of you.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR, TYPE_KEY } from '../server/protocol.js';
import { decodePair, quantiseDepthMm } from '../web/key-stream.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8361'));
const MUTATE = flag('--mutate');
const NO_BROWSER = argv.includes('--no-browser');
const WORK = join(REPO, '.vcam-check');
const SOURCE = join(REPO, 'captures', 'sample.knct');

// Where the fixture plants what the registered image cannot contain. Has to match `fake-grabber`'s
// `HD_MARGIN`, and is asserted below rather than assumed.
const MARGIN = Math.round(1920 * 0.12);
// How far a decoded margin may sit from the planted colour. JPEG at 4:2:0 moves a saturated edge by
// a few counts, and the two markers are 200-plus apart in every channel that distinguishes them.
const COLOUR_TOLERANCE = 40;

// This machine's own address, the only way to create a webcam subscriber that is not on loopback
// and therefore the only way section 6 can ask the refusal anything. Null on a
// machine that has none.
const LAN = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;

const MUTATIONS = {
  // The pose goes back onto the camera without passing the registry, which is how it shipped: the
  // `params` half of one socket patch is normalised and the `view` half was not. Must redden the
  // refusal row and leave the row under it green - a build that dropped `view` altogether would
  // redden that one and be a different defect.
  'pose-skips-the-registry': {
    file: 'web/main.js',
    edits: [[
      "    try {\n"
      + "      view = params.normalise('camera', patch.view);\n"
      + "    } catch (err) {\n"
      + "      console.error(`[program-out] ${err.message}`);\n"
      + "      return;\n"
      + "    }\n",
      '    view = patch.view;\n',
    ]],
    fails: 'the camera pose in a socket patch, put through the registry the parameters beside it '
      + 'already go through. Four finite numbers are not a rotation, and the source was '
      + 'drawing with whatever arrived. Reddens the refusal row and leaves the '
      + 'pose-still-arrives row green',
  },

  // The parameter half of the patch goes back to landing one name at a time with a catch per entry,
  // so a patch from a mismatched build applies its good half and draws the new mode against a stale
  // value. Must redden the half-right-patch row alone, because a wholly valid patch lands
  // identically either way.
  'patch-params-applied-one-at-a-time': {
    file: 'web/main.js',
    edits: [[
      '  if (patch.params) {\n'
      + '    try {\n'
      + '      params.apply(patch.params);\n'
      + '    } catch (err) {\n'
      + '      console.error(`[program-out] ${err.message}`);\n'
      + '      return;\n'
      + '    }\n'
      + '  }\n',
      '  if (patch.params) {\n'
      + '    for (const [name, value] of Object.entries(patch.params)) {\n'
      + '      try {\n'
      + '        params.set(name, value);\n'
      + '      } catch (err) {\n'
      + '        console.error(`[program-out] ${err.message}`);\n'
      + '      }\n'
      + '    }\n'
      + '  }\n',
    ]],
    fails: 'and the parameter half of the same patch, whole or not at all - applied one name at '
      + 'a time, a refused name kept the rest and the source drew half a frame nobody sent. '
      + 'Reddens the half-right-patch row alone',
  },

  // The endpoint serves the registered colour scaled up to 1080p instead of the colour camera's own
  // frame - the plausible wrong implementation. Placed at the offer rather than at the socket, so
  // the grabber, the negotiation and the take are untouched and sections 1, 3 and 4 keep passing.
  'hd-upscales-registered': {
    file: 'server/index.js',
    edits: [[
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
      'webcam.offer(upscaledRegistered ?? Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
    ], [
      '    recorder.write(msg.raw);\n  } else if (msg.type === TYPE_COLOR) {',
      '    try {\n'
      + '      const db = msg.payload.readUInt32LE(0);\n'
      + '      const cb = msg.payload.readUInt32LE(4);\n'
      + '      if (cb) {\n'
      + '        upscaledRegistered = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0",\n'
      + '          "-vf", "scale=1920:1080", "-frames:v", "1", "-q:v", "3", "-f", "mjpeg", "pipe:1"],\n'
      + '          { input: msg.payload.subarray(16 + db, 16 + db + cb), maxBuffer: 64 * 1024 * 1024 });\n'
      + '      }\n'
      + '    } catch { /* the mutation is best-effort */ }\n'
      + '    recorder.write(msg.raw);\n  } else if (msg.type === TYPE_COLOR) {',
    ], [
      "import { Webcam } from './webcam.js';",
      "import { Webcam } from './webcam.js';\nimport { execFileSync } from 'node:child_process';\nlet upscaledRegistered = null;",
    ]],
  },

  // The margins say the picture is the colour camera's; nothing said the bytes were. This decodes
  // the colour payload and re-encodes it at the same size, so every geometric row above still
  // passes and only the bytes differ. Memoised, because a synchronous 1920x1080 re-encode per
  // message starves the stream until a different row reddens - and with ffmpeg missing the memo
  // holds the original bytes, the mutation becomes a no-op and the run says NOT CAUGHT, loudly.
  'hd-reencodes-in-flight': {
    file: 'server/index.js',
    edits: [[
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
      'webcam.offer(reencodedColour(Buffer.from(msg.payload.subarray(8))), Number(msg.payload.readBigUInt64LE(0)));',
    ], [
      "import { Webcam } from './webcam.js';",
      "import { Webcam } from './webcam.js';\nimport { execFileSync } from 'node:child_process';\n"
      + 'let reencodedOnce = null;\n'
      + 'function reencodedColour(jpeg) {\n'
      + '  if (reencodedOnce) return reencodedOnce;\n'
      + '  try {\n'
      + '    reencodedOnce = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0",\n'
      + '      "-frames:v", "1", "-q:v", "2", "-f", "mjpeg", "pipe:1"],\n'
      + '      { input: jpeg, maxBuffer: 64 * 1024 * 1024 });\n'
      + '  } catch { reencodedOnce = jpeg; }\n'
      + '  return reencodedOnce;\n'
      + '}',
    ]],
  },

  // The colour message reaches the recorder, so a take carries a third message type - which moves
  // its content hash, the key the library joins two machines on. This is the `nearClip` versus
  // `--min-depth` failure class: it changes the footage in the one situation where nobody is
  // watching for it.
  'hd-reaches-recorder': {
    file: 'server/index.js',
    edits: [[
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));',
      'webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));\n'
      + '    recorder.write(msg.raw);',
    ]],
  },

  // The refusal keeps its monitors clause and loses its webcam one, so a take starts while somebody
  // pulls ~50Mbit/s of MJPEG over the same radio the depth packets compete for. Section 1's `a
  // loopback subscriber does not refuse the take` is a row this mutation makes more true, which is
  // why it could never stand in for this one.
  'refusal-ignores-webcam': {
    file: 'server/index.js',
    edits: [[
      "\n    ...webcam.subscribersCostingTheTake()\n"
      + "      .map(() => ({ kind: 'webcam', at: 'the colour camera at full rate' })),",
      '',
    ]],
  },

  // A key encoder that runs before anybody asks consumes the same HD thread as the colour camera
  // for every frame. The first row in section 7 asks while no client exists, so no neighbouring
  // assertion has to infer the absence from a later stream.
  'key-runs-unasked': {
    file: 'server/key-stream.js',
    edits: [[
      'this.demand = new OnDemand({ request, count: () => this.clients.size });',
      'this.demand = new OnDemand({ request, count: () => 1 });\n    this.demand.settle();',
    ]],
    fails: 'section 7\'s first row, which reads type 4 at the writer before any key client exists',
  },

  // The socket is attached and receives the acknowledgement, but the demand edge never reaches
  // the grabber. The run must finish and name the absent type 4 stream rather than time out.
  'key-never-asks': {
    file: 'server/key-stream.js',
    edits: [[
      '    this.clients.set(ws, { loopback, behind: 0, lastColourTs: null });\n'
      + '    this.demand.settle();\n'
      + '    console.log(`[key] client attached (${this.clients.size} total, ${loopback ? \'loopback\' : \'remote\'})`);',
      '    this.clients.set(ws, { loopback, behind: 0, lastColourTs: null });\n'
      + '    console.log(`[key] client attached (${this.clients.size} total, ${loopback ? \'loopback\' : \'remote\'})`);',
    ]],
    fails: 'the section 7 writer and pair rows, section 8\'s pair precondition, and section 9\'s '
      + 'drawing precondition; the run still reaches its verdict',
  },

  // A stale depth stamp behind the colour it is paired with reproduces the one-frame silhouette
  // lag at the wire seam without changing either JPEG. The fake writer stamps the two equal.
  'pair-serves-stale-depth': {
    file: 'server/key-stream.js',
    edits: [[
      'const pair = { depthTs: key.ts, colourTs, fx: key.fx, fy: key.fy, cx: key.cx, cy: key.cy, rangeM: key.rangeM };',
      'const pair = { depthTs: key.ts - 1, colourTs, fx: key.fx, fy: key.fy, cx: key.cx, cy: key.cy, rangeM: key.rangeM };',
    ]],
    fails: 'section 7\'s pair-stamp row alone: the colour stamp is now newer than the depth stamp',
  },

  // The last client goes away and the key stream stays wanted forever. Kept on KeyStream.detach
  // rather than the shared OnDemand class, so the webcam linger rows remain a control.
  'key-linger-never-fires': {
    file: 'server/key-stream.js',
    edits: [[
      '  detach(ws) {\n'
      + '    if (!this.clients.delete(ws)) return;\n'
      + '    console.log(`[key] client gone (${this.clients.size} left)`);\n'
      + '    this.demand.settle();\n'
      + '  }',
      '  detach(ws) {\n'
      + '    if (!this.clients.delete(ws)) return;\n'
      + '    console.log(`[key] client gone (${this.clients.size} left)`);\n'
      + '  }',
    ]],
    fails: 'section 7\'s leaving-stops-it row alone, after the six-second linger has elapsed',
  },

  // The plausible wrong input: throw away the colour camera's outer field, reduce what remains to
  // the registered grid, then scale it back to 1080p. Memoised so the control asks geometry rather
  // than starving the server event loop with one ffmpeg per frame.
  'key-upscales-grid': {
    file: 'server/key-stream.js',
    edits: [[
      "import { OnDemand } from './on-demand.js';",
      "import { OnDemand } from './on-demand.js';\nimport { execFileSync } from 'node:child_process';\n"
      + 'let gridUpscaledOnce = null;\n'
      + 'function gridUpscaledDepth(jpeg) {\n'
      + '  if (gridUpscaledOnce) return gridUpscaledOnce;\n'
      + '  try {\n'
      + '    gridUpscaledOnce = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",\n'
      + '      "-i", "pipe:0", "-vf", "crop=1460:1080:230:0,scale=512:424:flags=neighbor,scale=1920:1080:flags=neighbor",\n'
      + '      "-pix_fmt", "gray", "-frames:v", "1", "-q:v", "2", "-f", "mjpeg", "pipe:1"],\n'
      + '      { input: jpeg, maxBuffer: 64 * 1024 * 1024 });\n'
      + '  } catch { gridUpscaledOnce = jpeg; }\n'
      + '  return gridUpscaledOnce;\n'
      + '}',
    ], [
      'whole ??= encodePair({ ...pair, colour, depth: key.jpeg });',
      'whole ??= encodePair({ ...pair, colour, depth: gridUpscaledDepth(key.jpeg) });',
    ], [
      'elided ??= encodePair({ ...pair, colour: null, depth: key.jpeg });',
      'elided ??= encodePair({ ...pair, colour: null, depth: gridUpscaledDepth(key.jpeg) });',
    ]],
    fails: 'section 8\'s outer-depth and writer-passthrough rows, plus the page rows whose planted '
      + 'margins the upscale removed',
  },

  // The depth still has the right dimensions and values, but it is no longer the JPEG the writer
  // emitted. Memoised for the same reason as the colour-path control above.
  'key-reencodes-in-flight': {
    file: 'server/key-stream.js',
    edits: [[
      "import { OnDemand } from './on-demand.js';",
      "import { OnDemand } from './on-demand.js';\nimport { execFileSync } from 'node:child_process';\n"
      + 'let reencodedDepthOnce = null;\n'
      + 'function reencodedDepth(jpeg) {\n'
      + '  if (reencodedDepthOnce) return reencodedDepthOnce;\n'
      + '  try {\n'
      + '    reencodedDepthOnce = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",\n'
      + '      "-i", "pipe:0", "-pix_fmt", "gray", "-frames:v", "1", "-q:v", "5", "-f", "mjpeg", "pipe:1"],\n'
      + '      { input: jpeg, maxBuffer: 64 * 1024 * 1024 });\n'
      + '  } catch { reencodedDepthOnce = jpeg; }\n'
      + '  return reencodedDepthOnce;\n'
      + '}',
    ], [
      'whole ??= encodePair({ ...pair, colour, depth: key.jpeg });',
      'whole ??= encodePair({ ...pair, colour, depth: reencodedDepth(key.jpeg) });',
    ], [
      'elided ??= encodePair({ ...pair, colour: null, depth: key.jpeg });',
      'elided ??= encodePair({ ...pair, colour: null, depth: reencodedDepth(key.jpeg) });',
    ]],
    fails: 'section 8\'s row comparing every served depth JPEG with the writer log',
  },

  // A type 4 reaches the recorder. Section 3 already holds the class as "only hello and frames";
  // attaching a key client in that section makes this control reach that existing row.
  'key-reaches-recorder': {
    file: 'server/index.js',
    edits: [[
      '    keyStream.offer(msg.payload);',
      '    keyStream.offer(msg.payload);\n    recorder.write(msg.raw);',
    ]],
    fails: 'section 3\'s existing row that permits only hello and type 2 frames in a take',
  },

  // The remote key stream vanishes from the same refusal table the webcam already occupies.
  'refusal-ignores-key': {
    file: 'server/index.js',
    edits: [[
      "    ...keyStream.subscribersCostingTheTake()\n"
      + "      .map(() => ({ kind: 'key', at: 'the keyed colour camera at full rate' })),",
      '',
    ]],
    fails: 'section 7\'s two remote-key refusal rows; the loopback row stays green',
  },

  // An opaque clear turns every rejected pixel into black. The key still computes the right mask,
  // so only the output page can catch this.
  'key-writes-opaque': {
    file: 'web/key.js',
    edits: [[
      'renderer.setClearColor(0x000000, 0);',
      'renderer.setClearColor(0x000000, 1);',
    ]],
    fails: 'section 9\'s five transparency probes and binary-alpha row',
  },

  // The picture ignores the switch and all six faces. Rows drive the faces one at a time, so this
  // cannot pass merely because the default box happens to contain the fixture.
  'key-ignores-crop-faces': {
    file: 'web/key.js',
    edits: [[
      '  uniforms.cropOn.value = faces.crop ? 1 : 0;',
      '  uniforms.cropOn.value = 0;',
    ]],
    fails: 'section 9\'s default-far, moved-far, near and image-left lateral cuts',
  },

  // Keep only the four lateral faces. The lateral cut stays green, which is what separates this
  // from the control above; the near and far rows carry the missing depth pair.
  'key-tests-four-faces': {
    file: 'web/key-shader.js',
    edits: [[
      '  if (outsideDepthPair(z)) {\n'
      + '    gl_FragColor = vec4(0.0);\n'
      + '    return;\n'
      + '  }\n\n',
      '',
    ]],
    fails: 'section 9\'s default-far, moved-far and near rows while its lateral row stays green',
  },

  // Put the crop test after a levelling rotation. This needs two files because the correct page
  // deliberately does not hand tilt to the shader at all. The section drives tilt alone and
  // compares the whole RGBA frame before and after it.
  'key-tests-after-levelling': {
    file: 'web/key.js',
    edits: [[
      "  cropT: { value: FRAMING_DEFAULTS.top },\n};",
      "  cropT: { value: FRAMING_DEFAULTS.top },\n  tilt: { value: FRAMING_DEFAULTS.tilt },\n};",
    ], [
      "  top: FRAMING_DEFAULTS.top,\n};",
      "  top: FRAMING_DEFAULTS.top,\n  tilt: FRAMING_DEFAULTS.tilt,\n};",
    ], [
      '  uniforms.cropOn.value = faces.crop ? 1 : 0;\n',
      '  uniforms.cropOn.value = faces.crop ? 1 : 0;\n  uniforms.tilt.value = faces.tilt;\n',
    ], [
      '  if (typeof values.crop === \'boolean\') faces.crop = values.crop;\n',
      '  if (typeof values.crop === \'boolean\') faces.crop = values.crop;\n'
      + '  if (Number.isFinite(values.tilt)) faces.tilt = values.tilt;\n',
    ], [
      'uniform float cropOn, nearClip, farClip, cropL, cropR, cropB, cropT;',
      'uniform float cropOn, nearClip, farClip, cropL, cropR, cropB, cropT, tilt;',
      'web/key-shader.js',
    ], [
      '  float z = v / DEPTH_LEVELS * rangeM;\n'
      + '  if (outsideDepthPair(z)) {\n'
      + '    gl_FragColor = vec4(0.0);\n'
      + '    return;\n'
      + '  }\n\n'
      + '  // A fragment samples at the centre of its pixel, so this already carries the half that\n'
      + '  // \\`unproject\\` in web/cloud-shader.js adds to an integer index. Both axes negated with it, which\n'
      + '  // is what puts image-left on positive x.\n'
      + '  vec2 pixel = uv * imageSize;\n'
      + '  vec2 lateral = vec2(-(pixel.x - cx) / fx, -(pixel.y - cy) / fy) * z;\n'
      + '  if (outsideLateral(lateral)) {',
      '  float z = v / DEPTH_LEVELS * rangeM;\n\n'
      + '  // Wrong on purpose: rotate the sensor point before asking the crop box.\n'
      + '  vec2 pixel = uv * imageSize;\n'
      + '  vec2 lateral = vec2(-(pixel.x - cx) / fx, -(pixel.y - cy) / fy) * z;\n'
      + '  float a = radians(tilt);\n'
      + '  vec3 levelled = vec3(lateral.x, lateral.y * cos(a) + z * sin(a),\n'
      + '    lateral.y * sin(a) - z * cos(a));\n'
      + '  if (outsideDepthPair(-levelled.z) || outsideLateral(levelled.xy)) {',
      'web/key-shader.js',
    ]],
    fails: 'section 9\'s bit-identity row after tilt 14, with every crop face held fixed',
  },

  // Treat the missing reading as the near face rather than as no geometry. The hole in the
  // subject is the object every other region probe would skip.
  'zero-depth-is-nearest': {
    file: 'web/key-shader.js',
    edits: [[
      '  if (v == 0.0) {\n'
      + '    gl_FragColor = vec4(0.0);\n'
      + '    return;\n'
      + '  }',
      '  if (v == 0.0) v = nearClip / rangeM * DEPTH_LEVELS;',
    ]],
    fails: 'section 9\'s zero-depth-hole row alone',
  },
};

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}
if (!existsSync(SOURCE)) {
  console.error(`no capture at ${SOURCE} - this check needs one to loop; see tools/make-fixture.js`);
  process.exit(2);
}

// A mutation applied in place and restored afterwards leaves a mutated working tree behind any
// crash, which is the one state a proof tool must never produce.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
// `effects-builtin` is in this list because the effect store refuses to boot without its shipped
// root, so a staged tree without it is a server this tool can never start. It is copied rather than
// symlinked, so a mutation naming a chunk under it could not reach the repo's own source.
for (const dir of ['server', 'tools', 'web', 'effects-builtin']) {
  cpSync(join(REPO, dir), join(WORK, dir), { recursive: true });
}
for (const name of ['node_modules', 'vendor', 'captures']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(WORK, name));
}
mkdirSync(join(WORK, 'takes'), { recursive: true });
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const changed = new Map();
  for (const [from, to, editFile = spec.file] of spec.edits) {
    const path = join(WORK, editFile);
    let source = changed.get(path) ?? readFileSync(path, 'utf8');
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      console.error(`mutation ${MUTATE} matched ${hits} times in ${editFile}, expected exactly 1 - refusing to run an unmutated server`);
      process.exit(2);
    }
    source = source.replace(from, to);
    changed.set(path, source);
  }
  for (const [path, source] of changed) writeFileSync(path, source);
}

let checked = 0, failed = 0;
// Claims this machine could not be asked, each carrying its own remedy. A list rather than one
// string because two different absences reach here, and the verdict line used to append
// playwright's advice to whatever it was given.
const untested = [];
let crashed = null;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms, what = 'condition') => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await wait(50);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};
const servers = [];
const EMIT_LOG = join(WORK, 'emitted.log');

/**
 * Bring a server up and wait until there is a sensor behind it. The wait is on the resource rather
 * than on a constant: `viewer on` prints inside `httpServer.listen`'s callback, before `startLive`
 * has spawned the grabber, and this grabber reads a 138MB capture and runs a 1080p encode first -
 * 3.8 to 4.7 seconds on a loaded machine. `webcam.available` is the right predicate because
 * `unavailable` asks whether there is a colour camera to serve and never whether a frame has
 * arrived, and it is readable without subscribing, which section 1's first row needs. A timeout
 * throws and exits 2 as DID NOT RUN, because under `--mutate` a harness that never got a sensor
 * would otherwise be written down as the mutation being caught.
 */
const start = async (extra = []) => {
  const log = await new Promise((resolve, reject) => {
    const grabber = `${join(WORK, 'tools/fake-grabber.mjs')} --source ${SOURCE} --fps 30 --hd `
      + `--key --emit-log ${EMIT_LOG}`;
    const child = spawn(process.execPath, [
      join(WORK, 'server/index.js'), '--port', String(PORT),
      '--captures', join(WORK, 'takes'), '--grabber', grabber, ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    const lines = [];
    const onData = (c) => {
      lines.push(c.toString());
      if (lines.join('').includes('viewer on')) resolve(() => lines.join(''));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => reject(new Error(`server never came up:\n${lines.join('')}`)), 15000);
  });
  await waitFor(async () => (await api('/record/state')).body?.webcam?.available === true,
    25000, 'the grabber to handshake and offer a colour camera');
  return log;
};
const stopAll = async () => {
  for (const c of servers) c.kill('SIGKILL');
  servers.length = 0;
  await wait(200);
};

const api = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (path, body = {}) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * An MJPEG subscriber that keeps the parts it was sent. Parsed off the boundary rather than by
 * scanning for JPEG markers, because the thing being checked includes the framing: a part whose
 * declared length disagrees with its body is a stream OBS would resynchronise through and this
 * would not notice.
 */
function subscribe(host = '127.0.0.1') {
  const state = { parts: [], done: false, controller: new AbortController() };
  state.ready = fetch(`http://${host}:${PORT}/camera.mjpg`, { signal: state.controller.signal })
    .then(async (res) => {
      state.status = res.status;
      if (res.status !== 200) { state.done = true; return state; }
      let buf = Buffer.alloc(0);
      (async () => {
        try {
          for await (const chunk of res.body) {
            buf = Buffer.concat([buf, Buffer.from(chunk)]);
            for (;;) {
              const head = buf.indexOf('--braindanceframe\r\n');
              if (head === -1) break;
              const blank = buf.indexOf('\r\n\r\n', head);
              if (blank === -1) break;
              const headers = buf.subarray(head, blank).toString('latin1');
              const m = /Content-Length: (\d+)/.exec(headers);
              if (!m) break;
              const len = Number(m[1]);
              const bodyAt = blank + 4;
              if (buf.length < bodyAt + len) break;
              state.parts.push(Buffer.from(buf.subarray(bodyAt, bodyAt + len)));
              buf = buf.subarray(bodyAt + len);
            }
          }
        } catch { /* aborted */ }
        state.done = true;
      })();
      return state;
    });
  state.stop = () => state.controller.abort();
  return state;
}

/** A WebSocket that leaves the monitor population and keeps the key pairs it receives. */
function subscribeKey(host = '127.0.0.1') {
  const state = { pairs: [], raw: [], attached: false, closed: false, errors: [] };
  const ws = new WebSocket(`ws://${host}:${PORT}`);
  state.socket = ws;
  ws.on('open', () => ws.send(JSON.stringify({ key: true })));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message?.key?.attached === true) {
          state.attached = true;
          state.loopback = message.key.loopback;
        }
      } catch (err) {
        state.errors.push(err.message);
      }
      return;
    }
    // The server sends ordinary type 2 monitor frames before it acknowledges the mode switch. A
    // pair has no discriminator, so the acknowledgement is the seam and bytes before it are not
    // decoded as pairs.
    if (!state.attached) return;
    try {
      const raw = Buffer.from(data);
      state.raw.push(raw);
      state.pairs.push(decodePair(raw));
    } catch (err) {
      state.errors.push(err.message);
    }
  });
  ws.on('error', (err) => state.errors.push(err.message));
  ws.on('close', () => { state.closed = true; });
  state.ready = waitFor(() => state.attached, 8000, 'the socket to become a key client');
  state.stop = async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    await waitFor(() => state.closed, 2000, 'the key socket to close').catch(() => {});
  };
  return state;
}

/**
 * What the writer says it emitted, as `type -> [{ hash, body }]`. `hash` is the whole payload;
 * `body` is the part body a reader downstream receives, or null where the two are the same thing. A
 * colour payload is the u64 stamp then the JPEG, the stamp moves per frame, and the JPEG is the
 * only part that reaches a subscriber.
 */
function emitted() {
  if (!existsSync(EMIT_LOG)) return new Map();
  const out = new Map();
  for (const line of readFileSync(EMIT_LOG, 'utf8').split('\n')) {
    if (!line) continue;
    const [type, , hash, body] = line.split(' ');
    const key = Number(type);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ hash, body: body && body !== '-' ? body : null });
  }
  return out;
}

/** The mean RGB of a region, through ffmpeg, so nothing here decodes a JPEG by hand. */
function meanRgb(jpeg, crop) {
  const raw = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vf', `crop=${crop},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { input: jpeg, maxBuffer: 16 * 1024 * 1024 });
  return [raw[0], raw[1], raw[2]];
}
const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= COLOUR_TOLERANCE);
const dims = (jpeg) => execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', 'pipe:0',
], { input: jpeg, maxBuffer: 16 * 1024 * 1024 }).toString().trim().split(',').map(Number);

/** Decode one greyscale JPEG into its 1920x1080 byte plane. */
const greyOf = (jpeg) => execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
  '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
], { input: jpeg, maxBuffer: 16 * 1024 * 1024 });

/** Decode a transparent screenshot without flattening it onto a background. */
const rgbaOf = (png) => execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
], { input: png, maxBuffer: 16 * 1024 * 1024 });
const rgbaAt = (rgba, x, y, width = 1920) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

console.log(`\n[vcam] ${MUTATE ? `mutation ${MUTATE}` : 'unmutated'}, port ${PORT}\n`);

try {
  console.log('1. the colour stream is asked for and stops again');
  {
    await start();
    await wait(1500);
    const before = emitted().get(TYPE_COLOR)?.length ?? 0;
    ok('no colour message is emitted while nothing is subscribed', before === 0,
      `${before} emitted`);

    const sub = subscribe();
    await sub.ready;
    await wait(1500);
    const during = emitted().get(TYPE_COLOR)?.length ?? 0;
    ok('subscribing starts it', during > 10, `${during} emitted`);
    ok('and the subscriber is actually being served parts', sub.parts.length > 10,
      `${sub.parts.length} parts`);

    // The take must be able to see it, which is the positive twin of the refusal: a check built
    // only out of refusals passes against a server that refuses everything.
    const state = await api('/record/state');
    ok('the webcam is in the recorder\'s own accounting', Array.isArray(state.body?.webcam?.subscribers)
      && state.body.webcam.subscribers.length === 1,
    JSON.stringify(state.body?.webcam?.subscribers));
    // Loopback here, so it must NOT be refused - the exemption is what lets every proof tool in
    // this repo drive the server over localhost.
    ok('a loopback subscriber does not refuse the take', state.body?.monitors?.wouldRefuse === false);

    sub.stop();
    // Past the linger, which exists because OBS retries a dead source hard.
    await wait(7500);
    const atStop = emitted().get(TYPE_COLOR)?.length ?? 0;
    await wait(1500);
    const after = emitted().get(TYPE_COLOR)?.length ?? 0;
    ok('leaving stops it again', after === atStop, `${atStop} -> ${after}`);
    await stopAll();
  }

  console.log('\n2. what is served is the colour camera and not the registered image');
  {
    rmSync(EMIT_LOG, { force: true });
    await start();
    const sub = subscribe();
    await sub.ready;
    await wait(2000);
    ok('the endpoint answered 200', sub.status === 200, `status ${sub.status}`);

    const frame = sub.parts.at(-1);
    if (!frame) {
      ok('a frame was served at all', false, 'no parts arrived');
    } else {
      const [w, h] = dims(frame);
      ok('it is the colour camera\'s native resolution', w === 1920 && h === 1080, `${w}x${h}`);

      // The discriminator: an upscale of the registered image is 1920x1080 too, and it cannot be
      // magenta and cyan down the sides.
      const left = meanRgb(frame, `${MARGIN}:1080:0:0`);
      const right = meanRgb(frame, `${MARGIN}:1080:${1920 - MARGIN}:0`);
      ok('the left margin carries what the registered frustum cannot see',
        near(left, [255, 0, 255]), `rgb(${left})`);
      ok('and so does the right', near(right, [0, 255, 255]), `rgb(${right})`);
      // The middle has to be the room rather than more marker, or the two rows above would pass
      // against a page that was simply magenta and cyan all over.
      const middle = meanRgb(frame, '400:400:760:340');
      ok('and the middle is the scene rather than more marker',
        !near(middle, [255, 0, 255]) && !near(middle, [0, 255, 255]), `rgb(${middle})`);

      // Passthrough, against the writer's own log rather than against the other served parts. The
      // version this replaced hashed a part off `sub.parts` and asked whether anything in
      // `sub.parts` hashed to it, so it reduced to "a part arrived" and `--mutate
      // hd-reencodes-in-flight` sailed through the whole section.
      const emittedBodies = new Set((emitted().get(TYPE_COLOR) ?? []).map((e) => e.body).filter(Boolean));
      const strangers = sub.parts.filter((p) => !emittedBodies.has(createHash('sha256').update(p).digest('hex')));
      ok('every served part is the same JPEG the writer emitted',
        emittedBodies.size > 0 && strangers.length === 0,
        `${strangers.length} of ${sub.parts.length} served parts are not in the emit log, `
        + `which logged ${emittedBodies.size} distinct colour bodies`);
      // Every part is byte-identical to every other, because the fixture emits one frame. On a
      // sensor this row would not hold and is not the claim.
      const distinct = new Set(sub.parts.map((p) => createHash('sha256').update(p).digest('hex')));
      ok('and nothing re-encoded it on the way through', distinct.size === 1,
        `${distinct.size} distinct payloads across ${sub.parts.length} parts`);
    }
    sub.stop();
    await stopAll();
  }

  console.log('\n3. the take never learns the webcam exists');
  {
    rmSync(EMIT_LOG, { force: true });
    rmSync(join(WORK, 'takes'), { recursive: true, force: true });
    mkdirSync(join(WORK, 'takes'), { recursive: true });
    await start();
    const sub = subscribe();
    await sub.ready;
    const key = subscribeKey();
    await key.ready;
    await wait(800);

    const started = await post('/record/start');
    ok('a take starts with the webcam attached', started.status === 200, JSON.stringify(started.body));
    await wait(2500);
    const stopped = await post('/record/stop');
    ok('and stops', stopped.status === 200);
    sub.stop();
    await key.stop();
    await wait(400);

    const dir = join(WORK, 'takes');
    const file = execFileSync('sh', ['-c', `ls ${dir}/*.knct 2>/dev/null | head -1`]).toString().trim();
    if (!file) {
      ok('the take was written', false, `nothing in ${dir}`);
    } else {
      const parser = new MessageParser();
      const types = new Map();
      const frameHashes = [];
      for (const msg of parser.push(readFileSync(file))) {
        types.set(msg.type, (types.get(msg.type) ?? 0) + 1);
        if (msg.type === TYPE_FRAME) frameHashes.push(createHash('sha256').update(msg.payload).digest('hex'));
      }
      ok('the take carries a hello and frames', (types.get(TYPE_HELLO) ?? 0) === 1 && frameHashes.length > 10,
        `hello ${types.get(TYPE_HELLO) ?? 0}, frames ${frameHashes.length}`);
      // **The row the mutation has to trip.**
      ok('and carries no colour message at all', !types.has(TYPE_COLOR),
        `${types.get(TYPE_COLOR) ?? 0} colour messages in the take`);
      ok('and nothing but those two types', [...types.keys()].every((t) => t === TYPE_HELLO || t === TYPE_FRAME),
        `types ${[...types.keys()].join(', ')}`);

      // The payload hash here, not the body one: a type 2 frame goes into the file whole, so the
      // payload is what a reader gets and the log's fourth column is a `-` for it.
      const emittedFrames = new Set((emitted().get(TYPE_FRAME) ?? []).map((e) => e.hash));
      const foreign = frameHashes.filter((h) => !emittedFrames.has(h));
      ok('and every frame in it is byte for byte one the writer emitted', foreign.length === 0,
        `${foreign.length} of ${frameHashes.length} frames are not in the emit log`);
    }
    await stopAll();
  }

  console.log('\n4. the origin rule reaches every route serving live sensor bytes');
  {
    await start();
    const table = await api('/library/routes');
    const live = (table.body?.routes ?? []).filter((r) => r.live);
    ok('the table declares at least one live route', live.length > 0,
      live.map((r) => r.path).join(', '));

    // Walked rather than named: an arm that asked about `/camera.mjpg` would test `/camera.mjpg`,
    // and one that walks the table tests the rule.
    for (const route of live) {
      const foreign = await fetch(`http://127.0.0.1:${PORT}${route.path}`, {
        headers: { Origin: 'http://evil.example' },
      });
      ok(`${route.path} refuses a foreign origin`, foreign.status === 403, `status ${foreign.status}`);
      foreign.body?.cancel?.();

      const same = await fetch(`http://127.0.0.1:${PORT}${route.path}`, {
        headers: { Origin: `http://127.0.0.1:${PORT}` },
      });
      ok(`${route.path} allows its own origin`, same.status === 200, `status ${same.status}`);
      same.body?.cancel?.();
    }

    // The webcam says why rather than serving nothing, which is the difference between a setting
    // somebody fixes and a bug somebody files.
    await post('/record/stop').catch(() => {});
    await stopAll();
  }

  console.log('\n5. the program-out page renders at its own size with no furniture');
  if (NO_BROWSER) {
    console.log('  (skipped: --no-browser)');
  } else {
    let chromium = null;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      try {
        const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        ({ chromium } = await import(`file://${join(root, 'playwright/index.mjs')}`));
      } catch { /* reported below */ }
    }
    if (!chromium) {
      untested.push('playwright is not installed, so what the source actually draws was never asked'
        + ' - install playwright, or pass --no-browser and mean it');
    } else {
      await start();
      const browser = await chromium.launch({
        args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader'],
      });
      // Deliberately not 1920x1080: the claim is that the output size comes from the setting rather
      // than from the window, and a window that happened to match would pass whether or not
      // anything worked.
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`http://127.0.0.1:${PORT}/program`);
      await page.waitForTimeout(4000);

      const seen = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        return {
          body: document.body.className,
          panel: getComputedStyle(document.getElementById('panel')).display,
          buffer: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null,
          readout: document.getElementById('programOutReadout')?.textContent ?? '',
          orbit: globalThis.__kinect?.controls?.enabled,
        };
      });

      ok('the page knows it is a source', seen.body.includes('program-out'), seen.body);
      ok('the buffer is the output size and not the window', seen.buffer?.[0] === 1920 && seen.buffer?.[1] === 1080,
        `${seen.buffer?.join('x')} in a 900x600 window`);
      ok('the panel is not in the shot', seen.panel === 'none', seen.panel);
      ok('and orbit cannot fight the pose being pushed to it', seen.orbit === false, String(seen.orbit));
      ok('the readout reports a delivered rate', /(\d+\.\d) fps/.test(seen.readout), seen.readout);
      const fps = Number(/([\d.]+) fps/.exec(seen.readout)?.[1] ?? 0);
      ok('and the source really is drawing', fps > 5, `${fps} fps`);
      ok('with no error on the page', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

      // The operator's two controls, driven from the operator's page - the only place they can be
      // checked, because what they change is a different document.
      const operator = await browser.newPage({ viewport: { width: 900, height: 600 } });
      await operator.goto(`http://127.0.0.1:${PORT}/record`);
      await operator.waitForTimeout(2500);

      // Deliberately not a size anything defaults to, so a buffer that merely stayed put cannot be
      // read as having followed.
      await operator.fill('#progSize', '1280x720');
      await operator.dispatchEvent('#progSize', 'change');
      await operator.selectOption('#progMode', 'mirror');
      await page.waitForTimeout(2500);

      const after = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        return {
          buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          readout: document.getElementById('programOutReadout')?.textContent ?? '',
        };
      });
      ok('setting the size on the operator page resizes the source\'s buffer',
        after.buffer[0] === 1280 && after.buffer[1] === 720, after.buffer.join('x'));
      ok('and switching to mirror reaches the source', after.readout.includes('mirror'),
        after.readout);

      // A parameter write goes through the registry's one write hook rather than a list of
      // forwarded fields, so this row asks whether a parameter added later would arrive without
      // anybody wiring it.
      await operator.evaluate('__kinect.params.set("pointSize", 4.2)');
      await page.waitForTimeout(1200);
      const forwarded = await page.evaluate('__kinect.params.get("pointSize")');
      ok('and a parameter write reaches it through the registry', forwarded === 4.2, String(forwarded));

      // A patch that is half right applies as nothing at all. The old foot walked `patch.params`
      // through `params.set` one name at a time with a catch per entry, so a refused name left the
      // source drawing the new mode against a stale value. Driven at the source's own handler with
      // a name no registry holds.
      const bloomHeld = await page.evaluate('__kinect.params.get("bloom")');
      await page.evaluate(`__kinect.applyProgramOut({ params: {
        bloom: ${JSON.stringify(bloomHeld === 0.25 ? 0.75 : 0.25)}, "a-parameter-no-build-has": 1,
      } })`);
      await page.waitForTimeout(300);
      const bloomAfterBad = await page.evaluate('__kinect.params.get("bloom")');
      ok('a patch carrying one refused parameter applies none of them, so the source never draws half of a frame nobody sent',
        bloomAfterBad === bloomHeld, `bloom ${bloomAfterBad}, held at ${bloomHeld}`);
      // The positive twin: refused and ignored have to be told apart, or this gate is
      // indistinguishable from the params half of the patch being dropped.
      const bloomTarget = bloomHeld === 0.25 ? 0.75 : 0.25;
      await page.evaluate(`__kinect.applyProgramOut({ params: { bloom: ${JSON.stringify(bloomTarget)} } })`);
      await page.waitForTimeout(300);
      const bloomAfterGood = await page.evaluate('__kinect.params.get("bloom")');
      ok('  while a patch that is whole still lands through the registry',
        bloomAfterGood === bloomTarget, `bloom ${bloomAfterGood}, sent ${bloomTarget}`);
      await page.evaluate(`__kinect.applyProgramOut({ params: { bloom: ${JSON.stringify(bloomHeld)} } })`);

      // `params` goes through the registry's write path and is normalised, clamped and refused
      // there; `view` was written straight onto the camera the output frame is drawn with, and four
      // finite numbers are not a rotation. Driven at the source's own handler rather than through
      // the operator's camera: a camera object holds a rotation and `controls.update()`
      // renormalises whatever is written onto it, so the first version of this row read length
      // 1.000000 on both builds.
      const poseBefore = await page.evaluate('__kinect.freeCamera.quaternion.toArray()');
      await page.evaluate(`__kinect.applyProgramOut({ view: {
        position: [9, 9, 9], quaternion: [0, 0, 0, 5], fov: 60,
      } })`);
      await page.waitForTimeout(300);
      const poseAfter = await page.evaluate(`(() => ({
        q: __kinect.freeCamera.quaternion.toArray(),
        p: __kinect.freeCamera.position.toArray(),
      }))()`);
      const len = Math.hypot(...poseAfter.q);
      ok('a pose that is not a rotation is refused at the source rather than drawn with',
        Math.abs(len - 1) < 1e-3 && Math.abs(poseAfter.p[0] - 9) > 1e-6,
        `quaternion length ${len.toFixed(6)} (was ${Math.hypot(...poseBefore).toFixed(6)}), position ${poseAfter.p.map((v) => v.toFixed(2)).join(', ')}`);
      // The positive twin: a build that ignored `view` entirely would pass the row above while
      // breaking the whole mirror mode.
      await page.evaluate(`__kinect.applyProgramOut({ view: {
        position: [1.5, 0.25, 2.5], quaternion: [0, 0, 0, 1], fov: 60,
      } })`);
      await page.waitForTimeout(300);
      const moved = await page.evaluate('__kinect.freeCamera.position.toArray()');
      ok('while a pose that is one still reaches it, so the refusal is a gate rather than the mirror switched off',
        Math.abs(moved[0] - 1.5) < 1e-3 && Math.abs(moved[2] - 2.5) < 1e-3, moved.map((v) => v.toFixed(3)).join(', '));

      await browser.close();
      await stopAll();
    }
  }

  // Every other tool in this repo subscribes over `127.0.0.1` to a server started with no `--host`,
  // so `Webcam.isLoopback` was true by construction and the rule picking out costing subscribers
  // ran against an empty set in every run of every check. This arm makes the object: `--host
  // 0.0.0.0` and a subscriber arriving on this machine's own LAN address. The control plane stays
  // on loopback, because whether a remote caller may press record is section 4's question.
  console.log('\n6. a webcam subscriber that is not on loopback is charged to the take');
  if (!LAN) {
    untested.push('this machine has no non-internal IPv4, so there is no second address a webcam '
      + 'subscriber could arrive on and the refusal had nothing to refuse - run it on a machine '
      + 'with a LAN address');
    console.log('  (skipped: no non-internal IPv4 on this machine)');
  } else {
    await start(['--host', '0.0.0.0']);
    const remote = subscribe(LAN);
    await remote.ready;
    ok('a subscriber on this machine\'s LAN address is served', remote.status === 200, `status ${remote.status} on ${LAN}`);
    await waitFor(async () => ((await api('/record/state')).body?.webcam?.subscribers ?? []).length === 1,
      8000, 'the remote subscriber to appear in the recorder\'s accounting');

    const state = (await api('/record/state')).body;
    ok('and the recorder sees it as crossing the network rather than as loopback',
      state?.webcam?.subscribers?.every((s) => s.loopback === false) === true,
      JSON.stringify(state?.webcam?.subscribers));
    ok('so the take would be refused, with the webcam named as the reason',
      state?.monitors?.wouldRefuse === true
      && (state?.monitors?.costingTheTake ?? []).some((c) => c.kind === 'webcam'),
      JSON.stringify(state?.monitors?.costingTheTake));

    const refused = await post('/record/start');
    // Asserted on the consumer the refusal names, not on the word "webcam": the sentence ends with
    // "detach the webcam" whatever it refused for, so a row reading /webcam/ would pass with
    // the clause deleted.
    ok('and pressing record really is refused, saying which consumer it was',
      refused.status === 409 && String(refused.body?.error ?? '').includes('webcam at the colour camera at full rate'),
      `status ${refused.status}: ${String(refused.body?.error ?? '').slice(0, 90)}`);

    // Stopped unconditionally, because a run where the refusal did not fire has a take open and the
    // positive twin below would then be refused for already recording.
    await post('/record/stop').catch(() => {});

    // The positive twin, and it is not optional: an arm built only out of refusals passes against a
    // server that refuses everything.
    const forced = await post('/record/start', { acceptMonitorCost: true });
    ok('while an operator who accepts the cost can still start the take',
      forced.status === 200, `status ${forced.status}: ${JSON.stringify(forced.body).slice(0, 90)}`);
    await post('/record/stop').catch(() => {});

    remote.stop();
    await stopAll();
  }

  console.log('\n7. the keyed depth is asked for, paired, and stops again');
  {
    rmSync(EMIT_LOG, { force: true });
    await start();
    await wait(1500);
    const before = emitted().get(TYPE_KEY)?.length ?? 0;
    ok('no key message is emitted while nothing is subscribed', before === 0, `${before} emitted`);

    const key = subscribeKey();
    await key.ready;
    const arrived = await waitFor(() => key.pairs.length > 10, 8000, 'more than ten key pairs')
      .then(() => true, () => false);
    const during = emitted().get(TYPE_KEY)?.length ?? 0;
    ok('subscribing asks the grabber for keyed depth', during > 10, `${during} emitted`);
    ok('and paired colour and depth reach the socket', arrived && key.pairs.length > 10,
      `${key.pairs.length} pairs, ${key.errors.length} decode errors`);

    const state = (await api('/record/state')).body;
    ok('the key client is in the recorder\'s own accounting',
      Array.isArray(state?.key?.subscribers) && state.key.subscribers.length === 1,
      JSON.stringify(state?.key?.subscribers));
    const mismatchedStamps = key.pairs.filter((p) => p.colourTs !== p.depthTs);
    ok('every pair keeps the equal colour and depth stamps the fake writer emitted',
      key.pairs.length > 0 && mismatchedStamps.length === 0,
      `${mismatchedStamps.length} of ${key.pairs.length} pairs differ; `
      + `last delta ${key.pairs.length ? key.pairs.at(-1).depthTs - key.pairs.at(-1).colourTs : 'n/a'}ms`);
    ok('a loopback key client does not refuse the take', state?.monitors?.wouldRefuse === false,
      JSON.stringify(state?.monitors?.costingTheTake));

    await key.stop();
    // Past the shared six-second linger. Take the first count after the stop should have landed,
    // then watch another window: a count taken at detach would still include the linger by design.
    await wait(7500);
    const atStop = emitted().get(TYPE_KEY)?.length ?? 0;
    await wait(1500);
    const after = emitted().get(TYPE_KEY)?.length ?? 0;
    ok('leaving stops keyed depth again after the linger', after === atStop, `${atStop} -> ${after}`);
    await stopAll();

    // The loopback row above makes the ordinary proof path cheap. This second arm creates the
    // branch the take refusal is about; without a LAN address the whole tool already ends UNPROVEN
    // in section 6, so this does not turn a missing branch into a pass.
    if (LAN) {
      rmSync(EMIT_LOG, { force: true });
      await start(['--host', '0.0.0.0']);
      const remote = subscribeKey(LAN);
      await remote.ready;
      await waitFor(async () => ((await api('/record/state')).body?.key?.subscribers ?? []).length === 1,
        8000, 'the remote key client to appear in recorder accounting');
      const remoteState = (await api('/record/state')).body;
      ok('a remote key client is charged to the take',
        remoteState?.key?.subscribers?.every((s) => s.loopback === false) === true
        && (remoteState?.monitors?.costingTheTake ?? []).some((c) => c.kind === 'key'),
        JSON.stringify({ subscribers: remoteState?.key?.subscribers, costing: remoteState?.monitors?.costingTheTake }));
      const refused = await post('/record/start');
      ok('and pressing record refuses it by the keyed camera it names',
        refused.status === 409
        && String(refused.body?.error ?? '').includes('key at the keyed colour camera at full rate'),
        `status ${refused.status}: ${String(refused.body?.error ?? '').slice(0, 100)}`);
      // A failed refusal starts a take, so clean it up before the next server regardless of verdict.
      await post('/record/stop').catch(() => {});
      await remote.stop();
      await stopAll();
    }
  }

  console.log('\n8. keyed depth is the 1080p colour-space picture and reaches the client unchanged');
  {
    rmSync(EMIT_LOG, { force: true });
    await start();
    const key = subscribeKey();
    await key.ready;
    const arrived = await waitFor(() => key.pairs.length > 10, 8000, 'key pairs for the depth picture')
      .then(() => true, () => false);
    const pair = key.pairs.at(-1);
    ok('a key pair arrived for the depth picture checks below', arrived && Boolean(pair),
      `${key.pairs.length} pairs, ${key.errors.length} decode errors`);
    if (pair) {
      const [w, h] = dims(pair.depth);
      ok('the key is native 1920x1080 depth, not the 512x424 grid scaled up',
        w === 1920 && h === 1080, `${w}x${h}`);

      const grey = greyOf(pair.depth);
      const sample = (x, y) => grey[y * 1920 + x];
      const expected = {
        left: quantiseDepthMm(1000, pair.rangeM),
        right: quantiseDepthMm(4000, pair.rangeM),
        wall: quantiseDepthMm(3000, pair.rangeM),
      };
      const left = sample(100, 100);
      const right = sample(1820, 100);
      const wall = sample(1200, 100);
      ok('its left margin is the planted 1.0m colour-space reading', Math.abs(left - expected.left) <= 1,
        `${left}, expected ${expected.left}`);
      ok('its right margin is the planted 4.0m colour-space reading', Math.abs(right - expected.right) <= 1,
        `${right}, expected ${expected.right}`);
      ok('and its middle is the planted 3.0m wall rather than another margin', Math.abs(wall - expected.wall) <= 1,
        `${wall}, expected ${expected.wall}`);

      const emittedBodies = new Set((emitted().get(TYPE_KEY) ?? []).map((e) => e.body).filter(Boolean));
      const strangers = key.pairs.filter((p) => !emittedBodies.has(hashOf(p.depth)));
      ok('every served depth JPEG is byte for byte the one the writer emitted',
        emittedBodies.size > 0 && strangers.length === 0,
        `${strangers.length} of ${key.pairs.length} served depths are not in `
        + `${emittedBodies.size} writer bodies`);
      const distinct = new Set(key.pairs.map((p) => hashOf(p.depth)));
      ok('the constant fixture stays one distinct depth payload through the pairer', distinct.size === 1,
        `${distinct.size} distinct payloads across ${key.pairs.length} pairs`);
    }
    await key.stop();
    await stopAll();
  }

  console.log('\n9. the key page writes alpha from the unlevelled crop box and nothing else');
  if (NO_BROWSER) {
    console.log('  (skipped: --no-browser)');
  } else {
    let chromium = null;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      try {
        const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        ({ chromium } = await import(`file://${join(root, 'playwright/index.mjs')}`));
      } catch { /* reported below */ }
    }
    if (!chromium) {
      untested.push('playwright is not installed, so the keyed page\'s alpha was never asked'
        + ' - install playwright, or pass --no-browser and mean it');
    } else {
      await start();
      const browser = await chromium.launch({
        args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader'],
      });
      const operator = await browser.newPage({ viewport: { width: 900, height: 600 } });
      await operator.goto(`http://127.0.0.1:${PORT}/record`);
      await operator.waitForFunction(() => Boolean(globalThis.__kinect?.params));

      // Opened second, so its request for the whole program-out state reaches the operator rather
      // than being broadcast into an empty socket population.
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await page.goto(`http://127.0.0.1:${PORT}/key`);
      await page.waitForFunction(() => Boolean(globalThis.__key));
      const drew = await page.waitForFunction(() => globalThis.__key.frames > 5, null, { timeout: 10000 })
        .then(() => true, () => false);
      ok('the key page receives pairs and draws from them', drew,
        drew ? `${await page.evaluate('__key.frames')} frames` : 'no frame in 10 seconds');

      if (drew) {
        const setFaces = async (values) => {
          const beforeFrames = await page.evaluate('__key.frames');
          await operator.evaluate((next) => {
            for (const [name, value] of Object.entries(next)) globalThis.__kinect.params.set(name, value);
          }, values);
          const watched = Object.fromEntries(Object.entries(values).filter(([name]) => (
            name !== 'tilt' || MUTATE === 'key-tests-after-levelling'
          )));
          await page.waitForFunction((want) => {
            const got = globalThis.__key.faces();
            return Object.entries(want).every(([name, value]) => got[name] === value);
          }, watched);
          await page.waitForFunction((n) => globalThis.__key.frames > n, beforeFrames);
        };
        const shot = async () => {
          const png = await page.locator('#key').screenshot({ omitBackground: true });
          return { png, rgba: rgbaOf(png) };
        };

        await setFaces({ crop: true, near: 0.05, far: 2, left: -7, right: 7, bottom: -7, top: 7, tilt: 0 });
        const base = await shot();
        const pageSize = await page.evaluate('__key.size');
        const [shotW, shotH] = dims(base.png);
        ok('the source canvas and the captured frame are 1920x1080 in a 900x600 window',
          pageSize.w === 1920 && pageSize.h === 1080 && shotW === 1920 && shotH === 1080,
          `canvas ${pageSize.w}x${pageSize.h}, screenshot ${shotW}x${shotH}`);

        const left = rgbaAt(base.rgba, 100, 100);
        const right = rgbaAt(base.rgba, 1820, 100);
        ok('with far at 2.0m the 1.0m left margin is opaque magenta',
          left[3] === 255 && near(left.slice(0, 3), [255, 0, 255]), `rgba(${left})`);
        ok('while the 4.0m right margin is transparent', right[3] === 0, `rgba(${right})`);

        await setFaces({ far: 0.8, tilt: 0 });
        const farCut = await shot();
        const farLeft = rgbaAt(farCut.rgba, 100, 100);
        ok('moving far to 0.8m cuts the 1.0m margin', farLeft[3] === 0, `rgba(${farLeft})`);

        await setFaces({ far: 2, near: 1.2, tilt: 0 });
        const nearCut = await shot();
        const nearLeft = rgbaAt(nearCut.rgba, 100, 100);
        const subject = rgbaAt(nearCut.rgba, 800, 400);
        ok('moving near to 1.2m cuts the 1.0m margin and keeps the 1.5m subject',
          nearLeft[3] === 0 && subject[3] === 255,
          `left rgba(${nearLeft}), subject rgba(${subject})`);

        await setFaces({ near: 0.05, right: 0.5, tilt: 0 });
        const sideCut = await shot();
        const sideLeft = rgbaAt(sideCut.rgba, 100, 100);
        ok('moving right cuts image-left, whose unprojected x is positive', sideLeft[3] === 0,
          `rgba(${sideLeft})`);

        await setFaces({ right: 7, bottom: -0.2, top: 0.2, tilt: 0 });
        const untilted = await shot();
        await setFaces({ tilt: 14 });
        const tilted = await shot();
        ok('turning the room by tilt 14 moves no keyed edge', hashOf(untilted.rgba) === hashOf(tilted.rgba),
          `${hashOf(untilted.rgba).slice(0, 12)} then ${hashOf(tilted.rgba).slice(0, 12)}`);

        const hole = rgbaAt(base.rgba, 960, 540);
        ok('the planted zero-depth hole is transparent rather than treated as the nearest reading',
          hole[3] === 0, `rgba(${hole})`);
        const alpha = new Set();
        for (let i = 3; i < base.rgba.length; i += 4) alpha.add(base.rgba[i]);
        ok('the hard key writes binary alpha at every pixel',
          [...alpha].every((v) => v === 0 || v === 255) && alpha.has(0) && alpha.has(255),
          `alpha levels ${[...alpha].slice(0, 12).join(', ')}`);
        ok('and the page reports no decode error or browser error',
          (await page.evaluate('__key.errors')) === 0 && pageErrors.length === 0,
          `decode ${await page.evaluate('__key.errors')}, page ${pageErrors.slice(0, 2).join(' | ')}`);
      }

      await browser.close();
      await stopAll();
    }
  }
} catch (err) {
  // A run that threw did not finish, and that is a different answer from a claim that failed. Under
  // `--mutate` a harness timeout would otherwise be recorded as the mutation being caught.
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[vcam] ${checked} assertions, ${failed} failed`
  + (NO_BROWSER ? ' - the renderer section was skipped, so what the source draws is untested here' : ''));
if (crashed) {
  console.log(`[vcam] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested.length) {
  for (const reason of untested) console.log(`[vcam] UNPROVEN - ${reason}.`);
  process.exit(2);
}
if (MUTATE) {
  if (MUTATIONS[MUTATE]?.fails) console.log(`[vcam] it should redden: ${MUTATIONS[MUTATE].fails}`);
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed before asserting
  // anything", so the count is what the verdict is made of.
  if (failed === 0) { console.log('[vcam] NOT CAUGHT - the check passed a server it should have rejected'); process.exit(1); }
  console.log(`[vcam] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[vcam] FAIL'); process.exit(1); }
console.log('[vcam] PASS');
process.exit(0);
