#!/usr/bin/env node
// What a connected monitor costs the take, measured interleaved on the capture node: three
// arms - no client, a monitor at 1x1, and one at the recording cap - cycling A-B-C inside one
// continuous grabber run, so warm-up and thermal state are common to all three rather than
// confounded with them. The monitor is this process, so the frames cross the real wireless
// link. Read delivered fps first: a run whose A arms miss the floor is thrown away.
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');

const argv = process.argv.slice(2);
const flag = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const has = (n) => argv.includes(n);

const HOST = flag('--host', 'braindancePi.local');
const USER = flag('--user', 'braindancepi');
const KEY = flag('--key', `${process.env.HOME}/.ssh/id_ed25519`);
const DIR = flag('--dir', '~/braindance');
const PORT = Number(flag('--port', '8080'));
const WINDOW = Number(flag('--window', '40'));
const ROUNDS = Number(flag('--rounds', '3'));
// The baseline gate is the spread of the no-client arms rather than an absolute floor: this
// configuration records continuously to the card, so it settles near 28.9 rather than 30, and
// contention shows up as variance and non-monotonicity rather than as absolute level.
const SPREAD = Number(flag('--max-baseline-spread', '0.8'));
const KEEP = has('--keep');
// The instrumentation goes to tmpfs, never to the capture card the take is streaming to.
const LOG = flag('--log-path', '/tmp/monitor-cost.log');
const PIDFILE = '/tmp/monitor-cost.pid';

const ssh = (cmd) => new Promise((resolve, reject) => {
  // `-n` and a remote `< /dev/null` together: ssh does not return while anything holds the channel.
  execFile('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', KEY, `${USER}@${HOST}`, cmd],
    { maxBuffer: 64 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (cond, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await cond()) return true; } catch { /* keep trying */ }
    await wait(1000);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
};

// Start something on the node without waiting for it. `await ssh(...)` cannot launch a
// long-lived remote process, because the backgrounded process keeps holding the channel.
const sshDetached = (cmd) => {
  const child = spawn('ssh', ['-n', '-o', 'BatchMode=yes', '-i', KEY, `${USER}@${HOST}`, cmd],
    { stdio: 'ignore', detached: true });
  child.unref();
};

async function awaitServer(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const out = await ssh(`curl -s --max-time 3 http://127.0.0.1:${PORT}/record/state || true`);
      if (out.trim().startsWith('{')) return JSON.parse(out.trim());
    } catch { /* not up yet */ }
    await wait(2000);
  }
  throw new Error(`the node's server never answered within ${ms}ms - check ${LOG}`);
}

// The sampler that runs on the node. One line a second: node-local epoch, the recorder's durable
// frame count, libfreenect2's dropped-packet counter, and the arm read off the server's own
// answer. The phrase is `skipping depth packet` - `not all subsequences received` is a
// different event, and counting it produced a delta of zero in every arm.
const SAMPLER = (port, log, out) => `
  while true; do
    st=$(curl -s --max-time 2 http://127.0.0.1:${port}/record/state)
    sk=$(grep -c 'skipping depth packet' ${log} 2>/dev/null || echo 0)
    printf '%s\\t%s\\t%s\\n' "$(date +%s%3N)" "$sk" "$st" >> ${out}
    sleep 1
  done`;

function parseSample(line) {
  const [ms, skipped, ...rest] = line.split('\t');
  let state;
  try { state = JSON.parse(rest.join('\t')); } catch { return null; }
  const watching = state.monitors?.watching ?? [];
  // The arm is the server's own answer about what is attached, and anything else is labelled.
  let arm = 'A';
  if (watching.length === 1) arm = watching[0].divisor === 1 && watching[0].stride === 1 ? 'B' : 'C';
  else if (watching.length > 1) arm = '?';
  return { at: Number(ms), skipped: Number(skipped), frames: state.frames ?? 0, arm, watching: watching.length };
}

/** A monitor on this machine, so its frames cross the real wireless link. */
function connect() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/`, { headers: { Origin: `http://${HOST}:${PORT}` } });
  const state = { ws, frames: 0, bytes: 0 };
  ws.on('message', (data, isBinary) => { if (isBinary) { state.frames++; state.bytes += data.length; } });
  state.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  state.set = (divisor, stride) => ws.send(JSON.stringify({ monitor: { divisor, stride } }));
  state.close = () => { try { ws.terminate(); } catch { /* already gone */ } };
  return state;
}

