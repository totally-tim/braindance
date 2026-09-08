#!/usr/bin/env node
// Summarises `grabber --profile` output: one line per segment, plus the two numbers that
// decide whether the run is worth reading. Delivered fps is a health number rather than a
// result - a run that does not sustain ~30.0 was competing for the machine.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
// Flags are filtered out of the positional pair rather than counted into it: `prof-summary
// file --json` used to read '--json' as the warmup, and Number('--json') is NaN, which slices
// nothing off and reports a warmup of NaN on a run that discarded none of it.
const positional = args.filter((a) => !a.startsWith('--'));
const file = positional[0];
const warmup = Number(positional[1] ?? 60);
const json = args.includes('--json');

if (!file) {
  console.error('usage: prof-summary.mjs <profile> [warmup] [--json]');
  process.exit(2);
}
if (!Number.isInteger(warmup) || warmup < 0) {
  console.error(`warmup must be a whole number of frames to discard, got '${positional[1]}'`);
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('[prof] '));
const header = lines.find((l) => l.includes('arrival_us'));
// The column order a grabber built from this tree writes. Used only when the file carries no
// header line at all, so a hand-trimmed profile still reads.
const FALLBACK = ['n', 'arrival_us', 'newColor', 'wait_us', 'acq_us', 'reg_us', 'conv_us',
  'enc_us', 'asm_us', 'write_us', 'jpeg_bytes', 'hd_copy_us', 'key_copy_us'];
const columns = header ? header.slice(7).split(',').map((s) => s.trim()) : FALLBACK;

const rows = lines
  .filter((l) => !l.includes('arrival_us'))
  .map((l) => l.slice(7).split(',').map(Number));

const kept = rows.slice(warmup);
if (kept.length === 0) {
  console.error(`no rows left after discarding ${warmup} of ${rows.length} in ${file}`);
  process.exit(2);
}

const width = Math.max(...kept.map((r) => r.length));
// A column an older grabber never wrote reads as zero rather than as NaN, which would sort
// into the middle of a percentile and report a plausible number for a stage that was absent.
const has = (name) => columns.includes(name) && columns.indexOf(name) < width;
const col = (name) => (has(name) ? kept.map((r) => r[columns.indexOf(name)] ?? 0) : kept.map(() => 0));

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (v) => v / 1000;
const f2 = (v) => v.toFixed(2);
const spread = (name) => {
  const c = col(name);
  return { p50: ms(pct(c, 50)), p90: ms(pct(c, 90)), p99: ms(pct(c, 99)) };
};

const arr = col('arrival_us');
const gaps = arr.slice(1).map((v, i) => v - arr[i]);
const spanS = (arr[arr.length - 1] - arr[0]) / 1e6;
const fps = kept.length / spanS;

const NAMES = ['wait', 'acq', 'reg', 'conv', 'enc', 'asm', 'write'];
// The loop's share of the two live outputs. Each is already subtracted back out of the segment
// it happens inside, so neither belongs in TOTAL serial and both are reported beside it.
const COPIES = ['hd_copy', 'key_copy'];
const seg = {};
let serial = 0;
for (const name of NAMES) {
  seg[name] = spread(`${name}_us`);
  if (name !== 'wait') serial += seg[name].p50;
}
const copy = {};
for (const name of COPIES) copy[name] = spread(`${name}_us`);
const serialWithCopies = serial + copy.hd_copy.p50 + copy.key_copy.p50;
const missing = [...NAMES, ...COPIES].map((n) => `${n}_us`).filter((n) => !has(n));

if (json) {
  console.log(JSON.stringify({
    file, frames: kept.length, warmup, windowS: spanS, fps, seg, serial,
    copy, serialWithCopies, missingColumns: missing,
  }));
} else {
  console.log(`file        ${file.split('/').pop()}`);
  console.log(`frames      ${kept.length} kept (${rows.length} total, ${warmup} warmup discarded)`);
  console.log(`window      ${f2(spanS)}s`);
  console.log(`delivered   ${f2(fps)} fps${fps < 29.5 ? '   <-- BELOW 29.5, the machine was contended; do not read the segments below' : ''}`);
  console.log(`colour      ${col('newColor').filter(Boolean).length} frames carried a new colour image`);
  console.log(`gap         p50 ${f2(ms(pct(gaps, 50)))} ms   p90 ${f2(ms(pct(gaps, 90)))} ms   max ${f2(ms(Math.max(...gaps)))} ms`);
  if (missing.length) {
    console.log(`missing     ${missing.join(', ')} - an older grabber wrote this file and the column reads as zero`);
  }
  console.log('');
  console.log('segment      p50        p90        p99');
  const line = (name, s) => console.log(`${name.padEnd(12)} ${f2(s.p50).padStart(6)} ms ${f2(s.p90).padStart(6)} ms ${f2(s.p99).padStart(6)} ms`);
  for (const name of NAMES) line(name, seg[name]);
  console.log(`${'TOTAL serial'.padEnd(12)} ${f2(serial).padStart(6)} ms  (sum of per-segment p50)`);
  console.log('');
  console.log('copy, on the loop and already subtracted out of the segments above');
  for (const name of COPIES) line(name, copy[name]);
  console.log(`${'TOTAL serial with copies'} ${f2(serialWithCopies).padStart(6)} ms  (TOTAL serial plus both copy p50)`);
}
