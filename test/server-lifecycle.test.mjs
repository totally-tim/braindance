// The server as a desktop host drives it: every root named, --port 0, read through its `ready`
// line, stopped through its stdin. Real children throughout, because what is under test is what
// happens to a process and to the takes it owns. Captures come from tools/fake-grabber.mjs and a
// tools/make-sample.mjs file, so nothing here opens a sensor.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_GRABBER = join(REPO, 'tools/fake-grabber.mjs');
const PROBE = join(REPO, 'test/capture-close-probe.mjs');
const ROOT_NAMES = ['captures', 'projects', 'presets', 'deliverables', 'effects', 'jobs', 'exports'];
const WAIT_MS = 30_000;
const noShell = process.platform === 'win32' ? 'the stand-in encoders are shell scripts' : false;

let work;
let sample;
// Frames half a second apart, so the replay sits between two reads for most of the run.
let slowSample;
const children = new Set();

before(() => {
  work = mkdtempSync(join(tmpdir(), 'braindance-lifecycle-'));
  sample = join(work, 'sample.knct');
  execFileSync(process.execPath, [join(REPO, 'tools/make-sample.mjs'), sample, '--frames', '30'], { stdio: 'pipe' });
  slowSample = join(work, 'slow.knct');
  execFileSync(process.execPath, [join(REPO, 'tools/make-sample.mjs'), slowSample, '--frames', '30', '--fps', '2'], { stdio: 'pipe' });
  // Two stand-ins that write their own name where ffmpeg would put the video, so the file says
  // which one ran. `$last` is the output path, which is ffmpeg's last argument.
  for (const [dir, says] of [['named', 'named'], ['on-path', 'path']]) {
    mkdirSync(join(work, dir));
    const file = join(work, dir, dir === 'named' ? 'my-encoder' : 'ffmpeg');
    writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nfor last; do :; done\nprintf ${says} > "$last"\n`);
    chmodSync(file, 0o755);
  }
  mkdirSync(join(work, 'empty'));
}, { timeout: 120_000 });

after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function eventually(probe, what, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A server child with its own roots under `work`, resolved once it has printed its ready line. */
async function start(name, { flags = [], env = {}, rootsGiven = ROOT_NAMES, stdin = true, entry = join(REPO, 'server/index.js'), nodeArgs = [] } = {}) {
  const base = join(work, name);
  const roots = Object.fromEntries(ROOT_NAMES.map((root) => [root, join(base, root)]));
  const args = [...nodeArgs, entry, '--port', '0', '--standby-after', '0',
    ...rootsGiven.flatMap((root) => [`--${root}`, roots[root]]), ...flags];
  const environment = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete environment[key];
  const child = spawn(process.execPath, args, { cwd: REPO, env: environment, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdin?.on('error', () => { /* the child may be gone by the time a line is written */ });

  const lines = [];
  const watchers = new Set();
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line);
      for (const watcher of [...watchers]) watcher();
    });
  }
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));

  const server = {
    child, roots, lines, exited,
    until: (probe, what, ms = WAIT_MS) => new Promise((resolve, reject) => {
      const look = () => {
        const hit = probe(lines);
        if (!hit) return;
        clearTimeout(timer);
        watchers.delete(look);
        resolve(hit);
      };
      const timer = setTimeout(() => {
        watchers.delete(look);
        reject(new Error(`timed out waiting for ${what}; the last of the log:\n${lines.slice(-25).join('\n')}`));
      }, ms);
      watchers.add(look);
      look();
    }),
    // Rejects when the process is still there at the deadline, which is how a stop that does
    // nothing reads.
    stops: (ms = WAIT_MS) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the server was still running ${ms}ms after the stop; the last of the log:\n${lines.slice(-25).join('\n')}`));
      }, ms);
      exited.then((result) => { clearTimeout(timer); resolve(result); });
    }),
    get: (path) => fetch(server.url + path),
    post: (path, body) => fetch(server.url + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
  const readyLine = await server.until((all) => all.find((line) => line.startsWith('[server] ready ')), 'the ready line');
  server.ready = JSON.parse(readyLine.slice('[server] ready '.length));
  server.url = server.ready.url;
  return server;
}

const fakeGrabber = (extra = '') => `"${process.execPath}" "${FAKE_GRABBER}" --source "${sample}" --fps 120 ${extra}`;