const ARMS = [
  { key: 'A', label: 'no client' },
  { key: 'B', label: 'monitor \u00f71 \u00d71' },
  { key: 'C', label: 'monitor \u00f74 \u00d73' },
];
const SAMPLES = '/tmp/monitor-cost.samples';

// Killed by what they are: `pkill -f` over SSH matches the remote shell running the command itself.
const KILL_SERVER = `ss -tlnp 2>/dev/null | awk '/:${PORT} /{print $NF}' | grep -o 'pid=[0-9]*' `
  + '| cut -d= -f2 | xargs -r kill 2>/dev/null || true';
const KILL_SAMPLER = `for p in $(pgrep -f 'monitor-cost.samples' | grep -v $$); do kill "$p" 2>/dev/null; done || true`;

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

function windowStats(samples) {
  if (samples.length < 6) return null;
  const first = samples[0], last = samples.at(-1);
  const secs = (last.at - first.at) / 1000;
  if (!(secs > 20)) return null;
  // The recorder's counter resets when a take closes, so the teardown window reads as
  // a negative rate.
  if (last.frames < first.frames) return null;
  return {
    recordedFps: (last.frames - first.frames) / secs,
    skipped: last.skipped - first.skipped,
    secs,
  };
}

let rows = [];

try {
  console.log(`[cost] node ${USER}@${HOST}:${PORT}, ${ROUNDS} rounds x ${ARMS.length} arms x ${WINDOW}s`);
  console.log(`[cost] node link:\n${(await ssh('ip -brief addr | grep -v "^lo" | head -3')).trim()
    .split('\n').map((l) => `         ${l}`).join('\n')}`);

  // Listeners are resolved by port through `ss`, whose pipeline contains no text matching itself.
  // The deployed unit is Restart=always, so it is stopped for the run and started
  // again in teardown.
  await ssh(`sudo systemctl stop kinect-node 2>/dev/null || true; `
    + `${KILL_SERVER}; ${KILL_SAMPLER}; rm -f ${LOG} ${SAMPLES}; sleep 1`);
  sshDetached(`cd ${DIR} && XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 `
    + `setsid node server/index.js --standby-after 0 --port ${PORT} --host 0.0.0.0 --record `
    + `--grabber "$PWD/native/build/grabber --log debug" < /dev/null > ${LOG} 2>&1`);
  await awaitServer(40000);
  console.log('[cost] server up; warming up (device open, exposure, first flush) - discarded');
  await wait(25000);
  const armed = await awaitServer(10000);
  if (!(armed.frames > 0)) throw new Error('nothing is being recorded on the node - check ' + LOG);
  console.log(`[cost] recording, ${armed.frames} frames so far`);

  // Shipped base64 rather than quoted: through `bash -c "<script>"` the outer shell expands every
  // `$(...)` and JSON quoting carries \n as two literal characters, so the sampler
  // never ran at all.
  const script = Buffer.from(SAMPLER(PORT, LOG, SAMPLES)).toString('base64');
  sshDetached(`echo ${script} | base64 -d > /tmp/monitor-cost.sh && `
    + 'setsid bash /tmp/monitor-cost.sh < /dev/null > /dev/null 2>&1');
  // The sampler has to be writing before the first window opens. Asserted rather than slept for.
  await waitFor(async () => (await ssh(`wc -l < ${SAMPLES} 2>/dev/null || echo 0`)).trim() >= 3,
    20000, 'the node-side sampler to start writing');

  let live = null;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const arm of ARMS) {
      if (arm.key === 'A') { live?.close(); live = null; } else {
        if (!live) { live = connect(); await live.ready; }
        live.set(arm.key === 'B' ? 1 : 4, arm.key === 'B' ? 1 : 3);
      }
      // Settling, outside every window: the socket has to close or the grant has to land first.
      await wait(4000);
      console.log(`  round ${round} ${arm.key} ${arm.label} - ${WINDOW}s`);
      await wait(WINDOW * 1000);
    }
  }
  live?.close();
  await wait(3000);

  await ssh(`${KILL_SAMPLER}`);
  const raw = await ssh(`cat ${SAMPLES}`);
  const samples = raw.trim().split('\n').map(parseSample).filter(Boolean);
  console.log(`\n[cost] ${samples.length} node-local samples`);

  // Segmented by runs of a constant arm, so transitions fall out as short runs and are dropped.
  const runs = [];
  for (const s of samples) {
    const last = runs.at(-1);
    if (last && last.arm === s.arm) last.samples.push(s);
    else runs.push({ arm: s.arm, samples: [s] });
  }
  for (const run of runs) {
    if (run.arm === '?') continue;
    const st = windowStats(run.samples);
    if (st) rows.push({ arm: run.arm, ...st });
  }
} catch (err) {
  console.error(`\n[cost] the run did not finish: ${err.message}`);
  process.exitCode = 2;
} finally {
  try {
    await ssh(`${KILL_SAMPLER}; `
      + `curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -d '{}' `
      + `http://127.0.0.1:${PORT}/record/stop > /dev/null 2>&1; sleep 1; ${KILL_SERVER}`);
    if (!KEEP) await ssh(`rm -f ${DIR}/captures/*.knct ${DIR}/captures/*.idx || true`);
    await ssh('sudo systemctl start kinect-node 2>/dev/null || true');
    console.log('[cost] kinect-node started again');
  } catch { /* the node going away during teardown is not a result */ }
}

