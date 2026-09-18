#!/usr/bin/env node
// Every proof tool that needs no sensor and no native build, in three stages, one verdict line
// each: the offline checks side by side, the tools that spawn their own servers on disjoint ports
// at once, then the tools that share one `--url` server one after another, against a server this
// starts on `--port` and stops.
//
//   node tools/suite.mjs [--port 8431] [--logs <dir>]
//
// Exit 0 when every tool passed, 1 when any failed, 2 when none failed and any did not run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8431'));
const URL_BASE = `http://127.0.0.1:${PORT}`;
const LOGS = flag('--logs') ?? mkdtempSync(join(tmpdir(), 'braindance-suite-'));
const TOOL_TIMEOUT_MS = 30 * 60_000;
mkdirSync(LOGS, { recursive: true });

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const unitFiles = () => readdirSync(join(REPO, 'test')).filter((f) => f.endsWith('.test.mjs')).sort()
  .map((f) => join('test', f));

// The suite, stage by stage. `ports` are the fixed ports a tool binds, probed before it starts.
const OFFLINE = [
  { name: 'syntax-check' },
  { name: 'module-check' },
  { name: 'cpp-check' },
  { name: 'unit', argv: () => ['--test', '--test-reporter=spec', ...unitFiles()] },
  { name: 'release-gate-check' },
  { name: 'vendor-check' },
];
const SELF_SPAWNING = [
  { name: 'guard-check', ports: [8321] },
  { name: 'boot-check', ports: [8391] },
  { name: 'monitor-check', ports: [8341] },
  { name: 'level-check', ports: [8377] },
  { name: 'vcam-check', ports: [8361] },
  { name: 'cli-check', ports: [8401] },
  { name: 'jobs-check', ports: [8231, 8232] },
  { name: 'effect-check', ports: [8281] },
  { name: 'library-check', ports: range(8210, 8227) },
];
const ON_ONE_SERVER = [
  { name: 'registry-check' },
  { name: 'timeline-check', args: ['--take', 'fixture-1g'] },
  { name: 'keyframe-check', args: ['--take', 'fixture-1g'] },
  { name: 'export-check' },
  { name: 'editor-check', args: ['--take', 'fixture-1g'] },
  { name: 'preview-check', args: ['--take', 'fixture-1g'] },
  { name: 'effect-conformance-check' },
  { name: 'determinism-check' },
  { name: 'sensor-view-check', ports: [8131] },
  { name: 'index-check' },
];
// A check tool this file neither runs nor leaves out by name is reported as not run, so a new tool
// is asked about by existing.
const LEFT_OUT = {
  'hd-encoder-check': 'compiles and runs native code against TurboJPEG',
  'decoder-check': 'needs vendor/prefix and the built grabber',
  'registration-check': 'needs a corpus from grabber --dump-corpus',
};

// The fixtures the tools above ask for, each built by the tool that makes it and only when absent:
// timeline, keyframe, editor and preview need a long take, index-check a file past 2 GiB, and
// editor-check four openable takes.
const FIXTURES = [
  ['captures/sample.knct', ['tools/make-sample.mjs', 'captures/sample.knct', '--if-missing']],
  ['captures/fixture-1g.knct', ['tools/make-fixture.js', 'captures/sample.knct', 'captures/fixture-1g.knct', '--loops', '8']],
  ['captures/fixture-large.knct', ['tools/make-fixture.js', 'captures/sample.knct', 'captures/fixture-large.knct', '--loops', '18']],
  ['captures/fixture-2x.knct', ['tools/make-fixture.js', 'captures/sample.knct', 'captures/fixture-2x.knct', '--loops', '2']],
];

/**
 * The failed and total assertions a tool printed, either null when it printed none. Most print
 * `N assertions, M failed`; the rest are read in the shape each one prints, and a tool that prints
 * no total is counted by its `PASS` and `FAIL` rows.
 */
