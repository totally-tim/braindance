import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Recorder } from '../server/recorder.js';
import { buildIndex, colourAfterFrames, readHelloOnce } from '../server/capture.js';
import { MIN_TAKE_SEC, readMarks, scanTakes } from '../server/library.js';
import { encodeMessage, HEADER_BYTES, TYPE_COLOR, TYPE_FRAME } from '../server/protocol.js';
import {
  CAPTURE_FORMAT,
  TIMELAPSE_FPS,
  TIMELAPSE_MAX_SEC,
  TIMELAPSE_MIN_SEC,
  durationLabel,
  formatIntervalLabel,
  timelapseIntervalRefusal,
} from '../web/format.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT, 'bin/braindance.mjs');
const SERVER_BIN = join(ROOT, 'server/index.js');
const FAKE_GRABBER = join(ROOT, 'tools/fake-grabber.mjs');
const MAKE_SAMPLE = join(ROOT, 'tools/make-sample.mjs');

const HELLO = Buffer.from(JSON.stringify({
  format: CAPTURE_FORMAT,
  fx: 366,
  fy: 366,
  cx: 256,
  cy: 212,
  width: 512,
  height: 424,
}));

function makeFrame(stampMs, bytes = 256) {
  const payload = Buffer.alloc(bytes);
  payload.writeUInt32LE(bytes - 16, 0);
  payload.writeUInt32LE(0, 4);
  payload.writeBigUInt64LE(BigInt(stampMs), 8);
  return encodeMessage(TYPE_FRAME, payload);
}

function makeColour(stampMs, jpegBytes = 64) {
  const payload = Buffer.alloc(8 + jpegBytes);
  payload.writeBigUInt64LE(BigInt(stampMs), 0);
  payload.fill(0xab, 8);
  return encodeMessage(TYPE_COLOR, payload);
}

async function inTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-timelapse-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function freePort() {
  const srv = createServer();
  await new Promise((done) => srv.listen(0, '127.0.0.1', done));
  const { port } = srv.address();
  await new Promise((done) => srv.close(done));
  return port;
}

function runNode(args, env = process.env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

async function waitFor(predicate, timeoutMs = 15000, label = 'condition') {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

test('timelapse interval validation and labels accept valid bounds and refuse bad input', () => {
  for (const good of [TIMELAPSE_MIN_SEC, 0.5, 1, 5, 60, TIMELAPSE_MAX_SEC]) {
    assert.equal(timelapseIntervalRefusal(good), null, `expected ${good}s to be valid`);
  }
  for (const bad of [0, -1, 0.05, TIMELAPSE_MAX_SEC + 1, NaN, Infinity, -Infinity, '5', null, undefined, {}]) {
    assert.notEqual(timelapseIntervalRefusal(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
  assert.equal(formatIntervalLabel(0.5), '0.5s');
  assert.equal(formatIntervalLabel(5), '5s');
  assert.equal(formatIntervalLabel(90), '1m 30s');
  assert.equal(formatIntervalLabel(3600), '1h');
  assert.equal(durationLabel(45), '45s');
  assert.equal(durationLabel(125), '2m 05s');
  assert.equal(durationLabel(3665), '1h 01m');
});

test('timelapse skips frames between intervals, rewrites 30fps stamps, matches 1080p colour, and leaves inputs untouched', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    await recorder.start(HELLO, { intervalSec: 1 });
    assert.equal(recorder.state.timelapseIntervalMs, 1000);

    // Unmatched colour before the first frame must be ignored.
    recorder.write(makeColour(900));

    // Simulate 10 seconds at 30fps (300 frames + 300 1080p colour messages).
    const samples = [];
    for (let i = 0; i < 300; i++) {
      const ts = 10000 + Math.round((i * 1000) / 30);
      const f = makeFrame(ts, 4096);
      const c = makeColour(ts + 5, 1024);
      if (i === 0 || i === 30) samples.push({ ts, f, c });
      recorder.write(f);
      recorder.write(c);
      // Extra colour frame within the same interval must also be skipped.
      recorder.write(makeColour(ts + 15, 1024));
    }

    // Input wire buffers must never be mutated in place.
    for (const s of samples) {
      assert.equal(Number(s.f.readBigUInt64LE(HEADER_BYTES + 8)), s.ts);
      assert.equal(Number(s.c.readBigUInt64LE(HEADER_BYTES)), s.ts + 5);
    }

    // Mark lands on the compressed timelapse clock, not wall elapsed time.
    const markAt = recorder.currentSourceMs();
    assert.equal(markAt, Math.round((9 * 1000) / TIMELAPSE_FPS));
    recorder.mark(markAt, 'sunset');

    const closed = await recorder.stop();
    assert.equal(recorder.state.timelapseIntervalMs, null);
    assert.equal(closed.frames, 10, 'only 10 frames out of 300 were written');
    assert.equal(closed.colourFrames, 10, 'at most 1 matched 1080p colour frame per captured timelapse frame');

    const index = await buildIndex(closed.path);
    const expectedStamps = Array.from({ length: 10 }, (_, k) => Math.round((k * 1000) / TIMELAPSE_FPS));
    assert.deepEqual(index.frames.stampMs, expectedStamps);
    assert.deepEqual(index.colour.stampMs, expectedStamps);

    // Each colour frame sits immediately after its matching depth frame for --replay lockstep.
    const from = colourAfterFrames(index);
    for (let k = 0; k < 10; k++) {
      assert.equal(from[k + 1] - from[k], 1, `frame ${k} carries one matched colour message`);
    }

    const hello = await readHelloOnce(closed.path, index);
    assert.equal(hello.timelapseIntervalMs, 1000);
    assert.equal(hello.timelapseFps, TIMELAPSE_FPS);

    const marks = await readMarks(dir, index.hash);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].sourceMs, expectedStamps[9]);

    const { takes } = await scanTakes(dir);
    assert.equal(takes.length, 1);
    assert.equal(takes[0].timelapseIntervalMs, 1000);
    assert.equal(takes[0].frames, 10);
    assert.equal(takes[0].durationSec, expectedStamps[9] / 1000);

    // Verify real disk savings compared to writing all 300 frames + 600 colour messages.
    const fileStat = await stat(closed.path);
    assert.ok(fileStat.size < 60_000, `timelapse take should stay tiny on disk, got ${fileStat.size} bytes`);
  });
});

