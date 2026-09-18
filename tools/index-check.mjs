// Proves the sidecar index, the content hash and the HTTP frame API.
// Proves the sidecar index, the content hash and the HTTP frame API. The scan builds an index
// and a hash without ever holding the file, the index is checked against `MessageParser` rather
// than against a second copy of the scanner's own logic, and a frame pulled over HTTP is
// checked by an independent positioned read at offsets the parser produced.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { open, stat, unlink, copyFile, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MessageParser, HEADER_BYTES, TYPE_FRAME } from '../server/protocol.js';
import { buildIndex, loadIndex, indexPathFor, captureIdFor } from '../server/capture.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const MUTATE = flag('--mutate');
// A mutation edits the server's copy of `server/capture.js`, so a mutated run needs a server of
// its own. `--stage` spawns one without mutating, which is the only way to re-run the baseline in
// the conditions a mutated run failed in rather than in the conditions the baseline happened in.
const STAGE = has('--stage') || MUTATE !== null;
const STAGE_PORT = Number(flag('--stage-port', '8251'));
const WORK = join(REPO, '.index-check');

/**
 * Each names source text in the *server's* copy and must match exactly once. The check's own
 * imports come from the repo tree and are never mutated, so the oracle every row compares against
 * stays honest - a comparison whose two sides move together proves nothing.
 */
const MUTATIONS = {
  // The hazard `server/capture.js` opens by naming: a whole-file read cannot reach past 2 GiB at
  // all. `readAt` only, because `createFrameRunStream` is a second method and one property at a
  // time is what makes a fired row attributable.
  'frame-read-is-a-whole-file-read': { file: 'server/capture.js', edits: [[
    '    const buf = Buffer.allocUnsafe(bytes);\n'
    + '    let got = 0;\n'
    + '    // Nothing promises a positioned read returns everything asked for, and a short read here\n'
    + '    // would ship a frame with a tail of whatever was in memory.\n'
    + '    while (got < bytes) {\n'
    + '      const { bytesRead } = await this.handle.read(buf, got, bytes - got, position + got);\n'
    + '      if (bytesRead === 0) throw new Error(`short read at ${position + got} in ${this.path}`);\n'
    + '      got += bytesRead;\n'
    + '    }\n'
    + '    return buf;',
    '    return (await readFile(this.path)).subarray(position, position + bytes);',
  ]],
    fails: '`Capture.readAt` reading the file whole and slicing, which is the hazard '
      + '`server/capture.js` opens by naming. Implies --stage, and only the *server\'s* copy '
      + 'is edited - this tool\'s own imports stay unmutated, so the oracle every row '
      + 'compares against cannot move with the thing under test. Reddens **four** rows, '
      + 'measured: every frame at every offset, because a whole-file read of a 2.5 GB take '
      + 'fails wherever you aim it. Then the run ends early in the victim section, where the '
      + 'same read meets a deleted file - `caught, and the count is a floor`, which is a '
      + 'different animal from a control that fires nothing before it dies',
  },
  // The same hazard as a regression rather than a rewrite: an offset that wrapped at 32 bits.
  // It serves the frame at `offset % 2**31` with a 200, so the row can only redden through its own
  // byte comparison - and every offset below the mark is its own answer, which leaves the three
  // sub-boundary frames green as the positive twin.
  'frame-offsets-truncated-to-32-bits': { file: 'server/capture.js', edits: [[
    '      const { bytesRead } = await this.handle.read(buf, got, bytes - got, position + got);',
    '      const { bytesRead } = await this.handle.read(buf, got, bytes - got, (position + got) % 2 ** 31);',
  ]],
    fails: 'the same hazard as a regression rather than a rewrite: a positioned read whose '
      + 'offset wrapped at 32 bits. This is the sharp one. It serves the frame at `offset % '
      + '2**31` **with a 200**, so the row can only redden through its own byte comparison '
      + 'rather than through a status - a mutation that 500s would prove only that the check '
      + 'reads status codes. Reddens **two** rows, measured: the two picks past the mark, at '
      + '2147533537 and 2502006469. The two below it stay green and are the positive twin, '
      + 'because `x % 2**31 === x` under the line',
  },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

const URL_BASE = STAGE ? `http://127.0.0.1:${STAGE_PORT}` : flag('--url', 'http://localhost:8080');
const SCRATCH = flag('--scratch', '/tmp');
const RUNS = Number(flag('--runs', '4'));
const SAMPLES = Number(flag('--samples', '64'));
const WARMUP = Number(flag('--warmup', '8'));
const FIXTURES = (flag('--fixtures') ?? 'captures/sample.knct,captures/fixture-1g.knct,captures/fixture-large.knct')
  .split(',')
  .filter(Boolean);

const pct = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (x) => `${x.toFixed(2)} ms`;
const gb = (x) => `${(x / 1e9).toFixed(2)} GB`;

let failures = 0;
// Kept as well as counted: a mutation is caught only if the rows that reddened are its own.
const fired = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    fired.push(label.trim());
  }
};

