#!/usr/bin/env node
// Step 9: the monitor negotiates decimation on the live socket, and a take never pays for it. The
// finding it exists for is that a connected viewer degrades the capture itself - backpressure from
// a link that cannot carry 14.6 MB/s reaches back through the server's stdin pipe into the grabber,
// which then misses USB deadlines and drops depth packets, and those frames never reach the file.
//
// Four claims. The negotiation is honest, so what is granted is what is sent and the setting on
// screen is the setting on the wire. It is one mechanism: a socket frame at divisor k is
// byte-identical to the same frame from the HTTP frame API, because both call `decimatePayload`. A
// decimated frame renders as the same scene, coarser - which nothing here asked for two steps,
// while a divisor-4 block went into the head of a 512x424 texture and 93.8% of it held the previous
// full-rate frame. And the take is untouched, checked against the writer's own log rather than
// against anything a reader produced.
//
// Nothing caps a running stream, because an instrument that silently rescales is worse than none:
// `/record/start` refuses instead and takes `acceptMonitorCost` from an operator who means it.
// Every refusal here has a positive twin, because a check built only out of refusals passes against
// a server that refuses everything.
//
// It spawns its own servers and needs none running; the stream is `tools/fake-grabber.mjs`. Section
// 5 needs a GPU browser and `--no-browser` drops it. What it does not prove is the sensor half:
// that a decimated monitor stops the grabber dropping USB packets is a measurement on the node with
// the hardware attached.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MessageParser, TYPE_HELLO, TYPE_FRAME } from '../server/protocol.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8341'));
const MUTATE = flag('--mutate');
// Section 5 needs a GPU browser and is the only section that does. `--no-browser` drops it and says
// so in the verdict rather than passing quietly: a claim nobody tested here is not a
// claim that held.
const NO_BROWSER = argv.includes('--no-browser');
const WORK = join(REPO, '.monitor-check');
const SOURCE = join(REPO, 'captures', 'sample.knct');
// The live recorder, which `/` served until the main menu took that path. The menu page defines no
// `__kinect`, so a stale root here would read as the viewer never coming up rather
// than as a wrong URL.
const RECORDER_URL = `http://127.0.0.1:${PORT}/record`;

