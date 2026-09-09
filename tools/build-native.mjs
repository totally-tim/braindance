#!/usr/bin/env node
// Builds libfreenect2 from third_party into the gitignored vendor/prefix and the grabber
// into native/build, then runs the grabber, because a build can exit 0 with nothing usable.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: node tools/build-native.mjs [--preset macos|linux] [--jobs N] [--clean]

  --preset overrides the platform detection. macos builds depth on OpenCL and leaves
           OpenGL off; linux is the other way round and covers the Raspberry Pi.
  --jobs   parallel compile jobs. Defaults to this machine's core count, capped at 8.
  --clean  removes vendor/build, vendor/prefix and native/build first. The vendored
           library is a one-time build, so the ordinary run reuses it.`);
  process.exit(0);
}

// Two presets, and the Pi rides with linux because its V3D has no OpenCL. ENABLE_OPENGL=ON
// is only a request - a missing GLFW3 gives a successful CPU-only build - so `backend` is
// what the built grabber must report back.
const PRESETS = {
  macos: {
    cmake: ['-DENABLE_OPENCL=ON', '-DENABLE_OPENGL=OFF'],
    why: 'depth on OpenCL, OpenGL off (it only drives libfreenect2\'s own viewer)',
    backend: 'cl',
    missing: 'OpenCL is a system framework here, so a build without it means the configure did not see it - check vendor/build/CMakeCache.txt',
  },
  linux: {
    cmake: ['-DENABLE_OPENCL=OFF', '-DENABLE_OPENGL=ON'],
    why: 'depth on OpenGL, OpenCL off (the Pi\'s V3D has no OpenCL)',
    backend: 'gl',
    missing: 'sudo apt install libglfw3-dev libgl1-mesa-dev, then re-run with --clean',
  },
};

const detect = () => {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return null;
};

const preset = flag('--preset') ?? detect();
if (!preset || !PRESETS[preset]) {
  const named = flag('--preset');
  console.error(named
    ? `unknown preset ${named} - this ships ${Object.keys(PRESETS).join(' and ')}`
    : `no preset for platform ${process.platform} - pass --preset ${Object.keys(PRESETS).join('|')} if one of them fits`);
  process.exit(2);
}

const JOBS = Number(flag('--jobs')) || Math.min(cpus().length || 4, 8);

const VENDOR_BUILD = join(REPO, 'vendor/build');
const VENDOR_PREFIX = join(REPO, 'vendor/prefix');
const NATIVE_BUILD = join(REPO, 'native/build');
const GRABBER = join(NATIVE_BUILD, 'grabber');

// brew --prefix rather than a literal /opt/homebrew, which is Apple-Silicon-only.
const brewPrefix = (formula) => {
  const r = spawnSync('brew', ['--prefix', formula], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  const path = r.stdout.trim();
  return existsSync(path) ? path : null;
};

const have = (bin, args = ['--version']) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0;

if (!have('cmake')) {
  console.error(`cmake is not on PATH - ${preset === 'macos' ? 'brew install cmake' : 'sudo apt install cmake'}`);
  process.exit(2);
}

const vendorFlags = [
  // CMake 4 dropped pre-3.5 policies, and libfreenect2 v0.2.1 predates that floor.
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
  `-DCMAKE_INSTALL_PREFIX=${VENDOR_PREFIX}`,
  '-DENABLE_CXX11=ON',
  '-DENABLE_CUDA=OFF',
  ...PRESETS[preset].cmake,
];

if (preset === 'macos') {
  const missing = ['libusb', 'jpeg-turbo'].filter((f) => !brewPrefix(f));
  if (missing.length) {
    console.error(`missing Homebrew packages: ${missing.join(', ')} - brew install ${missing.join(' ')}`);
    process.exit(2);
  }
  // Pointed at explicitly because libfreenect2's finder does not look in Homebrew's opt paths.
  const jpeg = brewPrefix('jpeg-turbo');
  vendorFlags.push(
    `-DTurboJPEG_INCLUDE_DIRS=${join(jpeg, 'include')}`,
    `-DTurboJPEG_LIBRARIES=${join(jpeg, 'lib/libturbojpeg.dylib')}`,
  );
}

const run = (bin, args) => {
  console.log(`[build-native] ${bin} ${args.join(' ')}`);
  execFileSync(bin, args, { cwd: REPO, stdio: 'inherit' });
};

console.log(`[build-native] preset ${preset} - ${PRESETS[preset].why}`);
console.log(`[build-native] ${JOBS} parallel jobs`);

if (argv.includes('--clean')) {
  for (const dir of [VENDOR_BUILD, VENDOR_PREFIX, NATIVE_BUILD]) rmSync(dir, { recursive: true, force: true });
  console.log('[build-native] removed vendor/build, vendor/prefix and native/build');
}

try {
  run('cmake', ['-S', 'third_party/libfreenect2', '-B', 'vendor/build', ...vendorFlags]);
  run('cmake', ['--build', 'vendor/build', '--target', 'install', `-j${JOBS}`]);
  // Passed rather than defaulted: native/CMakeLists.txt declares FREENECT2_ROOT as a cache
  // entry, and a cache already holding one from an earlier -D override keeps it.
  run('cmake', ['-S', 'native', '-B', 'native/build', `-DFREENECT2_ROOT=${VENDOR_PREFIX}`]);
  run('cmake', ['--build', 'native/build', `-j${JOBS}`]);
} catch {
  // execFileSync already put the compiler's output on this terminal; repeating it buries it.
  console.error('[build-native] FAILED - the build did not complete; its output is above');
  process.exit(2);
}

// --help returns before device enumeration, so this stays true on a machine with no sensor.
if (!existsSync(GRABBER)) {
  console.error(`[build-native] FAILED - cmake reported success but ${GRABBER} does not exist`);
  process.exit(1);
}

const probe = spawnSync(GRABBER, ['--help'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('[build-native] FAILED - the grabber was built but will not run:');
  console.error((probe.stderr || probe.stdout || `exit ${probe.status}`).trim());
  console.error('a dyld failure here means the binary is not resolving vendor/prefix');
  process.exit(1);
}

// Read out of the binary's own usage rather than out of the flags passed in, because those
// two disagreeing is the point of asking. Both streams: the grabber writes usage to stderr.
const offers = /this build offers ([a-z ]+)/.exec(`${probe.stderr}${probe.stdout}`)?.[1]?.trim();
console.log(`[build-native] grabber runs and reports depth pipelines: ${offers ?? 'unknown'}`);

// Checked rather than printed: every build offers `cpu`, so an unreadable `offers` fails here.
const { backend, missing } = PRESETS[preset];
if (!offers || !offers.split(/\s+/).includes(backend)) {
  console.error(`[build-native] FAILED - the ${preset} preset asks for ${backend} depth, and this build offers ${offers ? `only ${offers}` : 'a set this script could not read'}`);
  console.error(`the library configured without it and fell back to cpu, which runs at roughly half rate: ${missing}`);
  process.exit(1);
}
// The colour decoders, read the same way and for the same reason. The default is checked against
// the offered set rather than printed, because `decoder_flag_value` answers "" for an enumerator
// it has no case for - so a decoder added to libfreenect2's enum and not to the grabber's spelling
// table would leave the grabber defaulting to a name no arm accepts, and every run would exit 2.
const usage = `${probe.stderr}${probe.stdout}`;
const decoders = /This build offers:\s*\n\s*([a-z ]+)/.exec(usage)?.[1]?.trim();
const defaultDecoder = /This build offers:[\s\S]*?and defaults to ([a-z]+)\./.exec(usage)?.[1];
console.log(`[build-native] and colour decoders: ${decoders ?? 'unknown'} (default ${defaultDecoder ?? 'unknown'})`);
if (!decoders || !defaultDecoder || !decoders.split(/\s+/).includes(defaultDecoder)) {
  console.error(`[build-native] FAILED - this build offers colour decoders ${decoders ? `'${decoders}'` : 'this script could not read'}`
    + ` and defaults to ${defaultDecoder ? `'${defaultDecoder}'` : 'a name this script could not read'},`
    + ' which is not one of them - the grabber would refuse its own default');
  process.exit(1);
}

console.log(`[build-native] OK - ${GRABBER}`);
console.log('[build-native] node tools/vendor-check.mjs proves the tree is upstream v0.2.1 plus the declared edits');