test('timelapse schedule avoids cumulative drift and does not burst after a sensor pause', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    await recorder.start(HELLO, { intervalSec: 1 });

    // Frame 0 at 1000ms -> next target 2000ms.
    // Late frames at 2040ms (still sets next target to 3000ms, not 3040ms) and 3010ms -> next 4000ms.
    // Then a 5-second pause until 9200ms -> captures once and sets next target to 10000ms (no burst).
    const arrivals = [1000, 1999, 2040, 2999, 3010, 9200, 9233, 9999, 10000];
    for (const ts of arrivals) recorder.write(makeFrame(ts, 64));

    const closed = await recorder.stop();
    assert.equal(closed.frames, 5, 'captures at 1000, 2040, 3010, 9200, and 10000 without drifting or bursting');
  });
});

test('timelapse preserves setting across grabber split, ignores short frames, and checks disk using timelapse rate', async () => {
  await inTempDir(async (dir) => {
    const seenRates = [];
    const recorder = new Recorder({
      dir,
      rateOf: (intervalMs) => {
        seenRates.push(intervalMs);
        // Simulate normal mode exceeding free space while timelapse fits comfortably.
        return intervalMs ? 1000 : Number.MAX_SAFE_INTEGER;
      },
    });

    await assert.rejects(() => recorder.start(HELLO), /refusing to start a take/);
    assert.equal(seenRates.at(-1), null);

    await recorder.start(HELLO, { intervalSec: 2 });
    assert.equal(seenRates.at(-1), 2000);

    // Conflicting interval while armed is refused; matching interval is idempotent.
    await assert.rejects(() => recorder.start(HELLO, { intervalSec: 5 }), /already armed/);
    await recorder.start(HELLO, { intervalSec: 2 });

    // Short/malformed payloads are ignored safely without throwing.
    recorder.write(encodeMessage(TYPE_FRAME, Buffer.alloc(8)));
    recorder.write(encodeMessage(TYPE_COLOR, Buffer.alloc(4)));

    recorder.write(makeFrame(1000, 64));
    recorder.write(makeFrame(3000, 64));

    // Grabber restart splits the take and opens the replacement with the same timelapse interval.
    const first = await recorder.split();
    assert.equal(first.frames, 2);
    recorder.onHello(HELLO);
    assert.equal(recorder.state.timelapseIntervalMs, 2000);
    recorder.write(makeFrame(500, 64));
    recorder.write(makeFrame(2500, 64));

    const second = await recorder.stop();
    assert.equal(second.frames, 2);
    assert.equal(recorder.state.timelapseIntervalMs, null);

    // Invalid intervalSec fails with HTTP status 400.
    await assert.rejects(
      () => recorder.start(HELLO, { intervalSec: -1 }),
      (err) => err.status === 400 && /between/.test(err.message),
    );
  });
});