// Each names source text and must match exactly once. A replacement matching nothing would run the
// unmutated server and be recorded as this check having missed a bug it was never shown.
const MUTATIONS = {
  // It leaks into the recorder and nowhere else: decimating at the top of `handleMessage` corrupts
  // the socket too, fails section 1's first row, and aborts the run before it reaches a take.
  'decimate-reaches-recorder': { file: 'server/index.js', edits: [[
    '    recorder.write(msg.raw);',
    "    recorder.write(encodeMessage(TYPE_FRAME, decimatePayload(msg.payload, 4, 'leak')));",
  ]] },
  'stride-ignored': { file: 'server/index.js', edits: [[
    '    if (frameSeq % m.stride !== 0) continue;',
    '    if (false) continue;',
  ]] },
  'divisor-ignored': { file: 'server/index.js', edits: [[
    '        out = decimatePayload(payload, m.divisor, `frame ${frameSeq}`);',
    '        out = payload;',
  ]] },
  // Anchored on the grant echo rather than the refusal one above it, because silencing the refusal
  // path reddens a different claim. And it reorders the echo rather than deleting it: with no send
  // at all the harness waits for a message that is not coming and the run ends as DID NOT RUN with
  // its own timeout among the failures.
  'grant-not-echoed': { file: 'server/index.js', edits: [[
    '      m.divisor = nextDivisor;\n'
    + '      m.stride = nextStride;\n'
    + '      m.granted = true;\n'
    + '      sendMonitor(ws);',
    '      sendMonitor(ws);\n'
    + '      m.divisor = nextDivisor;\n'
    + '      m.stride = nextStride;\n'
    + '      m.granted = true;',
  ]] },
  'start-never-refuses': { file: 'server/index.js', edits: [[
    '  if (costly.length && body.acceptMonitorCost !== true) {',
    '  if (false) {',
  ]] },
  // The mutation a refusal-only check cannot see: it makes the product useless and every "it
  // refused" assertion in this file still passes.
  'refuse-ignores-loopback': { file: 'server/index.js', edits: [[
    'const costsTheTake = (m) => !m.loopback && m.granted && (m.divisor < RECORDING_CAP.divisor || m.stride < RECORDING_CAP.stride);',
    'const costsTheTake = (m) => m.granted && (m.divisor < RECORDING_CAP.divisor || m.stride < RECORDING_CAP.stride);',
  ]] },
  'remote-default-eligible': { file: 'server/index.js', edits: [[
    '  const loopback = isLoopback(req);\n  monitors.set(ws, loopback\n    ? { divisor: 1, stride: 1, loopback: true, granted: true }\n    : { divisor: RECORDING_CAP.divisor, stride: RECORDING_CAP.stride, loopback: false, granted: false });',
    '  const loopback = isLoopback(req);\n  monitors.set(ws, { divisor: 1, stride: 1, loopback, granted: true });',
  ]] },
  // Zero is the interesting one: `frameSeq % 0` is NaN, so a stride of 0 sends nothing at all and
  // reads as a dead sensor.
  'accept-any-setting': { file: 'server/index.js', edits: [[
    'const whole = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);',
    'const whole = (v, max) => (typeof v === \'number\' ? v : null);',
  ]] },
  'bind-ignores-grid': { file: 'web/gpu-textures.js', edits: [[
    '  expandDepth(data, selected.depthCurr.image.data);',
    '  selected.depthCurr.image.data.set(data);',
  ]] },
  'expand-shifts-by-a-block': { file: 'web/gpu-textures.js', edits: [[
    'for (let col = 0; col < DEPTH_W; col++) dst[to + col] = src[from + ((col / grid.k) | 0)];',
    'for (let col = 0; col < DEPTH_W; col++) dst[to + col] = src[from + Math.min(grid.w - 1, (((col / grid.k) | 0) + 1))];',
  ]] },
  // Replaced with a comment rather than deleted, so the branch keeps its shape and only the
  // statement under test goes away. It reddens the `hasColor` row after the toggle
  // and nothing else.
  'colour-off-keeps-the-texture': { file: 'web/main.js', edits: [[
    '        if (!msg.color) uniforms.hasColor.value = 0;',
    '        // the hello said colour is off, and this build does nothing about it',
  ]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// A mutation applied in place and restored afterwards leaves a mutated working tree behind any
// crash, which is the one state a proof tool must never produce.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(join(REPO, 'server'), join(WORK, 'server'), { recursive: true });
cpSync(join(REPO, 'tools'), join(WORK, 'tools'), { recursive: true });
// `web/` is copied rather than linked because two of the mutations below are in `main.js`, and
// through a symlink they would rewrite the repo's own source silently - the staged tree is deleted
// at the end of every run.
cpSync(join(REPO, 'web'), join(WORK, 'web'), { recursive: true });
// `effects-builtin` is staged for a different reason than the three above: the effect store refuses
// to boot without its shipped root, so a staged tree missing it is a server that never comes up and
// this tool then says `DID NOT RUN` rather than failing a row. Copied rather than linked on the
// same argument `web/` is.
cpSync(join(REPO, 'effects-builtin'), join(WORK, 'effects-builtin'), { recursive: true });
for (const name of ['node_modules', 'vendor', 'captures']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(WORK, name));
}
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const path = join(WORK, spec.file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated server`);
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

let checked = 0, failed = 0;
// Set when a claim could not be tested here at all, which is a third answer and not a quiet pass.
let untested = null;
// Set when the run threw rather than when a claim failed. Separate from `failed` so the verdict can
// say the harness did not run instead of counting its own timeout as a caught mutation.
let crashed = null;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const servers = [];
const start = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(WORK, 'server/index.js'), '--standby-after', '0', '--port', String(PORT), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  const log = [];
  const onData = (c) => {
    log.push(c.toString());
    if (log.join('').includes('viewer on')) setTimeout(() => resolve(() => log.join('')), 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = async () => {
  for (const c of servers) c.kill('SIGKILL');
  servers.length = 0;
  await wait(150);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A monitor: opens the socket, optionally negotiates, and records what arrives. It keeps every
 * binary frame's length and the JSON it was told, because the whole question is whether those two
 * agree. Frames are counted from the moment the setting was granted rather than from connect, so
 * frames already in flight under the previous setting cannot be read as the new one
 * failing to apply.
 */
function monitor(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const state = { name, ws, frames: [], grants: [], since: 0, open: false };
  ws.on('message', (data, isBinary) => {
    // The declared depth length rather than the message length, for the reason `DEPTH_FULL` sets
    // out - the colour half is a JPEG and moves on its own.
    if (isBinary) { state.frames.push(depthOf(data)); return; }
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.monitor) state.grants.push(msg.monitor);
  });
  state.ready = new Promise((resolve, reject) => {
    ws.on('open', () => { state.open = true; resolve(state); });
    ws.on('error', reject);
  });
  // Frames seen since the last `mark()`, which is what every rate row measures over.
  state.mark = () => { state.since = state.frames.length; };
  state.seen = () => state.frames.slice(state.since);
  // Resolves to null rather than throwing when no answer comes back. A server that applies a
  // setting and says nothing is a real failure mode - it is what `grant-not-echoed` plants - and it
  // has to fail the row about being told, not abort the run before any later row gets to speak.
  state.ask = async (monitorPatch) => {
    const before = state.grants.length;
    ws.send(JSON.stringify({ monitor: monitorPatch }));
    try {
      await waitFor(() => state.grants.length > before, 2500, 'the server to answer a setting request');
      return state.grants.at(-1);
    } catch {
      return null;
    }
  };
  state.close = () => { try { ws.terminate(); } catch { /* already gone */ } };
  return state;
}

const waitFor = async (cond, ms, what = 'condition') => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await wait(30);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};

/**
 * Waits until the page has published what the section about to run reaches through, and throws
 * naming what never arrived.
 *
 * Not a fixed sleep: `waitUntil: 'load'` stopped meaning the page is up when the effect packages
 * moved onto the wire, because boot fetches every one of them behind the module's own top-level
 * await - measured at 366ms to `load` against 398ms to the handle, on loopback with a
 * warm page cache.
 *
 * Every clause a caller hands this is written to be false on a page that has not booted rather than
 * to throw on one, and `Boolean` is what reads `?.`'s `undefined` as false: a predicate raising a
 * TypeError inside `waitFor` is not caught by it, so the seconds the wait was given are never
 * spent. A caller asks for what its own section reaches rather than for the earliest thing that
 * happens to be there - `__kinect` existing does not say the socket has connected.
 *
 * The two decimation sections let the throw out, so the catch at the bottom records a run that
 * threw as DID NOT RUN; the colour section catches it and puts it on a row, because it is the one
 * place where "the page never booted" and "colour never arrived" are two different findings. What
 * it waited out is printed rather than asserted, because a page is up when it is up and the number
 * is what says how much headroom a slower machine has left.
 */
const published = async (page, reaches, what, ms = 20000) => {
  const began = Date.now();
  await waitFor(
    // Caught rather than let out: an evaluate landing while the page is still navigating rejects
    // with a destroyed execution context, which is a page that is not up yet rather than an
    // answer about one.
    () => page.evaluate(`Boolean(${reaches})`).catch(() => false),
    ms,
    what,
  );
  console.log(`  ....  waited ${Date.now() - began}ms after load for ${what}`);
};

// The full chromium build rather than the bundled headless shell, for `export-check`'s reason: the
// shell has no GPU and falls back to SwiftShader.
async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const roots = [];
  try {
    const { execFileSync } = await import('node:child_process');
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }
  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(`file://${req.resolve(join(root, name))}`));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  return null;
}

const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const get = (path) => fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => r.json());

/** Every message in a take file, parsed back out of the bytes on disk. */
function readTake(path) {
  const parser = new MessageParser();
  const out = { hello: null, frames: [] };
  for (const msg of parser.push(readFileSync(path))) {
    if (msg.type === TYPE_HELLO) out.hello ??= Buffer.from(msg.payload);
    else if (msg.type === TYPE_FRAME) out.frames.push(Buffer.from(msg.payload));
  }
  return out;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The writer's own record of what it put on stdout: `type length sha256`. */
const readEmitLog = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
  const [type, length, hash] = line.split(' ');
  return { type: Number(type), length: Number(length), hash };
});

// The depth block, which is the only fixed quantity a frame has. The colour block is a JPEG, so a
// full frame off the sample ranges over 485,869 to 492,860 bytes and no two are alike - comparing
// totals would mean a tolerance band that cannot tell a divisor-2 frame from a busy JPEG. The
// declared depth length is exact, is what the divisor changes, and is read out of the
// frame's own header.
const DEPTH_FULL = 512 * 424 * 2;
const depthAt = (k) => Math.ceil(512 / k) * Math.ceil(424 / k) * 2;
const depthOf = (buf) => buf.readUInt32LE(0);

