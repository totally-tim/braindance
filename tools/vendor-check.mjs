#!/usr/bin/env node
// Proves third_party/libfreenect2 is upstream v0.2.1 plus exactly the edits declared
// here, using only files in this repo. A declared edit that has quietly reverted fails
// too: that is what a careless re-vendor looks like.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, cpSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'third_party', 'libfreenect2.manifest');

// Each entry pins the blob hash our patched file must have, because "differs from
// upstream" is not "contains our change". `marker` is a string the edit leaves in the
// compiled library, which is what catches a stale vendor/prefix; an edit whose change
// leaves no symbol or literal behind cannot have one.
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
  ['src/libfreenect2.cpp', {
    why: 'let the two USB link setup calls fail without failing the open, on macOS only',
    ours: 'a89572d9bed79becdea8c61e398803c536b1b6ee',
    marker: null,
  }],
  ['include/libfreenect2/packet_pipeline.h', {
    why: 'declare ColorDecoder, defaultColorDecoder and a decoder overload per pipeline',
    ours: 'a27d0a8ee8180502ee11479eac662b1e3a22b810',
    marker: null,
  }],
  ['src/packet_pipeline.cpp', {
    why: 'pick the colour decoder by name, prefer software decode, and never substitute',
    ours: 'ba72ce1235d27e0b74d70546ac47435d33d0913e',
    // The mangled name of the one symbol this edit exports. Unlike the macOS edit, which leaves
    // no symbol behind and so cannot be pinned, this proves vendor/prefix was rebuilt from our
    // source rather than left stale. Mach-O prefixes another underscore, so the substring holds
    // on both platforms.
    marker: '_ZN12libfreenect219defaultColorDecoderEv',
  }],
]);

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

const MUTATIONS = {
  // Anchored on a file no declared edit touches, so what it proves is assertion 2's
  // "undeclared change" arm. Planted in a declared file it would still redden, but through the
  // hash comparison instead, and the control would no longer test what it is named for.
  'undeclared-edit': (tree) => {
    const f = join(tree, 'src', 'frame_listener_impl.cpp');
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
  'oracle-drift': (_tree, oracle) => {
    const f = join(oracle, 'registration.cpp');
    const s = readFileSync(f, 'utf8');
    if (!s.includes('filter_width_half(2)')) throw new Error('anchor missing');
    writeFileSync(f, s.replace('filter_width_half(2)', 'filter_width_half(4)'));
  },
// vendor/prefix-oracle only exists after a registration-check run, so its absence is exit 2.
  'stale-prefix': () => ({ prefix: join(ROOT, 'vendor', 'prefix-oracle') }),
};

const argv = process.argv.slice(2);
const mutation = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
if (mutation && !MUTATIONS[mutation]) {
  console.error(`unknown mutation '${mutation}'; have: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// Mutations run against a throwaway copy so a falsification run cannot alter the real tree.
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
// Differing from upstream only says somebody touched the file; this pins what they left.
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
//    Without it, registration-check could be comparing our build against itself.
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
//    A stale prefix built from other source still links and still streams, looking correct.
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
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed before
  // asserting", and a mutation whose control could not run was never shown to the check.
  if (unproven) { console.log(`DID NOT RUN - ${unproven} claim unproven, so this mutation was never actually shown to the check`); process.exit(2); }
  if (failed === 0) { console.log('NOT CAUGHT - the check passed a tree it should have rejected'); process.exit(1); }
  console.log(`caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(0);
}
if (failed) { console.log('FAIL'); process.exit(1); }
// "Some claims were not tested here" and "a claim failed" are different answers; 1 is the second.
if (unproven) { console.log('PASS on the source, with the artifact untested here'); process.exit(2); }
console.log('PASS');
if (mutation && MUTATIONS[mutation]?.fails) console.log(`[vendor] it should redden: ${MUTATIONS[mutation].fails}`);
process.exit(0);