test('server refuses --timelapse without --record and drives full timelapse flow through CLI and HTTP', async () => {
  await inTempDir(async (dir) => {
    // Off-happy-path: --timelapse without --record must fail at boot.
    const badBoot = await runNode([SERVER_BIN, '--timelapse', '5', '--captures', dir]);
    assert.notEqual(badBoot.code, 0);
    assert.match(badBoot.stderr, /--timelapse requires --record/);

    // Build a minimal 4-frame synthetic sample quickly so the test runs offline without ffmpeg.
    const samplePath = join(dir, 'sample.knct');
    const sampleBuild = await runNode([MAKE_SAMPLE, samplePath, '--frames', '4']);
    assert.equal(sampleBuild.code, 0, sampleBuild.stderr);
    assert.ok(existsSync(samplePath));

    const capturesDir = join(dir, 'captures');
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const grabberCmd = `"${process.execPath}" "${FAKE_GRABBER}" --source "${samplePath}" --fps 30`;
    const server = spawn(process.execPath, [
      SERVER_BIN,
      '--port', String(port),
      '--captures', capturesDir,
      '--projects', join(dir, 'projects'),
      '--presets', join(dir, 'presets'),
      '--deliverables', join(dir, 'deliverables'),
      '--effects', join(dir, 'effects'),
      '--jobs', join(dir, 'jobs'),
      '--exports', join(dir, 'exports'),
      '--audio', join(dir, 'audio'),
      '--standby-after', '0',
      '--grabber', grabberCmd,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let serverErr = '';
    server.stderr.on('data', (d) => { serverErr += d; });
    server.stdout.on('data', (d) => { serverErr += d; });

    try {
      await waitFor(async () => {
        if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode}): ${serverErr}`);
        try {
          const res = await fetch(`${url}/sensor/health`);
          if (!res.ok) return false;
          const body = await res.json();
          return body.state === 'live';
        } catch {
          return false;
        }
      }, 15000, 'live fake grabber');

      // Bad interval over HTTP returns 400 and does not arm the recorder.
      const badStart = await fetch(`${url}/record/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalSec: 0 }),
      });
      assert.equal(badStart.status, 400);
      const afterBad = await (await fetch(`${url}/record/state`)).json();
      assert.equal(afterBad.armed, false);
      assert.ok(afterBad.storage.frameBytes > 0, 'storage reports frameBytes for live timelapse estimate');
      const normalRate = afterBad.storage.bytesPerSec;

      // Start a 0.25s timelapse via CLI (4 fps instead of 30 fps -> ~7.5x disk savings).
      const startCli = await runNode([CLI_BIN, '--url', url, '--json', 'record', 'start', '--interval', '0.25']);
      assert.equal(startCli.code, 0, startCli.stderr);
      const started = JSON.parse(startCli.stdout);
      assert.equal(started.timelapseIntervalMs, 250);
      assert.ok(started.storage.bytesPerSec < normalRate / 3,
        `expected timelapse rate (${started.storage.bytesPerSec}) far below normal (${normalRate})`);

      // Wait until at least 4 timelapse frames have landed (~1 second of wall time = ~30 raw sensor frames).
      await waitFor(async () => {
        const st = await (await fetch(`${url}/record/state`)).json();
        return st.frames >= 4;
      }, 10000, 'at least 4 timelapse frames');

      // Drop a mark via CLI and verify its sourceMs is on the compressed 30fps timeline.
      const markCli = await runNode([CLI_BIN, '--url', url, '--json', 'record', 'mark']);
      assert.equal(markCli.code, 0, markCli.stderr);

      const stopCli = await runNode([CLI_BIN, '--url', url, '--json', 'record', 'stop']);
      assert.equal(stopCli.code, 0, stopCli.stderr);
      const stoppedState = JSON.parse(stopCli.stdout);
      assert.equal(stoppedState.recording, false);
      assert.equal(stoppedState.timelapseIntervalMs, null);

      // Inspect the resulting take via the library API and index.
      const lib = await (await fetch(`${url}/library/takes`)).json();
      assert.equal(lib.takes.length, 1);
      const take = lib.takes[0];
      assert.equal(take.timelapseIntervalMs, 250);
      assert.ok(take.frames >= 4 && take.frames <= 12, `expected ~4-8 timelapse frames, got ${take.frames}`);
      assert.equal(take.marks.length, 1);
      assert.ok(
        take.marks[0].sourceMs <= take.durationSec * 1000 + 1,
        `mark (${take.marks[0].sourceMs}ms) must land inside compressed take duration (${take.durationSec * 1000}ms)`,
      );

      const index = await buildIndex(join(capturesDir, take.file));
      for (let i = 1; i < index.frames.stampMs.length; i++) {
        const gap = index.frames.stampMs[i] - index.frames.stampMs[i - 1];
        assert.ok(gap === 33 || gap === 34, `expected 30fps gap (33 or 34ms), got ${gap}ms`);
      }
      assert.equal(index.colour.offset.length, 0, 'fake-grabber without --hd emits depth + registered colour only');
    } finally {
      server.kill('SIGTERM');
      await new Promise((done) => server.once('exit', done));
      if (server.exitCode && server.exitCode !== 0 && serverErr) {
        console.error(serverErr);
      }
    }
  });
});

test('MIN_TAKE_SEC remains the disk-space gate for timelapse takes', () => {
  assert.equal(MIN_TAKE_SEC, 120);
});