function countOf(out) {
  const last = (re) => [...out.matchAll(re)].at(-1);
  let m = last(/^(?:\[[\w-]+\] |[^\n:]+: )?(\d+) (?:assertions|JavaScript files)(?: ran)?, (\d+|none) failed/gm);
  if (m) return { failed: m[2] === 'none' ? 0 : Number(m[2]), total: Number(m[1]) };
  m = last(/^(?:\[[\w-]+\] )?(\d+)\/(\d+) passed, (\d+) failed/gm);
  if (m) return { failed: Number(m[3]), total: Number(m[2]) };
  m = last(/^(\d+) passed, (\d+) failed/gm);
  if (m) return { failed: Number(m[2]), total: Number(m[1]) + Number(m[2]) };
  m = last(/^\[[\w-]+\] PASS \((\d+) assertions\)$/gm);
  if (m) return { failed: 0, total: Number(m[1]) };
  m = last(/^\[[\w-]+\] FAIL \((\d+)\/(\d+) assertions failed\)$/gm);
  if (m) return { failed: Number(m[1]), total: Number(m[2]) };
  const tests = last(/^[ℹ#] tests (\d+)$/gm);
  const fails = last(/^[ℹ#] fail (\d+)$/gm);
  if (tests && fails) return { failed: Number(fails[1]), total: Number(tests[1]) };
  const rows = [...out.matchAll(/^ {2}(PASS|FAIL) +\S/gm)];
  const total = rows.length || null;
  m = last(/^(?:\[[\w-]+\] )?FAIL \((\d+)\)$/gm) ?? last(/^(\d+) failed$/gm);
  if (m) return { failed: Number(m[1]), total };
  if (last(/^(?:\[[\w-]+\] )?PASS$/gm)) return { failed: 0, total };
  if (last(/^(?:\[[\w-]+\] )?FAIL$/gm)) return { failed: Math.max(1, rows.filter((r) => r[1] === 'FAIL').length), total };
  return { failed: null, total };
}

/** The line a run that did not finish is explained by: its own refusal, the error, or its last word. */
function whyOf(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(?:\[[\w-]+\] )?DID NOT RUN\b/.test(l))
    ?? lines.find((l) => /^(?:\w*Error|page\.\w+): /.test(l))
    ?? lines.filter((l) => !/^Node\.js v/.test(l)).at(-1) ?? 'no output';
}

/**
 * PASS, FAIL or DID NOT RUN. FAIL is a finished run with a failed assertion. A run finished when it
 * exited 0 or 1 with its count printed; exit 2 is a tool declining, and zero failed with exit 1 is
 * a crash rather than a pass.
 */
function verdictOf({ code, signal, out, timedOut }) {
  const { failed, total } = countOf(out);
  const counted = { failed, total };
  if (timedOut) return { verdict: 'DID NOT RUN', ...counted, why: `killed after ${TOOL_TIMEOUT_MS / 60_000} minutes` };
  if (signal || code === null) return { verdict: 'DID NOT RUN', ...counted, why: `killed by ${signal}` };
  if (code !== 0 && code !== 1) return { verdict: 'DID NOT RUN', ...counted, why: `exit ${code}: ${whyOf(out)}` };
  if (failed === null) return { verdict: 'DID NOT RUN', ...counted, why: `no assertion count: ${whyOf(out)}` };
  if (failed > 0) return { verdict: 'FAIL', ...counted, why: '' };
  if (code !== 0) return { verdict: 'DID NOT RUN', ...counted, why: `exit 1 with nothing failed: ${whyOf(out)}` };
  return { verdict: 'PASS', ...counted, why: '' };
}

/** Whether something accepts a connection on this loopback port. */
const listening = (port) => new Promise((resolve) => {
  const socket = new Socket();
  const done = (held) => { socket.destroy(); resolve(held); };
  socket.setTimeout(500, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.connect(port, '127.0.0.1');
});

const children = new Set();

/** Runs one tool to its end, its output kept whole in the log directory. */
function runTool(entry) {
  const script = entry.argv ? null : join('tools', `${entry.name}.mjs`);
  const args = entry.argv ? entry.argv() : [script, ...(entry.args ?? [])];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const decoder = new StringDecoder('utf8');
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TOOL_TIMEOUT_MS);
    child.stdout.on('data', (c) => { out += decoder.write(c); });
    child.stderr.on('data', (c) => { out += decoder.write(c); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      out += decoder.end();
      writeFileSync(join(LOGS, `${entry.name}.log`), `$ node ${args.join(' ')}\n${out}\nexit ${code ?? signal}\n`);
      resolve({ name: entry.name, seconds: (Date.now() - started) / 1000, ...verdictOf({ code, signal, out, timedOut }) });
    });
  });
}

const results = [];
function report(r) {
  results.push(r);
  const count = `${r.failed ?? '?'}/${r.total ?? '?'}`;
  console.log(`  ${r.verdict.padEnd(11)}  ${r.name.padEnd(25)} ${count.padStart(8)}  ${r.seconds.toFixed(1).padStart(6)}s`
    + `${r.why ? `  ${r.why.slice(0, 160)}` : ''}`);
}

/** A tool whose port something else answers on is not run: the stranger would answer it. */
async function heldPort(entry) {
  for (const port of entry.ports ?? []) {
    if (await listening(port)) return port;
  }
  return null;
}

async function runStage(title, entries, { together }) {
  console.log(`\n[suite] ${title}`);
  const t0 = Date.now();
  const one = async (entry) => {
    const port = await heldPort(entry);
    if (port !== null) {
      report({ name: entry.name, verdict: 'DID NOT RUN', failed: null, total: null, seconds: 0,
        why: `port ${port} already has a listener` });
      return;
    }
    report(await runTool(entry));
  };
  if (together) await Promise.all(entries.map(one));
  else for (const entry of entries) await one(entry);
  console.log(`  stage wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

let server = null;
let storeRoot = null;

async function startServer() {
  if (await listening(PORT)) throw new Error(`port ${PORT} already has a listener; pick another with --port`);
  storeRoot = mkdtempSync(join(tmpdir(), 'braindance-suite-store-'));
  const store = (name) => join(storeRoot, name);
  server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--standby-after', '0',
    '--grabber', `${process.execPath} tools/fake-grabber.mjs --hd`,
    '--projects', store('projects'), '--presets', store('presets'), '--effects', store('effects'),
    '--deliverables', store('deliverables'), '--jobs', store('jobs')],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  server.stdout.on('data', (c) => log.push(c.toString()));
  server.stderr.on('data', (c) => log.push(c.toString()));
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null || server.signalCode !== null) break;
    if (await fetch(`${URL_BASE}/library/takes`).then((r) => r.ok).catch(() => false)) return log;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error(`the server never answered on ${PORT}:\n${log.join('').slice(-2000)}`);
}

async function stopServer() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => { server.once('exit', resolve); });
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  server = null;
  if (storeRoot) rmSync(storeRoot, { recursive: true, force: true });
  storeRoot = null;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const child of children) child.kill('SIGTERM');
    await stopServer();
    process.exit(130);
  });
}

const t0 = Date.now();
console.log(`[suite] node ${process.version}, logs in ${LOGS}`);

const known = new Set([...OFFLINE, ...SELF_SPAWNING, ...ON_ONE_SERVER].map((e) => e.name));
const unknown = readdirSync(join(REPO, 'tools'))
  .filter((f) => /-check\.mjs$/.test(f))
  .map((f) => f.replace(/\.mjs$/, ''))
  .filter((name) => !known.has(name) && !Object.hasOwn(LEFT_OUT, name));

console.log('\n[suite] fixtures');
mkdirSync(join(REPO, 'captures'), { recursive: true });
for (const [path, command] of FIXTURES) {
  if (existsSync(join(REPO, path))) {
    console.log(`  have   ${path}`);
    continue;
  }
  const f0 = Date.now();
  const made = spawnSync(process.execPath, command, { cwd: REPO, encoding: 'utf8' });
  const said = `${made.stdout ?? ''}${made.stderr ?? ''}`.trim().split('\n').at(-1);
  console.log(`  ${made.status === 0 ? 'built ' : 'FAILED'} ${path} in ${((Date.now() - f0) / 1000).toFixed(1)}s: ${said}`);
}

await runStage('offline checks, side by side', OFFLINE, { together: true });
await runStage('tools with their own servers, at once', SELF_SPAWNING, { together: true });

console.log(`\n[suite] a server on ${PORT} for the tools that share one`);
const serverFailure = await startServer().then(() => null, (err) => err);
if (serverFailure) {
  for (const entry of ON_ONE_SERVER) {
    report({ name: entry.name, verdict: 'DID NOT RUN', failed: null, total: null, seconds: 0,
      why: serverFailure.message.split('\n')[0] });
  }
} else {
  await runStage(`tools against ${URL_BASE}, one after another`,
    ON_ONE_SERVER.map((e) => ({ ...e, args: ['--url', URL_BASE, ...(e.args ?? [])] })), { together: false });
}
await stopServer();

if (unknown.length || Object.keys(LEFT_OUT).length) console.log('\n[suite] not in the suite');
for (const name of unknown) {
  report({ name, verdict: 'DID NOT RUN', failed: null, total: null, seconds: 0, why: 'tools/suite.mjs does not name it' });
}
for (const [name, why] of Object.entries(LEFT_OUT)) console.log(`  ${'left out'.padEnd(11)}  ${name.padEnd(25)} ${why}`);

const tally = (v) => results.filter((r) => r.verdict === v).length;
console.log(`\n[suite] ${results.length} tools: ${tally('PASS')} PASS, ${tally('FAIL')} FAIL, ${tally('DID NOT RUN')} DID NOT RUN, `
  + `in ${((Date.now() - t0) / 1000).toFixed(0)}s; logs in ${LOGS}`);
process.exit(tally('FAIL') ? 1 : tally('DID NOT RUN') ? 2 : 0);
