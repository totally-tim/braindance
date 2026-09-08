// The full sweep, with each tool's mutation list read out of the tool rather than written down
// beside it: every tool refuses an unknown mutation with `have a, b, c`, so that refusal is the
// enumeration. Judged by failed-assertion count and never by exit code, since a refused anchor,
// a Playwright context destruction and a real catch all exit non-zero.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
// Aliased because every promise in this file names its own `resolve`.
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const OUT = resolvePath(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, '.sweep-all'));
const URL = process.env.SWEEP_URL ?? 'http://localhost:8080';
const TAKE = process.env.SWEEP_TAKE ?? 'fixture-1g';
const CRASH = 'Execution context was destroyed';
const TOOLS = ['library', 'timeline', 'keyframe', 'export', 'preview'];

mkdirSync(OUT, { recursive: true });
// Removed up front so the artifact cannot outlive the thing it describes: absent means running,
// present means finished, and a previous run's file otherwise answers for this one.
rmSync(join(OUT, 'SUMMARY.txt'), { force: true });

function run(tool, args, timeoutMs = 900_000) {
  return new Promise((resolve) => {
    const toolArgs = [...args];
    if ((tool === 'timeline' || tool === 'keyframe') && !toolArgs.includes('--take')) {
      toolArgs.push('--take', TAKE);
    }
    const child = spawn('node', [`tools/${tool}-check.mjs`, ...toolArgs], { cwd: ROOT });
    // Decoded through a StringDecoder rather than by concatenating Buffers: a multi-byte sequence
    // straddling a chunk boundary would corrupt the line and silently cost a `  FAIL ` match.
    const decoder = new StringDecoder('utf8');
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => { out += decoder.write(c); });
    child.stderr.on('data', (c) => { out += decoder.write(c); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out += decoder.end();
      resolve({ code, signal, out });
    });
  });
}

// The refusal message is the enumeration, so an unparseable one throws rather than
// yielding no mutations.
async function enumerate(tool) {
  const { out } = await run(tool, ['--mutate', '__enumerate__'], 60_000);
  const m = out.match(/unknown mutation __enumerate__ - have ([^\n]+)/);
  if (!m) throw new Error(`${tool}-check did not enumerate its mutations:\n${out.slice(0, 800)}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const rows = [];
let unproven = 0;

for (const tool of TOOLS) {
  const names = await enumerate(tool);
  console.log(`[sweep] ${tool}: ${names.length} mutations declared`);
  for (const name of names) {
    let attempt = 0;
    for (;;) {
      attempt++;
      const { code, out } = await run(tool, ['--url', URL, '--mutate', name]);
      writeFileSync(join(OUT, `${tool}-${name}.log`), out);
      const fails = (out.match(/^ {2}FAIL /gm) ?? []).length;
      if (fails > 0) {
        rows.push({ tool, name, verdict: 'CAUGHT', fails, code, attempt });
        console.log(`  CAUGHT   ${tool}/${name} fails=${fails} rc=${code} attempt=${attempt}`);
        break;
      }
      if (out.includes(CRASH) && attempt < 3) {
        writeFileSync(join(OUT, `${tool}-${name}.crash${attempt}.log`), out);
        console.log(`  ...crash ${tool}/${name} attempt=${attempt}, retrying`);
        continue;
      }
      rows.push({ tool, name, verdict: 'UNPROVEN', fails: 0, code, attempt });
      unproven++;
      console.log(`  UNPROVEN ${tool}/${name} fails=0 rc=${code} attempt=${attempt}`);
      break;
    }
  }
}

const byTool = Object.fromEntries(TOOLS.map((t) => [t, rows.filter((r) => r.tool === t).length]));
const summary = [
  ...rows.map((r) => `${r.tool.padEnd(9)} ${r.name.padEnd(32)} ${r.verdict.padEnd(9)} fails=${String(r.fails).padEnd(3)} rc=${r.code} attempt=${r.attempt}`),
  '--- totals ---',
  ...TOOLS.map((t) => `${t}: ${byTool[t]}`),
  `total mutations: ${rows.length}`,
  `caught:          ${rows.filter((r) => r.verdict === 'CAUGHT').length}`,
  `unproven:        ${unproven}`,
].join('\n');
writeFileSync(join(OUT, 'SUMMARY.txt'), `${summary}\n`);
console.log(`\n${summary}`);
process.exit(unproven === 0 ? 0 : 1);
