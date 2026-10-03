// The readings and the rules `tools/native-stage.mjs` audits a staged grabber by. The otool text is
// what this repo's own build printed for the grabber before staging; the ldd and readelf text is
// glibc's format. Every rule has a case that must come back as a problem, so a rule that stopped
// asking leaves a test red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LINUX_BUNDLED, isLinuxSystem, isMacSystem, linuxViolations, macViolations,
  parseLdd, parseOtoolDeps, parseOtoolId, parseOtoolRpaths, parseReadelfDynamic, stage,
} from '../tools/native-stage.mjs';

const BUILT_GRABBER = `native/build/grabber:
\t@rpath/libfreenect2.0.2.dylib (compatibility version 0.2.0, current version 0.2.0)
\t/opt/homebrew/opt/jpeg-turbo/lib/libturbojpeg.0.dylib (compatibility version 0.0.0, current version 0.5.0)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2200.27.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)
`;
const DYLIB = `lib/libusb-1.0.0.dylib:
\t@rpath/libusb-1.0.0.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/usr/lib/libobjc.A.dylib (compatibility version 1.0.0, current version 228.0.0)
\t/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit (compatibility version 1.0.0, current version 275.0.0)
`;
const LOAD_COMMANDS = `Load command 14
          cmd LC_LOAD_DYLIB
      cmdsize 64
Load command 15
          cmd LC_RPATH
      cmdsize 96
         path /home/build/braindance/vendor/prefix/lib (offset 12)
Load command 16
          cmd LC_RPATH
      cmdsize 56
         path /opt/homebrew/Cellar/jpeg-turbo/3.2.0/lib (offset 12)
`;

test('otool -L reads the install names, and a dylib lists its own first', () => {
  assert.deepEqual(parseOtoolDeps(BUILT_GRABBER), [
    '@rpath/libfreenect2.0.2.dylib',
    '/opt/homebrew/opt/jpeg-turbo/lib/libturbojpeg.0.dylib',
    '/usr/lib/libc++.1.dylib',
    '/usr/lib/libSystem.B.dylib',
  ]);
  assert.equal(parseOtoolDeps(DYLIB)[0], '@rpath/libusb-1.0.0.dylib');
  assert.equal(parseOtoolId('lib/libusb-1.0.0.dylib:\n@rpath/libusb-1.0.0.dylib\n'), '@rpath/libusb-1.0.0.dylib');
});

test('otool -l reads every LC_RPATH and nothing else', () => {
  assert.deepEqual(parseOtoolRpaths(LOAD_COMMANDS), [
    '/home/build/braindance/vendor/prefix/lib',
    '/opt/homebrew/Cellar/jpeg-turbo/3.2.0/lib',
  ]);
  assert.deepEqual(parseOtoolRpaths('Load command 3\n          cmd LC_LOAD_DYLIB\n'), []);
});

test('the system owns /usr/lib and /System/Library on a Mac, and the library directories on Linux', () => {
  assert.ok(isMacSystem('/usr/lib/libc++.1.dylib'));
  assert.ok(isMacSystem('/System/Library/Frameworks/OpenCL.framework/Versions/A/OpenCL'));
  assert.ok(!isMacSystem('/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib'));
  assert.ok(!isMacSystem('/usr/local/lib/libusb-1.0.0.dylib'));
  assert.ok(isLinuxSystem('/lib/x86_64-linux-gnu/libc.so.6'));
  assert.ok(isLinuxSystem('/usr/lib/aarch64-linux-gnu/libstdc++.so.6'));
  assert.ok(!isLinuxSystem('/usr/local/lib/libusb-1.0.so.0'));
  assert.ok(!isLinuxSystem('/home/runner/work/braindance/vendor/prefix/lib/libfreenect2.so.0.2'));
});

