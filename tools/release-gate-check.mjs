#!/usr/bin/env node
// Proves this repo's supply-chain gate is armed: that `.npmrc` names a minimum release age,
// and that the npm doing the installing actually refuses on it. It needs the registry, because
// reading the key back answers `null` whether it took or not, and a value npm can parse but
// nobody meant - 0, -1, 2000 - is an open gate wearing a configured file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;

const MUTATIONS = {
  'wrong-unit': 'min-release-age=2d\n',
  'no-gate': '# nothing here\n',
  absent: null,
};
if (MUTATE && !(MUTATE in MUTATIONS)) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// Two distinct empty files rather than /dev/null twice: npm refuses to load one path as both
// the user and the global config, and dies before it resolves anything.
const scratch = mkdtempSync(join(tmpdir(), 'release-gate-'));
const MASK = ['--userconfig', join(scratch, 'user'), '--globalconfig', join(scratch, 'global')];
writeFileSync(MASK[1], '');
writeFileSync(MASK[3], '');
// Under `npm test` the calling npm exports its config as `npm_config_*`, which a nested npm reads
// as command-line flags, so the machine's own config would reach every probe past MASK.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));

let cwd = REPO;
if (MUTATE) {
  cwd = join(scratch, 'tree');
  mkdirSync(cwd, { recursive: true });
  if (MUTATIONS[MUTATE] !== null) writeFileSync(join(cwd, '.npmrc'), MUTATIONS[MUTATE]);
}

let checked = 0;
let failed = 0;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const bail = (why, extra = '') => {
  console.log(`DID NOT RUN - ${why}, so nothing below was measured`);
  if (extra) console.log(`  ${extra.split('\n').slice(0, 3).join('\n  ')}`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
};

const gateFile = join(cwd, '.npmrc');
const source = existsSync(gateFile) ? readFileSync(gateFile, 'utf8') : null;
ok('the tree carries an .npmrc, so a contributor cloning it inherits the gate rather than this machine\'s user config',
  source !== null, gateFile);
ok('and it names min-release-age, which is the only key npm turns into a cutoff',
  /^\s*min-release-age\s*=/m.test(source ?? ''),
  // Matched on the setting rather than on the substring, or the detail column quotes a comment.
  (source ?? '').split('\n').find((l) => /^\s*min-release-age\s*=/.test(l)) ?? 'no such line');

// Asked of npm rather than compared against a version number: `config ls -l` lists
// every key it knows.
const known = (() => {
  try {
    return /^\s*min-release-age\s*=/m.test(execFileSync('npm', ['config', 'ls', '-l', ...MASK],
      { cwd: scratch, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { return false; }
})();
const npmVersion = (() => {
  try {
    return execFileSync('npm', ['--version'], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return 'unknown'; }
})();
ok('this npm knows min-release-age at all - it arrived in npm 11, and an older one ignores the file entirely while reporting nothing',
  known, `npm ${npmVersion}`);

// Make npm resolve under whatever gate `from` carries, and hand back what it said. The
// package.json is written only where there is not one already - unmutated, `from` is this repo.
const PROBE = 'abbrev@99.99.99';
function resolveUnderGate(from) {
  const manifest = join(from, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, '{"name":"release-gate-probe","version":"1.0.0","private":true}\n');
  }
  try {
    execFileSync('npm', ['install', PROBE, '--dry-run', '--no-audit', '--no-fund', ...MASK],
      { cwd: from, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

// A registry this cannot reach answers nothing about the gate, but npm rejecting the
// value is a finding.
const said = resolveUnderGate(cwd);
const valueRejected = /invalid config|Invalid time value/i.test(said);
if (!valueRejected && !/notarget|No matching version/i.test(said)) {
  bail('npm could not resolve against the registry, so its refusal could not be read',
    said.trim() || 'no output at all');
}

// The cutoff npm names in the refusal: its absence is the wrong-unit and the no-gate cases.
const stamp = valueRejected ? null : said.match(/with a date before ([^\n]+?)\.?\s*$/m)?.[1]?.trim() ?? null;
const when = stamp ? new Date(stamp) : null;
const valid = when !== null && !Number.isNaN(when.getTime());
ok('npm refuses on it, naming the cutoff it derived - so the value is one npm turned into a real date rather than one it could not use',
  valid, stamp ?? (valueRejected
    ? `npm rejected the value outright: ${said.match(/npm (?:warn|error) [^\n]*/i)?.[0]?.trim() ?? 'invalid config'}`
    : 'no cutoff named in the refusal'));

const hours = valid ? (Date.now() - when.getTime()) / 3_600_000 : 0;
ok('and the cutoff is at least 48 hours back, which is the window a compromised release is most likely to be caught in',
  valid && hours >= 47.5, valid ? `${hours.toFixed(1)}h` : 'no cutoff');
// An upper bound too, because a gate nobody can install through gets turned off rather than fixed.
ok('and not so far back that ordinary dependency work is impossible, which is how a gate gets deleted instead of corrected',
  valid && hours <= 24 * 400, valid ? `${(hours / 24).toFixed(1)} days` : 'no cutoff');

// The positive twin: without it a cutoff proves only that some gate exists somewhere
// on this machine.
const bare = join(scratch, 'bare');
mkdirSync(bare, { recursive: true });
const elsewhere = resolveUnderGate(bare);
if (!/notarget|No matching version/i.test(elsewhere)) {
  bail('the ungated control could not reach the registry either, so the row above is unattributable',
    elsewhere.trim() || 'no output at all');
}
ok('and a directory with no .npmrc draws no cutoff at all, so the one above came from the file under test',
  !/with a date before/i.test(elsewhere),
  elsewhere.match(/with a date before ([^\n]+?)\.?\s*$/m)?.[1]?.trim() ?? 'none named');

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${checked} assertions, ${failed} failed`);
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[release-gate] it should redden: ${MUTATIONS[MUTATE].fails}`);
  if (failed === 0) { console.log(`NOT CAUGHT - ${MUTATE} passed a check that exists to reject it`); process.exit(1); }
  console.log(`caught, as required (${failed} assertions fired)`);
  process.exit(0);
}
process.exit(failed ? 1 : 0);