/**
 * The count decides, and it decides before the crash does: a mutation here damages the server the
 * rows below go on to drive, so a run that reddened rows and then died would otherwise be reported
 * as having found nothing. A mutated run with failures is caught however it ended, and says it
 * ended early because the count is a floor; with no failures, crashed means `DID NOT RUN`.
 *
 * Installed as a handler rather than wrapped around the body, because the body is a top-level
 * script and indenting it would bury the change this exists to make legible.
 */
let verdictGiven = false;
function verdict(crashed) {
  if (verdictGiven) return;
  verdictGiven = true;
  if (crashed) console.log(`\n  FAIL  the run did not finish: ${crashed.message ?? crashed}`);
  stopStagedServer();
  // The victim section writes a take into the checkout's own `captures/` and tidies it at the end,
  // which a run that died in the middle of that section never reaches. Named by pid, so this
  // sweeps only what this process wrote.
  for (const ext of ['knct', 'idx']) {
    rmSync(`captures/index-check-victim-${process.pid}.${ext}`, { force: true });
  }
  if (MUTATE && failures > 0) {
    console.log(`\n[index] caught, as required (${failures} assertion${failures === 1 ? '' : 's'} fired)`);
    if (crashed) console.log(`[index] and the run ended early: ${crashed.message ?? crashed} - the count is a floor`);
    console.log(`[index] rows that fired: ${fired.join(' | ')}`);
    process.exit(1);
  }
  if (crashed) {
    console.log(`\n[index] DID NOT RUN - ${crashed.message ?? crashed}. Nothing here is a finding: re-run it.`);
    process.exit(2);
  }
  if (MUTATE) {
  if (MUTATIONS[MUTATE]?.fails) console.log(`[index] it should redden: ${MUTATIONS[MUTATE].fails}`);
    console.log('\n[index] NOT CAUGHT - the check passed a build it should have rejected');
    process.exit(1);
  }
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}
process.on('uncaughtException', verdict);
process.on('unhandledRejection', verdict);

// A second walk of the same bytes, framed by the parser the live server uses.
async function parserWalk(path) {
  const parser = new MessageParser();
  const frames = [];
  const hash = createHash('sha256');
  let consumed = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    hash.update(chunk);
    for (const msg of parser.push(chunk)) {
      if (msg.type === TYPE_FRAME) {
        frames.push({
          offset: consumed + HEADER_BYTES,
          length: msg.payload.length,
          stampMs: Number(msg.payload.readBigUInt64LE(8)),
        });
      }
      consumed += msg.raw.length;
    }
  }
  return { frames, hash: `sha256:${hash.digest('hex')}` };
}


async function scanCost(path) {
  const size = (await stat(path)).size;
  const times = [];
  let index = null;
  for (let r = 0; r < RUNS; r++) {
    await unlink(indexPathFor(path)).catch(() => {});
    const t0 = performance.now();
    index = await buildIndex(path);
    times.push(performance.now() - t0);
  }
  // Run 1 is reported apart from the rest but is not a cold read: this is the warm-cache ceiling.
  const rest = times.slice(1);
  // Resident set after the scan, so "the scan never holds the file" is enforced
  // rather than asserted.
  return { size, index, first: times[0], rest, restP50: pct(rest, 50), rss: process.memoryUsage().rss };
}


