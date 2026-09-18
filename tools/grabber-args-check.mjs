#!/usr/bin/env node
// The grabber refuses a depth-clip range it cannot honour, and says which text it refused, before
// it looks for a device. `--min-depth`/`--max-depth` clip before a frame is built, so a range the
// grabber misreads records a normal-sized take with nothing in it.
//
// Builds the grabber through `tools/build-native.mjs` on every run, the one build `decoder-check`
// and the server use, because `native/build/grabber` can be older than the source beside it. A
// mutation edits `native/grabber.cpp` in place and is undone, and rebuilt, on every way out of the
// process. Every vector leads with `--check`, which runs the argument pass and exits before
// enumeration, so no row touches a device on a machine that has one. Needs what build-native needs,
// and the libfreenect2 it installs into `vendor/prefix`. No sensor, no server, no fixture.
//
// Exit 0 pass, 1 a failed assertion or a mutation run (caught or NOT CAUGHT), 2 did not run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
const PREFIX = join(REPO, 'vendor/prefix');
const GRABBER = join(REPO, 'native/build/grabber');

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

// build-native checks the binary it made answers `--help` with the pipelines and decoders it was
// asked for, so a zero exit is a grabber that runs against this prefix.
const rebuild = (why) => {
  const r = spawnSync(process.execPath, [join(REPO, 'tools/build-native.mjs')], { encoding: 'utf8' });
  if (r.status === 0) return true;
  console.error(`[grabber-args] the rebuild ${why} did not complete:\n`
    + `${(r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n')}`);
  return false;
};

const binaryHash = () => (existsSync(GRABBER) ? createHash('sha256').update(readFileSync(GRABBER)).digest('hex') : null);

// The make cmake drives here can compare timestamps to the second, so a source written in the second
// the object was built in reads as up to date and the rebuild keeps the old binary: measured, as a
// mutation NOT CAUGHT against a grabber built from the unmutated source. Written after that second.
const writeSource = (file, text) => {
  if (existsSync(GRABBER)) {
    const after = (Math.floor(statSync(GRABBER).mtimeMs / 1000) + 1) * 1000 - Date.now();
    if (after > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, after + 20);
  }
  writeFileSync(file, text);
};

// The mutated source goes back and is rebuilt on every way out, a refusal included, or the next
// tool is handed a tree that reads clean and a binary that is not built from it.
let pending = null;
const restore = () => {
  if (!pending) return;
  const { file, text, mutated } = pending;
  pending = null;
  writeSource(file, text);
  console.log(`[grabber-args] restored ${file.replace(`${REPO}/`, '')}, rebuilding`);
  if (!rebuild('after restoring the source') || binaryHash() === mutated) {
    console.error(`[grabber-args] ${file.replace(`${REPO}/`, '')} is back but native/build/grabber is`
      + ' still the mutated build - run `npm run build:native` before trusting anything');
  }
};
process.on('exit', restore);

const started = Date.now();
if (MUTATE) {
  const { file: rel, edits } = MUTATIONS[MUTATE];
  const file = join(REPO, rel);
  const original = readFileSync(file, 'utf8');
  let text = original;
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) didNotRun(`mutation ${MUTATE} matched ${hits} times in ${rel}, expected exactly 1`);
    text = text.replace(from, to);
  }
  // Built from the tree as it stands first, so the mutated build has a binary to differ from.
  if (!rebuild('of this tree\'s source')) didNotRun('build-native failed');
  const before = binaryHash();
  pending = { file, text: original };
  writeSource(file, text);
  if (!rebuild('with the mutation applied')) didNotRun('build-native failed');
  pending.mutated = binaryHash();
  // A mutation that never reached the binary reads as NOT CAUGHT, the same line a blind row prints.
  if (pending.mutated === before) didNotRun(`the rebuild with ${MUTATE} applied left native/build/grabber unchanged`);
} else if (!rebuild('of this tree\'s source')) didNotRun('build-native failed');

console.log(`\n[grabber-args] ${MUTATE ? `mutation ${MUTATE}` : 'unmutated'}, built by build-native in `
  + `${((Date.now() - started) / 1000).toFixed(1)}s\n`);

/** One run of the grabber's argument pass. `--check` leads, so no vector can take it as a value. */
const run = async (args) => {
  const r = spawnSync(GRABBER, ['--check', ...args], { encoding: 'utf8', timeout: 15000 });
  return { code: r.status, signal: r.signal, stderr: r.stderr ?? '' };
};

let checked = 0, failed = 0;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const lastLine = (r) => r.stderr.trim().split('\n').at(-1) ?? '';
const said = (r) => `exit ${r.code ?? r.signal}: ${lastLine(r)}`;

// What `--check` prints when the whole argument pass let the vector through.
const ACCEPTED = /\[grabber\] arguments accepted: /;

/** Refused in the argument pass, with this sentence. */
const refused = (r, sentence) => r.code === 2 && sentence(r.stderr) && !ACCEPTED.test(r.stderr);
/** Through every argument check, which only `--check`'s own line says. */
const accepted = (r) => r.code === 0 && ACCEPTED.test(r.stderr);

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
    ok(`refused in the argument pass: ${flag} '${raw}', ${what}`, refused(r, parseRefusal(flag, raw)), said(r));
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
  console.log('\n4. a range the sensor can honour gets through the argument pass');
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
    ok(`accepted: ${what}`, accepted(r), `${args.join(' ') || '(none)'} -> ${said(r)}`);
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
