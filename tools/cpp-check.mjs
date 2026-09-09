#!/usr/bin/env node
// Parses and typechecks the two C++ files this repo ships, in eight configurations of the
// macros grabber.cpp branches on: the four combinations of the two pipeline macros, and four
// more carrying a colour decoder each, so every decoder branch and every decoder refusal
// branch is compiled somewhere. Five probes beside them hold that each ColorDecoder enumerator
// exists only on a build carrying that decoder. No sensor, no prefix, no link step: a call to a
// function present in the headers and absent from the library is as green here as a correct
// one, and which processor an enumerator maps to is `tools/decoder-check.mjs`. Exit 1 means a
// claim failed; exit 2 means the harness did not run.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;

const MUTATIONS = {
  'grabber-syntax-error': {
    file: 'native/grabber.cpp',
    edits: [['  std::string logLevel = "warning";', '  std::string logLevel = ;']],
  },

  // A wrong argument type, because `-fsyntax-only` is a semantic pass and this is the
  // row that says so.
  'grabber-type-error': {
    file: 'native/grabber.cpp',
    edits: [['  HdEncoder hdEncoder(jpegQuality);', '  HdEncoder hdEncoder("high");']],
    fails: 'a wrong argument type, which is the row that says this is a semantic pass and not a '
      + 'tokeniser',
  },

  'opencl-branch-broken': {
    file: 'native/grabber.cpp',
    edits: [[
      '    pipeline = new libfreenect2::OpenCLPacketPipeline(-1, colorDecoder);',
      '    pipeline = new libfreenect2::OpenCLPacketPipelineThatDoesNotExist(-1, colorDecoder);',
    ]],
  },

  // The arm that earns the matrix: it is compiled out of every build on the machine this runs from.
  'opengl-branch-broken': {
    file: 'native/grabber.cpp',
    edits: [[
      '    pipeline = new libfreenect2::OpenGLPacketPipeline(0, false, colorDecoder);',
      '    pipeline = new libfreenect2::OpenGLPacketPipelineThatDoesNotExist(0, false, colorDecoder);',
    ]],
    fails: 'a break inside the Pi\'s `#ifdef` arm, which is the control the matrix exists for: a '
      + 'gate parsing one configuration reports this green. Reddens 4 of the 8 grabber rows, '
      + 'not all of them - read the rows',
  },

  // The decoder counterpart: an arm nothing on this Mac compiles, so it says the decoder
  // configurations are parsed rather than listed.
  'vaapi-branch-broken': {
    file: 'native/grabber.cpp',
    edits: [[
      '    colorDecoder = libfreenect2::ColorDecoder::VAAPI;',
      '    colorDecoder = libfreenect2::ColorDecoder::VAAPIThatDoesNotExist;',
    ]],
    fails: 'a break inside the grabber\'s VAAPI `#ifdef` arm, which no build on this machine '
      + 'compiles. Reddens 1 of the 8 grabber rows, the vaapi one, and leaves the decoder rows '
      + 'alone because their probes are generated rather than read from the grabber - read the rows',
  },

  // Gate the list once instead of once per decoder and every enumerator exists on every build,
  // which is the state that makes `createRgbPacketProcessor` return NULL for a name the grabber
  // accepted. An all-off arm beside an all-on arm reports this green.
  'enum-gated-as-a-block': {
    file: 'third_party/libfreenect2/include/libfreenect2/packet_pipeline.h',
    edits: [[
      'enum class ColorDecoder\n'
      + '{\n'
      + '#ifdef LIBFREENECT2_WITH_VT_SUPPORT\n  VideoToolbox,\n#endif\n'
      + '#ifdef LIBFREENECT2_WITH_TURBOJPEG_SUPPORT\n  TurboJPEG,\n#endif\n'
      + '#ifdef LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT\n  TegraJPEG,\n#endif\n'
      + '#ifdef LIBFREENECT2_WITH_VAAPI_SUPPORT\n  VAAPI,\n#endif\n'
      + '};',
      'enum class ColorDecoder\n'
      + '{\n'
      + '#if defined(LIBFREENECT2_WITH_VT_SUPPORT) || defined(LIBFREENECT2_WITH_TURBOJPEG_SUPPORT) \\\n'
      + ' || defined(LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT) || defined(LIBFREENECT2_WITH_VAAPI_SUPPORT)\n'
      + '  VideoToolbox,\n  TurboJPEG,\n  TegraJPEG,\n  VAAPI,\n#endif\n'
      + '};',
    ]],
    fails: 'one gate around the whole enumerator list instead of one per decoder. Reddens all 4 '
      + 'per-decoder rows and leaves the all-four row and every grabber row green, because the '
      + 'grabber names an enumerator only inside its own `#ifdef` - read the rows',
  },

  'harness-syntax-error': {
    file: 'native/harness/reg-runner.cpp',
    edits: [['#include <cstdio>', '#include <cstdio>\nint broken( = ;']],
  },
};

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