// The take the server opens at hello, with a mark pressed in it: the two things a stop must not lose.
async function shoot(server) {
  const [, id] = await server.until(
    (all) => all.map((line) => /^\[recorder\] take (\S+) open$/.exec(line)).find(Boolean),
    'a take to open',
  );
  await eventually(async () => (await (await server.get('/record/state')).json()).frames >= 3, 'frames in the take');
  const marked = await server.post('/record/mark', { label: `mark-${id}` });
  assert.equal(marked.status, 200, 'the mark was taken');
  return id;
}

function assertFinished(server, id) {
  assert.ok(existsSync(join(server.roots.captures, `${id}.idx`)), `take ${id} has its index sidecar`);
  const marksDir = join(server.roots.captures, 'marks');
  const marks = existsSync(marksDir) ? readdirSync(marksDir).map((file) => readFileSync(join(marksDir, file), 'utf8')).join('\n') : '';
  assert.ok(marks.includes(`mark-${id}`), `take ${id} has its mark in the marks log`);
}

const TRIGGERS = {
  'a stop line': (server) => server.child.stdin.write('stop\n'),
  'end of file on stdin': (server) => server.child.stdin.end(),
};

// ---------------------------------------------------------------------------------------------
// The ready line, and the exports root it reports.

test('the ready line is one line carrying the real url, the pid and every root', { timeout: 60_000 }, async () => {
  const server = await start('ready', { flags: ['--replay', sample] });
  assert.equal(server.lines.filter((line) => line.startsWith('[server] ready ')).length, 1);
  assert.deepEqual(Object.keys(server.ready).sort(), ['pid', 'roots', 'url']);
  assert.equal(server.ready.pid, server.child.pid);
  const { port } = new URL(server.ready.url);
  assert.match(server.ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(Number(port), 0, '--port 0 reports the port it was given, not 0');
  assert.deepEqual(server.ready.roots, server.roots, 'every root is the one the flag named');
  assert.equal((await server.get('/record/state')).status, 200, 'and the url is where the server is');
  assert.ok(server.lines.some((line) => line.startsWith('[server] viewer on ')), 'the existing viewer line is still printed');
  server.child.kill('SIGKILL');
});

test('with no --exports the exports root is the one beside the source', { timeout: 60_000 }, async () => {
  const server = await start('default-exports', {
    flags: ['--replay', sample], rootsGiven: ROOT_NAMES.filter((root) => root !== 'exports'),
  });
  assert.equal(server.ready.roots.exports, join(REPO, 'exports'));
  server.child.kill('SIGKILL');
});

test('--exports is where the static route reads', { timeout: 60_000 }, async () => {
  const server = await start('exports-static', { flags: ['--replay', sample] });
  mkdirSync(server.roots.exports, { recursive: true });
  writeFileSync(join(server.roots.exports, 'hello.txt'), 'from the named root');
  const answer = await server.get('/exports/hello.txt');
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), 'from the named root');
  server.child.kill('SIGKILL');
});

// ---------------------------------------------------------------------------------------------
// An export through the socket of a real server: where it lands, and which encoder runs.

