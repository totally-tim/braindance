#!/usr/bin/env node
// Proves that third_party/libfreenect2 is upstream v0.2.1 plus exactly the edits
// we have declared, using only files in this repo - no network, no clone, no
// GitHub still being there in a year. That is the whole point: the old recipe
// ran `git clone --depth 1` against a branch name, which pins nothing, and was
// correct only because upstream has not committed since 2020.
//
// The check is deliberately two-sided. An undeclared edit failing is obvious;
// the one that matters more is a *declared* edit that has quietly reverted,
// because that is what a careless re-vendor looks like, and it would ship a
// driver missing the sub-9 fix while every file still "matched upstream".
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, cpSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'third_party', 'libfreenect2.manifest');

// The authoritative list of what we changed. UPSTREAM.md explains why in prose;
// this is what the check enforces, so the two cannot drift into disagreeing
// about anything that matters.
//
// Each entry pins the blob hash our patched file must have, and the first
// version of this tool did not - it asserted only that the file *differed* from
// upstream. Mutation testing killed that: reverting the sub-9 condition from
// `& 0x1ff` back to `== 0x3ff` left the patch's comment behind, so the file
// still differed and the check still passed while the fix it exists to protect
// was gone. "Differs from upstream" is not "contains our change", and pinning
// the exact content is the difference between the two.
//
// The pin now holds one more thing than it did. Both files carry a notice of
// modification in their header, which is what Apache-2.0 section 4(b) requires
// of a modified file we redistribute, and that notice is inside the content the
// hash covers - so stripping it fails this check rather than quietly shipping a
// changed upstream file that claims to be upstream. The disclosure is enforced
// rather than asserted, which is the same reading as everything else here.
//
// `marker` is a string the edit puts into the *compiled* library, and it is what
// section 5 reads. Only one of the three edits has one, which is stated here rather
// than papered over: the sub-9 fix changes `== 0x3ff` to `& 0x1ff`, which compiles
// to an immediate and leaves nothing in the binary to look for, and the macOS USB
// edit is inside an `#if` that a Linux build compiles straight out.
const DECLARED_EDITS = new Map([
  ['src/depth_packet_stream_parser.cpp', {
    why: 'accept depth frames missing only the unused 10th sub-image',
    ours: '70aebcc30122fbefbb73cf6761b70388071deef2',
    marker: null,
  }],
  ['src/registration.cpp', {
    why: 'thread the occlusion filter, banded by linear index',
    ours: '7e6037cd7e7d6f5496a693adcc44e9c2893ff426',
    marker: 'LIBFREENECT2_REG_THREADS',
  }],
  // The third edit, and the one with nothing to look for in the binary for a reason
  // worth stating rather than leaving to be worked out: it is `#if defined(__APPLE__)`,
  // so on a Linux capture node the compiler emits upstream's code and there is no
  // string, no symbol and no observable difference to find. `marker` is null because
  // the edit is genuinely absent from that build, not because nobody looked.
  ['src/libfreenect2.cpp', {
    why: 'let the two USB link setup calls fail without failing the open, on macOS only',
    ours: 'a89572d9bed79becdea8c61e398803c536b1b6ee',
    marker: null,
  }],
]);

// git's blob hash, computed here rather than by shelling out to git-hash-object
// 140 times - and it means the check does not need a git repo to run in.
const blobHash = (buf) =>
  createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const walk = (dir, base = dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
};

function parseManifest() {
  const m = new Map();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [hash, ...rest] = line.split(/\s+/);
    m.set(rest.join(' '), hash);
  }
  return m;
}