let failed = 0;
let asserted = 0;
const check = (ok, what) => {
  asserted++;
  if (ok) console.log(`  ok   ${what}`);
  else { failed++; console.log(`  FAIL ${what}`); }
};
const cannotRun = (why) => { console.error(`[cpp-check] ${why}`); process.exit(2); };

const CXX = process.env.CXX || 'c++';
if (spawnSync(CXX, ['--version'], { encoding: 'utf8' }).status !== 0) {
  cannotRun(`no C++ compiler: ${CXX} --version did not answer. Set CXX= to one that does.`);
}

// turbojpeg is keg-only under Homebrew, resolved the same way and order as native/CMakeLists.txt.
const turbojpegInclude = () => {
  const pc = spawnSync('pkg-config', ['--cflags-only-I', 'libturbojpeg'], { encoding: 'utf8' });
  if (pc.status === 0) {
    const dir = pc.stdout.trim().replace(/^-I/, '').split(/\s+/)[0];
    if (dir && existsSync(join(dir, 'turbojpeg.h'))) return dir;
  }
  for (const dir of ['/opt/homebrew/opt/jpeg-turbo/include', '/usr/local/opt/jpeg-turbo/include',
    '/usr/include', '/usr/local/include']) {
    if (existsSync(join(dir, 'turbojpeg.h'))) return dir;
  }
  return null;
};
const TURBOJPEG = turbojpegInclude();
if (!TURBOJPEG) {
  cannotRun('turbojpeg.h not found - install libturbojpeg0-dev or `brew install jpeg-turbo`.'
    + ' Nothing was checked.');
}

const VENDOR_INCLUDE = join(REPO, 'third_party/libfreenect2/include');
const CONFIG_IN = join(VENDOR_INCLUDE, 'libfreenect2/config.h.in');
if (!existsSync(CONFIG_IN)) {
  cannotRun(`${CONFIG_IN} is missing, so there is no header to template and nothing was checked`);
}

const TMP = mkdtempSync(join(tmpdir(), 'cpp-check-'));

// `#cmakedefine X` becomes `#define X` when the feature is on and a comment when it is off,
// which is what CMake does with it. What is left over is dropped rather than left to choke on.
const writeConfig = (dir, features) => {
  const on = new Set([...features, 'LIBFREENECT2_THREADING_STDLIB', 'LIBFREENECT2_WITH_CXX11_SUPPORT']);
  const text = readFileSync(CONFIG_IN, 'utf8')
    .replace(/@PROJECT_VER@/g, '0.2.1')
    .replace(/@PROJECT_VER_MAJOR@/g, '0')
    .replace(/@PROJECT_VER_MINOR@/g, '2')
    .replace(/@TegraJPEG_LIBRARIES@/g, '')
    .split('\n')
    .map((line) => {
      const m = /^#cmakedefine\s+(\w+)/.exec(line);
      if (!m) return line;
      return on.has(m[1]) ? `#define ${m[1]}` : `/* ${m[1]} off in this arm */`;
    })
    .join('\n');
  mkdirSync(join(dir, 'libfreenect2'), { recursive: true });
  writeFileSync(join(dir, 'libfreenect2/config.h'), text);
  // What generate_export_header writes, reduced to what an unlinked translation unit can observe.
  writeFileSync(join(dir, 'libfreenect2/export.h'),
    '#ifndef LIBFREENECT2_EXPORT_H\n#define LIBFREENECT2_EXPORT_H\n'
    + '#define LIBFREENECT2_EXPORT\n#define LIBFREENECT2_NO_EXPORT\n#define LIBFREENECT2_DEPRECATED\n'
    + '#endif\n');
};

