// Copies the built grabber and every non-system shared library it loads into DIR/bin and DIR/lib,
// points each file at its neighbours by a relative path, and audits what it wrote. `build-native.mjs
// --stage DIR` is the entry point.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAC_BIN_RPATH = '@loader_path/../lib';
const MAC_LIB_RPATH = '@loader_path';
const LINUX_BIN_RPATH = '$ORIGIN/../lib';
const LINUX_LIB_RPATH = '$ORIGIN';

// What a Mac supplies. Anything else a binary loads is Homebrew's or the build's, and travels.
const MAC_SYSTEM = ['/usr/lib/', '/System/Library/'];
export const isMacSystem = (path) => MAC_SYSTEM.some((p) => path.startsWith(p));

// What a Linux box supplies, which is every library in its own library directories. The four that
// travel are named, because libusb and libturbojpeg sit in those directories beside libc and a
// distribution's copy is not the one this was built and run against.
const LINUX_SYSTEM = ['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/'];
export const isLinuxSystem = (path) => LINUX_SYSTEM.some((p) => path.startsWith(p));
export const LINUX_BUNDLED = /^lib(freenect2|usb-1\.0|turbojpeg|glfw)\.so(\.|$)/;

/** The install names `otool -L` lists, in order. A dylib's own install name comes first. */
export function parseOtoolDeps(text) {
  return text.split('\n').slice(1).map((line) => /^\s+(\S.*?) \(compatibility version/.exec(line)?.[1]).filter(Boolean);
}

/** The install name `otool -D` prints for a dylib. */
export function parseOtoolId(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)[1] ?? null;
}

/** The path of every LC_RPATH command in `otool -l`. */
export function parseOtoolRpaths(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcmd LC_RPATH\b/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const m = /^\s+path (.+) \(offset \d+\)$/.exec(lines[j]);
      if (m) { out.push(m[1]); break; }
    }
  }
  return out;
}

/**
 * `ldd`'s resolved libraries: the name asked for and the path it came to, null when not found. A
 * dependency recorded by an absolute path prints with no arrow and comes back as its own path. The
 * address closing each line is what bounds a path, because a path can hold spaces.
 */
export function parseLdd(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const arrow = /^\s*(\S+) => (?:(not found)|(.+?) \(0x[0-9a-fA-F]+\))\s*$/.exec(line);
    if (arrow) { out.push({ name: arrow[1], path: arrow[2] ? null : arrow[3] }); continue; }
    const bare = /^\s*(\/.+?) \(0x[0-9a-fA-F]+\)\s*$/.exec(line);
    if (bare) out.push({ name: bare[1], path: bare[1] });
  }
  return out;
}

/** The NEEDED names and the RPATH and RUNPATH entries in `readelf -d`. */
export function parseReadelfDynamic(text) {
  const needed = [];
  const rpath = [];
  for (const line of text.split('\n')) {
    const need = /\(NEEDED\)\s+Shared library: \[(.+)\]/.exec(line);
    if (need) needed.push(need[1]);
    const rp = /\((?:RPATH|RUNPATH)\)\s+Library (?:rpath|runpath): \[(.*)\]/.exec(line);
    if (rp) rpath.push(...rp[1].split(':').filter(Boolean));
  }
  return { needed, rpath };
}

/**
 * What is wrong with a staged macOS tree. `files` is one record per Mach-O: its path under the
 * stage, `bin` or `lib`, its install name (libraries), the names it loads and its LC_RPATHs.
 * A dependency is fine when the system owns it, or when it is `@rpath/NAME` and NAME is staged
 * and this file carries the rpath that reaches it.
 */