// --- mutations ------------------------------------------------------------
// Each must make the check fail, and must fail on the assertion it is aimed at
// rather than on a crash. A mutation that changes nothing reads as a check that
// found nothing, so each one alters bytes the check demonstrably reads.
const MUTATIONS = {
  // Deliberately a file with no declared edit. It used to touch registration.cpp,
  // which stopped testing anything once registration.cpp became a declared edit -
  // the mutation still failed, but on the content pin rather than on the
  // undeclared-change assertion it is named for, so the assertion it exists to
  // exercise was no longer covered by anything.
  'undeclared-edit': (tree) => {
    const f = join(tree, 'src', 'packet_pipeline.cpp');
    writeFileSync(f, readFileSync(f, 'utf8') + '\n// not upstream\n');
  },
  'revert-local-edit': (tree) => {
    const f = join(tree, 'src', 'depth_packet_stream_parser.cpp');
    const s = readFileSync(f, 'utf8');
    if (!s.includes('(current_subsequence_ & 0x1ff) == 0x1ff')) throw new Error('anchor missing');
    writeFileSync(f, s.replace('(current_subsequence_ & 0x1ff) == 0x1ff', 'current_subsequence_ == 0x3ff'));
  },
  'extra-file': (tree) => writeFileSync(join(tree, 'src', 'sneaky.cpp'), '// not upstream\n'),
  'missing-file': (tree) => rmSync(join(tree, 'src', 'registration.cpp')),
  // Not a mutation of the vendored tree but of the harness oracle beside it -
  // the failure where somebody "refreshes" the oracle from our own optimised
  // source and registration-check quietly starts comparing a build to itself.
  'oracle-drift': (_tree, oracle) => {
    const f = join(oracle, 'registration.cpp');
    const s = readFileSync(f, 'utf8');
    if (!s.includes('filter_width_half(2)')) throw new Error('anchor missing');
    writeFileSync(f, s.replace('filter_width_half(2)', 'filter_width_half(4)'));
  },
  // The control for section 5, and the one this tool went without for a while.
  // It does not touch the source at all - it points the artifact assertion at a
  // prefix built from *different* source, which is precisely the thing the old
  // version of this check could not tell from the right one.
  //
  // `vendor/prefix-oracle` is built by registration-check out of upstream's own
  // registration.cpp, so it is a real library from real different source rather
  // than a doctored copy of ours. That also means it only exists after a
  // registration-check run, and its absence is exit 2 rather than a pass: a
  // control that silently does not run is worse than no control.
  'stale-prefix': () => ({ prefix: join(ROOT, 'vendor', 'prefix-oracle') }),
};

// --- run ------------------------------------------------------------------
const argv = process.argv.slice(2);
const mutation = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
if (mutation && !MUTATIONS[mutation]) {
  console.error(`unknown mutation '${mutation}'; have: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// Mutations run against a throwaway copy so a falsification run can never leave
// the real vendored tree altered - a proof tool that damages its subject would
// make every later run untrustworthy.
let tree = join(ROOT, 'third_party', 'libfreenect2');
let oracleDir = join(ROOT, 'third_party', 'oracle');
let prefix = argv.includes('--prefix') ? argv[argv.indexOf('--prefix') + 1] : join(ROOT, 'vendor', 'prefix');
let scratch = null;
if (mutation) {
  scratch = mkdtempSync(join(tmpdir(), 'vendor-check-'));
  cpSync(tree, join(scratch, 'libfreenect2'), { recursive: true });
  cpSync(oracleDir, join(scratch, 'oracle'), { recursive: true });
  tree = join(scratch, 'libfreenect2');
  oracleDir = join(scratch, 'oracle');
  // A mutation may redirect what gets inspected rather than edit the copy.
  const redirect = MUTATIONS[mutation](tree, oracleDir);
  if (redirect?.prefix) prefix = redirect.prefix;
}

let checked = 0;
let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL  ${msg}`); };

const manifest = parseManifest();
const onDisk = new Set(walk(tree));

// 1. every upstream file is present and hashes as upstream, unless declared.
const actuallyDiffer = new Set();
const ourHashes = new Map();
for (const [path, upstreamHash] of manifest) {
  checked++;
  if (!onDisk.has(path)) { fail(`missing from our tree: ${path}`); continue; }
  const ours = blobHash(readFileSync(join(tree, path)));
  ourHashes.set(path, ours);
  if (ours !== upstreamHash) actuallyDiffer.add(path);
}

// 2. the differing set is exactly the declared set - both directions.
for (const path of actuallyDiffer) {
  checked++;
  if (!DECLARED_EDITS.has(path)) fail(`undeclared change to ${path} (hash differs from upstream v0.2.1)`);
}
for (const [path, { why, ours }] of DECLARED_EDITS) {
  checked++;
  if (!actuallyDiffer.has(path)) {
    fail(`declared edit has reverted: ${path} now matches upstream, so "${why}" is NOT in this tree`);
    continue;
  }
  // The content pin. Differing from upstream only says somebody touched the
  // file; this says they left it in the exact state we reviewed.
  checked++;
  const got = ourHashes.get(path);
  if (got !== ours) {
    fail(`${path} is neither upstream nor our reviewed version (want ${ours}, got ${got}) - "${why}" may be altered or gone`);
  }
}

