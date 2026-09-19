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