export function macViolations(files, staged) {
  const problems = [];
  for (const f of files) {
    const want = f.kind === 'bin' ? MAC_BIN_RPATH : MAC_LIB_RPATH;
    for (const r of f.rpaths) {
      if (r !== want) problems.push(`${f.path} carries the rpath ${r}, which is not ${want}`);
    }
    if (f.kind === 'lib' && f.id !== `@rpath/${basename(f.path)}`) {
      problems.push(`${f.path} names itself ${f.id}, not @rpath/${basename(f.path)}`);
    }
    for (const dep of f.deps) {
      if (isMacSystem(dep)) continue;
      if (!dep.startsWith('@rpath/')) {
        problems.push(`${f.path} loads ${dep}, which is neither the system's nor relative to the stage`);
      } else if (!staged.has(dep.slice('@rpath/'.length))) {
        problems.push(`${f.path} loads ${dep}, and lib/ holds no such file`);
      } else if (!f.rpaths.includes(want)) {
        problems.push(`${f.path} loads ${dep} and carries no rpath to find it by`);
      }
    }
  }
  return problems;
}

/**
 * What is wrong with a staged Linux tree. `files` is one record per ELF: its path under the stage,
 * `bin` or `lib`, its NEEDED names and its RPATH and RUNPATH entries. `loaded` is what `ldd` resolved for the
 * grabber, and `stageLib` the real path of lib/. Every library that has to travel has to resolve
 * inside the stage, because a copy on this machine's own library path would run just as well and
 * prove nothing.
 */
export function linuxViolations(files, loaded, stageLib) {
  const problems = [];
  for (const f of files) {
    const want = f.kind === 'bin' ? LINUX_BIN_RPATH : LINUX_LIB_RPATH;
    if (f.rpath.length === 0) problems.push(`${f.path} carries no rpath, so it would be found by the host's search path alone`);
    for (const n of f.needed) {
      if (n.includes('/')) problems.push(`${f.path} needs ${n} by an absolute path, which no rpath redirects`);
    }
    for (const r of f.rpath) {
      if (r !== want) problems.push(`${f.path} carries the rpath ${r}, which is not ${want}`);
    }
  }
  const inStage = (p) => p === stageLib || p.startsWith(`${stageLib}/`);
  for (const { name, path } of loaded) {
    if (path === null) problems.push(`${name} is not found`);
    else if (LINUX_BUNDLED.test(basename(name))) {
      if (!inStage(path)) problems.push(`${name} resolves to ${path}, outside the stage`);
    } else if (!isLinuxSystem(path) && !inStage(path)) {
      problems.push(`${name} resolves to ${path}, which is neither the system's nor in the stage`);
    }
  }
  return problems;
}

const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// Absent means the spawn failed. The exit code is not read, because install_name_tool answers a
// bare call with its usage and a 1.
const need = (bin, args, hint) => {
  if (spawnSync(bin, args, { stdio: 'ignore' }).error) throw new Error(`${bin} is not on PATH - ${hint}`);
};

// A stage carries this file, and only a directory that carries it is replaced. Another directory
// holding bin/ and lib/ is somebody's install, and a typo must not empty it.
const MARKER = '.braindance-stage';

function prepare(dir) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    const entries = readdirSync(dir);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(`${dir} is not empty and is not a stage this wrote - refusing to replace it`);
    }
    const stray = entries.filter((e) => e !== MARKER && e !== 'bin' && e !== 'lib');
    if (stray.length) throw new Error(`${dir} holds ${stray.join(', ')} beside a stage - refusing to replace it`);
    rmSync(join(dir, 'bin'), { recursive: true, force: true });
    rmSync(join(dir, 'lib'), { recursive: true, force: true });
  }
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, MARKER), '');
}

// Copied as a file, never as a link, and made writable: Homebrew's libraries are read-only.
function copyIn(source, target) {
  copyFileSync(source, target);
  chmodSync(target, 0o755);
}