// `--grabber` is one space-separated string, so the writer and its arguments arrive as a single
// flag. The staged copy under `WORK` rather than the repo's, so a mutation of `server/` is what the
// grabber's own import resolves against too.
const streamer = (extra = '') => ['--grabber',
  `${join(WORK, 'tools/fake-grabber.mjs')} --source ${SOURCE} --fps 30 ${extra}`.trim()];

try {
  console.log(`[monitor] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}\n`);
  ok('the fixture this check measures against is here', existsSync(SOURCE),
    existsSync(SOURCE) ? '' : `${SOURCE} is missing - run tools/make-fixture.js`);
  if (!existsSync(SOURCE)) throw new Error('no sample capture to stream');

  console.log('[monitor] what the server grants is what it sends');
  const caps = join(WORK, 'caps-1');
  mkdirSync(caps, { recursive: true });
  await start([...streamer(),
    '--captures', caps, '--name', 'negotiate', '--projects', join(WORK, 'p1'), '--presets', join(WORK, 'q1')]);

  const a = await monitor('a').ready;
  await waitFor(async () => a.frames.length > 5, 8000, 'the first frames to arrive');
  ok('a monitor is told its setting on connect without asking', a.grants.length >= 1,
    JSON.stringify(a.grants[0] ?? null));
  ok('and it starts at full rate - the default is the honest one, since a coarse default would be a downgrade nobody chose',
    a.grants[0]?.divisor === 1 && a.grants[0]?.stride === 1);
  ok('a full-rate frame carries the whole depth grid', a.frames.every((n) => n === DEPTH_FULL),
    `${[...new Set(a.frames)].join('/')} against ${DEPTH_FULL}`);

  // The divisor, measured on the wire rather than read off the label.
  for (const k of [2, 4, 8]) {
    const grant = await a.ask({ divisor: k });
    ok(`asking for depth ÷${k} is granted, and answered`, grant?.divisor === k, JSON.stringify(grant));
    a.mark();
    await wait(600);
    const seen = a.seen();
    ok(`and the frames that arrive are ÷${k} frames - the label is not the claim, the bytes are`,
      seen.length > 0 && seen.every((n) => n === depthAt(k)),
      `${seen.length} frames, depth ${[...new Set(seen)].join('/')}, expected ${depthAt(k)}`);
  }

  // The stride, counted as a ratio against a full-rate monitor watching the same stream, so a slow
  // machine cannot fail this by delivering fewer frames overall.
  const pacer = await monitor('pacer').ready;
  await a.ask({ divisor: 1, stride: 3 });
  a.mark(); pacer.mark();
  await wait(2000);
  const strided = a.seen().length, fullRate = pacer.seen().length;
  ok('a stride of 3 delivers about a third of what a full-rate monitor beside it sees',
    strided > 0 && fullRate > 0 && Math.abs(strided / fullRate - 1 / 3) < 0.12,
    `${strided} against ${fullRate} = ${(strided / Math.max(1, fullRate)).toFixed(3)}`);
  ok('and the full-rate monitor beside it is unaffected - one client\'s setting is its own',
    fullRate > 20, `${fullRate} frames in 2s`);

  // Refusals, each with the setting surviving unchanged: a validator that reset the setting on a
  // bad value would be a second way to downgrade a monitor silently.
  await a.ask({ divisor: 4, stride: 2 });
  for (const bad of [{ divisor: 0 }, { divisor: 17 }, { divisor: 2.5 }, { divisor: 'four' }, { stride: 0 }, { stride: 99 }]) {
    const grant = await a.ask(bad);
    ok(`${JSON.stringify(bad)} is refused with a reason`, Boolean(grant?.refused),
      grant ? (grant.refused ?? 'accepted') : 'no answer at all');
    ok('and the setting it had is still the setting it has', grant?.divisor === 4 && grant?.stride === 2,
      grant ? `÷${grant.divisor} ×${grant.stride}` : 'no answer at all');
  }
  a.mark();
  await wait(600);
  const afterBad = a.seen();
  ok('and the wire still carries the setting that survived, not the ones that were refused',
    afterBad.length > 0 && afterBad.every((n) => n === depthAt(4)),
    `depth ${[...new Set(afterBad)].join('/')}, expected ${depthAt(4)}`);

  a.close(); pacer.close();
  await stopAll();

  console.log('\n[monitor] the socket and the frame API decimate identically, because they are one function');
  const caps2 = join(WORK, 'caps-2');
  mkdirSync(caps2, { recursive: true });
  await start(['--replay', SOURCE, '--captures', caps2, '--name', 'onemech',
    '--projects', join(WORK, 'p2'), '--presets', join(WORK, 'q2')]);
  // A replay server serves the same file it streams, so a frame can be fetched over HTTP and
  // watched on the socket and the two compared byte for byte.
  const viaHttp = {};
  for (const k of [1, 4]) {
    const res = await fetch(`http://127.0.0.1:${PORT}/capture/sample/frame/7?decimate=${k}`);
    viaHttp[k] = Buffer.from(await res.arrayBuffer());
  }
  ok('the frame API answers a full frame and a ÷4 one',
    depthOf(viaHttp[1]) === DEPTH_FULL && depthOf(viaHttp[4]) === depthAt(4),
    `depth ${depthOf(viaHttp[1])} and ${depthOf(viaHttp[4])}`);
  ok('and the ÷4 frame is smaller in exactly the depth block, colour untouched',
    viaHttp[4].readUInt32LE(4) === viaHttp[1].readUInt32LE(4),
    `${viaHttp[4].readUInt32LE(4)} colour bytes against ${viaHttp[1].readUInt32LE(4)}`);

  // Matching on the stamp rather than on arrival order is what makes this a comparison of the same
  // moment rather than of two neighbours.
  const b = await monitor('b').ready;
  await b.ask({ divisor: 4 });
  const bodies = [];
  b.ws.on('message', (data, isBinary) => { if (isBinary) bodies.push(Buffer.from(data)); });
  const wantStamp = viaHttp[4].readBigUInt64LE(8);
  await waitFor(async () => bodies.some((f) => f.readBigUInt64LE(8) === wantStamp), 12000,
    'the socket to deliver the frame the API was asked for');
  const fromSocket = bodies.find((f) => f.readBigUInt64LE(8) === wantStamp);
  ok('the same frame at ÷4 is byte-identical off the socket and off the frame API',
    fromSocket.equals(viaHttp[4]), `${sha(fromSocket).slice(0, 12)} against ${sha(viaHttp[4]).slice(0, 12)}`);
  b.close();
  await stopAll();

  console.log('\n[monitor] a monitor never costs the take a byte');
  const recDir = join(WORK, 'caps-3');
  mkdirSync(recDir, { recursive: true });
  const emitLog = join(WORK, 'emitted.log');
  writeFileSync(emitLog, '');
  await start([...streamer(`--emit-log ${emitLog}`),
    '--captures', recDir, '--name', 'shooting', '--record',
    '--projects', join(WORK, 'p3'), '--presets', join(WORK, 'q3')]);

  // Watching coarsely, so the recorder is running with a decimating monitor attached - the only
  // configuration in which the leak this row is about can happen.
  const watcher = await monitor('watcher').ready;
  const watchGrant = await watcher.ask({ divisor: 4, stride: 3 });
  ok('a monitor is watching the take at ÷4 ×3', watchGrant?.divisor === 4 && watchGrant?.stride === 3,
    JSON.stringify(watchGrant));
  await waitFor(async () => watcher.frames.length > 4, 8000, 'decimated frames to arrive');
  ok('and it really is receiving decimated frames while the take runs',
    watcher.frames.length > 0 && watcher.frames.every((n) => n === depthAt(4)),
    `depth ${[...new Set(watcher.frames)].join('/')}, expected ${depthAt(4)}`);

  await waitFor(async () => (await get('/record/state')).frames > 40, 20000, 'the take to gather frames');
  const stopped = await post('/record/stop');
  ok('the take stops cleanly', stopped.status === 200, JSON.stringify(stopped.body).slice(0, 80));
  watcher.close();
  await wait(400);

  const takes = readdirSync(recDir).filter((f) => f.endsWith('.knct'));
  ok('exactly one take was written', takes.length === 1, takes.join(', '));
  const take = readTake(join(recDir, takes[0]));
  const emitted = readEmitLog(emitLog);
  const emittedFrames = emitted.filter((e) => e.type === TYPE_FRAME);

  ok('the take carries frames', take.frames.length > 20, `${take.frames.length} frames`);
  // The identity: every frame in the file is a frame the writer logged putting on stdout, so a
  // recorder handed a decimated buffer fails here even though the file would still
  // parse, index and play.
  const emittedHashes = new Set(emittedFrames.map((e) => e.hash));
  const strangers = take.frames.filter((f) => !emittedHashes.has(sha(f)));
  ok('every frame on disk is byte for byte a frame the grabber emitted, with a monitor watching decimated throughout',
    strangers.length === 0,
    strangers.length ? `${strangers.length} of ${take.frames.length} frames are not in the writer's log; `
      + `first declares ${depthOf(strangers[0])} depth bytes where a full frame declares ${DEPTH_FULL}`
      : `${take.frames.length} frames matched`);
  // The blunt second reading, because a hash set answers "is it one of them" and not "is it the
  // right size". A leak changes the length, and saying so names the bug.
  ok('and every one of them carries the full depth grid rather than a decimated one',
    take.frames.every((f) => depthOf(f) === DEPTH_FULL),
    `depth ${[...new Set(take.frames.map(depthOf))].join('/')} against ${DEPTH_FULL}`);
  ok('the take is in order and contiguous in the writer\'s log, so this is the stream rather than a lucky subset',
    (() => {
      const idx = take.frames.map((f) => emittedFrames.findIndex((e) => e.hash === sha(f)));
      return idx.every((v, i) => v >= 0 && (i === 0 || v === idx[i - 1] + 1));
    })(), `${take.frames.length} frames`);
  await stopAll();

  console.log('\n[monitor] a take refuses to start under a monitor that would cost it frames');
  const recDir4 = join(WORK, 'caps-4');
  mkdirSync(recDir4, { recursive: true });
  await start([...streamer(),
    '--captures', recDir4, '--name', 'refusing', '--host', '0.0.0.0',
    '--projects', join(WORK, 'p4'), '--presets', join(WORK, 'q4')]);

  // The positive twin first, and deliberately: a check that opened with the refusal would pass
  // against a server that refused everything.
  const idle = await post('/record/start');
  ok('with nothing watching, a take starts', idle.status === 200 && idle.body.armed === true,
    JSON.stringify(idle.body).slice(0, 90));
  await post('/record/stop');

  const local = await monitor('loopback').ready;
  await waitFor(async () => local.frames.length > 2, 8000, 'the loopback monitor to receive frames');
  const withLocal = await post('/record/start');
  ok('a full-rate monitor on loopback does not refuse it - its frames never cross the link the refusal is about',
    withLocal.status === 200 && withLocal.body.armed === true,
    JSON.stringify(withLocal.body).slice(0, 90));
  await post('/record/stop');
  local.close();
  await wait(200);

  // The refusal needs a monitor that is genuinely off-machine, so this arrives on the LAN address
  // rather than on loopback.
  const { networkInterfaces } = await import('node:os');
  const LAN = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
  ok('this machine has a second address, so "over the network" is a thing a monitor can be', Boolean(LAN),
    LAN ?? 'no non-internal IPv4');

  if (LAN) {
    const remote = new WebSocket(`ws://${LAN}:${PORT}/`, { headers: { Origin: `http://${LAN}:${PORT}` } });
    const grants = [];
    let binaryBeforeGrant = 0;
    let framesAfterGrant = 0;
    remote.on('message', (data, isBinary) => {
      if (isBinary) {
        const last = grants.at(-1);
        if (!last || !last.granted) binaryBeforeGrant++;
        else framesAfterGrant++;
        return;
      }
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.monitor) grants.push(msg.monitor);
    });
    await new Promise((res, rej) => { remote.on('open', res); remote.on('error', rej); });
    await waitFor(async () => grants.length > 0, 4000, 'the remote monitor to be told its setting');
    const cap = grants[0].cap;
    ok('a monitor arriving over the network is told it is not on loopback', grants[0].loopback === false,
      JSON.stringify(grants[0]));
    ok('and it starts ungranted, with the cap as the ordinary proposal',
      grants[0].granted === false
        && grants[0].divisor === cap.divisor
        && grants[0].stride === cap.stride,
      JSON.stringify(grants[0]));

    const state = await get('/record/state');
    ok('the record surface says the same thing over HTTP, so the button can warn before it is pressed',
      state.monitors?.wouldRefuse === false && state.monitors.costingTheTake.length === 0,
      JSON.stringify(state.monitors));

    ok('no binary frame arrives before the client has requested and been granted a setting',
      binaryBeforeGrant === 0);

    // Twin one: a finer request is refused, and the grant is not silently clamped - an accept-only
    // check on the request would let the same monitor record after being refused.
    remote.send(JSON.stringify({ monitor: { divisor: 1, stride: 1 } }));
    await waitFor(async () => grants.length > 1, 4000, 'the finer refusal').catch(() => false);
    ok('a finer request from a remote monitor is refused without changing the grant',
      grants[1]?.granted === false
        && grants[1]?.divisor === 1
        && grants[1]?.stride === 1
        && /would cost/.test(String(grants[1]?.refused ?? '')),
      JSON.stringify(grants[1]));
    ok('and still no binary frames arrive', binaryBeforeGrant === 0);

    // Twin two: the cap is the ordinary initial grant, and recording works.
    remote.send(JSON.stringify({ monitor: { divisor: 4, stride: 3 } }));
    await waitFor(async () => grants.at(-1)?.granted === true, 4000, 'the cap grant').catch(() => false);
    ok('the cap is granted and answered',
      grants.at(-1)?.granted === true
        && grants.at(-1)?.divisor === cap.divisor
        && grants.at(-1)?.stride === cap.stride,
      JSON.stringify(grants.at(-1)));
    ok('coarsened to the cap, the same monitor no longer blocks it', grants.at(-1)?.wouldRefuseRecording === false);
    await waitFor(async () => framesAfterGrant > 0, 4000, 'a frame after the cap grant');
    const coarse = await post('/record/start');
    ok('and the take starts', coarse.status === 200 && coarse.body.armed === true,
      JSON.stringify(coarse.body).slice(0, 90));
    await post('/record/stop');

    // Twin three: a finer setting is reachable only when the client explicitly accepts the cost,
    // and the take still refuses until the operator does too.
    remote.send(JSON.stringify({ monitor: { divisor: 1, stride: 1, acceptMonitorCost: true } }));
    await waitFor(async () => grants.at(-1)?.divisor === 1 && grants.at(-1)?.stride === 1,
      4000, 'the costly grant').catch(() => false);
    ok('a remote monitor that explicitly accepts cost is granted the finer setting',
      grants.at(-1)?.granted === true && grants.at(-1)?.wouldRefuseRecording === true,
      JSON.stringify(grants.at(-1)));

    // Counted before the attempt rather than compared against an empty directory: the positive
    // twins above deliberately recorded, so "no take exists" would be asserting that
    // those rows failed.
    const takesBefore = readdirSync(recDir4).filter((f) => f.endsWith('.knct')).length;
    const refused = await post('/record/start');
    ok('and the take refuses, naming the cost rather than a status', refused.status === 409
      && /costs? the take frames/.test(refused.body.error ?? ''), (refused.body.error ?? '').slice(0, 110));
    ok('and nothing was armed by the attempt', (await get('/record/state')).armed === false);
    const takesAfter = readdirSync(recDir4).filter((f) => f.endsWith('.knct')).length;
    ok('and no take file was opened by it', takesAfter === takesBefore,
      `${takesBefore} takes before, ${takesAfter} after`);

    const forced = await post('/record/start', { acceptMonitorCost: true });
    ok('and an operator who accepts the cost in as many words gets the take',
      forced.status === 200 && forced.body.armed === true, JSON.stringify(forced.body).slice(0, 90));
    await post('/record/stop');
    try { remote.terminate(); } catch { /* already gone */ }
  }
  await stopAll();

  // The claim this file made for four sections and never once tested: every row above watches the
  // server - what it grants, what it puts on the wire, what it writes to disk - and not one asks
  // what happens to those bytes after a client has them. Two questions, and they are separate: does
  // an arriving frame reach the whole grid, and does each of its samples land on the ray it was
  // measured on. `bind-ignores-grid` and `expand-shifts-by-a-block` are one control each, so a
  // red row says which.
  if (NO_BROWSER) {
    console.log('\n[monitor] --no-browser: the renderer section did not run, so its claims are untested here');
  } else {
    console.log('\n[monitor] a decimated frame renders as the same scene, coarser');
    // Not an assertion, because a missing browser is not a finding: as a failed row it would count
    // toward `failed`, and the verdict below reads any non-zero `failed` on a mutation run as the
    // mutation having been caught - so a machine without playwright would record every control here
    // as caught while testing none.
    const pw = await loadPlaywright();
    if (!pw) untested = 'playwright is not installed, so nothing here drove a renderer';
    if (pw) {
      // A server with no grabber for the exact rows: nothing arrives, so an injected frame is the
      // only thing that ever touches the textures. The sample is linked in so the frame API can
      // serve it, and into `caps-5` rather than the repo's own directory so the sidecar the first
      // open builds is deleted with the staged tree.
      mkdirSync(join(WORK, 'caps-5'), { recursive: true });
      symlinkSync(SOURCE, join(WORK, 'caps-5', 'sample.knct'));
      await start(['--captures', join(WORK, 'caps-5'), '--name', 'render',
        '--projects', join(WORK, 'p5'), '--presets', join(WORK, 'q5')]);
      const browser = await pw.chromium.launch({ channel: 'chromium', headless: true });
      const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(RECORDER_URL, { waitUntil: 'load' });
      // The door and the texture every row below reads back through, rather than the handle they
      // hang off. Nothing waits out a duration beside it, because this server was started with no
      // grabber at all - so a timeout here is a page that never booted rather than a frame that
      // landed in the wrong place, and it is left to throw.
      await published(page,
        'typeof globalThis.__kinect?.drive?.injectDepth === "function"'
        + ' && Boolean(globalThis.__kinect?.uniforms?.depthCurr?.value?.image?.data)',
        'the viewer to publish the depth door and the texture it writes into');

      // The expectation is computed from the same index by the reader rather than from anything the
      // door produced, so a wrong mapping has nothing to agree with. 65535 is beyond the 9000mm the
      // grabber clips at, so a real frame can never forge it.
      const EXACT = `(opts) => {
        const { k, DW, DH } = opts;
        const w = Math.ceil(DW / k), h = Math.ceil(DH / k);
        const f = (i) => (i % 60000) + 1;
        const drive = globalThis.__kinect.drive;
        // Twice, because the door alternates two textures and one wipe reaches only
        // one of them - which is exactly why the stale half of this bug survived
        // every frame that followed it rather than being overwritten next arrival.
        drive.injectDepth(new Uint16Array(DW * DH).fill(65535));
        drive.injectDepth(new Uint16Array(DW * DH).fill(65535));
        const src = new Uint16Array(w * h);
        for (let i = 0; i < src.length; i++) src[i] = f(i);
        let refused = null;
        try { drive.injectDepth(src); } catch (err) { refused = err.message; }
        const dst = globalThis.__kinect.uniforms.depthCurr.value.image.data;
        let sentinel = 0, misplaced = 0, firstBad = null;
        for (let row = 0; row < DH; row++) {
          for (let col = 0; col < DW; col++) {
            const got = dst[row * DW + col];
            if (got === 65535) sentinel++;
            const want = f(((row / k) | 0) * w + ((col / k) | 0));
            if (got !== want) {
              misplaced++;
              if (!firstBad) firstBad = { col, row, got, want };
            }
          }
        }
        return { w, h, samples: src.length, sentinel, misplaced, firstBad, refused, of: DW * DH };
      }`;

      // Every divisor the socket and the frame API accept, not a sample of them: a build that
      // handled 4 and dropped a row at 3 is the bug wearing a fix's clothes.
      for (const k of [1, 2, 3, 4, 5, 7, 8, 11, 16]) {
        const r = await page.evaluate(`(${EXACT})(${JSON.stringify({ k, DW: 512, DH: 424 })})`);
        ok(`a ÷${k} frame (${r.w}x${r.h}, ${r.samples} samples) leaves no texel of the grid unwritten`,
          r.sentinel === 0 && !r.refused,
          r.refused ? `refused: ${r.refused}` : `${r.sentinel} of ${r.of} still hold the sentinel`);
        ok(`and every texel of it carries the sample measured on that texel's own ray`,
          r.misplaced === 0,
          r.misplaced ? `${r.misplaced} of ${r.of} misplaced, first at col ${r.firstBad.col} row ${r.firstBad.row}: `
            + `${r.firstBad.got} where the sample for that ray is ${r.firstBad.want}` : '');
      }

      // A length that is no divisor's grid is refused rather than written into the head of the
      // texture, which is the general form of the bug: the old door took whatever it was handed,
      // because `TypedArray.set` only objects to a source that is too long.
      const odd = await page.evaluate(`(${`() => {
        try { globalThis.__kinect.drive.injectDepth(new Uint16Array(1234)); return null; }
        catch (err) { return err.message; }
      }`})()`);
      ok('a depth block on no grid at all is refused, loudly, rather than half-written',
        typeof odd === 'string' && /divisor/.test(odd), odd ?? 'it was accepted');

      // The same frame at four divisors, so nothing in the room moved between the arms and sampling
      // is the only thing that differs. The sentinel wipe before each arm is what makes it sharp:
      // without it a broken build keeps the previous arm's full grid in the 93.8% it cannot reach,
      // and the centroid of a cloud that is mostly the right answer is the right answer - 0.233
      // against 0.224, which no tolerance worth having would separate.
      const SAME_FRAME = `async (opts) => {
        const kin = globalThis.__kinect;
        const DW = 512, DH = 424;
        const fx = kin.uniforms.focal.value.x, fy = kin.uniforms.focal.value.y;
        const cx = kin.uniforms.center.value.x, cy = kin.uniforms.center.value.y;
        // No near/far clip here on purpose: the clip is a viewer setting, and a row
        // about where a sample lands should not move when somebody drags a slider.
        const measure = () => {
          const d = kin.uniforms.depthCurr.value.image.data;
          let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, n = 0, sx = 0, sy = 0, sz = 0;
          for (let i = 0; i < d.length; i++) {
            const mm = d[i];
            if (mm <= 0 || mm === 65535) continue;
            const z = mm * 0.001;
            const col = i % DW, row = (i / DW) | 0;
            // x negated: the mirror correction unproject in web/cloud-shader.js carries the
          // reasoning for. Width and height are invariant under it and the centroid is
          // not, so an oracle left un-negated would agree with the page on the rows that
          // happen to measure extents and disagree on the one that measures a position.
          const X = -(col + 0.5 - cx) / fx * z, Y = -(row + 0.5 - cy) / fy * z;
            if (X < minX) minX = X; if (X > maxX) maxX = X;
            if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
            sx += X; sy += Y; sz += z; n++;
          }
          return { n, width: maxX - minX, height: maxY - minY,
            centroid: [sx / n, sy / n, sz / n] };
        };
        const out = {};
        for (const div of opts.divisors) {
          const res = await fetch('/capture/' + opts.take + '/frame/' + opts.n + '?decimate=' + div);
          if (!res.ok) return { error: 'frame ' + opts.n + ' at div ' + div + ': HTTP ' + res.status };
          const buf = await res.arrayBuffer();
          const depthBytes = new DataView(buf).getUint32(0, true);
          const src = new Uint16Array(buf, 16, depthBytes / 2);
          kin.drive.injectDepth(new Uint16Array(DW * DH).fill(65535));
          kin.drive.injectDepth(new Uint16Array(DW * DH).fill(65535));
          kin.drive.injectDepth(src);
          out[div] = Object.assign({ samples: src.length }, measure());
        }
        return out;
      }`;
      const same = await page.evaluate(
        `(${SAME_FRAME})(${JSON.stringify({ take: 'sample', n: 7, divisors: [1, 2, 4, 8] })})`,
      );
      ok('the frame API served frame 7 of the sample at every divisor this compares',
        !same.error, same.error ?? '');
      if (!same.error) {
        const base = same[1];
        for (const div of [2, 4, 8]) {
          const arm = same[div];
          const drift = Math.hypot(...arm.centroid.map((v, i) => v - base.centroid[i]));
          const taller = arm.height / base.height;
          const kept = arm.n / base.n;
          // Two gated terms and a third reported rather than gated, all set from measurement on
          // both sides. The centroid separates by a factor of 46 and the point count by 4 to 64, so
          // 0.05m and 5% sit an order of magnitude clear of both. The height does not - honest, it
          // falls from 0.958 to 0.847 as the divisor rises, because an extent is an extremum - so a
          // gate there would be calibrated on the gap rather than on the property, and it is
          // printed and left ungated.
          ok(`the same frame at ÷${div} (${arm.samples} samples) reconstructs the same scene as at ÷1`,
            drift < 0.05 && Math.abs(kept - 1) < 0.05,
            `centroid ${drift.toFixed(4)}m away, ${arm.n} points against ${base.n} `
            + `(x${kept.toFixed(3)}), and ${(taller * 100).toFixed(1)}% as tall`);
        }
      }

      await stopAll();

      // The rows above drive one function; this one drives the product, a monitor asking for
      // divisor 4 the way an operator asks. Interleaved rather than before-and-after, because a
      // single ordered pair cannot tell the setting from anything else that moved
      // between the reads.
      mkdirSync(join(WORK, 'caps-5b'), { recursive: true });
      await start([...streamer(), '--captures', join(WORK, 'caps-5b'), '--name', 'renderlive',
        '--projects', join(WORK, 'p5b'), '--presets', join(WORK, 'q5b')]);
      await page.goto(RECORDER_URL, { waitUntil: 'load' });
      // Two clauses, and the second is the one a boot probe would miss: `sendMonitor` returns
      // silently unless the socket is OPEN, so a page whose handle has published but whose socket
      // has not connected takes the drag, sends nothing, and turns the divisor-4 arm into a second
      // divisor-1 arm read under a divisor-4 label. A depth texel that is no longer zero settles
      // both halves at once, because `web/gpu-textures.js` builds both depth textures
      // zero-filled deliberately.
      await published(page,
        'typeof globalThis.__kinect?.drive?.injectDepth === "function"'
        + ' && Boolean(globalThis.__kinect?.uniforms?.depthCurr?.value?.image?.data?.some((v) => v !== 0))',
        'the live socket to land a depth frame in the viewer');

      const setDivisor = (d) => page.evaluate(`(${`(d) => {
        const el = document.getElementById('monDivisor');
        el.value = String(d);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }`})(${d})`);

      // Parity-safe by construction: it asks what is still 65535 rather than what changed between
      // two reads, and which of the two textures a read lands on alternates with every frame.
      const WIPE_AND_COUNT = `() => {
        const k = globalThis.__kinect;
        const d = k.uniforms.depthCurr.value.image.data;
        let n = 0;
        for (let i = 0; i < d.length; i++) if (d[i] === 65535) n++;
        return { sentinel: n, of: d.length };
      }`;
      const WIPE = `() => {
        globalThis.__kinect.drive.injectDepth(new Uint16Array(512 * 424).fill(65535));
        globalThis.__kinect.drive.injectDepth(new Uint16Array(512 * 424).fill(65535));
      }`;

      // Through the page's own intrinsics and the page's own clip, so no constant in this tool
      // decides where a point goes.
      const SCENE = `() => {
        const k = globalThis.__kinect;
        const d = k.uniforms.depthCurr.value.image.data;
        const DW = 512;
        const fx = k.uniforms.focal.value.x, fy = k.uniforms.focal.value.y;
        const cx = k.uniforms.center.value.x, cy = k.uniforms.center.value.y;
        let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, n = 0;
        for (let i = 0; i < d.length; i++) {
          const mm = d[i];
          if (mm <= 0 || mm === 65535) continue;
          const z = mm * 0.001;
          if (z < k.uniforms.nearClip.value || z > k.uniforms.farClip.value) continue;
          const col = i % DW, row = (i / DW) | 0;
          // x negated: the mirror correction unproject in web/cloud-shader.js carries the
          // reasoning for. Width and height are invariant under it and the centroid is
          // not, so an oracle left un-negated would agree with the page on the rows that
          // happen to measure extents and disagree on the one that measures a position.
          const X = -(col + 0.5 - cx) / fx * z, Y = -(row + 0.5 - cy) / fy * z;
          if (X < minX) minX = X; if (X > maxX) maxX = X;
          if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
          n++;
        }
        return { n, width: maxX - minX, height: maxY - minY };
      }`;

      const rounds = [];
      for (let round = 0; round < 2; round++) {
        const arm = {};
        for (const k of [1, 4]) {
          await setDivisor(k);
          await wait(1200);
          // What the server answered, before anything is measured under it: section 1 proves the
          // negotiation against a different server, so without this row a grant that silently
          // failed would make the divisor-4 arm a second divisor-1 arm. The `<output>` is written
          // by `showMonitor` from the answer rather than from the request.
          const granted = await page.evaluate('document.getElementById(\'monDivisor\').nextElementSibling.value');
          ok(`round ${round + 1}: the ÷${k} arm is being served at ÷${k}, so it is an arm rather than a label`,
            Number(granted) === k, `the monitor panel shows ÷${granted}`);
          await page.evaluate(`(${WIPE})()`);
          await wait(1200); // ~36 arrivals at 30fps, so a stride of 1 has had many
          arm[k] = { ...await page.evaluate(`(${WIPE_AND_COUNT})()`), ...await page.evaluate(`(${SCENE})()`) };
        }
        rounds.push(arm);
        ok(`round ${round + 1}: a full-rate stream refreshes the whole grid`,
          arm[1].sentinel === 0, `${arm[1].sentinel} of ${arm[1].of} texels never arrived`);
        ok(`round ${round + 1}: and so does a ÷4 stream - the divisor is a network concession, not a smaller picture`,
          arm[4].sentinel === 0, `${arm[4].sentinel} of ${arm[4].of} texels never arrived`);
        // The reconstructed shape is deliberately not compared here, and that is a correction
        // rather than an omission: these two arms are 2.4 seconds apart and the sample is a person
        // moving, so a real scene change sat inside every comparison and 1.153 once failed a gate
        // at 1.15 under a mutation that cannot touch geometry. The shape question moved to the
        // same-frame comparison below, where both arms are one moment. What stays here is exact.
      }
      ok('both rounds agree, so neither is a single pair that happened to land well',
        rounds.every((r) => r[4].sentinel === 0),
        rounds.map((r) => `÷4 left ${r[4].sentinel}`).join(', '));
      ok('and the page reported no error while doing any of it', pageErrors.length === 0,
        pageErrors.slice(0, 2).join(' | '));

      // The colour-off half of the live path, which nothing in this repo could reach until the
      // fixture learned to produce it: `tools/fake-grabber.mjs` ignored both `--no-color` and the
      // mid-shoot toggle for its whole life, so the viewer's one statement that handles the real
      // thing was untested in the strongest sense - deleting it left the whole suite green. What it
      // costs live is a cloud wearing a frozen still of the moment colour went off, on a page
      // that looks healthy.
      //
      // Two rows on two different objects, so a red row says which half is at fault: one reads the
      // wire, one reads the page. Its own server and its own captures directory, away from the
      // take-identity section, because the toggle takes the grabber down and a
      // respawn splits a take.
      await stopAll();
      console.log('\n[monitor] the colour camera goes off, and the cloud stops wearing the last JPEG');
      mkdirSync(join(WORK, 'caps-6'), { recursive: true });
      await start([...streamer(), '--captures', join(WORK, 'caps-6'), '--name', 'colouroff',
        '--projects', join(WORK, 'p6'), '--presets', join(WORK, 'q6')]);

      // Read off the wire rather than off the page. Helloes are recognised on the grabber's own
      // fields, the same discriminator `main.js` uses, because the payload goes into a take
      // verbatim and carries no type tag.
      const streamed = { helloes: [], colorBytes: [] };
      const observer = new WebSocket(`ws://127.0.0.1:${PORT}/`);
      observer.on('message', (data, isBinary) => {
        if (isBinary) { streamed.colorBytes.push(data.readUInt32LE(4)); return; }
        const msg = JSON.parse(data.toString('utf8'));
        if (typeof msg.serial === 'string' && Number.isFinite(msg.fx)) streamed.helloes.push(msg);
      });
      await new Promise((resolve, reject) => {
        observer.on('open', resolve);
        observer.on('error', reject);
      });

      await page.goto(RECORDER_URL, { waitUntil: 'load' });

      // The precondition is asserted, never waited out: `hasColor` reaching 1 is the proof that a
      // JPEG really decoded and bound, since `bindColor` is the only thing that ever sets it, and a
      // fixed wait here would turn "no colour ever decoded" into a silent pass on the row that
      // matters most. Boot is waited for apart from colour, and caught rather than let out here
      // alone, because this is the one section that can tell a page that never booted from a colour
      // that never arrived. `-1` from the read below keeps the same distinction available for a
      // page that booted and then died inside the wait.
      let up = true;
      try {
        await published(page, 'globalThis.__kinect?.uniforms?.hasColor',
          'the viewer to publish the colour uniform the toggle is measured against');
      } catch { up = false; }
      const hasColor = () => page.evaluate('globalThis.__kinect ? globalThis.__kinect.uniforms.hasColor.value : -1');
      let bound = false;
      if (up) {
        try {
          await waitFor(async () => (await hasColor()) === 1, 20000, 'a colour frame to decode and bind');
          bound = true;
        } catch { /* the row below is the report, and the rows after it are skipped */ }
      }
      // Short-circuited and caught, because this read runs on the path where the wait has already
      // failed: a page that died during those twenty seconds would turn a red row into a crash with
      // the count still short.
      const booted = up && (bound || (await hasColor().catch(() => -1)) !== -1);
      ok('a colour-on grabber paints the cloud with a real decoded JPEG, which is what the toggle is measured against',
        bound, bound ? '' : (booted
          ? 'hasColor never reached 1, so no colour ever bound and nothing below would have measured the toggle'
          : 'the page never published __kinect, so this is a viewer that did not boot rather than a colour that did not arrive'));

      // Counted before the press, because the restart can be under way by the time the click
      // resolves and a hello read after the fact could be the one already on file.
      const helloesBefore = streamed.helloes.length;
      // The real control, pressed the way an operator presses it: the page's own `change` handler
      // is what puts `{camera: {color: false}}` on the socket.
      await page.click('#colorCam');

      // Waited on the respawned grabber's handshake rather than on a duration, because the toggle
      // drops the child and the backoff spawns a replacement with the new argv.
      let respawned = null;
      try {
        await waitFor(() => streamed.helloes.length > helloesBefore, 25000, 'the respawned grabber to hand shake');
        respawned = streamed.helloes.at(-1);
      } catch { /* reported by the row below */ }
      ok('the toggle takes the grabber down and the replacement hands shake again',
        respawned !== null, respawned ? '' : 'no second hello arrived, so nothing restarted');
      // Both fields, and the second is easy to get wrong: `native/grabber.cpp` reports `lowLight`
      // as the conjunction, so a grabber given `--no-color` alone - which is exactly what the
      // server produces here - says `"lowLight":false`. A fixture watching only for
      // `--no-low-light` would still say true.
      ok('and it handshakes the configuration it was actually given: colour off, and low light off with it',
        respawned?.color === false && respawned?.lowLight === false,
        `hello says color=${respawned?.color}, lowLight=${respawned?.lowLight}`);

      // Frames from before the new hello are dropped rather than counted, so one still in flight
      // under the previous grabber cannot read as the new one failing to drop its colour.
      streamed.colorBytes.length = 0;
      let streaming = false;
      try {
        await waitFor(() => streamed.colorBytes.length >= 5, 15000, 'frames from the respawned grabber');
        streaming = true;
      } catch { /* reported by the row below */ }
      const carried = streamed.colorBytes.filter((c) => c !== 0).length;
      ok('and every frame it sends declares no colour block at all, which is what the viewer reads to decide whether to decode one',
        streaming && carried === 0,
        streaming ? `${carried} of ${streamed.colorBytes.length} frames still declared colour` : 'no frames arrived after the respawn');

      // The row this section exists for. Skipped rather than asserted when no colour ever bound,
      // because `hasColor` is 0 at boot and asserting against a page that never reached 1 would
      // pass by agreeing with the initial value.
      if (bound) {
        let zeroed = false;
        try {
          await waitFor(async () => (await hasColor()) === 0, 15000, 'the viewer to stop sampling a colour it is no longer sent');
          zeroed = true;
        } catch { /* reported by the row below */ }
        ok('the viewer stops texturing the cloud the moment the hello says there is no colour',
          zeroed, zeroed ? '' : `hasColor is still ${await hasColor()}, so the cloud is wearing a frozen still of the moment colour went off`);
      } else {
        console.log('  ....  the viewer row did not run: no colour ever bound, so there was nothing for the toggle to take away');
      }
      observer.terminate();

      await browser.close();
    }
  }
} catch (err) {
  // A run that threw did not finish, and that is a different answer from a claim that failed. It
  // matters most under `--mutate`, where a harness timeout would otherwise be counted as the
  // mutation being caught: `expand-shifts-by-a-block` did exactly that on a busy machine, exiting
  // on one fired assertion that was this line.
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[monitor] ${checked} assertions, ${failed} failed`
  + (NO_BROWSER ? ' - the renderer section was skipped, so what a client does with a decimated frame is untested here' : ''));
// Before every other verdict, because a run that threw has not earned any of them.
if (crashed) {
  console.log(`[monitor] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested) {
  console.log(`[monitor] UNTESTED - ${untested}. Install playwright, or pass --no-browser and mean it.`);
  process.exit(2);
}
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[monitor] it should redden: ${MUTATIONS[MUTATE].fails}`);
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed before asserting
  // anything", and this repo has been bitten by exactly that twice.
  if (failed === 0) { console.log('[monitor] NOT CAUGHT - the check passed a server it should have rejected'); process.exit(1); }
  console.log(`[monitor] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[monitor] FAIL'); process.exit(1); }
console.log('[monitor] PASS');
process.exit(0);