function socketTo(server) {
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/export`);
  const queue = [];
  let waiting = null;
  const push = (message) => { queue.push(message); const wake = waiting; waiting = null; wake?.(); };
  ws.on('message', (data, isBinary) => { if (!isBinary) push(JSON.parse(data.toString('utf8'))); });
  ws.on('close', () => push({ closed: true }));
  ws.on('error', (err) => push({ socketError: err.message }));
  return {
    opened: new Promise((open, failed) => { ws.once('open', open); ws.once('error', failed); }),
    send: (message) => ws.send(Buffer.isBuffer(message) ? message : JSON.stringify(message)),
    async next(ms = 20_000) {
      const end = Date.now() + ms;
      while (!queue.length) {
        if (Date.now() > end) throw new Error('the export socket said nothing');
        await Promise.race([new Promise((wake) => { waiting = wake; }), sleep(100)]);
      }
      return queue.shift();
    },
  };
}

// One 2x2 frame through begin, frame, end. Returns every message the server sent, in order.
async function exportOneFrame(server) {
  const socket = socketTo(server);
  await socket.opened;
  socket.send({ begin: { name: 'shot', width: 2, height: 2, fps: 30, frames: 1, codec: 'h264' } });
  const heard = [];
  for (;;) {
    const message = await socket.next();
    heard.push(message);
    if (message.ready) {
      socket.send(Buffer.alloc(2 * 2 * 4));
      socket.send({ end: true });
    }
    if (message.done || message.error || message.closed || message.socketError) return heard;
  }
}

test('an export lands under --exports and is served from it, by the encoder FFMPEG names', { skip: noShell, timeout: 60_000 }, async () => {
  const server = await start('export-named', {
    flags: ['--replay', sample],
    env: { FFMPEG: join(work, 'named/my-encoder'), PATH: join(work, 'on-path') },
  });
  const heard = await exportOneFrame(server);
  const done = heard.find((message) => message.done)?.done;
  assert.ok(done, `the export finished: ${JSON.stringify(heard)}`);
  assert.ok(done.output.startsWith(`${server.roots.exports}/`), `${done.output} is under ${server.roots.exports}`);
  assert.equal(readFileSync(done.output, 'utf8'), 'named', 'FFMPEG wins over an ffmpeg on PATH');
  const served = await server.get(done.href);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), 'named');
  server.child.kill('SIGKILL');
});

test('with FFMPEG unset an export uses the ffmpeg on PATH', { skip: noShell, timeout: 60_000 }, async () => {
  const server = await start('export-path', {
    flags: ['--replay', sample], env: { FFMPEG: undefined, PATH: join(work, 'on-path') },
  });
  const heard = await exportOneFrame(server);
  const done = heard.find((message) => message.done)?.done;
  assert.ok(done, `the export finished: ${JSON.stringify(heard)}`);
  assert.equal(readFileSync(done.output, 'utf8'), 'path');
  server.child.kill('SIGKILL');
});

test('with no ffmpeg anywhere the export is refused before it is ready, naming what was tried', { timeout: 60_000 }, async () => {
  const server = await start('export-none', {
    flags: ['--replay', sample], env: { FFMPEG: undefined, PATH: join(work, 'empty') },
  });
  const heard = await exportOneFrame(server);
  assert.equal(heard.some((message) => message.ready), false, 'nothing was started');
  const refusal = heard.find((message) => message.error)?.error;
  assert.ok(refusal, `the export was refused: ${JSON.stringify(heard)}`);
  assert.match(refusal, /FFMPEG environment variable is not set/);
  assert.ok(refusal.includes(join(work, 'empty')), 'and it names the directory it searched');
  assert.equal(existsSync(server.roots.exports), false, 'and created nothing under the exports root');
  server.child.kill('SIGKILL');
});

// ---------------------------------------------------------------------------------------------
// A stop reaching a live server mid-take.

for (const [what, trigger] of Object.entries(TRIGGERS)) {
  test(`${what} stops a live server with exit 0 and the open take indexed and marked`, { timeout: 90_000 }, async () => {
    const server = await start(`live-${what.replace(/\W+/g, '-')}`, {
      flags: ['--stop-on-stdin', '--record', '--grabber', fakeGrabber()],
    });
    const id = await shoot(server);
    trigger(server);
    const { code, signal } = await server.stops();
    assert.deepEqual([code, signal], [0, null]);
    assertFinished(server, id);
  });
}

test('SIGTERM still stops a live server with exit 0 and the open take indexed and marked', { timeout: 90_000 }, async () => {
  const server = await start('live-sigterm', { flags: ['--stop-on-stdin', '--record', '--grabber', fakeGrabber()] });
  const id = await shoot(server);
  server.child.kill('SIGTERM');
  const { code, signal } = await server.stops();
  assert.deepEqual([code, signal], [0, null]);
  assertFinished(server, id);
});

for (const [what, trigger] of Object.entries(TRIGGERS)) {
  test(`${what} just after a grabber restart still gives the split take its index and marks`, { timeout: 90_000 }, async () => {
    // 200 frames at 120fps: a take large enough that its close outlasts the round trip of the stop.
    const server = await start(`split-${what.replace(/\W+/g, '-')}`, {
      flags: ['--stop-on-stdin', '--record', '--grabber', fakeGrabber('--die-after 200')],
    });
    const id = await shoot(server);
    await server.until((all) => all.some((line) => line.startsWith('[server] grabber exited')), 'the grabber to die');
    trigger(server);
    const { code, signal } = await server.stops();
    assert.deepEqual([code, signal], [0, null]);
    assert.ok(
      server.lines.some((line) => line.startsWith(`[recorder] take ${id} closed (grabber restarted)`)),
      `the split take's close finished before the process went; the log:\n${server.lines.join('\n')}`,
    );
    assertFinished(server, id);
  });
}

