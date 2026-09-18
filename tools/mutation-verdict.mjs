// The one reading of a mutation run, which sweep-all grades every run by. A run is CAUGHT when the
// tool finished with at least one failed assertion, NOT CAUGHT when it finished with none, and DID
// NOT RUN otherwise. Finished means the tool printed its assertion count and exited 0 or 1: a
// `FAIL` row printed on the way to a crash is not a verdict, and exit 2 is a tool declining.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CAUGHT = 'CAUGHT';
export const NOT_CAUGHT = 'NOT CAUGHT';
export const DID_NOT_RUN = 'DID NOT RUN';

// The count line a tool prints once it reaches its verdict: `[tool] N assertions, M failed`, with
// an optional label and trailing clause. syntax-check counts files where the others count
// assertions.
const COUNT = /^(?:\[[\w-]+\] |[^\n:]+: )?\d+ (?:assertions|JavaScript files), (\d+) failed(?:,[^\n]*)?$/gm;

// A tool whose catch needs one named row prints `[tool] NOT CAUGHT` when that row stayed green,
// and that outranks a count holding other rows. Anchored to the line start, because a mutation's
// own description can quote the words.
const MISS = /^(?:\[[\w-]+\] )?NOT CAUGHT\b/m;

// The refusal every tool gives a name it does not declare, which lists the ones it does. Keyed on
// the name asked, because a tool that throws the refusal also echoes the source line building it.
export const ENUMERATE = '__enumerate__';
const NAMES = new RegExp(`(?:unknown mutation ${ENUMERATE} - have|unknown mutation '${ENUMERATE}'; have:`
  + `|no mutation named ${ENUMERATE}; this tool knows) ([^\\n]+)`);

/** What one finished or unfinished run of a tool under `--mutate` says about that mutation. */
export function verdictOf({ code, signal, out }) {
  const counts = [...out.matchAll(COUNT)];
  const failed = counts.length ? Number(counts.at(-1)[1]) : null;
  if (signal || code === null) return { verdict: DID_NOT_RUN, failed, why: `killed by ${signal ?? 'an unknown signal'}` };
  if (code !== 0 && code !== 1) return { verdict: DID_NOT_RUN, failed, why: `exit ${code}, the tool declining` };
  if (failed === null) return { verdict: DID_NOT_RUN, failed, why: 'no assertion count, so it stopped before its verdict' };
  if (failed === 0) return { verdict: NOT_CAUGHT, failed, why: 'every assertion stayed green' };
  if (MISS.test(out)) return { verdict: NOT_CAUGHT, failed, why: 'the tool says its required row stayed green' };
  return { verdict: CAUGHT, failed, why: `${failed} failed` };
}

/** The mutation names a tool declares, read off its refusal of `--mutate __enumerate__`. */
export function namesIn(out) {
  const m = NAMES.exec(out);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Runs `tools/<tool>-check.mjs` with `args` under this Node, and hands back its exit and output. */
export function runTool(tool, args, { timeoutMs = 900_000, script = join(ROOT, 'tools', `${tool}-check.mjs`) } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT });
    // A multi-byte sequence split across two chunks would otherwise corrupt the count line.
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
