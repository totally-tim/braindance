#!/usr/bin/env node
// The grabber refuses a depth-clip range it cannot honour, and says which text it refused, before
// it looks for a device. `--min-depth`/`--max-depth` clip before a frame is built, so a range the
// grabber misreads records a normal-sized take with nothing in it.
//
// Builds the grabber from this tree's `native/` into a scratch directory, with the mutation applied
// to that copy, then runs it with argument vectors and reads the exit code and stderr. The binary
// under test is always the one this source builds: `native/build/grabber` can be older than the
// source beside it. Needs libfreenect2 in `vendor/prefix` (`node tools/build-native.mjs`), cmake and
// a C++ compiler. No sensor, no server, no fixture.
//
// Exit 0 pass, 1 a failed assertion or a mutation run (caught or NOT CAUGHT), 2 did not run.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageParser, TYPE_HELLO } from '../server/protocol.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
const PREFIX = join(REPO, 'vendor/prefix');
// Long enough for a sensor-attached run to reach its hello, which is the answer an accepted row
// waits for on a capture node.
const RUN_MS = 15000;

const MUTATIONS = {
  // The pair rule, and only it: every value still parses, and an inverted range reaches the device.
  'clip-accepts-inverted-range': {
    file: 'native/grabber.cpp',
    edits: [['  if (!(minDepth < maxDepth)) {', '  if (false) {']],
    fails: 'the four pair rows - swapped, equal, and each flag alone against the other\'s default',
  },
  // `std::atof`'s behaviour: the leading number is kept and whatever follows it is dropped.
  'depth-takes-a-numeric-prefix': {
    file: 'native/grabber.cpp',
    edits: [["  if (end == text || *end != '\\0') return false;", '  if (end == text) return false;']],
    fails: 'the comma-decimal, trailing-unit and trailing-space rows; the pair rows stay green',
  },
  // `nan` then still meets the pair rule, which refuses it under its own sentence; the row asks for
  // the parse's sentence, which is what separates the two rules.
  'depth-accepts-non-finite': {
    file: 'native/grabber.cpp',
    edits: [['  if (!std::isfinite(v)) return false;\n', '']],
    fails: 'the nan and inf rows',
  },
  'depth-accepts-zero-or-negative': {
    file: 'native/grabber.cpp',
    edits: [['  if (v <= 0.0f) return false;\n', '']],
    fails: 'the zero and negative rows',
  },
};

const didNotRun = (reason) => {
  console.log(`[grabber-args] DID NOT RUN - ${reason}`);
  process.exit(2);
};

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}
if (!existsSync(join(PREFIX, 'include/libfreenect2/libfreenect2.hpp'))) {
  didNotRun(`no libfreenect2 build in ${PREFIX} - run node tools/build-native.mjs`);
}
if (spawnSync('cmake', ['--version'], { stdio: 'ignore' }).status !== 0) didNotRun('cmake is not on PATH');

// Staged outside the checkout, so a mutation can never be left in the tree by a run that died.
const STAGE = mkdtempSync(join(tmpdir(), 'grabber-args-'));
process.on('exit', () => rmSync(STAGE, { recursive: true, force: true }));