test('a stop that cannot write the take\'s marks exits 1, names the take, and still indexes it', { timeout: 90_000 }, async () => {
  const server = await start('live-marks-fail', { flags: ['--stop-on-stdin', '--record', '--grabber', fakeGrabber()] });
  const id = await shoot(server);
  // A regular file where the marks directory goes: the take closes, and only its marks fail.
  const marks = join(server.roots.captures, 'marks');
  rmSync(marks, { recursive: true, force: true });
  writeFileSync(marks, 'not a directory');
  server.child.stdin.write('stop\n');
  const { code, signal } = await server.stops();
  assert.deepEqual([code, signal], [1, null]);
  await server.until(
    (all) => all.some((line) => line.startsWith(`[server] shutdown: the take did not finish: take ${id}: could not write its marks`)),
    'the sentence naming the take',
  );
  assert.equal(server.lines.some((line) => line.includes('the grabber did not finish')), false, 'the grabber stopped');
  assert.ok(existsSync(join(server.roots.captures, `${id}.idx`)), `take ${id} has its index sidecar`);
});

test('without --stop-on-stdin a stop line and end of file do nothing', { timeout: 60_000 }, async () => {
  const server = await start('no-flag', { flags: ['--replay', sample] });
  server.child.stdin.write('stop\n');
  server.child.stdin.end();
  await sleep(750);
  assert.equal(server.child.exitCode, null, 'the server is still running');
  assert.equal((await server.get('/record/state')).status, 200, 'and still answering');
  server.child.kill('SIGKILL');
});

test('a line that is not stop is ignored and said so', { timeout: 60_000 }, async () => {
  const server = await start('unknown-line', { flags: ['--stop-on-stdin', '--replay', sample] });
  server.child.stdin.write('quit\n');
  await server.until((all) => all.some((line) => line.includes('stdin: ignoring "quit"')), 'the refusal of the line');
  assert.equal(server.child.exitCode, null);
  server.child.stdin.write('stop\r\n');
  assert.deepEqual((await server.stops()).code, 0, 'and a stop with a Windows line ending still stops');
});

// ---------------------------------------------------------------------------------------------
// A replay server stops too. Process exit releases the capture, the timer and the listener whether
// or not the shutdown did, so each is read while the capture's close is held open or at the moment
// the process ends, through a probe on the capture that leaves the server's code alone.

const REPLAY_TRIGGERS = { ...TRIGGERS, SIGTERM: (server) => server.child.kill('SIGTERM') };
// How long the close stays held after the timer is released, for a read a left-behind timer starts.
const HOLD_MS = 800;

const WHAT_FAILED = {
  closed: 'the shutdown never called the capture\'s close',
  waited: 'the server exited while the capture was still closing',
  finished: 'the capture\'s close had not finished when the server exited',
  timer: 'a frame was read after the stop began, so the replay timer was left running',
  listener: 'the listener still accepted a connection after the stop began',
  code: 'the exit code was not the one the capture\'s close earned',
  diagnostic: 'the failed close was not reported',
};

// A fresh connection rather than a request: a fetch may ride a connection that is already open,
// and a closed listener leaves those answering.
const refused = (port) => new Promise((done) => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); done(false); });
  socket.once('error', () => done(true));
});