async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function timedGet(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { dt: performance.now() - t0, bytes: buf.length };
}


/**
 * The fixtures this check needs, refused at the door with their sizes named.
 *
 * The last one has to be past 2 GiB, because the row this tool exists for reads a frame at an
 * offset a whole-file read cannot reach. Without this, a fixture that was absent crashed on
 * ENOENT and one that was merely too small crashed on `walk.frames[-1]` - both with zero failed
 * assertions and a non-zero exit, which is the shape that reads as a crash rather than a finding.
 * A worktree ran a whole session on a two-fixture set that could not cross the mark and nothing
 * said so.
 */
const TWO_GIB = 2 ** 31;
{
  const missing = FIXTURES.filter((p) => !existsSync(p));
  if (missing.length) {
    console.error(`index-check needs ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not here.`);
    console.error('`npm run fixtures` builds the first two; the last is');
    console.error('  node tools/make-fixture.js captures/sample.knct captures/fixture-large.knct --loops 18');
    process.exit(2);
  }
  const big = FIXTURES[FIXTURES.length - 1];
  const bigBytes = statSync(big).size;
  if (bigBytes <= TWO_GIB) {
    console.error(
      `index-check's largest fixture is ${big} at ${bigBytes} bytes, which is under the ${TWO_GIB}-byte `
      + 'mark. Every row here would pass and the one that matters would be testing nothing: it reads a '
      + 'frame at an offset a whole-file read cannot reach, and this file has no such offset in it.',
    );
    // The default path rather than `big`, because `big` may be a fixture that is the right size
    // for its own slot and merely in the last one - and the hint would then say to overwrite it.
    console.error('  node tools/make-fixture.js captures/sample.knct captures/fixture-large.knct --loops 18');
    process.exit(2);
  }
}