const cleanMac = () => [
  { path: 'bin/grabber', kind: 'bin', id: null, rpaths: ['@loader_path/../lib'],
    deps: ['@rpath/libfreenect2.0.2.dylib', '@rpath/libturbojpeg.0.dylib', '/usr/lib/libc++.1.dylib'] },
  { path: 'lib/libfreenect2.0.2.dylib', kind: 'lib', id: '@rpath/libfreenect2.0.2.dylib', rpaths: ['@loader_path'],
    deps: ['@rpath/libusb-1.0.0.dylib', '/System/Library/Frameworks/OpenCL.framework/Versions/A/OpenCL'] },
  { path: 'lib/libusb-1.0.0.dylib', kind: 'lib', id: '@rpath/libusb-1.0.0.dylib', rpaths: [], deps: ['/usr/lib/libobjc.A.dylib'] },
  { path: 'lib/libturbojpeg.0.dylib', kind: 'lib', id: '@rpath/libturbojpeg.0.dylib', rpaths: [], deps: [] },
];
const STAGED = new Set(['libfreenect2.0.2.dylib', 'libusb-1.0.0.dylib', 'libturbojpeg.0.dylib']);

test('a macOS stage that reaches only its own lib/ and the system has no violations', () => {
  assert.deepEqual(macViolations(cleanMac(), STAGED), []);
});