function stageMac(grabber, dir) {
  need('install_name_tool', [], 'install the Xcode command line tools');
  const target = join(dir, 'bin/grabber');
  copyIn(grabber, target);
  const exeRpaths = parseOtoolRpaths(run('otool', ['-l', grabber]));
  const queue = [{ file: target, source: grabber, kind: 'bin' }];
  const bundled = new Map();
  const touched = [];
  while (queue.length) {
    const { file, source, kind } = queue.shift();
    const ownRpaths = parseOtoolRpaths(run('otool', ['-l', file]));
    const id = kind === 'lib' ? parseOtoolId(run('otool', ['-D', file])) : null;
    const changes = [];
    for (const dep of parseOtoolDeps(run('otool', ['-L', file])).filter((d) => d !== id)) {
      if (isMacSystem(dep)) continue;
      const name = basename(dep);
      let from;
      if (dep.startsWith('@rpath/')) {
        const roots = [...ownRpaths, ...exeRpaths].map((r) => r.replace('@loader_path', dirname(source)).replace('@executable_path', dirname(grabber)));
        from = roots.map((r) => join(r, name)).find((p) => existsSync(p));
      } else if (isAbsolute(dep)) from = dep;
      if (!from || !existsSync(from)) throw new Error(`${basename(file)} loads ${dep}, which does not resolve on this machine`);
      from = realpathSync(from);
      if (bundled.has(name) && bundled.get(name) !== from) {
        throw new Error(`two libraries are both called ${name}: ${bundled.get(name)} and ${from}`);
      }
      if (!bundled.has(name)) {
        bundled.set(name, from);
        copyIn(from, join(dir, 'lib', name));
        queue.push({ file: join(dir, 'lib', name), source: from, kind: 'lib' });
      }
      changes.push(['-change', dep, `@rpath/${name}`]);
    }
    // Deleted before the new one goes in, because the old path's load command is the room it takes.
    for (const r of ownRpaths) run('install_name_tool', ['-delete_rpath', r, file]);
    if (kind === 'lib') run('install_name_tool', ['-id', `@rpath/${basename(file)}`, file]);
    for (const c of changes) run('install_name_tool', [...c, file]);
    if (changes.length) run('install_name_tool', ['-add_rpath', kind === 'bin' ? MAC_BIN_RPATH : MAC_LIB_RPATH, file]);
    touched.push(file);
  }
  // The edits invalidate a signature, and an arm64 binary with an invalid one is killed on launch.
  // Ad hoc, because a release signs the whole tree again with its own identity.
  for (const file of touched) run('codesign', ['--force', '--sign', '-', file]);
  return [...bundled.keys()];
}

function stageLinux(grabber, dir) {
  need('patchelf', ['--version'], 'sudo apt install patchelf');
  need('ldd', ['--version'], 'ldd ships with libc-bin');
  const target = join(dir, 'bin/grabber');
  copyIn(grabber, target);
  const names = [];
  for (const { name, path } of parseLdd(run('ldd', [grabber]))) {
    if (!LINUX_BUNDLED.test(name)) continue;
    if (!path) throw new Error(`${name} does not resolve on this machine`);
    copyIn(realpathSync(path), join(dir, 'lib', name));
    names.push(name);
  }
  // Each library gets its own, because a RUNPATH on the grabber does not reach what a library loads.
  run('patchelf', ['--set-rpath', LINUX_BIN_RPATH, target]);
  for (const name of names) run('patchelf', ['--set-rpath', LINUX_LIB_RPATH, join(dir, 'lib', name)]);
  return names;
}

/** Builds DIR/bin/grabber and DIR/lib/* from a built grabber. Returns the library names staged. */
export function stage({ grabber, dir }) {
  const root = resolve(dir);
  prepare(root);
  const libs = process.platform === 'darwin' ? stageMac(grabber, root) : stageLinux(grabber, root);
  if (!libs.length) throw new Error('the grabber loads no library that travels, so there was nothing to stage');
  return libs;
}