// A server of this check's own, from a staged tree, so a mutation edits the copy that runs rather
// than a file nothing is serving from. Only the server is staged: the imports above come from the
// repo tree, so what every row compares against is unmutated by construction.
let staged = null;
function stopStagedServer() {
  if (staged) { staged.kill('SIGKILL'); staged = null; }
  rmSync(WORK, { recursive: true, force: true });
}
if (STAGE) {
  const held = await fetch(`${URL_BASE}/library/takes`).then(() => true).catch(() => false);
  if (held) {
    console.error(`something is already listening on ${STAGE_PORT}: a staged run answered by a stranger asserts against whatever fixture that process staged, which is a green run proving nothing`);
    process.exit(2);
  }
  rmSync(WORK, { recursive: true, force: true });
  const root = join(WORK, 'root');
  mkdirSync(root, { recursive: true });
  for (const name of ['server', 'web', 'effects-builtin', 'presets-builtin']) {
    cpSync(join(REPO, name), join(root, name), { recursive: true });
  }
  for (const name of ['node_modules', 'vendor']) {
    if (existsSync(join(REPO, name))) symlinkSync(join(REPO, name), join(root, name));
  }
  if (MUTATE) {
    const spec = MUTATIONS[MUTATE];
    const path = join(root, spec.file);
    let source = readFileSync(path, 'utf8');
    for (const [from, to] of spec.edits) {
      const hits = source.split(from).length - 1;
      if (hits !== 1) {
        console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated server`);
        process.exit(2);
      }
      source = source.replace(from, to);
    }
    writeFileSync(path, source);
  }
  // The real captures directory, because the fixtures are gigabytes and the victim section writes
  // a take into it by the same relative path this process uses.
  staged = spawn(process.execPath, [join(root, 'server/index.js'), '--standby-after', '0',
    '--port', String(STAGE_PORT), '--captures', join(REPO, 'captures'),
    '--projects', join(WORK, 'projects'), '--presets', join(WORK, 'presets'),
    '--deliverables', join(WORK, 'deliverables'), '--jobs', join(WORK, 'jobs')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  staged.stdout.on('data', (c) => log.push(c.toString()));
  staged.stderr.on('data', (c) => log.push(c.toString()));
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    await new Promise((done) => { setTimeout(done, 100); });
    up = await fetch(`${URL_BASE}/library/takes`).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error(`the staged server never came up on ${STAGE_PORT}:\n${log.join('')}`);
  console.log(`[index] staged server on ${STAGE_PORT}${MUTATE ? ` with ${MUTATE} applied to ${MUTATIONS[MUTATE].file}` : ' unmutated'}`);
}

console.log(`index-check  node ${process.version}  url ${URL_BASE}\n`);

const scans = new Map();

console.log('== scan cost, index and hash ==');
console.log(`method: ${RUNS} runs per capture, sidecar deleted before each so every run is`);
console.log('a real scan. All runs are page-cache warm - purging needs root and this machine');
console.log('holds every fixture at once - so these are the CPU-bound ceiling, not a disk read.\n');
for (const path of FIXTURES) {
  const s = await scanCost(path);
  scans.set(path, s);
  const n = s.index.frames.offset.length;
  console.log(
    `${path}\n  ${gb(s.size)}  ${n} frames  ${s.index.hash}\n` +
    `  run 1 ${(s.first / 1000).toFixed(2)}s  p50 ${(s.restP50 / 1000).toFixed(2)}s ` +
    `(${(s.size / 1e6 / (s.restP50 / 1000)).toFixed(0)} MB/s)  ` +
    `runs 2..${RUNS} [${s.rest.map((t) => (t / 1000).toFixed(2)).join(', ')}]s\n` +
    `  truncated=${s.index.truncated}  sidecar ${((JSON.stringify(s.index).length) / 1e3).toFixed(0)} KB` +
    `  rss after scan ${(s.rss / 1e6).toFixed(0)} MB`,
  );
}

{
  // The claim is that the working set does not track file size, so the check is the
  // shape of the curve.
  const small = scans.get(FIXTURES[0]);
  const large = scans.get(FIXTURES[FIXTURES.length - 1]);
  const RSS_CEILING = 512e6;
  const RSS_DELTA = 128e6;
  check(
    large.rss < RSS_CEILING,
    `scanning ${gb(large.size)} leaves ${(large.rss / 1e6).toFixed(0)} MB resident, under the ${RSS_CEILING / 1e6} MB ceiling`,
  );
  check(
    large.rss - small.rss < RSS_DELTA,
    `${(large.size / small.size).toFixed(0)}x the bytes costs ` +
    `${((large.rss - small.rss) / 1e6).toFixed(0)} MB more resident, under the ${RSS_DELTA / 1e6} MB bound`,
  );
}

console.log('\n== hash stability and sensitivity ==');
for (const path of FIXTURES) {
  const first = scans.get(path).index;
  const repeat = await buildIndex(path);
  check(repeat.hash === first.hash, `${path}: hash stable across rebuilds (${first.hash.slice(0, 23)}…)`);
  check(
    JSON.stringify(repeat.frames) === JSON.stringify(first.frames),
    `${path}: index identical across rebuilds`,
  );
}

{
  // Flipped inside a payload rather than a framing header, which would move what the
  // scanner parses too.
  const src = FIXTURES[0];
  const copy = `${SCRATCH}/index-check-flip.knct`;
  await copyFile(src, copy);
  const before = await buildIndex(copy);
  const target = before.frames.offset[1] + 40;
  const fh = await open(copy, 'r+');
  const one = Buffer.alloc(1);
  await fh.read(one, 0, 1, target);
  one[0] ^= 0xff;
  await fh.write(one, 0, 1, target);
  await fh.close();
  const after = await buildIndex(copy);
  check(after.hash !== before.hash, `one payload byte at ${target} changes the hash`);
  check(
    JSON.stringify(after.frames) === JSON.stringify(before.frames),
    'the same byte leaves every offset, stamp and length untouched',
  );
  await unlink(copy).catch(() => {});
  await unlink(indexPathFor(copy)).catch(() => {});
}

{
  // A same-size substitution is the one staleness case byte length cannot see, so mtime is
  // checked beside it.
  const copy = `${SCRATCH}/index-check-stale.knct`;
  await copyFile(FIXTURES[0], copy);
  const before = await buildIndex(copy);
  // Read the mtime back rather than assuming the one set: Date carries milliseconds, the
  // filesystem nanoseconds.
  const target = Math.floor((await stat(copy)).mtimeMs) + 5000;
  await utimes(copy, new Date(target), new Date(target));
  const landed = (await stat(copy)).mtimeMs;
  const after = await loadIndex(copy);
  check(
    after.mtimeMs === landed && after.mtimeMs !== before.mtimeMs,
    'a capture touched without changing size rebuilds rather than reusing the sidecar',
  );
  check(after.bytes === before.bytes, 'and the rebuild finds the same bytes');
  await unlink(copy).catch(() => {});
  await unlink(indexPathFor(copy)).catch(() => {});
}

{
  // The sidecar exists so a writer that died mid-take leaves a usable file, so cut one
  // mid-frame and check.
  const src = FIXTURES[0];
  const whole = await loadIndex(src);
  const keep = 100;
  const cutAt = whole.frames.offset[keep] + Math.floor(whole.frames.length[keep] / 2);
  const copy = `${SCRATCH}/index-check-cut.knct`;
  await copyFile(src, copy);
  const fh = await open(copy, 'r+');
  await fh.truncate(cutAt);
  await fh.close();
  const cut = await buildIndex(copy);
  check(cut.truncated === true, `a take cut inside frame ${keep} reports truncated`);
  check(cut.frames.offset.length === keep, `it indexes the ${keep} whole frames that landed (got ${cut.frames.offset.length})`);
  check(
    cut.frames.offset.every((o, i) => o === whole.frames.offset[i] && cut.frames.length[i] === whole.frames.length[i]),
    'and every surviving offset and length matches the intact take',
  );
  await unlink(copy).catch(() => {});
  await unlink(indexPathFor(copy)).catch(() => {});
}

console.log('\n== index agrees with the stream parser ==');
for (const path of FIXTURES) {
  const idx = scans.get(path).index;
  const walk = await parserWalk(path);
  const n = idx.frames.offset.length;
  check(walk.frames.length === n, `${path}: ${n} frames, parser found ${walk.frames.length}`);
  let bad = 0;
  for (let i = 0; i < Math.min(n, walk.frames.length); i++) {
    const w = walk.frames[i];
    if (w.offset !== idx.frames.offset[i] || w.length !== idx.frames.length[i] || w.stampMs !== idx.frames.stampMs[i]) bad++;
  }
  check(bad === 0, `${path}: every offset, length and stamp agrees (${bad} mismatches)`);
  check(walk.hash === idx.hash, `${path}: content hash agrees with an independent digest`);
}

console.log('\n== frame API is byte-identical to the file ==');
const BIG = FIXTURES[FIXTURES.length - 1];
{
  const capture = await loadIndex(BIG);
  const id = captureIdFor(BIG);
  // A take is asked for by its content hash, never by its name.
  const key = encodeURIComponent(capture.hash);
  const n = capture.frames.offset.length;
  const walk = await parserWalk(BIG);
  const fh = await open(BIG, 'r');

  const served = JSON.parse((await getBytes(`${URL_BASE}/capture/${key}/index`)).toString('utf8'));
  check(served.hash === capture.hash, `${id}: /index serves the sidecar's hash`);
  check(served.frames.offset.length === n, `${id}: /index serves ${n} frames`);

  // One deliberately past the 2 GiB mark, which is the offset a whole-file read could
  // not reach at all.
  const past2Gib = walk.frames.findIndex((f) => f.offset > TWO_GIB);
  // A backstop under the door's fixture rule, because -1 out of `findIndex` used to go into
  // `picks` and read as an undefined frame three lines later.
  check(past2Gib >= 0, `${id} carries a frame past ${TWO_GIB}, so the row below is about an offset a whole-file read cannot reach`);
  const picks = [0, Math.floor(Math.random() * (n - 2)) + 1, past2Gib, n - 1].filter((k) => k >= 0);
  for (const k of picks) {
    // Offsets come from the parser walk, so a wrong index cannot make a frame agree with itself.
    const w = walk.frames[k];
    const onDisk = Buffer.alloc(w.length);
    await fh.read(onDisk, 0, w.length, w.offset);
    // Reported rather than thrown: a build that cannot reach this offset answers 500, and a
    // throw here would end the run with zero failed assertions - which is a crash to investigate
    // rather than the catch it actually is.
    const overHttp = await getBytes(`${URL_BASE}/capture/${key}/frame/${k}`)
      .catch((err) => ({ failed: String(err.message ?? err) }));
    check(
      !overHttp.failed && overHttp.length === onDisk.length && overHttp.equals(onDisk),
      `frame ${k} of ${n} (${w.length} bytes at ${w.offset}) is byte-identical over HTTP`
      + (overHttp.failed ? ` - ${overHttp.failed}` : ''),
    );
  }

  // A run comes back framed, so it has to parse back into the payloads the single-frame
  // endpoint serves.
  const a = Math.floor(n / 2);
  const b = a + 7;
  const run = await getBytes(`${URL_BASE}/capture/${key}/frames/${a}-${b}`);
  const runParser = new MessageParser();
  const got = [...runParser.push(run)].filter((m) => m.type === TYPE_FRAME);
  check(got.length === b - a + 1, `frames/${a}-${b} parses back to ${b - a + 1} frames (got ${got.length})`);
  let runBad = 0;
  for (let i = 0; i < got.length; i++) {
    const w = walk.frames[a + i];
    const onDisk = Buffer.alloc(w.length);
    await fh.read(onDisk, 0, w.length, w.offset);
    if (!got[i].payload.equals(onDisk)) runBad++;
  }
  check(runBad === 0, `every payload in the run is byte-identical (${runBad} mismatches)`);

  check((await fetch(`${URL_BASE}/capture/${key}/frame/${n}`)).status === 404, 'a frame past the end is 404');
  check((await fetch(`${URL_BASE}/capture/${key}/frames/${n - 1}-${n - 4}`)).status === 404, 'a backwards range is 404');
  // Encoded so the separators survive URL normalisation and the whole thing arrives as
  // one path segment.
  const traversal = await fetch(`${URL_BASE}/capture/..%2f..%2fetc%2fpasswd/index`);
  check(traversal.status === 404, `a traversing key is refused, because only a content hash names a take (${traversal.status})`);
  check((await fetch(`${URL_BASE}/capture/${encodeURIComponent(id)}/index`)).status === 404,
    `and so is ${id}'s own name, which is not an address`);
  check((await fetch(`${URL_BASE}/capture/sha256%3A${'0'.repeat(64)}/index`)).status === 404, 'an unknown capture is 404');

  await fh.close();
}

console.log('\n== the run endpoint survives the file moving underneath it ==');
{
  // A run streams off the descriptor it opened, so a take deleted after its headers went out
  // finishes off that handle: ENOENT inside a stream, after the headers had gone out, killed the
  // process. The take is its own footage - one byte flipped - so its hash names it and nothing else.
  const id = `index-check-victim-${process.pid}`;
  const victim = `captures/${id}.knct`;
  const replacement = `${SCRATCH}/index-check-replacement.knct`;

  const src = FIXTURES[0];
  const srcIndex = await loadIndex(src);
  const flipped = async (path, at) => {
    const fh = await open(path, 'r+');
    const one = Buffer.alloc(1);
    await fh.read(one, 0, 1, at);
    one[0] ^= 0xff;
    await fh.write(one, 0, 1, at);
    await fh.close();
  };
  await copyFile(src, victim);
  await flipped(victim, srcIndex.frames.offset[0] + 40);
  // Same length again, and one byte different from the victim, so a wrong answer can only mean the
  // wrong file.
  await copyFile(src, replacement);
  await flipped(replacement, srcIndex.frames.offset[0] + 41);
  const victimKey = encodeURIComponent((await buildIndex(victim)).hash);
  const lastFrame = srcIndex.frames.offset.length - 1;

  const original = await getBytes(`${URL_BASE}/capture/${victimKey}/frame/0`);
  check(original.length === srcIndex.frames.length[0], `${id}: opened and served frame 0`);

  // Headers and the first bytes of the whole take as one run, then the file goes.
  const streaming = await fetch(`${URL_BASE}/capture/${victimKey}/frames/0-${lastFrame}`);
  const reader = streaming.body.getReader();
  const chunks = [];
  const first = await reader.read();
  if (!first.done) chunks.push(Buffer.from(first.value));
  await unlink(victim);
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  const whole = [...new MessageParser().push(Buffer.concat(chunks))].filter((m) => m.type === TYPE_FRAME);
  check(streaming.ok && whole.length === lastFrame + 1 && whole[0].payload.equals(original),
    `with the file deleted mid-run, the run finishes off the handle it opened (${whole.length} of ${lastFrame + 1} frames)`);
  const afterDelete = await fetch(`${URL_BASE}/capture/${victimKey}/frame/0`);
  check(afterDelete.status === 404, `and once it is gone its hash names nothing here (${afterDelete.status})`);

  await copyFile(replacement, victim);
  const replacementKey = encodeURIComponent((await buildIndex(victim)).hash);
  const stillGone = await fetch(`${URL_BASE}/capture/${victimKey}/frame/0`);
  const afterSwap = await getBytes(`${URL_BASE}/capture/${replacementKey}/frame/0`);
  const runAfterSwap = await getBytes(`${URL_BASE}/capture/${replacementKey}/frames/0-3`);
  const swappedRun = [...new MessageParser().push(runAfterSwap)].filter((m) => m.type === TYPE_FRAME);
  check(
    stillGone.status === 404 && !afterSwap.equals(original) && swappedRun[0].payload.equals(afterSwap),
    'after a same-name re-record the old hash still names nothing, and /frame and /frames agree on the new one',
  );

  const alive = await fetch(`${URL_BASE}/capture/${replacementKey}/index`);
  check(alive.status === 200, `the server is still up afterwards (${alive.status})`);
  check((await fetch(`${URL_BASE}/%zz`)).status === 400, 'a malformed percent escape is 400, not a dead process');

  await unlink(victim).catch(() => {});
  await unlink(indexPathFor(victim)).catch(() => {});
  await unlink(replacement).catch(() => {});
  await unlink(indexPathFor(replacement)).catch(() => {});
}

console.log('\n== per-frame fetch latency over loopback ==');
{
  const id = captureIdFor(BIG);
  const idx = await loadIndex(BIG);
  const key = encodeURIComponent(idx.hash);
  const n = idx.frames.offset.length;
  console.log(
    `method: ${id}, ${n} frames, ${SAMPLES} samples per arm, first ${WARMUP} discarded,\n` +
    'arms alternated sample by sample, node fetch over loopback, file warm in the page cache.',
  );
  const random = [];
  const sequential = [];
  let seq = 0;
  let bytes = 0;
  for (let i = 0; i < SAMPLES + WARMUP; i++) {
    const r = await timedGet(`${URL_BASE}/capture/${key}/frame/${Math.floor(Math.random() * n)}`);
    const s = await timedGet(`${URL_BASE}/capture/${key}/frame/${seq++ % n}`);
    if (i >= WARMUP) {
      random.push(r.dt);
      sequential.push(s.dt);
      bytes = r.bytes;
    }
  }
  console.log(`\n  payload ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  random interior   p50 ${ms(pct(random, 50))}   p90 ${ms(pct(random, 90))}`);
  console.log(`  sequential walk   p50 ${ms(pct(sequential, 50))}   p90 ${ms(pct(sequential, 90))}`);

  // A prefetch run is why the range endpoint exists: eight frames one at a time against the
  // same eight as a run.
  const RUN = 8;
  const perFrame = [];
  const asRun = [];
  for (let i = 0; i < 24; i++) {
    const a = Math.floor(Math.random() * (n - RUN));
    let t0 = performance.now();
    for (let k = 0; k < RUN; k++) await getBytes(`${URL_BASE}/capture/${key}/frame/${a + k}`);
    perFrame.push(performance.now() - t0);
    t0 = performance.now();
    await getBytes(`${URL_BASE}/capture/${key}/frames/${a}-${a + RUN - 1}`);
    asRun.push(performance.now() - t0);
  }
  console.log(`\n  ${RUN} frames, one request each   p50 ${ms(pct(perFrame.slice(4), 50))}   p90 ${ms(pct(perFrame.slice(4), 90))}`);
  console.log(`  ${RUN} frames, one range request  p50 ${ms(pct(asRun.slice(4), 50))}   p90 ${ms(pct(asRun.slice(4), 90))}`);
}

verdict(null);