// Stops a replay server under the probe and answers which observations failed.
async function observeReplayStop(name, trigger, { mode = 'hold', root = REPO } = {}) {
  const events = join(work, `${name}.events`);
  const release = join(work, `${name}.release`);
  const timerRelease = join(work, `${name}.timer-release`);
  writeFileSync(events, '');
  const server = await start(name, {
    flags: ['--stop-on-stdin', '--replay', slowSample],
    entry: join(root, 'server/index.js'),
    nodeArgs: ['--import', PROBE],
    env: {
      BRAINDANCE_PROBE_CAPTURE: join(root, 'server/capture.js'),
      BRAINDANCE_PROBE_EVENTS: events,
      BRAINDANCE_PROBE_MODE: mode,
      BRAINDANCE_PROBE_RELEASE: release,
      BRAINDANCE_PROBE_TIMER_RELEASE: timerRelease,
    },
  });
  const happened = () => readFileSync(events, 'utf8').split('\n').filter(Boolean);
  const failed = [];
  const expect = (ok, id) => { if (!ok) failed.push(id); };

  // The probe holds the timer the read arms, so it is pending when the stop arrives however long the read took.
  await eventually(() => happened().includes('timer-armed'), 'the replay to arm its next frame timer');
  trigger(server);
  await eventually(() => happened().includes('close-begun') || server.child.exitCode !== null, 'the stop to reach the capture or end the process');
  const begun = happened().includes('close-begun');
  expect(begun, 'closed');
  if (begun && mode === 'hold') {
    // A timer the stop left pending fires now, and reads a frame inside the held close.
    writeFileSync(timerRelease, '');
    await sleep(HOLD_MS);
    expect(server.child.exitCode === null, 'waited');
    expect(!happened().slice(happened().indexOf('close-begun')).includes('frame-read'), 'timer');
    expect(await refused(Number(new URL(server.url).port)), 'listener');
  }
  writeFileSync(release, '');
  const { code } = await server.stops();
  expect(happened().includes(mode === 'reject' ? 'close-rejected' : 'close-ended'), 'finished');
  expect(code === (mode === 'reject' ? 1 : 0), 'code');
  if (mode === 'reject') {
    const said = await server.until(
      (all) => all.some((line) => line === '[server] shutdown: the capture did not close: injected: the capture would not close'),
      'the diagnostic', 3000,
    ).catch(() => false);
    expect(said, 'diagnostic');
  }
  return failed;
}

const explain = (ids) => ids.map((id) => WHAT_FAILED[id]);

for (const [what, trigger] of Object.entries(REPLAY_TRIGGERS)) {
  test(`${what} stops a replay server: it waits for the capture to close, then exits 0`, { timeout: 60_000 }, async () => {
    assert.deepEqual(explain(await observeReplayStop(`replay-${what.replace(/\W+/g, '-')}`, trigger)), []);
  });
}

test('a capture that fails to close is reported and the replay server exits 1', { timeout: 60_000 }, async () => {
  assert.deepEqual(explain(await observeReplayStop('replay-reject', TRIGGERS['a stop line'], { mode: 'reject' })), []);
});

// A copy of the server with one line changed, so a control can ask whether the observation above
// notices. The line must be there exactly once, or the control would be testing nothing.
function stagedWith(name, from, to) {
  const root = join(work, 'staged', name);
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(REPO)) {
    if (entry !== 'server' && !entry.startsWith('.')) symlinkSync(join(REPO, entry), join(root, entry));
  }
  cpSync(join(REPO, 'server'), join(root, 'server'), { recursive: true });
  const file = join(root, 'server/index.js');
  const source = readFileSync(file, 'utf8');
  assert.equal(source.split(from).length - 1, 1, `${from} is in server/index.js exactly once`);
  writeFileSync(file, source.replace(from, to));
  return root;
}

// Each removes one thing the replay shutdown does, and names the observations that must catch it
// and no others.
const REPLAY_CONTROLS = [
  { name: 'the capture is never closed', from: 'await capture?.close();', to: '', fails: ['closed', 'finished'] },
  { name: 'the capture is closed but not awaited', from: 'await capture?.close();', to: 'capture?.close();', fails: ['waited', 'finished'] },
  { name: 'the replay timer is not cleared', from: 'clearTimeout(timer);', to: '', fails: ['timer'] },
  { name: 'the listener is not closed', from: 'httpServer.close();', to: '', fails: ['listener'] },
  { name: 'a capture that fails to close is counted as a success', mode: 'reject', from: 'failed = true;', to: '', fails: ['code'] },
];

for (const { name, from, to, fails, mode = 'hold' } of REPLAY_CONTROLS) {
  test(`control: when ${name}, the replay stop observation goes red`, { timeout: 60_000 }, async () => {
    const root = stagedWith(name.replace(/\W+/g, '-'), from, to);
    const failed = await observeReplayStop(`control-${name.replace(/\W+/g, '-')}`, TRIGGERS['a stop line'], { mode, root });
    assert.deepEqual(explain(failed.sort()), explain([...fails].sort()));
  });
}

test('a replay of a capture that is not there still stops on the stop line', { timeout: 60_000 }, async () => {
  const server = await start('replay-missing', { flags: ['--stop-on-stdin', '--replay', join(work, 'not-there.knct')] });
  await server.until((all) => all.some((line) => line.includes('no capture at')), 'the refusal to open it');
  server.child.stdin.write('stop\n');
  assert.deepEqual(await server.stops(), { code: 0, signal: null });
});