if (rows.length === 0) { console.error('[cost] no usable windows'); process.exit(process.exitCode ?? 2); }

console.log(`\n[cost] method: one grabber, one device open, one continuous recording; `
  + `${ROUNDS} interleaved rounds of ${ARMS.length} arms at ${WINDOW}s each, 4s of settling outside every `
  + `window; first 25s discarded as warm-up before the sampler starts; counters sampled once a second by the `
  + `node itself and pulled afterwards, so the driver never reads across the link under test; each window `
  + `labelled by the server's own list of attached monitors; skipped counted from libfreenect2's `
  + `'skipping depth packet' lines; monitor on the editing machine over Wi-Fi.`);

const baseline = rows.filter((r) => r.arm === 'A');
const spread = Math.max(...baseline.map((r) => r.recordedFps)) - Math.min(...baseline.map((r) => r.recordedFps));
console.log(`\n[cost] arm A delivered ${baseline.map((r) => r.recordedFps.toFixed(2)).join(', ')} fps, `
  + `spread ${spread.toFixed(2)}`);
if (baseline.length < 2 || spread > SPREAD) {
  console.log(`[cost] THROWN AWAY: the no-client arms spread ${spread.toFixed(2)}fps, over the ${SPREAD} this rig `
    + 'settles within, so the node was competing for itself and every other number here is noise. '
    + 'Re-run on a settled node.');
  process.exit(2);
}

console.log('\n| arm | windows | recorded fps (median) | skipped / window (median) |');
console.log('| --- | --- | --- | --- |');
for (const arm of ARMS) {
  const mine = rows.filter((r) => r.arm === arm.key);
  if (!mine.length) { console.log(`| ${arm.label} | 0 | - | - |`); continue; }
  console.log(`| ${arm.label} | ${mine.length} | ${median(mine.map((r) => r.recordedFps)).toFixed(2)} `
    + `| ${median(mine.map((r) => r.skipped))} |`);
}

// Paired within a round, which is the comparison that survives drift over a twenty-minute run.
console.log('\n[cost] paired deltas, each within its own round');
let allSameSign = true;
const byRound = [];
for (let i = 0; i + 2 < rows.length + 1; i += 3) {
  const trio = rows.slice(i, i + 3);
  if (trio.length === 3 && trio[0].arm === 'A' && trio[1].arm === 'B' && trio[2].arm === 'C') byRound.push(trio);
}
for (const [key, idx] of [['B', 1], ['C', 2]]) {
  const pct = byRound.map((t) => ((t[0].recordedFps - t[idx].recordedFps) / t[0].recordedFps) * 100);
  const skip = byRound.map((t) => t[idx].skipped - t[0].skipped);
  if (new Set(pct.map(Math.sign)).size > 1) allSameSign = false;
  console.log(`  ${key} against A: fps cost ${pct.map((p) => `${p.toFixed(1)}%`).join(', ')} `
    + `(median ${pct.length ? median(pct).toFixed(1) : '-'}%), extra skipped ${skip.join(', ')}`);
}
console.log(`\n[cost] ${byRound.length} complete rounds; `
  + `${allSameSign ? 'every paired delta has the same sign' : 'PAIRED DELTAS DISAGREE IN SIGN - noise, not a result'}`);
process.exit(allSameSign ? 0 : 1);
