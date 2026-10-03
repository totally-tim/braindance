#!/usr/bin/env node
// OBS receives the point-cloud program, the live colour camera, and the colour camera keyed by
// live depth. They have different failure modes, so this file has different arms for them, for the
// take, which records the colour camera and never the key, and for a replay of that take.
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
// rather than passing quietly without one. Section 10 waits out the webcam's whole 45-second hold,
// because nothing shortens it. What it does not prove is OBS: that a browser source
// renders WebGL at 1080p and that OBS samples it at canvas rate require OBS in front of you.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR, TYPE_KEY, encodeMessage } from '../server/protocol.js';
import { COLOUR_FRAME_BYTES } from '../server/library.js';
import { decodePair, quantiseDepthMm } from '../web/key-stream.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8361'));
const MUTATE = flag('--mutate');
const NO_BROWSER = argv.includes('--no-browser');
const WORK = join(REPO, '.vcam-check');
const SOURCE = join(REPO, 'captures', 'sample.knct');
// The linger the two leaving-stops-it rows run the server at, through `testTimer`; it ships at six
// seconds, which `test/on-demand.test.mjs` holds.
const LINGER_MS = 1000;
// Read off the server rather than copied, so section 10 waits out the hold the server really has.
// No flag shortens it, so that section costs the whole of it.
const HOLD_MS = Number(/^const HOLD_MS = (\d+);$/m.exec(readFileSync(join(REPO, 'server/webcam.js'), 'utf8'))?.[1]);
// The sentence a colour-off grabber's webcam answers with, in the response it ends and in the 503.
const COLOUR_OFF = 'colour is off on this grabber, so there is no colour camera to serve';

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

  // A source that reconnects while the operator is still is answered by the server, because a still
  // camera sends nothing. Dropping the held pose from what a connecting page is told leaves that
  // source at its boot camera until the operator moves again.
  'pose-not-held-for-a-late-source': {
    file: 'server/output.js',
    edits: [[
      "      ...(mode === 'mirror' && this.lastView ? [{ view: this.lastView }] : []),",
      '',
    ]],
    fails: 'the row that opens a source page after the operator has orbited and stopped; it adopts '
      + 'the boot pose instead of the one the server is holding',
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

  // The colour message goes to the webcam and never reaches the take, so a take recorded with colour
  // on has no colour camera in it.
  'hd-dropped-from-take': {
    file: 'server/index.js',
    edits: [[
      '    recorder.write(msg.raw);\n  } else if (msg.type === TYPE_KEY) {',
      '  } else if (msg.type === TYPE_KEY) {',
    ]],
    fails: 'section 3\'s colour rows in both arms, and section 10, which has no colour take to replay',
  },

  // The recorder stops asking for the colour camera, so a take carries it only while somebody is
  // watching the webcam: what a take holds would depend on who was looking.
  'recorder-never-asks-for-colour': {
    file: 'server/webcam.js',
    edits: [[
      'count: () => this.subscribers.size + (recording() ? 1 : 0)',
      'count: () => this.subscribers.size',
    ]],
    fails: 'section 3\'s unwatched arm, whose take has no colour, and section 10; the watched arm stays green',
  },

  // The remaining-time rate forgets the colour camera, so a take is sized as depth alone and the
  // refusal to start lets one begin that the disk cannot hold.
  'rate-ignores-colour': {
    file: 'server/index.js',
    edits: [[
      '  if (!camera.color) return observedBytesPerSec;',
      '  return observedBytesPerSec;',
    ]],
    fails: 'section 3\'s two rate rows, before the take and during it',
  },

  // A replay reads the take's colour and never offers the webcam anything.
  'replay-serves-no-colour': {
    file: 'server/index.js',
    edits: [['  replayHasColour = capture.colourCount > 0;', '  replayHasColour = false;']],
    fails: 'section 10\'s three served-colour rows',
  },

  // A replay serves one recorded colour frame over and over: every part is the take's, and only the
  // order row can tell.
  'replay-repeats-one-colour-frame': {
    file: 'server/index.js',
    edits: [['          const colour = await capture.readColour(c);', '          const colour = await capture.readColour(0);']],
    fails: 'section 10\'s order row alone',
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

  // A permanent revocation sets its reason and leaves every open response attached and silent, so
  // OBS sits on its last frame and the refusal counts a stream that sends nothing. The loop alone:
  // the `transient` assignment above it stays, or `attach` stops answering 503 and the positive
  // twin reddens for a reason that is not this defect.
  'revoke-keeps-subscribers': {
    file: 'server/webcam.js',
    edits: [[
      '      if (!transient) sub.res.end(reason);\n      else this.#hold(sub);',
      '      if (transient) this.#hold(sub);',
    ]],
    fails: 'section 10\'s colour-off ended and accounting rows, and the standby accounting row; the 503 '
      + 'row and the restart rows stay green',
  },

  // Every revocation ends its subscribers, the grabber restart included, which is the reconnect
  // storm on every USB drop that the linger exists to avoid.
  'restart-drops-subscribers': {
    file: 'server/webcam.js',
    edits: [[
      '      if (!transient) sub.res.end(reason);\n      else this.#hold(sub);',
      '      sub.res.end(reason);',
    ]],
    fails: 'section 10\'s survives-a-restart row alone; the colour-off rows stay green',
  },

  // A subscriber held through a restart that never comes back stays open for good.
  'hold-never-expires': {
    file: 'server/webcam.js',
    edits: [[
      "      sub.res.end(this.unavailable ?? 'no colour frame arrived before the wait expired');\n",
      '',
    ]],
    fails: 'section 10\'s hold row alone, after the hold and its margin have elapsed',
  },

  // An ended response whose socket has not closed stays in the set until it does, which for a
  // client that stopped reading is never. Only the destroyed half of the reap is left.
  'reap-skips-ended': {
    file: 'server/webcam.js',
    edits: [[
      '      if (s.res.destroyed || s.res.writableEnded) {',
      '      if (s.res.destroyed) {',
    ]],
    fails: 'section 10\'s standby accounting row alone, through the subscriber that stopped reading',
  },

  // A key encoder that runs before anybody asks consumes the same HD thread as the colour camera
  // for every frame. The first row in section 7 asks while no client exists, so no neighbouring
  // assertion has to infer the absence from a later stream.
  'key-runs-unasked': {
    file: 'server/key-stream.js',
    edits: [[
      'this.demand = new OnDemand({ request, count: () => this.demandCount });',
      'this.demand = new OnDemand({ request, count: () => 1 });\n    this.demand.settle();',
    ]],
    fails: 'section 7\'s first row, which reads type 4 at the writer before any key client exists',
  },

  // The socket is attached and receives the acknowledgement, but the demand edge never reaches
  // the grabber. The run must finish and name the absent type 4 stream rather than time out.
  'key-never-asks': {
    file: 'server/key-stream.js',
    edits: [[
      '    this.demand.settle();\n    this.#sendStatus(ws);',
      '    this.#sendStatus(ws);',
    ]],
    fails: 'the section 7 writer and pair rows, section 8 pair precondition, and section 9 drawing precondition',
  },

  'unavailable-key-costs-the-take': {
    file: 'server/key-stream.js',
    edits: [[
      'return this.unavailable ? [] : this.describe().filter((c) => !c.loopback);',
      'return this.describe().filter((c) => !c.loopback);',
    ]],
    fails: 'the unavailable remote subscription and depth-only recording rows in section 7',
  },

  'depth-only-take-gets-live-data': {
    file: 'server/index.js',
    edits: [['    recorder.write(msg.raw);\n  } else if (msg.type === TYPE_COLOR) {',
      '    recorder.write(camera.color ? msg.raw : Buffer.concat([msg.raw,\n'
      + '      Buffer.from([0x54, 0x43, 0x4e, 0x4b, 4, 0, 0, 0, 1, 0, 0, 0, 0])]));\n  } else if (msg.type === TYPE_COLOR) {']],
    fails: 'the depth-only file census row in section 7',
  },

  'key-recovery-is-not-announced': {
    file: 'server/key-stream.js',
    edits: [['    for (const ws of this.clients.keys()) this.#sendStatus(ws);', '']],
    fails: 'the source recovery row in section 9',
  },

  'key-outage-keeps-picture': {
    file: 'web/key-frames.js',
    edits: [['    this.clear();', '    // The mutation leaves the last framebuffer visible.']],
    fails: 'the outage clear and late-decode transparency rows in section 9',
  },

  'key-decode-survives-outage': {
    file: 'web/key-frames.js',
    edits: [['    this.generation++;', '    // The mutation lets an obsolete decode finish.']],
    fails: 'the late-decode transparency row in section 9',
  },

  'operator-reconnect-keeps-old-framing': {
    file: 'server/index.js',
    edits: [['  sendOutput(ws);', '  // The mutation omits restoration.']],
    fails: 'the socket reconnect and operator reload rows in section 9',
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

  // The webcam's twin of the control below, on Webcam's own drop rather than the shared class.
  'webcam-linger-never-fires': {
    file: 'server/webcam.js',
    edits: [[
      '      console.log(`[webcam] subscriber gone (${this.subscribers.size} left)`);\n'
      + '      this.demand.settle();\n',
      '      console.log(`[webcam] subscriber gone (${this.subscribers.size} left)`);\n',
    ]],
    fails: 'section 1\'s leaving-stops-it row alone, after the shortened linger has elapsed',
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
    fails: 'section 7\'s leaving-stops-it row alone, after the shortened linger has elapsed',
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
    fails: 'section 3\'s row that permits only hello, frame and colour messages in a take',
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
if (!(HOLD_MS > 0)) {
  console.error('server/webcam.js no longer declares `const HOLD_MS = <ms>;` - section 10 cannot know how long to wait');
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
const start = async (extra = [], { timers = null, source = SOURCE, grabberArgs = [] } = {}) => {
  const log = await new Promise((resolve, reject) => {
    const grabber = [join(WORK, 'tools/fake-grabber.mjs'), '--source', source, '--fps', '30', '--hd',
      '--key', '--emit-log', EMIT_LOG, ...grabberArgs].join(' ');
    const child = spawn(process.execPath, [
      join(WORK, 'server/index.js'), '--standby-after', '0', '--port', String(PORT),
      '--captures', join(WORK, 'takes'), '--grabber', grabber, ...extra,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: timers ? { ...process.env, BRAINDANCE_TEST_TIMERS: JSON.stringify(timers) } : process.env,
    });
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
        // What followed the last whole part, less that part's closing CRLF: the server's sentence
        // when it ended the stream.
        state.tail = buf.toString('utf8').trim();
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
    await start([], { timers: { linger: LINGER_MS } });
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
    await wait(LINGER_MS + 1500);
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

  console.log('\n3. a take recorded with colour on carries the colour camera, whoever is watching');
  // The file's messages by type, and the payload hashes of its frames and colour messages.
  const census = (file) => {
    const types = new Map();
    const hashes = { [TYPE_FRAME]: [], [TYPE_COLOR]: [] };
    const colourStamps = [];
    for (const msg of new MessageParser().push(readFileSync(file))) {
      types.set(msg.type, (types.get(msg.type) ?? 0) + 1);
      if (msg.type in hashes) hashes[msg.type].push(hashOf(msg.payload));
      if (msg.type === TYPE_COLOR) colourStamps.push(Number(msg.payload.readBigUInt64LE(0)));
    }
    return { types, hashes, colourStamps };
  };
  const emittedPayloads = (type) => new Set((emitted().get(type) ?? []).map((e) => e.hash));
  const takeFile = (id) => join(WORK, 'takes', `${id}.knct`);
  // The capture routes answer under the take's content hash, so an id resolves through the listing.
  const takeHash = async (id) =>
    (await api('/library/takes')).body?.takes?.find((take) => take.id === id)?.hash;
  // Kept for section 10, which replays it.
  let colourTake = null;
  {
    // Nothing attached: the only thing that can ask the grabber for colour is the recorder.
    rmSync(EMIT_LOG, { force: true });
    rmSync(join(WORK, 'takes'), { recursive: true, force: true });
    mkdirSync(join(WORK, 'takes'), { recursive: true });
    await start();
    // Past one five-second window, so the rate below is measured rather than the boot figure.
    await wait(5600);
    const idle = (await api('/record/state')).body;
    const idleHealth = (await api('/sensor/health')).body;
    const colourShare = idle?.storage?.bytesPerSec - idleHealth?.bytesPerSec;
    const expectedShare = idleHealth?.fps * COLOUR_FRAME_BYTES;
    ok('before a take, with colour on and nothing flowing, the remaining-time rate counts one colour frame per depth frame',
      idleHealth?.fps > 0 && Math.abs(colourShare - expectedShare) <= 1,
      `${(colourShare / 1e6).toFixed(2)}MB/s over ${(idleHealth?.bytesPerSec / 1e6).toFixed(2)}MB/s of depth at ${idleHealth?.fps?.toFixed(1)}fps, `
      + `expected ${(expectedShare / 1e6).toFixed(2)}MB/s`);

    const started = await post('/record/start');
    ok('a take starts with nothing watching', started.status === 200, JSON.stringify(started.body));
    // Long enough that the last window to close lies wholly inside the take.
    await wait(10500);
    const during = (await api('/record/state')).body;
    const duringHealth = (await api('/sensor/health')).body;
    const hdEmitted = (emitted().get(TYPE_COLOR) ?? []).length;
    const measuredShare = during?.storage?.bytesPerSec - duringHealth?.bytesPerSec;
    const fixtureShare = duringHealth?.fps * (readFileSync(EMIT_LOG, 'utf8').split('\n')
      .map((line) => line.split(' ')).find(([type]) => Number(type) === TYPE_COLOR)?.[1] ?? 0);
    ok('and while it records, the rate counts the colour the take is actually writing',
      hdEmitted > 0 && measuredShare > 0.5 * fixtureShare && measuredShare < 1.5 * fixtureShare,
      `${(measuredShare / 1e6).toFixed(2)}MB/s of colour counted, ${(fixtureShare / 1e6).toFixed(2)}MB/s at one fixture frame per depth frame`);
    const stopped = await post('/record/stop');
    ok('and stops', stopped.status === 200);
    await wait(400);

    const file = takeFile(started.body?.takeId);
    if (!started.body?.takeId || !existsSync(file)) {
      ok('the unwatched take was written', false, `nothing at ${file}`);
    } else {
      colourTake = file;
      const { types, hashes, colourStamps } = census(file);
      const colourCount = types.get(TYPE_COLOR) ?? 0;
      ok('it carries the colour camera although nobody was subscribed', colourCount > 10,
        `${colourCount} colour messages beside ${types.get(TYPE_FRAME) ?? 0} frames`);
      const foreign = hashes[TYPE_COLOR].filter((h) => !emittedPayloads(TYPE_COLOR).has(h));
      ok('and every colour message in it is byte for byte one the writer emitted', colourCount > 0 && foreign.length === 0,
        `${foreign.length} of ${colourCount} are not in the emit log`);
      ok('with stamps that only rise', colourStamps.every((t, k) => k === 0 || t > colourStamps[k - 1]),
        `${colourStamps.length} stamps`);
      const index = (await api(`/capture/${await takeHash(started.body.takeId)}/index`)).body;
      ok('and the index lists those colour messages apart from the frames',
        index?.colour?.offset?.length === colourCount && index?.frames?.offset?.length === (types.get(TYPE_FRAME) ?? 0),
        `index: ${index?.frames?.offset?.length} frames, ${index?.colour?.offset?.length} colour; file: `
        + `${types.get(TYPE_FRAME) ?? 0} and ${colourCount}`);
    }
    await stopAll();
  }
  {
    // The webcam and a key page attached, so type 3 and type 4 both flow: the take takes one of them.
    rmSync(EMIT_LOG, { force: true });
    await start();
    const sub = subscribe();
    await sub.ready;
    const key = subscribeKey();
    await key.ready;
    await wait(800);

    const started = await post('/record/start');
    ok('a take starts with the webcam and a key page attached', started.status === 200, JSON.stringify(started.body));
    await wait(2500);
    const stopped = await post('/record/stop');
    ok('and stops', stopped.status === 200);
    sub.stop();
    await key.stop();
    await wait(400);

    const file = takeFile(started.body?.takeId);
    if (!started.body?.takeId || !existsSync(file)) {
      ok('the watched take was written', false, `nothing at ${file}`);
    } else {
      const { types, hashes } = census(file);
      ok('the take carries a hello and frames', (types.get(TYPE_HELLO) ?? 0) === 1 && hashes[TYPE_FRAME].length > 10,
        `hello ${types.get(TYPE_HELLO) ?? 0}, frames ${hashes[TYPE_FRAME].length}`);
      ok('and the colour camera', (types.get(TYPE_COLOR) ?? 0) > 10, `${types.get(TYPE_COLOR) ?? 0} colour messages`);
      // **The row `key-reaches-recorder` has to trip.**
      ok('and nothing but those three types - no keyed depth', [...types.keys()].every((t) => [TYPE_HELLO, TYPE_FRAME, TYPE_COLOR].includes(t)),
        `types ${[...types.keys()].join(', ')}`);
      // The payload hash, not the body one: a message goes into the file whole.
      const foreignFrames = hashes[TYPE_FRAME].filter((h) => !emittedPayloads(TYPE_FRAME).has(h));
      ok('and every frame in it is byte for byte one the writer emitted', foreignFrames.length === 0,
        `${foreignFrames.length} of ${hashes[TYPE_FRAME].length} frames are not in the emit log`);
      const foreignColour = hashes[TYPE_COLOR].filter((h) => !emittedPayloads(TYPE_COLOR).has(h));
      ok('and so is every colour message', hashes[TYPE_COLOR].length > 0 && foreignColour.length === 0,
        `${foreignColour.length} of ${hashes[TYPE_COLOR].length} colour messages are not in the emit log`);
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

      const sourceLinks = await operator.evaluate(() => {
        const note = document.getElementById('progNote');
        return {
          hasDot: note.textContent.includes('·'),
          labels: [...note.querySelectorAll('.prog-source-label')].map((label) => label.textContent),
          links: [...note.querySelectorAll('a')].map((link) => ({
            text: link.textContent,
            href: link.href,
            target: link.target,
            noopener: link.relList.contains('noopener'),
          })),
        };
      });
      const sourceUrls = ['/program', '/camera.mjpg', '/key']
        .map((path) => `http://127.0.0.1:${PORT}${path}`);
      const clickedSources = [];
      if (sourceLinks.links.length === sourceUrls.length) {
        await operator.evaluate(() => {
          globalThis.__proofSourceClicks = [];
          document.getElementById('progNote').addEventListener('click', (event) => {
            const link = event.target.closest('a');
            if (!link) return;
            event.preventDefault();
            globalThis.__proofSourceClicks.push(link.href);
          });
        });
        for (let i = 0; i < sourceUrls.length; i++) {
          await operator.locator('#progNote a').nth(i).click();
        }
        clickedSources.push(...await operator.evaluate('globalThis.__proofSourceClicks'));
      }
      ok('the operator note exposes all three source URLs as links that leave the controls open',
        !sourceLinks.hasDot
          && sourceLinks.labels.join('|') === 'browser source:|webcam:|keyed webcam:'
          && sourceLinks.links.length === sourceUrls.length
          && sourceLinks.links.every((link, i) => link.text === sourceUrls[i]
            && link.href === sourceUrls[i] && link.target === '_blank' && link.noopener)
          && clickedSources.every((href, i) => href === sourceUrls[i])
          && clickedSources.length === sourceUrls.length,
        JSON.stringify({ ...sourceLinks, clickedSources }));

      const sourceCopyButtons = await operator.evaluate(() => (
        [...document.querySelectorAll('#progNote button')].map((button) => ({
          text: button.textContent,
          label: button.getAttribute('aria-label'),
          after: button.previousElementSibling?.tagName ?? null,
          icon: button.querySelector('svg')?.outerHTML ?? null,
          path: button.querySelector('path')?.getAttribute('d') ?? null,
          left: button.getBoundingClientRect().left,
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
        }))
      ));
      const copiedSources = [];
      if (sourceCopyButtons.length === sourceUrls.length) {
        await operator.evaluate(() => {
          globalThis.__proofSourceCopies = [];
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (value) => { globalThis.__proofSourceCopies.push(value); },
            },
          });
        });
        for (let i = 0; i < sourceUrls.length; i++) {
          await operator.locator('#progNote button').nth(i).click();
        }
        copiedSources.push(...await operator.evaluate('globalThis.__proofSourceCopies'));
      }
      const sourceCopyFeedback = await operator.evaluate(() => (
        [...document.querySelectorAll('#progNote button')].map((button) => ({
          state: button.dataset.state,
          label: button.getAttribute('aria-label'),
          path: button.querySelector('path')?.getAttribute('d') ?? null,
        }))
      ));
      const copyLefts = sourceCopyButtons.map((button) => button.left);
      ok('an aligned icon button after each source link copies that exact URL without leaving the operator page',
        sourceCopyButtons.length === sourceUrls.length
          && sourceCopyButtons.every((button, i) => button.text === '' && button.icon
            && button.label === `Copy ${['browser source', 'webcam', 'keyed webcam'][i]} link`
            && button.after === 'A' && button.width <= 24 && button.height <= 24)
          && Math.max(...copyLefts) - Math.min(...copyLefts) <= 0.5
          && copiedSources.every((href, i) => href === sourceUrls[i])
          && copiedSources.length === sourceUrls.length
          && sourceCopyFeedback.every((feedback, i) => feedback.state === 'copied'
            && feedback.label === `${['browser source', 'webcam', 'keyed webcam'][i]} link copied`
            && feedback.path !== sourceCopyButtons[i].path)
          && operator.url() === `http://127.0.0.1:${PORT}/record`,
        JSON.stringify({ sourceCopyButtons, copiedSources, sourceCopyFeedback }));

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

      await page.evaluate(() => __kinect.applyProgramOut({ preset: {
        version: __kinect.library.PROJECT_VERSION, requires: [], values: { exposure: 1.8 },
      } }));
      ok('a source applies a preset through the stored-preset door',
        await page.evaluate('__kinect.params.get("exposure")') === 1.8);

      // What an OBS restart looks like: the source reconnects on its own schedule and an operator who
      // has stopped moving sends nothing more, because a still camera sends nothing at all. The
      // operator is moved and left still, so only what the server holds can answer the page that
      // arrives next, and the answer is compared against the operator rather than a constant.
      await operator.evaluate('(() => { const k = globalThis.__kinect;'
        + ' k.freeCamera.position.set(2.4, 1.2, -3.1); k.controls.update(16); })()');
      await operator.waitForTimeout(1500);
      const held = await operator.evaluate('__kinect.freeCamera.position.toArray()');
      const late = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const lateErrors = [];
      late.on('pageerror', (err) => lateErrors.push(err.message));
      await late.goto(`http://127.0.0.1:${PORT}/program`);
      await late.waitForTimeout(2500);
      const adopted = await late.evaluate(`(() => ({
        position: globalThis.__kinect.freeCamera.position.toArray(),
        readout: document.getElementById('programOutReadout').textContent,
      }))()`);
      const off = Math.hypot(...adopted.position.map((v, i) => v - held[i]));
      ok('a source that connects while the operator is still draws where the operator left the camera',
        off < 1e-2 && adopted.readout.includes('mirror'),
        `${(off * 1000).toFixed(1)} mm off, ${adopted.readout.trim()}`);
      ok('and the page that arrived late has no error of its own', lateErrors.length === 0, lateErrors.slice(0, 2).join(' | '));
      await late.close();

      await operator.reload();
      await operator.waitForFunction(() => globalThis.__kinect?.params.get('pointSize') === 4.2, null, { timeout: 5000 }).catch(() => {});
      ok('record boot adopts the server output mode and size',
        await operator.inputValue('#progMode') === 'mirror' && await operator.inputValue('#progSize') === '1280x720'
        && await operator.evaluate('__kinect.params.get("pointSize")') === 4.2);

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
    await start([], { timers: { linger: LINGER_MS } });
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
    // Past the shared linger. Take the first count after the stop should have landed, then watch
    // another window: a count taken at detach would still include the linger by design.
    await wait(LINGER_MS + 1500);
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
      let depthOnlyHello = false;
      remote.socket.on('message', (bytes, binary) => {
        if (binary) return;
        try { const h = JSON.parse(bytes.toString()); if (h.serial && h.color === false) depthOnlyHello = true; }
        catch { /* binary and malformed input are counted by subscribeKey */ }
      });
      remote.socket.send(JSON.stringify({ camera: { color: false } }));
      await waitFor(() => depthOnlyHello, 25000, 'the depth-only grabber to handshake');
      const unavailable = (await api('/record/state')).body;
      ok('an unavailable remote key stays attached without charging the take',
        unavailable.key.available === false && unavailable.key.subscribers.some((c) => !c.loopback)
        && !unavailable.monitors.costingTheTake.some((c) => c.kind === 'key'));
      const started = await post('/record/start');
      ok('a depth-only take starts with that remote key still attached', started.status === 200,
        `status ${started.status}: ${JSON.stringify(started.body)}`);
      if (started.status === 200) {
        await waitFor(async () => (await api('/record/state')).body.frames > 5, 8000, 'depth-only recorded frames');
        await post('/record/stop');
        const file = join(WORK, 'takes', `${started.body.takeId}.knct`);
        const records = new MessageParser().push(readFileSync(file));
        const frames = records.filter((m) => m.type === TYPE_FRAME);
        ok('the resulting take contains depth-only frames, and no colour camera or keyed depth',
          frames.length > 5 && frames.every((m) => m.payload.readUInt32LE(4) === 0)
          && records.every((m) => m.type === TYPE_HELLO || m.type === TYPE_FRAME),
          `${frames.length} depth frames, types ${[...new Set(records.map((m) => m.type))]}`);
      }
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
      await operator.addInitScript(() => {
        const Socket = WebSocket;
        globalThis.WebSocket = class extends Socket {
          constructor(...args) { super(...args); globalThis.__proofSocket = this; }
        };
      });
      await operator.goto(`http://127.0.0.1:${PORT}/record`);
      await operator.waitForFunction(() => Boolean(globalThis.__kinect?.params));

      // Opened second so its frames arrive at a page that is already watching, and so the operator's
      // socket is one of the clients the server can broadcast to while this one is being driven.
      const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));
      await page.addInitScript(() => {
        const decode = createImageBitmap;
        globalThis.__heldKeyBitmaps = [];
        globalThis.__holdKeyDecode = false;
        globalThis.createImageBitmap = async (...args) => {
          const hold = globalThis.__holdKeyDecode;
          const bitmap = await decode(...args);
          if (!hold) return bitmap;
          return new Promise((resolve) => globalThis.__heldKeyBitmaps.push(() => resolve(bitmap)));
        };
      });
      await page.goto(`http://127.0.0.1:${PORT}/key`);
      await page.waitForFunction(() => Boolean(globalThis.__key));
      const drew = await page.waitForFunction(() => globalThis.__key.frames > 5, null, { timeout: 10000 })
        .then(() => true, () => false);
      ok('the key page receives pairs and draws from them', drew,
        drew ? `${await page.evaluate('__key.frames')} frames` : 'no frame in 10 seconds');

      if (drew) {
        const setFaces = async (values) => {
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
          const beforeFrames = await page.evaluate('__key.frames');
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

        await setFaces({ far: 2, bottom: -7, top: 7, tilt: 0 });
        await operator.evaluate(() => {
          globalThis.__proofSocket.close();
          globalThis.__kinect.params.set('far', 4);
        });
        const resynced = await operator.waitForFunction(() => __kinect.params.get('far') === 2, null, { timeout: 5000 })
          .then(() => true, () => false);
        ok('socket reconnect restores the server framing over an unsent local edit', resynced && await page.evaluate('__key.faces().far === 2'),
          `key far ${await page.evaluate('__key.faces().far')}, server far 2`);
        await operator.reload();
        await operator.waitForFunction(() => globalThis.__kinect?.params.get('far') === 2, null, { timeout: 5000 }).catch(() => {});
        const ownerFar = await operator.evaluate('__kinect.params.get("far")');
        const reloaded = await page.waitForFunction((far) => __key.faces().far === far, ownerFar, { timeout: 5000 })
          .then(() => true, () => false);
        ok('operator reload adopts the framing held by the server', reloaded && ownerFar === 2,
          `key far ${await page.evaluate('__key.faces().far')}, operator far ${ownerFar}`);

        await setFaces({ far: 2 });
        await page.evaluate(() => { globalThis.__holdKeyDecode = true; });
        await page.waitForFunction(() => __heldKeyBitmaps.length >= 2);
        await operator.locator('#colorCam').click();
        await page.waitForFunction(() => __key.lastColourTs === null, null, { timeout: 3000 });
        const empty = (rgba) => { for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false; return true; };
        const framesAtOutage = await page.evaluate('__key.frames');
        const outage = await shot();
        ok('colour off clears every pixel of the keyed output to transparent', empty(outage.rgba));
        await page.evaluate(() => {
          globalThis.__holdKeyDecode = false;
          globalThis.__heldKeyBitmaps.splice(0).forEach((release) => release());
        });
        await page.waitForTimeout(150);
        const afterDecode = await shot();
        ok('an old decode finishing after the outage cannot repaint the person', empty(afterDecode.rgba)
          && (await page.evaluate('__key.frames')) === framesAtOutage);
        const beforeRecovery = await page.evaluate('__key.frames');
        await operator.locator('#colorCam').click();
        const recovered = await page.waitForFunction((n) => __key.frames > n + 2, beforeRecovery, { timeout: 25000 })
          .then(() => true, () => false);
        const recovery = await shot();
        ok('colour returning restores the keyed picture on the same page', recovered
          && rgbaAt(recovery.rgba, 100, 100)[3] === 255 && rgbaAt(recovery.rgba, 1820, 100)[3] === 0);
      }

      await browser.close();
      await stopAll();
    }
  }

  console.log('\n10. a replayed take serves the colour camera it recorded, and no key');
  {
    // A server replaying `file`, with no grabber. Up when it answers, which in replay is after the
    // take has been indexed.
    const replay = async (file) => {
      const child = spawn(process.execPath, [
        join(WORK, 'server/index.js'), '--standby-after', '0', '--port', String(PORT),
        '--captures', join(WORK, 'replay-caps'), '--replay', file,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      servers.push(child);
      let log = '';
      child.stdout.on('data', (c) => { log += c; });
      child.stderr.on('data', (c) => { log += c; });
      await waitFor(() => /frames indexed|contains no frames|cannot open/.test(log), 20000, 'the replay to index its take');
    };
    if (!colourTake) {
      ok('section 3 left a colour take to replay', false, 'it did not');
    } else {
      mkdirSync(join(WORK, 'replay-caps'), { recursive: true });
      // Each colour frame numbered after its end-of-image marker, so a part served says which frame
      // it is: the fixture writes one picture over and over, and order would otherwise be invisible.
      const numbered = [];
      const colourless = [];
      const bodies = new Map();
      let seq = 0;
      for (const msg of new MessageParser().push(readFileSync(colourTake))) {
        if (msg.type !== TYPE_COLOR) {
          numbered.push(msg.raw);
          colourless.push(msg.raw);
          continue;
        }
        const payload = Buffer.alloc(msg.payload.length + 4);
        msg.payload.copy(payload);
        payload.writeUInt32LE(seq, msg.payload.length);
        bodies.set(hashOf(payload.subarray(8)), seq++);
        numbered.push(encodeMessage(TYPE_COLOR, payload));
      }
      const numberedFile = join(WORK, 'replay-colour.knct');
      const colourlessFile = join(WORK, 'replay-colourless.knct');
      writeFileSync(numberedFile, Buffer.concat(numbered));
      writeFileSync(colourlessFile, Buffer.concat(colourless));

      await replay(numberedFile);
      const sub = subscribe();
      await sub.ready;
      await wait(3000);
      ok('/camera.mjpg on a replayed colour take answers and serves parts', sub.status === 200 && sub.parts.length > 10,
        `status ${sub.status}, ${sub.parts.length} parts`);
      const served = sub.parts.map((p) => bodies.get(hashOf(p)));
      ok('and every part is a colour frame the take holds, byte for byte',
        served.length > 0 && served.every((n) => n !== undefined),
        `${served.filter((n) => n === undefined).length} of ${served.length} parts are not in the take`);
      // One wrap is allowed, because the replay loops.
      const backwards = served.filter((n, k) => k > 0 && !(n > served[k - 1])).length;
      ok('in the order the take holds them', served.length > 10 && backwards <= 1,
        `${backwards} steps back or standing in ${served.length} parts: ${served.slice(0, 12).join(' ')}`);
      const state = (await api('/record/state')).body;
      ok('while the key refuses on a replay and names the keyed depth a take does not carry',
        state?.key?.available === false && /keyed depth/.test(state?.key?.unavailable ?? ''),
        JSON.stringify(state?.key?.unavailable));
      sub.stop();
      await stopAll();

      await replay(colourlessFile);
      const refused = await fetch(`http://127.0.0.1:${PORT}/camera.mjpg`, { signal: AbortSignal.timeout(8000) })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .catch((err) => ({ status: 0, text: err.message }));
      ok('a replayed take with no colour refuses /camera.mjpg and says the take carries none',
        refused.status === 503 && /carries no colour camera frames/.test(refused.text),
        `${refused.status} ${refused.text.slice(0, 120)}`);
      await stopAll();
    }
  }

  // A revocation either ends the webcam's subscribers or holds them, decided by whether a grabber
  // is coming back. Ending on a restart makes OBS reconnect on every USB drop; holding on colour off
  // leaves a response nothing will ever write to, still charged to the take.
  console.log('\n11. a revoked webcam ends its subscribers unless the picture is coming back');
  {
    // Every spawn exits after 150 frames and reads the capture through a link this section removes,
    // so the first respawn comes back and none after the link has gone can.
    const link = join(WORK, 'once', 'sample.knct');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(SOURCE, link);
    rmSync(EMIT_LOG, { force: true });
    const log = await start([], { source: link, grabberArgs: ['--die-after', '150'] });
    const exits = () => (log().match(/\[server\] grabber exited/g) ?? []).length;
    const sub = subscribe();
    await sub.ready;
    await waitFor(() => sub.parts.length > 10, 8000, 'parts before the grabber exits');
    await waitFor(() => exits() > 0, 30000, 'the grabber to exit after 150 frames');
    const atExit = sub.parts.length;
    const back = await waitFor(async () => (await api('/record/state')).body?.webcam?.available === true,
      30000, 'the respawned grabber to handshake').then(() => true, () => false);
    await waitFor(() => sub.done || sub.parts.length > atExit + 10, 15000, 'parts after the respawn').catch(() => {});
    ok('a subscriber survives a grabber restart and is served parts again on the same response',
      back && !sub.done && sub.parts.length > atExit + 10,
      `${atExit} parts at the exit, ${sub.parts.length} after${sub.done ? `; ended with "${sub.tail}"` : ''}`);

    rmSync(link);
    const before = exits();
    await waitFor(() => exits() > before, 30000, 'the last grabber that can read its capture to exit');
    const lostAt = Date.now();
    const ended = await waitFor(() => sub.done, HOLD_MS + 20000, 'the hold to end the subscriber')
      .then(() => true, () => false);
    const heldS = ((Date.now() - lostAt) / 1000).toFixed(1);
    const left = (await api('/record/state')).body?.webcam?.subscribers ?? null;
    ok(`a subscriber whose grabber never comes back is ended by the ${HOLD_MS / 1000}s hold, saying why, `
      + 'and leaves the accounting',
    ended && /^the (sensor|grabber) is /.test(sub.tail ?? '') && left?.length === 0,
    `${ended ? `ended ${heldS}s after the last exit with "${sub.tail}"` : `still open ${heldS}s after the last exit`}; `
      + `subscribers ${JSON.stringify(left)}`);
    sub.stop();
    await stopAll();

    rmSync(EMIT_LOG, { force: true });
    await start();
    const reading = subscribe();
    await reading.ready;
    await waitFor(() => reading.parts.length > 10, 8000, 'parts for the reading subscriber');

    // The way the operator page turns colour off.
    const control = new WebSocket(`ws://127.0.0.1:${PORT}`);
    let depthOnly = false;
    control.on('message', (bytes, binary) => {
      if (binary) return;
      try { const h = JSON.parse(bytes.toString()); if (h.serial && h.color === false) depthOnly = true; }
      catch { /* not a hello */ }
    });
    await new Promise((resolve, reject) => { control.once('open', resolve); control.once('error', reject); });
    control.send(JSON.stringify({ camera: { color: false } }));

    const closed = await waitFor(() => reading.done, 5000, 'colour off to end the response')
      .then(() => true, () => false);
    ok('colour off ends a subscriber\'s response, with the reason as its last bytes',
      closed && (reading.tail ?? '').includes(COLOUR_OFF),
      closed ? `ended with "${reading.tail}"` : `still open 5s after colour went off, ${reading.parts.length} parts`);
    let after = null;
    await waitFor(async () => {
      after = (await api('/record/state')).body?.webcam?.subscribers ?? null;
      return after?.length === 0;
    }, 3000, 'the accounting to empty').catch(() => {});
    ok('and it is no longer in the recorder\'s accounting', after?.length === 0, `subscribers ${JSON.stringify(after)}`);

    // After the depth-only hello, because the exit between says "the grabber is restarting".
    await waitFor(() => depthOnly, 25000, 'the depth-only grabber to handshake');
    const fresh = await fetch(`http://127.0.0.1:${PORT}/camera.mjpg`);
    // A 200 here is a stream that never ends, so only a refusal is read to the end.
    const refusal = fresh.status === 503 ? await fresh.json().catch(() => null) : null;
    if (fresh.status !== 503) await fresh.body?.cancel();
    ok('while a new request is answered 503 with the same reason', fresh.status === 503 && refusal?.error === COLOUR_OFF,
      `status ${fresh.status}: ${JSON.stringify(refusal)}`);

    control.close();
    reading.stop();
    await stopAll();

    // A client that sends its request and never reads: its response cannot finish, so its socket
    // never closes and only the reap takes an ended one out of the set. Colour off in standby,
    // because on a running grabber the exit that follows ends the response a second time, and the
    // write-after-end error that raises prunes it whether or not the reap does.
    await start();
    const stalled = connect(PORT, '127.0.0.1');
    stalled.on('error', () => {});
    stalled.write(`GET /camera.mjpg HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n\r\n`);
    // Stuck, not merely slow: the kernel buffers grow before they fill, so a write can finish late
    // and the response then closes on its own. Stuck is two whole seconds of frames dropped, at a
    // floor of 10 a second so a contended fixture below its 30fps still counts.
    let attached = null;
    const behind = async () => {
      attached = (await api('/record/state')).body?.webcam?.subscribers ?? null;
      return attached?.length === 1 ? attached[0].behind : -1;
    };
    let stuck = false;
    let streak = 0;
    let last = await behind();
    for (const until = Date.now() + 30000; !stuck && Date.now() < until;) {
      await wait(1000);
      const now = await behind();
      streak = last >= 0 && now - last >= 10 ? streak + 1 : 0;
      stuck = streak >= 2;
      last = now;
    }
    // The positive twin of the reap: a subscriber that is stuck but open is still a subscriber.
    ok('a subscriber that stops reading stays in the accounting, dropping every frame, while nothing has ended it',
      stuck, JSON.stringify(attached));
    const standby = await post('/sensor/standby');
    const off = await post('/sensor/camera', { color: false });
    const inStandby = (await api('/record/state')).body?.webcam?.subscribers ?? null;
    ok('colour off in standby takes it out of the accounting while its socket is still open',
      standby.status === 200 && off.status === 200 && inStandby?.length === 0 && !stalled.destroyed,
      `standby ${standby.status}, colour off ${off.status}, subscribers ${JSON.stringify(inStandby)}`);
    stalled.destroy();
    await stopAll();
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