test('a macOS stage is refused for each path that would only work on the machine that built it', () => {
  const broken = (edit) => { const f = cleanMac(); edit(f); return macViolations(f, STAGED); };
  const cases = [
    ['an absolute rpath on the grabber', (f) => { f[0].rpaths.push('/opt/homebrew/lib'); }, /carries the rpath \/opt\/homebrew\/lib/],
    ['the build prefix left as the grabber\'s only rpath', (f) => { f[0].rpaths = ['/home/build/braindance/vendor/prefix/lib']; }, /carries the rpath \/home\/build/],
    ['a dependency still named by its Homebrew path', (f) => { f[1].deps[0] = '/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib'; }, /neither the system's nor relative/],
    ['a dependency on a library that was never staged', (f) => { f[1].deps.push('@rpath/libglfw.3.dylib'); }, /lib\/ holds no such file/],
    ['a library that keeps its Homebrew install name', (f) => { f[2].id = '/opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib'; }, /names itself/],
    ['an rpath Homebrew built into a library', (f) => { f[3].rpaths = ['/opt/homebrew/Cellar/jpeg-turbo/3.2.0/lib']; }, /carries the rpath/],
    ['a library that loads a neighbour and carries no rpath to find it', (f) => { f[1].rpaths = []; }, /carries no rpath to find it/],
    ['a grabber that loads a neighbour and carries no rpath', (f) => { f[0].rpaths = []; }, /carries no rpath to find it/],
  ];
  for (const [what, edit, expected] of cases) {
    const problems = broken(edit);
    assert.ok(problems.some((p) => expected.test(p)), `${what} should be refused, got ${JSON.stringify(problems)}`);
  }
});

const LDD = `\tlinux-vdso.so.1 (0x00007ffd4b5f6000)
\tlibfreenect2.so.0.2 => /tmp/stage/lib/libfreenect2.so.0.2 (0x00007f1b4a000000)
\tlibusb-1.0.so.0 => /tmp/stage/lib/libusb-1.0.so.0 (0x00007f1b49f00000)
\tlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f1b49c00000)
\tlibudev.so.1 => not found
\t/lib64/ld-linux-x86-64.so.2 (0x00007f1b4b2a0000)
`;

test('ldd gives the name asked for and where it came to, or null when it did not', () => {
  assert.deepEqual(parseLdd(LDD), [
    { name: 'libfreenect2.so.0.2', path: '/tmp/stage/lib/libfreenect2.so.0.2' },
    { name: 'libusb-1.0.so.0', path: '/tmp/stage/lib/libusb-1.0.so.0' },
    { name: 'libstdc++.so.6', path: '/lib/x86_64-linux-gnu/libstdc++.so.6' },
    { name: 'libudev.so.1', path: null },
  ]);
});

test('readelf -d reads the needed names and every rpath entry, RPATH or RUNPATH', () => {
  const text = ` 0x0000000000000001 (NEEDED)             Shared library: [libfreenect2.so.0.2]
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN/../lib]
 0x000000000000000f (RPATH)              Library rpath: [/a/lib:/b/lib]
`;
  assert.deepEqual(parseReadelfDynamic(text), {
    needed: ['libfreenect2.so.0.2', 'libc.so.6'],
    rpath: ['$ORIGIN/../lib', '/a/lib', '/b/lib'],
  });
  assert.deepEqual(parseReadelfDynamic('Dynamic section at offset 0x2d40 contains 28 entries:\n').rpath, []);
});

test('the four libraries that travel on Linux are named, and a distribution\'s other libraries are not', () => {
  for (const name of ['libfreenect2.so.0.2', 'libusb-1.0.so.0', 'libturbojpeg.so.0', 'libglfw.so.3']) {
    assert.ok(LINUX_BUNDLED.test(name), name);
  }
  for (const name of ['libc.so.6', 'libstdc++.so.6', 'libGL.so.1', 'libudev.so.1', 'libusbmuxd.so.6', 'libglfwx.so.3']) {
    assert.ok(!LINUX_BUNDLED.test(name), name);
  }
});

const STAGE_LIB = '/tmp/stage/lib';
const cleanLinux = () => ({
  files: [
    { path: 'bin/grabber', kind: 'bin', rpath: ['$ORIGIN/../lib'] },
    { path: 'lib/libfreenect2.so.0.2', kind: 'lib', rpath: ['$ORIGIN'] },
    { path: 'lib/libusb-1.0.so.0', kind: 'lib', rpath: ['$ORIGIN'] },
  ],
  loaded: [
    { name: 'libfreenect2.so.0.2', path: `${STAGE_LIB}/libfreenect2.so.0.2` },
    { name: 'libusb-1.0.so.0', path: `${STAGE_LIB}/libusb-1.0.so.0` },
    { name: 'libc.so.6', path: '/lib/x86_64-linux-gnu/libc.so.6' },
  ],
});

test('a Linux stage whose own libraries resolve inside it and the rest in the system has no violations', () => {
  const { files, loaded } = cleanLinux();
  assert.deepEqual(linuxViolations(files, loaded, STAGE_LIB), []);
});

test('a Linux stage is refused when a library that has to travel resolves somewhere else, because that run proves nothing', () => {
  const broken = (edit) => { const s = cleanLinux(); edit(s); return linuxViolations(s.files, s.loaded, STAGE_LIB); };
  const cases = [
    ['a bundled library found on the host\'s own library path', (s) => { s.loaded[1].path = '/lib/x86_64-linux-gnu/libusb-1.0.so.0'; }, /libusb-1\.0\.so\.0 resolves to \/lib\/x86_64-linux-gnu.*outside the stage/],
    ['a bundled library found under the build prefix', (s) => { s.loaded[0].path = '/home/runner/vendor/prefix/lib/libfreenect2.so.0.2'; }, /outside the stage/],
    ['a library that is not found', (s) => { s.loaded.push({ name: 'libglfw.so.3', path: null }); }, /libglfw\.so\.3 is not found/],
    ['a system library resolved from a non-system directory', (s) => { s.loaded[2].path = '/usr/local/lib/libc.so.6'; }, /neither the system's nor in the stage/],
    ['an absolute rpath on the grabber', (s) => { s.files[0].rpath = ['/home/runner/vendor/prefix/lib']; }, /carries the rpath \/home\/runner/],
    ['no rpath on a library', (s) => { s.files[1].rpath = []; }, /carries no rpath/],
    ['the grabber\'s rpath on a library', (s) => { s.files[2].rpath = ['$ORIGIN/../lib']; }, /not \$ORIGIN/],
  ];
  for (const [what, edit, expected] of cases) {
    const problems = broken(edit);
    assert.ok(problems.some((p) => expected.test(p)), `${what} should be refused, got ${JSON.stringify(problems)}`);
  }
});

test('stage refuses a directory that holds anything beyond a stage, before it touches it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'braindance-stage-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'keep'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    assert.throws(() => stage({ grabber: join(dir, 'no-such-grabber'), dir }), /notes\.txt.*not part of a stage/);
    assert.ok(existsSync(join(dir, 'bin', 'keep')) && existsSync(join(dir, 'notes.txt')), 'a refused directory is left as it was');
    const file = join(dir, 'notes.txt');
    assert.throws(() => stage({ grabber: file, dir: file }), /is not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