// What dyld says it loaded when the grabber answers --help. It prints the real path of every image.
function macLoaded(grabber) {
  const r = spawnSync(grabber, ['--help'], { encoding: 'utf8', env: { ...process.env, DYLD_PRINT_LIBRARIES: '1' } });
  const images = `${r.stderr}${r.stdout}`.split('\n')
    .map((l) => /^dyld\[\d+\]: (?:<[0-9A-Fa-f-]+> )?(\/\S.*)$/.exec(l)?.[1]).filter(Boolean);
  return { images, status: r.status, signal: r.signal };
}

/**
 * Reads the stage back and returns what is wrong with it, with the raw tool output for a log.
 * Nothing here trusts what `stage` meant to write.
 */
export function audit(dir) {
  const root = realpathSync(resolve(dir));
  const lib = join(root, 'lib');
  const names = readdirSync(lib).sort();
  const report = [];
  const files = [{ path: 'bin/grabber', abs: join(root, 'bin/grabber'), kind: 'bin' },
    ...names.map((n) => ({ path: `lib/${n}`, abs: join(lib, n), kind: 'lib' }))];
  const problems = [];
  if (process.platform === 'darwin') {
    const records = files.map((f) => {
      const loads = run('otool', ['-L', f.abs]);
      report.push(`$ otool -L ${f.path}\n${loads.trim()}`);
      const id = f.kind === 'lib' ? parseOtoolId(run('otool', ['-D', f.abs])) : null;
      const rpaths = parseOtoolRpaths(run('otool', ['-l', f.abs]));
      report.push(`  LC_RPATH: ${rpaths.length ? rpaths.join(', ') : '(none)'}`);
      return { path: f.path, kind: f.kind, id, deps: parseOtoolDeps(loads).filter((d) => d !== id), rpaths };
    });
    problems.push(...macViolations(records, new Set(names)));
    for (const f of files) {
      const sig = spawnSync('codesign', ['--verify', '--strict', f.abs], { encoding: 'utf8' });
      if (sig.status !== 0) problems.push(`${f.path} fails codesign --verify: ${sig.stderr.trim().split('\n')[0]}`);
    }
    const { images, status, signal } = macLoaded(join(root, 'bin/grabber'));
    const own = images.filter((i) => !isMacSystem(i));
    const ended = signal ? `killed by ${signal}` : `exit ${status}`;
    report.push(`$ DYLD_PRINT_LIBRARIES=1 bin/grabber --help  (${ended}, ${images.length - own.length} system images not listed)\n${own.map((i) => `  ${i}`).join('\n')}`);
    if (status !== 0) problems.push(`the staged grabber's --help ended with ${ended}`);
    for (const img of images) {
      if (!isMacSystem(img) && !img.startsWith(`${root}/`)) problems.push(`dyld loaded ${img}, outside the stage and the system`);
    }
    // A run that printed no images would read as clean, so each staged library has to be seen.
    for (const n of names) {
      if (!images.some((i) => i === join(lib, n))) problems.push(`dyld never loaded lib/${n} from the stage`);
    }
  } else {
    need('readelf', ['--version'], 'sudo apt install binutils');
    const records = files.map((f) => {
      const dyn = run('readelf', ['-d', f.abs]);
      report.push(`$ readelf -d ${f.path}\n${dyn.split('\n').filter((l) => /NEEDED|RPATH|RUNPATH/.test(l)).join('\n')}`);
      const { needed, rpath } = parseReadelfDynamic(dyn);
      return { path: f.path, kind: f.kind, needed, rpath };
    });
    const env = { ...process.env };
    delete env.LD_LIBRARY_PATH;
    const ldd = run('ldd', [join(root, 'bin/grabber')], { env });
    report.push(`$ ldd bin/grabber\n${ldd.trim()}`);
    const loaded = parseLdd(ldd).map(({ name, path }) => ({ name, path: path && existsSync(path) ? realpathSync(path) : path }));
    problems.push(...linuxViolations(records, loaded, lib));
    for (const n of names) {
      if (!loaded.some((l) => l.name === n && l.path === join(lib, n))) problems.push(`ldd never resolved ${n} to lib/${n}`);
    }
  }
  return { problems, report: report.join('\n') };
}
