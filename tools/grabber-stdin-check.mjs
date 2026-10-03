#!/usr/bin/env node
// Compile and run the shipped `pollCommands` against a real pipe. No sensor or libfreenect2 build.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;

const EOF_BRANCH = '  if (n == 0) {\n    std::fprintf(stderr, "[grabber] stdin closed, stopping\\n");\n    g_stop = 1;\n  }\n';
const STOP_BRANCH = '    if (line == "stop") {\n';
const MUTATIONS = {
  'eof-never-stops': {
    file: 'native/grabber.cpp',
    edits: [[EOF_BRANCH, EOF_BRANCH.replace('n == 0', 'n == -2')]],
    fails: 'the closed-pipe rows: end-of-file no longer sets the stop flag',
  },
  'would-block-stops': {
    file: 'native/grabber.cpp',
    edits: [[EOF_BRANCH, EOF_BRANCH.replace('n == 0', 'n <= 0')]],
    fails: 'the open-pipe rows: -1 with EAGAIN is read as end-of-file, so a pipe with nothing in it stops the run',
  },
  'eof-drops-the-commands-it-arrives-with': {
    file: 'native/grabber.cpp',
    edits: [[EOF_BRANCH, EOF_BRANCH.replace('    g_stop = 1;\n', '    g_stop = 1;\n    return;\n')]],
    fails: 'the same-pass row: the commands read with the end-of-file are never parsed',
  },
  'stop-line-ignored': {
    file: 'native/grabber.cpp',
    edits: [[STOP_BRANCH, '    if (line == "stop-never-sent") {\n']],
    fails: 'the stop-line rows, while the end-of-file rows stay green',
  },
  'stop-matches-a-prefix': {
    file: 'native/grabber.cpp',
    edits: [[STOP_BRANCH, '    if (line.compare(0, 4, "stop") == 0) {\n']],
    fails: 'the near-miss row: "stopped", "stop now" and the rest stop the run',
  },
};
const fail = (reason) => { console.error(`[grabber-stdin] DID NOT RUN: ${reason}`); process.exit(2); };
if (MUTATE && !MUTATIONS[MUTATE]) fail(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
let source = readFileSync(join(REPO, 'native/grabber.cpp'), 'utf8');
if (MUTATE) for (const [from, to] of MUTATIONS[MUTATE].edits) {
  if (source.split(from).length !== 2) fail(`mutation anchor does not match once: ${from}`);
  source = source.replace(from, to);
}
const start = source.indexOf('// Low light on lets');
const end = source.indexOf('/**\n * Reads a flag given in metres', start);
if (start < 0 || end < 0) fail('pollCommands extraction anchors moved');
const cxx = process.env.CXX || 'c++';
const scratch = mkdtempSync(join(tmpdir(), 'grabber-stdin-'));
try {
  writeFileSync(join(scratch, 'poll-under-test.h'), source.slice(start, end));
  const binary = join(scratch, 'check');
  const build = spawnSync(cxx, ['-std=c++11', '-O1', `-I${scratch}`,
    join(REPO, 'test/fixtures/grabber-stdin.cpp'), '-o', binary], { encoding: 'utf8' });
  if (build.status !== 0) fail(`a C++ compiler is required: ${build.error?.message ?? build.stderr}`);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(run.stdout ?? '');
  const summary = /\[grabber-stdin\] (\d+) assertions, (\d+) failed/.exec(run.stdout ?? '');
  if (!summary || run.error || run.signal || run.status === 2) fail(run.error?.message ?? `the run did not finish (${run.status}, ${run.signal})`);
  const failures = Number(summary[2]);
  if (MUTATE) {
    console.log(`[grabber-stdin] should fail: ${MUTATIONS[MUTATE].fails}`);
    console.log(failures ? `[grabber-stdin] caught (${failures} failed assertions)` : '[grabber-stdin] NOT CAUGHT');
    process.exitCode = 1;
  } else process.exitCode = failures ? 1 : 0;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