// A mutation is a literal substitution that has to match exactly once, and is refused
// loudly otherwise.
const sourceFor = (rel) => {
  const original = readFileSync(join(REPO, rel), 'utf8');
  if (!MUTATE || MUTATIONS[MUTATE].file !== rel) return original;
  let text = original;
  for (const [from, to] of MUTATIONS[MUTATE].edits) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) {
      cannotRun(`mutation ${MUTATE} anchors on text appearing ${hits} times in ${rel}, not once`
        + ' - re-anchor it. Nothing was checked.');
    }
    text = text.replace(from, to);
  }
  return text;
};

const staged = (rel) => {
  const at = join(TMP, rel.replace(/\//g, '__'));
  writeFileSync(at, sourceFor(rel));
  return at;
};

// The vendored header a mutation can reach, ahead of the real include directory on every arm's
// path so the copy wins. A run with no mutation writes the file back byte for byte, which is
// what lets one include list serve both.
const VENDOR_HEADER = 'third_party/libfreenect2/include/libfreenect2/packet_pipeline.h';
const VENDOR_STAGED = join(TMP, 'vendor-staged');
mkdirSync(join(VENDOR_STAGED, 'libfreenect2'), { recursive: true });
writeFileSync(join(VENDOR_STAGED, 'libfreenect2/packet_pipeline.h'), sourceFor(VENDOR_HEADER));

const parse = (path, includes) => {
  const r = spawnSync(CXX, ['-fsyntax-only', '-std=c++11',
    ...includes.flatMap((d) => ['-I', d]), path], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
};

// A compiler that had stopped rejecting broken code would make every row below a green light
// wired to nothing, so the mechanism is shown to work on this machine before it is used.
const canary = join(TMP, 'canary.cpp');
writeFileSync(canary, 'int main() { int x = ; }\n');
if (parse(canary, []).ok) {
  cannotRun(`${CXX} -fsyntax-only accepted a file with a syntax error in it,`
    + ' so every check below would pass whatever the source said. Nothing was checked.');
}
console.log(`  ok   ${CXX} rejects a planted syntax error, so this run can mean something`);

// Each enumerator is gated on the macro that gates its own decoder, which is what makes
// `createRgbPacketProcessor`'s trailing `return NULL` unreachable and lets the grabber refuse a
// name before it opens anything. One arm per decoder asks that directly: with the other three
// macros on, a translation unit naming this one alone has to be refused, and the rejection has
// to name it, so a typo or a bad include path cannot pass for the catch. An all-off arm beside
// an all-on arm cannot ask it - the two differ on whether any decoder exists, so one `#if
// defined(A) || defined(B) || defined(C) || defined(D)` around the whole list satisfies both.
const DECODERS = [
  ['VideoToolbox', 'LIBFREENECT2_WITH_VT_SUPPORT'],
  ['TurboJPEG', 'LIBFREENECT2_WITH_TURBOJPEG_SUPPORT'],
  ['TegraJPEG', 'LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT'],
  ['VAAPI', 'LIBFREENECT2_WITH_VAAPI_SUPPORT'],
];
console.log('\nlibfreenect2::ColorDecoder, per decoder');
{
  // The path must not carry the enumerator: every compiler prints the filename in its
  // diagnostics, so a probe called `enum-probe-VAAPI.cpp` satisfies "the rejection names VAAPI"
  // by failing for any reason at all. Numbered, the name can only come from the diagnostic body.
  let probeIndex = 0;
  const probeNaming = (names) => {
    const at = join(TMP, `enum-probe-${probeIndex++}.cpp`);
    writeFileSync(at, '#include <libfreenect2/packet_pipeline.h>\n'
      + 'int main() {\n  libfreenect2::ColorDecoder wanted[] = {\n'
      + names.map((d) => `    libfreenect2::ColorDecoder::${d},\n`).join('')
      + '  };\n  (void)wanted;\n  return 0;\n}\n');
    return at;
  };

  // The positive control. Every arm below expects a refusal, and a probe broken in any other
  // way - a bad include path, a misspelled enumerator - refuses too.
  const all = join(TMP, 'inc-probe-all');
  writeConfig(all, DECODERS.map(([, macro]) => macro));
  const positive = parse(probeNaming(DECODERS.map(([name]) => name)), [all, VENDOR_STAGED, VENDOR_INCLUDE]);
  check(positive.ok, 'a unit naming all four decoders compiles against a build carrying all four,'
    + ' so a refusal below is the gating and not a broken probe');
  if (!positive.ok) {
    console.log(positive.out.split('\n').slice(0, 12).map((l) => `       ${l}`).join('\n'));
  }

  for (const [name, macro] of DECODERS) {
    const dir = join(TMP, `inc-probe-no-${name}`);
    writeConfig(dir, DECODERS.filter(([d]) => d !== name).map(([, m]) => m));
    const r = parse(probeNaming([name]), [dir, VENDOR_STAGED, VENDOR_INCLUDE]);
    check(!r.ok && r.out.includes(name),
      `a build carrying the other three decoders and not ${macro} refuses ${name} by name`
      + `${r.ok ? ' - it compiled, so the enumerator exists without its decoder' : ''}`
      + `${!r.ok && !r.out.includes(name) ? ` - refused without naming ${name}` : ''}`);
  }
}

// The pipeline macros grabber.cpp branches on, then one arm per colour decoder. `cpu only` is
// what a CPU-only libfreenect2 gives you, and it also compiles the empty enum. Every decoder
// has an arm defining it and an arm without it, so both sides of each decoder `#ifdef` parse.
const ARMS = [
  ['cpu only', []],
  ['opengl', ['LIBFREENECT2_WITH_OPENGL_SUPPORT']],
  ['opencl', ['LIBFREENECT2_WITH_OPENCL_SUPPORT']],
  ['opengl+opencl', ['LIBFREENECT2_WITH_OPENGL_SUPPORT', 'LIBFREENECT2_WITH_OPENCL_SUPPORT']],
  // A Linux desktop.
  ['vaapi+turbojpeg, opengl', ['LIBFREENECT2_WITH_OPENGL_SUPPORT',
    'LIBFREENECT2_WITH_VAAPI_SUPPORT', 'LIBFREENECT2_WITH_TURBOJPEG_SUPPORT']],
  // This Mac.
  ['videotoolbox+turbojpeg, opencl', ['LIBFREENECT2_WITH_OPENCL_SUPPORT',
    'LIBFREENECT2_WITH_VT_SUPPORT', 'LIBFREENECT2_WITH_TURBOJPEG_SUPPORT']],
  // A Jetson.
  ['tegrajpeg+turbojpeg, opengl', ['LIBFREENECT2_WITH_OPENGL_SUPPORT',
    'LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT', 'LIBFREENECT2_WITH_TURBOJPEG_SUPPORT']],
  // A plain Linux box.
  ['turbojpeg, cpu only', ['LIBFREENECT2_WITH_TURBOJPEG_SUPPORT']],
];

const GRABBER = staged('native/grabber.cpp');
const RUNNER = staged('native/harness/reg-runner.cpp');

console.log('\nnative/grabber.cpp, per pipeline and colour-decoder configuration');
for (const [i, [label, features]] of ARMS.entries()) {
  // The index gives each arm its own directory. Two labels stripping to the same letters would
  // otherwise share one config, and the second arm would report on macros it was not given.
  const dir = join(TMP, `inc-${i}-${label.replace(/[^a-z]/g, '')}`);
  writeConfig(dir, features);
  const r = parse(GRABBER, [dir, VENDOR_STAGED, VENDOR_INCLUDE, TURBOJPEG]);
  check(r.ok, `grabber.cpp parses and typechecks with ${label}`);
  if (!r.ok) console.log(r.out.split('\n').slice(0, 12).map((l) => `       ${l}`).join('\n'));
}

// The harness branches on neither macro, so one arm is the whole of it.
console.log('\nnative/harness/reg-runner.cpp, which branches on neither macro');
{
  const dir = join(TMP, 'inc-runner');
  writeConfig(dir, ['LIBFREENECT2_WITH_OPENCL_SUPPORT']);
  const r = parse(RUNNER, [dir, VENDOR_STAGED, VENDOR_INCLUDE]);
  check(r.ok, 'reg-runner.cpp parses and typechecks');
  if (!r.ok) console.log(r.out.split('\n').slice(0, 12).map((l) => `       ${l}`).join('\n'));
}

console.log(`\n${asserted} assertions, ${failed} failed`);
console.log('parse and typecheck only - nothing was linked and nothing ran;'
  + ' see CLAUDE.md "Proof tools" for what actually exercises the grabber');
if (MUTATE && MUTATIONS[MUTATE]?.fails) console.log(`it should redden: ${MUTATIONS[MUTATE].fails}`);
process.exit(failed ? 1 : 0);
