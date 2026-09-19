// A mutation of a native source that a check can trust to have reached the build it then asks,
// and the rebuild that puts the tree back on every way out of the process. The checks that mutate
// native code build through `tools/build-native.mjs`, so this is the one place both rules live.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// What a build produces that a check reads: the grabber, and the library a probe links. Whichever
// of the two library names this platform installs is the one present.
const OUTPUTS = ['native/build/grabber', 'vendor/prefix/lib/libfreenect2.dylib', 'vendor/prefix/lib/libfreenect2.so'];

/** Runs `tools/build-native.mjs`. Null when it built, otherwise the tail of what it printed. */
export function buildNative() {
  const r = spawnSync(process.execPath, [join(REPO, 'tools/build-native.mjs')], { encoding: 'utf8' });
  if (r.status === 0) return null;
  return (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-6).join('\n');
}

/** One hash over every build output present, so a mutation that reached any of them moves it. */
export function builtHash() {
  const hash = createHash('sha256');
  for (const rel of OUTPUTS) {
    const path = join(REPO, rel);
    if (existsSync(path)) hash.update(rel).update(readFileSync(path));
  }
  return hash.digest('hex');
}

// The make cmake drives on macOS compares timestamps to the second, so a source written in the
// second its object was built in reads as up to date and the rebuild keeps the old build: measured
// as a mutation NOT CAUGHT against a grabber built from the unmutated source, and as a restore that
// left the mutated grabber in place. Every output is no newer than now, so the next second is
// newer than all of them.
function writeAfterTheSecond(file, text) {
  const wait = (Math.floor(Date.now() / 1000) + 1) * 1000 - Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait + 20);
  writeFileSync(file, text);
}

/**
 * Applies `edits` to the source at `rel` and rebuilds, after building the source as it stands so
 * there is a build to differ from. The source goes back, and is rebuilt, when the process exits.
 * Answers null when the mutated build is in place, or why no mutated build exists to ask.
 */
export function mutateNative(tag, rel, edits) {
  const file = join(REPO, rel);
  const original = readFileSync(file, 'utf8');
  let text = original;
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) return `the mutation matched ${hits} times in ${rel}, expected exactly 1 - re-anchor it`;
    text = text.replace(from, to);
  }
  const unbuilt = buildNative();
  if (unbuilt) return `build-native failed on this tree's own source:\n${unbuilt}`;
  const clean = builtHash();

  let mutated = null;
  let pending = true;
  // Leaving either the source or the build behind hands the next tool a tree that reads clean and
  // a build that is not made from it, which is the one failure a mutation control must not cause.
  // `exit` because a check runs to its end without yielding: Ctrl-C kills the rebuild in flight,
  // the check runs on, and this puts the source back on the way out.
  process.on('exit', () => {
    if (!pending) return;
    pending = false;
    writeAfterTheSecond(file, original);
    console.log(`[${tag}] restored ${rel}, rebuilding`);
    const failed = buildNative();
    if (failed || (mutated !== null && builtHash() === mutated)) {
      console.error(`[${tag}] ${rel} is back but the build is still the mutated one`
        + ' - run `npm run build:native` before trusting anything');
    }
  });

  writeAfterTheSecond(file, text);
  const refused = buildNative();
  if (refused) return `build-native failed with the mutation applied:\n${refused}`;
  mutated = builtHash();
  // Read as NOT CAUGHT, a build the mutation never reached is the same line a blind row prints.
  if (mutated === clean) return `the rebuild with the mutation applied left every build output unchanged`;
  return null;
}