// 3. nothing extra crept in.
for (const path of onDisk) {
  checked++;
  if (!manifest.has(path)) fail(`not part of upstream v0.2.1: ${path}`);
}

// 4. the harness oracle is still upstream, byte for byte.
//
// third_party/oracle/registration.cpp is the reference registration-check
// measures our build against, so it has to be upstream's file and not a copy of
// whatever we most recently wrote. Once registration is optimised, our own
// src/registration.cpp stops matching upstream by design - and at that moment
// the only thing standing between "differential test" and "a build compared
// against itself" is this assertion.
for (const [oraclePath, upstreamOf] of [['registration.cpp', 'src/registration.cpp']]) {
  checked++;
  const want = manifest.get(upstreamOf);
  const full = join(oracleDir, oraclePath);
  let got = null;
  try { got = blobHash(readFileSync(full)); } catch { /* reported below */ }
  if (got === null) fail(`harness oracle missing: ${oraclePath}`);
  else if (got !== want) {
    fail(`harness oracle has drifted from upstream ${upstreamOf} (want ${want}, got ${got}) - registration-check would be comparing our build against itself`);
  }
}

// 5. the library that is actually installed was built from this source.
//
// Sections 1-4 prove the *source tree*, and for a long time that was the whole of
// this tool - which meant it passed identically whether the library the grabber
// loads came from that tree or from a stale prefix built from something else. The
// grabber's new call passes two optional out-parameters any libfreenect2 0.2
// accepts, so an old prefix still links and still streams, single-threaded, with
// nothing anywhere looking wrong. That is this repo's signature failure aimed at
// the tool that proves the vendoring, and this section is the answer to it.
//
// What it reads is a string the declared edit puts in the binary. It is honest
// about its own reach: only the registration edit has one, so this closes the gap
// for the threading and NOT for the sub-9 fix, whose `& 0x1ff` compiles to an
// immediate with nothing to look for. The sub-9 fix is still source-only proof.
let unproven = 0;
const libDir = join(prefix, 'lib');
let lib = null;
try {
  const name = readdirSync(libDir).find((f) => /^libfreenect2\.\d+\.\d+\.\d+\.(dylib|so)$/.test(f))
    ?? readdirSync(libDir).find((f) => /^libfreenect2\.so\.\d+\.\d+\.\d+$/.test(f));
  if (name) lib = join(libDir, name);
} catch { /* reported just below */ }

if (!lib) {
  unproven++;
  console.log(`UNPROVEN  no built library under ${prefix} - sections 1-4 proved the source, and nothing here proved what is loaded`);
} else {
  const bytes = readFileSync(lib);
  for (const [path, { why, marker }] of DECLARED_EDITS) {
    if (!marker) continue;
    checked++;
    if (!bytes.includes(marker)) {
      fail(`the library at ${lib} does not carry ${marker}, so it was NOT built from our ${path} - "${why}" is missing from the artifact even though the source has it`);
    }
  }
}

if (scratch) rmSync(scratch, { recursive: true, force: true });

const label = mutation ? `mutation '${mutation}'` : 'vendored tree';
console.log(`\n${label}: ${checked} assertions, ${failed} failed${unproven ? `, ${unproven} unproven` : ''}`);
if (mutation) {
  // Exit code alone cannot distinguish "the mutation was caught" from "the tool
  // crashed before asserting anything", and this repo has been bitten by exactly
  // that. So a mutation run reports on the assertion count.
  // A mutation whose control could not run is not a mutation that was caught.
  // `stale-prefix` points at a prefix registration-check builds, so on a tree
  // where that has never run there is nothing to compare and saying "caught"
  // would credit this tool with a detection it never made.
  if (unproven) { console.log(`DID NOT RUN - ${unproven} claim unproven, so this mutation was never actually shown to the check`); process.exit(2); }
  if (failed === 0) { console.log('NOT CAUGHT - the check passed a tree it should have rejected'); process.exit(1); }
  console.log(`caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(0);
}
if (failed) { console.log('FAIL'); process.exit(1); }
// Same reading as library-check's exit 2: "some claims were not tested here" and
// "a claim failed" are different answers, and 1 already means the second.
if (unproven) { console.log('PASS on the source, with the artifact untested here'); process.exit(2); }
console.log('PASS');
process.exit(0);
