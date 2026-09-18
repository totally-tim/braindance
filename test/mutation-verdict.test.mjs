// The controls for the one mutation verdict, the one sweep-all reads. Each stub is a real process,
// run through the same `runTool` the sweep uses, so the verdict is asked of an exit and an output
// that came from Node rather than of a string written to look like one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAUGHT, DID_NOT_RUN, NOT_CAUGHT, namesIn, runTool, verdictOf,
} from '../tools/mutation-verdict.mjs';

const dir = mkdtempSync(join(tmpdir(), 'braindance-verdict-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const stub = async (name, body, options = {}) => {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, `${body}\n`);
  return verdictOf(await runTool(name, [], { script, ...options }));
};

test('a tool that prints a FAIL row and then crashes did not run, however red it looked', async () => {
  const { verdict, why } = await stub('fail-then-crash', [
    "console.log('  FAIL  the first row, which fired');",
    "throw new Error('the harness died before its verdict');",
  ].join('\n'));
  assert.equal(verdict, DID_NOT_RUN, why);
});

test('and one that catches its own crash and exits 2 did not run either, whatever it counted', async () => {
  const { verdict } = await stub('declares-its-death', [
    "console.log('  FAIL  a row');",
    "console.log('[stub] 4 assertions ran, 1 failed before the crash');",
    "console.log('[stub] 4 assertions, 1 failed');",
    'process.exit(2);',
  ].join('\n'));
  assert.equal(verdict, DID_NOT_RUN);
});

test('a run killed after printing its count did not run', async () => {
  const { verdict, why } = await stub('killed', [
    "console.log('[stub] 3 assertions, 1 failed');",
    "process.kill(process.pid, 'SIGKILL');",
  ].join('\n'));
  assert.equal(verdict, DID_NOT_RUN, why);
});

test('a run that never ends is killed at the timeout and did not run', async () => {
  const { verdict, why } = await stub('hangs', 'setInterval(() => {}, 1000);', { timeoutMs: 300 });
  assert.equal(verdict, DID_NOT_RUN, why);
});

test('a finished run with a failed assertion is caught, whichever of 0 or 1 it exits', async () => {
  for (const code of [0, 1]) {
    const { verdict, failed } = await stub(`caught-${code}`, [
      "console.log('  FAIL  the row the mutation breaks');",
      "console.log('\\n[stub] 3 assertions, 1 failed');",
      `process.exit(${code});`,
    ].join('\n'));
    assert.equal(verdict, CAUGHT, `exit ${code}`);
    assert.equal(failed, 1);
  }
});

test('a finished run with none failed is not caught, whichever of 0 or 1 it exits', async () => {
  for (const code of [0, 1]) {
    const { verdict } = await stub(`missed-${code}`, `console.log('[stub] 3 assertions, 0 failed');\nprocess.exit(${code});`);
    assert.equal(verdict, NOT_CAUGHT, `exit ${code}`);
  }
});

test('the last count is the verdict, so an earlier red count cannot stand in for a green final one', async () => {
  const { verdict } = await stub('two-counts', [
    "console.log('[stub] 2 assertions, 1 failed');",
    "console.log('[stub] 5 assertions, 0 failed');",
  ].join('\n'));
  assert.equal(verdict, NOT_CAUGHT);
});

test('a tool that says its required row stayed green is not caught, whatever else fired', async () => {
  const { verdict } = await stub('required-row-green', [
    "console.log('[stub] 9 assertions, 2 failed');",
    "console.log('[stub] NOT CAUGHT for the declared reason');",
    'process.exit(1);',
  ].join('\n'));
  assert.equal(verdict, NOT_CAUGHT);
  const quoted = verdictOf({ code: 1, signal: null, out: [
    '[stub] 9 assertions, 2 failed',
    '[stub] it should redden: one row; aimed elsewhere it was NOT CAUGHT, which this closes',
  ].join('\n') });
  assert.equal(quoted.verdict, CAUGHT, 'a description quoting the words is not the tool saying them');
});

test('every count line the swept and CI tools print is read, with its failed count', () => {
  const lines = {
    '124 JavaScript files, 2 failed': 2,
    '[module] 61 assertions, 1 failed': 1,
    '12 assertions, 3 failed': 3,
    '[library] 256 assertions, 4 failed, 1 claim unproven here (reveal)': 4,
    '[timeline] 88 assertions, 5 failed': 5,
    '[keyframe] 70 assertions, 6 failed': 6,
    '[export] 120 assertions, 7 failed': 7,
    '[preview] 80 assertions, 8 failed': 8,
    '[hd-encoder] 14 assertions, 9 failed': 9,
    "mutation 'extra-file': 291 assertions, 10 failed, 1 unproven": 10,
  };
  for (const [line, failed] of Object.entries(lines)) {
    const read = verdictOf({ code: 1, signal: null, out: `  FAIL  a row\n${line}\n` });
    assert.equal(read.failed, failed, line);
    assert.equal(read.verdict, CAUGHT, line);
  }
  const crash = verdictOf({ code: 1, signal: null, out: '[editor] 13 assertions ran, 2 failed before the crash\n' });
  assert.equal(crash.verdict, DID_NOT_RUN, 'a crash line is not a count line');
});

// The shapes the tools print on an unmutated run, as suite reads them: each line below is one a
// tool printed on this tree, with the verdict and the failed/total it has to come to.
const read = (code, lines) => verdictOf({ code, signal: null, out: `${lines.join('\n')}\n` });
const counted = (r) => `${r.failed ?? '?'}/${r.total ?? '?'}`;

test('a count line carries the total beside the failed count, the label and trailing clause aside', () => {
  const cases = [
    [['126 JavaScript files, 0 failed'], NOT_CAUGHT, '0/126'],
    [['vendored tree: 296 assertions, 0 failed, 1 unproven', 'PASS on the source, with the artifact untested here'], NOT_CAUGHT, '0/296'],
    [['[library] 536 assertions, 2 failed, 1 claim unproven here (reveal)'], CAUGHT, '2/536'],
    // A verdict line under the count is not a second count.
    [['  FAIL  a row', '[jobs] 108 assertions, 1 failed', '[jobs] FAIL (1)'], CAUGHT, '1/108'],
  ];
  for (const [lines, verdict, count] of cases) {
    const r = read(0, lines);
    assert.equal(r.verdict, verdict, lines.at(-1));
    assert.equal(counted(r), count, lines.at(-1));
  }
});

test('the tools that print no count line are read by their tally, their test summary or their verdict line', () => {
  const cases = [
    // cli-check's tally, with and without the clause a mutated run adds.
    [0, ['  PASS server up', '122 passed, 0 failed'], NOT_CAUGHT, '0/122'],
    [1, ['  FAIL a row', '120 passed, 2 failed; mutation m: CAUGHT'], CAUGHT, '2/122'],
    // node:test, spec and TAP.
    [0, ['ℹ tests 299', 'ℹ suites 0', 'ℹ pass 299', 'ℹ fail 0'], NOT_CAUGHT, '0/299'],
    [1, ['# tests 12', '# pass 9', '# fail 3'], CAUGHT, '3/12'],
    // A verdict line alone, totalled by its rows, however far a row's label is indented.
    [0, ['  PASS  one', '  PASS    and so on', '  PASS  three', '', '[registry] PASS'], NOT_CAUGHT, '0/3'],
    [1, ['  PASS  one', '  FAIL  two', '  FAIL  three', '[registry] FAIL (2)'], CAUGHT, '2/3'],
    // index-check's bare verdict, which is not one of its rows.
    [0, ['  PASS  a frame', '  PASS  a range', '', 'PASS'], NOT_CAUGHT, '0/2'],
    // determinism-check prints no rows, so it has no total.
    [0, ['[determinism] run 1 vs run 3 (fresh page)     : IDENTICAL', '', '[determinism] PASS'], NOT_CAUGHT, '0/?'],
    [1, ['[determinism] run 1 vs run 3 (fresh page)     : DIFFER at image 2 of 8', '[determinism] FAIL'], CAUGHT, '1/?'],
  ];
  for (const [code, lines, verdict, count] of cases) {
    const r = read(code, lines);
    assert.equal(r.verdict, verdict, lines.at(-1));
    assert.equal(counted(r), count, lines.at(-1));
  }
});

test('and a row is never a verdict: rows with no verdict line did not run, however red', () => {
  const r = read(1, ['  PASS  one', '  FAIL  two', 'Error: the stage came out 320x180 and this file\'s figures are 640x360']);
  assert.equal(r.verdict, DID_NOT_RUN);
  assert.equal(counted(r), '?/?');
  const declined = read(2, ['  FAIL  no hello', '[sensor-view] 86 assertions, 1 failed', '[sensor-view] DID NOT RUN - no sensor']);
  assert.equal(declined.verdict, DID_NOT_RUN, 'exit 2 declines whatever it counted');
  assert.equal(counted(declined), '1/86');
});

test('every refusal shape lists the names a tool declares', () => {
  assert.deepEqual(namesIn('unknown mutation __enumerate__ - have a, b-c, d\n'), ['a', 'b-c', 'd']);
  assert.deepEqual(namesIn("unknown mutation '__enumerate__'; have: a, b\n"), ['a', 'b']);
  assert.deepEqual(namesIn('DID NOT RUN - no mutation named __enumerate__; this tool knows a, b\n'), ['a', 'b']);
  assert.deepEqual(namesIn('Error: something else\n'), []);
  // A thrown refusal echoes the source line that builds it before the message itself.
  assert.deepEqual(namesIn([
    "    throw new Error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);",
    'Error: unknown mutation __enumerate__ - have a, b',
  ].join('\n')), ['a', 'b']);
});