cpSync(join(REPO, 'native'), join(STAGE, 'native'), {
  recursive: true,
  filter: (from) => from !== join(REPO, 'native/build'),
});
if (MUTATE) {
  const { file, edits } = MUTATIONS[MUTATE];
  const path = join(STAGE, file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) didNotRun(`mutation ${MUTATE} matched ${hits} times in ${file}, expected exactly 1`);
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

const build = (args) => {
  const r = spawnSync('cmake', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    didNotRun(`cmake ${args.join(' ')} failed:\n${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-15).join('\n')}`);
  }
};
const started = Date.now();
build(['-S', join(STAGE, 'native'), '-B', join(STAGE, 'build'), `-DFREENECT2_ROOT=${PREFIX}`]);
build(['--build', join(STAGE, 'build'), '--target', 'grabber']);
const GRABBER = join(STAGE, 'build/grabber');
// A binary that cannot load its library would fail every row for a reason none of them names.
const help = spawnSync(GRABBER, ['--help'], { encoding: 'utf8' });
if (help.status !== 0) didNotRun(`the built grabber will not run --help: ${(help.stderr || help.error?.message || '').trim()}`);

console.log(`\n[grabber-args] ${MUTATE ? `mutation ${MUTATE}` : 'unmutated'}, built from native/ in `
  + `${((Date.now() - started) / 1000).toFixed(1)}s\n`);

/**
 * One run of the grabber. Stops at the first hello, because an accepted vector on a machine with a
 * sensor opens it and streams; SIGKILL after the grace, because a grabber can hang in `dev->stop()`.
 */
const run = (args) => new Promise((resolve) => {
  const child = spawn(GRABBER, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const parser = new MessageParser();
  let stderr = '';
  let hello = false;
  let timedOut = false;
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  child.stdout.on('data', (c) => {
    try {
      if (!hello && parser.push(c).some((m) => m.type === TYPE_HELLO)) {
        hello = true;
        child.kill('SIGTERM');
      }
    } catch { /* a desynced stream is not a hello */ }
  });
  const kill = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, RUN_MS);
  const force = setTimeout(() => child.kill('SIGKILL'), RUN_MS + 8000);
  child.on('close', (code, signal) => {
    clearTimeout(kill);
    clearTimeout(force);
    resolve({ code, signal, stderr, hello, timedOut });
  });
});

let checked = 0, failed = 0;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const lastLine = (r) => r.stderr.trim().split('\n').at(-1) ?? '';
const said = (r) => `exit ${r.code ?? r.signal}: ${lastLine(r)}`;

// What any refusal prints, and what only a run that got past the arguments prints.
const REFUSAL = /\[grabber\] (--[a-z-]+ must be|unknown argument)/;
const DEVICE_STAGE = /\[grabber\] (no Kinect v2 found|failed to open device|device start failed)|\[Freenect2Impl\]/;

/** Refused before anything was attempted, with this sentence. */
const refused = (r, sentence) => r.code === 2 && sentence(r.stderr) && !DEVICE_STAGE.test(r.stderr) && !r.hello;
/** Got past every argument check: it went looking for a sensor, and found none or found one. */
const accepted = (r) => r.code !== 2 && !REFUSAL.test(r.stderr) && !r.timedOut
  && (r.hello || /\[grabber\] (no Kinect v2 found|failed to open device|device start failed)/.test(r.stderr));

const parseRefusal = (flag, raw) => (stderr) => stderr.includes(`[grabber] ${flag} must be a positive finite number of metres, got '${raw}'`);
// The pair sentence reports the values that survived the parse, at %.3f.
const pairRefusal = (min, max) => (stderr) => {
  const m = /\[grabber\] --min-depth (\S+) must be less than --max-depth (\S+)/.exec(stderr);
  return Boolean(m) && Math.abs(Number(m[1]) - min) < 5e-4 && Math.abs(Number(m[2]) - max) < 5e-4;
};

try {
  console.log('1. a depth flag the parse cannot read exactly is refused, quoting the text as typed');
  const unreadable = [
    ['--max-depth', '4,5', 'a comma decimal, which std::atof read as 4'],
    ['--max-depth', '4.5m', 'a trailing unit'],
    ['--max-depth', '4.5 ', 'a trailing space'],
    ['--max-depth', '', 'an empty value'],
    ['--min-depth', '0', 'zero'],
    ['--min-depth', '-1', 'a negative'],
    ['--max-depth', 'nan', 'nan, which strtof parses cleanly'],
    ['--max-depth', 'inf', 'inf, which strtof parses cleanly'],
    ['--max-depth', '1e40', 'a value past the float range'],
  ];
  for (const [flag, raw, what] of unreadable) {
    const r = await run([flag, raw]);
    ok(`refused before any device: ${flag} '${raw}', ${what}`, refused(r, parseRefusal(flag, raw)), said(r));
  }

  console.log('\n2. a pair that leaves no depth between the two planes is refused');
  const pairs = [
    [['--min-depth', '4.5', '--max-depth', '0.5'], 4.5, 0.5, 'a swapped pair'],
    [['--min-depth', '2', '--max-depth', '2'], 2, 2, 'an equal pair'],
    [['--min-depth', '10'], 10, 9, '--min-depth alone, above the default ceiling of 9'],
    [['--max-depth', '0.04'], 0.05, 0.04, '--max-depth alone, below the default floor of 0.05'],
  ];
  for (const [args, min, max, what] of pairs) {
    const r = await run(args);
    ok(`refused, naming both values: ${what}`, refused(r, pairRefusal(min, max)), said(r));
  }

  // The rest of the refusal block, so a mutation that broke the block wholesale is told apart from
  // one confined to the depth pair.
  console.log('\n3. the refusals beside the depth pair still hold');
  {
    const quality = await run(['--quality', '0']);
    ok('--quality 0 exits 2 with its own sentence',
      refused(quality, (s) => s.includes("[grabber] --quality must be an integer 1-100, got '0'")), said(quality));
    const missing = await run(['--max-depth']);
    ok('--max-depth with no value exits 2 as a missing value',
      refused(missing, (s) => s.includes("[grabber] unknown argument or missing value: '--max-depth'")), said(missing));
  }

  // The positive twins: a check built only out of refusals passes a grabber that refuses everything.
  console.log('\n4. a range the sensor can honour gets past the arguments to the device');
  const honoured = [
    [[], 'no depth flags at all'],
    [['--min-depth', '0.05', '--max-depth', '9.0'], 'the shipped defaults typed out'],
    [['--min-depth', '0.5', '--max-depth', '4.5'], 'libfreenect2\'s own 0.5 to 4.5'],
    [['--min-depth', '4.499', '--max-depth', '4.5'], 'a range one millimetre deep'],
    [['--min-depth', '5e-1'], 'exponent notation'],
    [['--max-depth', '100'], 'a ceiling past the sensor\'s reach, which the u16 conversion floors'],
  ];
  for (const [args, what] of honoured) {
    const r = await run(args);
    ok(`accepted: ${what}`, accepted(r), `${args.join(' ') || '(none)'} -> ${said(r)}${r.hello ? ', hello on stdout' : ''}`);
  }
} catch (err) {
  // Not a FAIL line: a crash counted as a failed assertion reads as a catch under --mutate.
  console.log(`\n[grabber-args] ${checked} assertions, ${failed} failed`);
  didNotRun(`the run did not finish: ${err.message}. Nothing here is a finding: re-run it`);
}

console.log(`\n[grabber-args] ${checked} assertions, ${failed} failed`);
if (MUTATE) {
  console.log(`[grabber-args] it should redden: ${MUTATIONS[MUTATE].fails}`);
  if (failed === 0) console.log('[grabber-args] NOT CAUGHT - the check passed a grabber it should have rejected');
  else console.log(`[grabber-args] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[grabber-args] FAIL'); process.exit(1); }
console.log('[grabber-args] PASS');
process.exit(0);
