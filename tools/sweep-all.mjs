// Every mutation of the named tools, each run judged by `verdictOf` in tools/mutation-verdict.mjs,
// with each tool's list read out of its own refusal of a name it does not declare. A run that
// did not run is tried three times in all. Exits 0 only when every mutation was caught.
//
//   node tools/sweep-all.mjs [--tools a,b] [--jobs N] [--out <dir>]
//
// With no --tools it sweeps the five browser tools, which need a server at SWEEP_URL and hours.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  CAUGHT, DID_NOT_RUN, ENUMERATE, NOT_CAUGHT, ROOT, namesIn, runTool, verdictOf,
} from './mutation-verdict.mjs';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const URL = process.env.SWEEP_URL ?? 'http://localhost:8080';
const TAKE = process.env.SWEEP_TAKE ?? 'fixture-1g';
const OUT = resolvePath(flag('--out') ?? join(ROOT, '.sweep-all'));
const JOBS = Number(flag('--jobs') ?? '1');
const ATTEMPTS = 3;

// What each browser tool is handed beyond `--mutate`. A tool not named here is handed nothing.
const BROWSER_ARGS = {
  library: [],
  timeline: ['--url', URL, '--take', TAKE],
  keyframe: ['--url', URL, '--take', TAKE],
  export: ['--url', URL],
  preview: ['--url', URL],
};
// These mutate in memory or in a private temp copy and bind no port, so concurrent runs cannot
// see each other. Every other tool stages its mutation where a second run would read it.
const CONCURRENT = new Set(['syntax', 'module', 'cpp', 'hd-encoder', 'release-gate']);

const TOOLS = flag('--tools')?.split(',').filter(Boolean) ?? Object.keys(BROWSER_ARGS);
const argsFor = (tool) => BROWSER_ARGS[tool] ?? [];

const refuse = (why) => {
  console.log(`[sweep] DID NOT RUN - ${why}`);
  process.exit(2);
};
if (!Number.isInteger(JOBS) || JOBS < 1) refuse(`--jobs wants a whole number of at least 1, not ${flag('--jobs')}`);
const missing = TOOLS.filter((tool) => !existsSync(join(ROOT, 'tools', `${tool}-check.mjs`)));
if (missing.length) refuse(`no tools/${missing[0]}-check.mjs${missing.length > 1 ? ` (nor ${missing.slice(1).join(', ')})` : ''}`);
const staged = TOOLS.filter((tool) => !CONCURRENT.has(tool));
if (JOBS > 1 && staged.length) refuse(`--jobs ${JOBS} runs mutations side by side, and these stage theirs where a second run would read it: ${staged.join(', ')}`);

mkdirSync(OUT, { recursive: true });
// Removed up front: absent means running, present means finished.
rmSync(join(OUT, 'SUMMARY.txt'), { force: true });

const queue = [];
for (const tool of TOOLS) {
  const { out } = await runTool(tool, [...argsFor(tool), '--mutate', ENUMERATE], { timeoutMs: 120_000 });
  const names = namesIn(out);
  if (names.length === 0) refuse(`${tool}-check named no mutations, so this sweep would assert nothing:\n${out.slice(0, 800)}`);
  console.log(`[sweep] ${tool}: ${names.length} mutations declared`);
  for (const name of names) queue.push({ tool, name });
}

const rows = [];
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { tool, name } = job;
    let result;
    let attempt = 0;
    let run;
    while (attempt < ATTEMPTS) {
      attempt++;
      run = await runTool(tool, [...argsFor(tool), '--mutate', name]);
      writeFileSync(join(OUT, `${tool}-${name}${attempt > 1 ? `.attempt${attempt}` : ''}.log`), run.out);
      result = verdictOf(run);
      if (result.verdict !== DID_NOT_RUN) break;
    }
    rows.push({ tool, name, ...result, code: run.code, signal: run.signal, attempt });
    console.log(`  ${result.verdict.padEnd(11)} ${tool}/${name}  ${result.why}, rc=${run.signal ?? run.code}, attempt ${attempt}`);
    if (result.verdict !== CAUGHT) {
      for (const line of run.out.trimEnd().split('\n').slice(-6)) console.log(`      | ${line}`);
    }
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));

const order = new Map(TOOLS.map((tool, i) => [tool, i]));
rows.sort((a, b) => order.get(a.tool) - order.get(b.tool) || a.name.localeCompare(b.name));
const count = (verdict) => rows.filter((r) => r.verdict === verdict).length;
const totals = [
  ...TOOLS.map((tool) => `${tool}: ${rows.filter((r) => r.tool === tool).length}`),
  `total mutations: ${rows.length}`,
  `caught:          ${count(CAUGHT)}`,
  `not caught:      ${count(NOT_CAUGHT)}`,
  `did not run:     ${count(DID_NOT_RUN)}`,
].join('\n');
const table = rows.map((r) => `${r.tool.padEnd(12)} ${r.name.padEnd(40)} ${r.verdict.padEnd(11)} failed=${String(r.failed ?? '-').padEnd(4)} rc=${r.signal ?? r.code} attempt=${r.attempt}`);
writeFileSync(join(OUT, 'SUMMARY.txt'), `${table.join('\n')}\n--- totals ---\n${totals}\n`);
console.log(`\n${totals}\n[sweep] every row is in ${join(OUT, 'SUMMARY.txt')}, every run's output beside it`);
process.exit(count(CAUGHT) === rows.length ? 0 : 1);
