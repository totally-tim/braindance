#!/usr/bin/env node
// Each ColorDecoder enumerator builds its own processor, in the library this build loads.
// `cpp-check` holds that an enumerator exists only where its decoder does; nothing there reaches
// the mapping behind the enumerator, because it never links. The grabber cannot see it either:
// it reports the decoder by echoing the flag it was handed, so a `ColorDecoder::TurboJPEG` that
// builds the VideoToolbox processor still prints `turbojpeg colour decode` on every line it
// writes. This links the built library and asks the pipeline what it made.
//
// The grabber's own flag-to-enumerator chain is covered too, but by the grabber: it spells the
// enumerator it picked back through its name table and refuses a disagreement, inside the
// argument pass. `--check` runs that and exits, so the rows below reach it with no device.
//
// Needs `vendor/prefix`, so `npm run build:native` comes first. No sensor is needed and none is
// opened: the grabber is asked only for names it refuses before it enumerates. Constructing a
// VAAPI or TegraJPEG pipeline does open that decoder's own device, because its processor does
// that in its constructor. Exit 1 means a claim failed; exit 2 means nothing ran.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutateNative } from './native-mutation.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;

const PIPELINE_CPP = 'third_party/libfreenect2/src/packet_pipeline.cpp';

// Every mutation edits a file the build reads and is undone before this process exits, because
// the only way to ask what the library does is to build one. `npm run build:native` is 4s once
// the tree is warm, so each of these costs three rebuilds rather than a from-scratch one.
const MUTATIONS = {
  // The defect the grabber cannot report and `cpp-check` cannot compile its way to.
  'decoder-mapping-swapped': {
    file: PIPELINE_CPP,
    edits: [['  case ColorDecoder::TurboJPEG:    return new TurboJpegRgbPacketProcessor();',
      '  case ColorDecoder::TurboJPEG:    return new VTRgbPacketProcessor();']],
    fails: 'ColorDecoder::TurboJPEG building the VideoToolbox processor. Reddens the TurboJPEG '
      + 'row of section 1 and nothing else, and needs a build carrying both to say anything',
  },

  // The grabber keeps the flag spellings and libfreenect2 keeps the precedence, so a wrong
  // spelling makes the grabber report a default the library did not choose. `build-native`
  // reads the offered set against the default and passes this, because both names are real.
  // The step between the flag and the library. The grabber refuses this itself, before it
  // enumerates, which is why a sensorless machine can see it at all.
  'grabber-resolves-wrong-enumerator': {
    file: 'native/grabber.cpp',
    edits: [['    colorDecoder = libfreenect2::ColorDecoder::TurboJPEG;\n#else\n    std::fprintf(stderr, "[grabber] this libfreenect2 was built without TurboJPEG support\\n");',
      '    colorDecoder = libfreenect2::ColorDecoder::VideoToolbox;\n#else\n    std::fprintf(stderr, "[grabber] this libfreenect2 was built without TurboJPEG support\\n");']],
    fails: 'the grabber\'s `turbojpeg` arm resolving to VideoToolbox. Reddens section 2\'s '
      + 'resolution row on a build carrying both, and needs both to say anything',
  },

  'grabber-spelling-wrong': {
    file: 'native/grabber.cpp',
    edits: [['  case libfreenect2::ColorDecoder::VideoToolbox: return "videotoolbox";',
      '  case libfreenect2::ColorDecoder::VideoToolbox: return "turbojpeg";']],
    fails: 'the grabber spelling one enumerator as another decoder\'s flag. Reddens 2 rows on a '
      + 'build defaulting to VideoToolbox - the default row, and that name\'s --check row, because '
      + 'the grabber now spells its own enumerator back and disagrees with itself',
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
const cannotRun = (why) => { console.error(`[decoder-check] ${why}`); process.exit(2); };

// One table, and it is the dispatch: the probe, the expectations and the grabber's offered set
// are all read off it, so a decoder added to libfreenect2 is asked by this tool as it stands.
// `name` is what the processor class answers; `flag` is what `--color-decoder` accepts.
// `holdsDevice` is why a row is asserted or only reported: VAAPI opens a render node and
// TegraJPEG dlopens NVIDIA's library, both in the processor's constructor, so what they answer
// depends on the machine rather than on this repo.
const DECODERS = [
  { enumerator: 'VideoToolbox', macro: 'LIBFREENECT2_WITH_VT_SUPPORT', name: 'VideoToolbox', flag: 'videotoolbox', holdsDevice: false },
  { enumerator: 'TurboJPEG', macro: 'LIBFREENECT2_WITH_TURBOJPEG_SUPPORT', name: 'TurboJPEG', flag: 'turbojpeg', holdsDevice: false },
  { enumerator: 'TegraJPEG', macro: 'LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT', name: 'TegraJPEG', flag: 'tegrajpeg', holdsDevice: true },
  { enumerator: 'VAAPI', macro: 'LIBFREENECT2_WITH_VAAPI_SUPPORT', name: 'VAAPI', flag: 'vaapi', holdsDevice: true },
];

const PREFIX = join(REPO, 'vendor/prefix');
const GRABBER = join(REPO, 'native/build/grabber');
const CONFIG_H = join(PREFIX, 'include/libfreenect2/config.h');

const CXX = process.env.CXX || 'c++';
if (spawnSync(CXX, ['--version'], { encoding: 'utf8' }).status !== 0) {
  cannotRun(`no C++ compiler: ${CXX} --version did not answer. Set CXX= to one that does.`);
}

const TMP = mkdtempSync(join(tmpdir(), 'decoder-check-'));

// `mutateNative` builds the tree as it stands, writes the mutation in the second after that build
// so make cannot read it as up to date, rebuilds, and refuses a rebuild that changed nothing. The
// source and the build go back on every way out of this process, a refusal below included.
if (MUTATE) {
  const { file, edits } = MUTATIONS[MUTATE];
  console.log(`[decoder-check] ${MUTATE} applied to ${file}, rebuilding`);
  const refused = mutateNative('decoder-check', file, edits);
  if (refused) cannotRun(`DID NOT RUN - ${refused}. Nothing was checked.`);
}

if (!existsSync(CONFIG_H)) {
  cannotRun(`no built library under ${PREFIX} - run \`npm run build:native\`, which installs the`
    + ' header and the library together. Nothing was checked.');
}

// Which decoders this build carries, read out of the installed header rather than guessed from
// the platform, because that header is the one the library and the grabber both compiled against.
const config = readFileSync(CONFIG_H, 'utf8');
const carried = DECODERS.filter((d) => new RegExp(`^\\s*#define\\s+${d.macro}\\b`, 'm').test(config));
if (carried.length === 0) {
  cannotRun(`${CONFIG_H} defines none of the four decoder macros, which no library builds from`
    + ' - the prefix is not a libfreenect2 this repo made. Nothing was checked.');
}

console.log(`[decoder-check] ${PREFIX} carries ${carried.map((d) => d.flag).join(' ')}`);

// One probe per run, naming only the decoders this build carries, so it compiles wherever it
// runs. It prints one line per question and the assertions below read the lines.
//
// The pipelines are leaked on purpose. `~AsyncPacketProcessor` sets `shutdown_` and notifies
// without holding `packet_mutex_`, so a notify landing between the worker's `!shutdown_` test and
// its wait is lost and `join()` never returns. A process that builds and drops four pipelines
// back to back sits right on that window; the grabber holds one for hours and effectively never
// does. Nothing here needs a destructor to run, and the timeout below catches it if this is ever
// wrong.
const probe = join(TMP, 'probe.cpp');
writeFileSync(probe, [
  '#include <libfreenect2/packet_pipeline.h>',
  '#include <cstdio>',
  'using namespace libfreenect2;',
  'static void ask(const char *flag, ColorDecoder d) {',
  '  CpuPacketPipeline *p = new CpuPacketPipeline(d);',
  '  std::printf("built %s %s %d\\n", flag, p->colorDecoderName(),',
  '              p->colorDecoderStarted() ? 1 : 0);',
  '}',
  'int main() {',
  ...carried.map((d) => `  ask("${d.flag}", ColorDecoder::${d.enumerator});`),
  '  std::printf("default %s\\n", (new CpuPacketPipeline(defaultColorDecoder()))->colorDecoderName());',
  '  std::printf("noarg %s\\n", (new CpuPacketPipeline())->colorDecoderName());',
  '  return 0;',
  '}',
  '',
].join('\n'));

const bin = join(TMP, 'probe');
// The installed library's install name is `@rpath/libfreenect2.0.2.dylib`, so the rpath is what
// lets the probe run at all. One argument, not `-Wl,-rpath,` beside a bare path: that form leans
// on the linker reading the next argv as the value, which is not a thing either linker promises.
const build = spawnSync(CXX, ['-std=c++11', '-o', bin, probe,
  '-I', join(PREFIX, 'include'),
  '-L', join(PREFIX, 'lib'), '-lfreenect2', `-Wl,-rpath,${join(PREFIX, 'lib')}`],
{ encoding: 'utf8' });
if (build.status !== 0) {
  // A link error here is the finding, not a harness fault: it means the installed library does
  // not carry a symbol the installed header declares.
  console.log('  FAIL the probe does not build against the installed prefix');
  console.log(`${build.stderr}${build.stdout}`.trim().split('\n').slice(0, 14)
    .map((l) => `       ${l}`).join('\n'));
  console.log('\n1 assertions, 1 failed');
  process.exit(1);
}

const run = spawnSync(bin, [], { encoding: 'utf8', timeout: 60_000 });
if (run.error?.code === 'ETIMEDOUT' || run.signal) {
  console.log(`  FAIL the probe built and then did not finish (${run.signal ?? run.error?.code})`);
  console.log('       it read ' + (run.stdout?.trim().split('\n').length ?? 0) + ' of its answers'
    + ' before it stopped; a hang here is the library, not the question');
  console.log('\n1 assertions, 1 failed');
  process.exit(1);
}
if (run.status !== 0) {
  console.log(`  FAIL the probe built and then died (status ${run.status}, signal ${run.signal})`);
  console.log(`${run.stderr}`.trim().split('\n').slice(0, 10).map((l) => `       ${l}`).join('\n'));
  console.log('\n1 assertions, 1 failed');
  process.exit(1);
}
const lines = run.stdout.trim().split('\n');
const said = (kind, key) => lines.find((l) => l.startsWith(key ? `${kind} ${key} ` : `${kind} `));

console.log('\n1. the library: which processor each enumerator builds');
for (const d of carried) {
  const line = said('built', d.flag);
  const [, , got, started] = (line ?? '').split(' ');
  check(got === d.name,
    `ColorDecoder::${d.enumerator} builds the ${d.name} processor`
    + `${got && got !== d.name ? ` - it built ${got}` : ''}${line ? '' : ' - the probe said nothing'}`);
  // A decoder that holds nothing inherits the base class's `true`, so `false` here means
  // colorDecoderStarted() is not reading good() at all - the grabber would then refuse every
  // build. A device decoder answers its own initialise, which is a fact about this machine's
  // render node or driver, so it is reported and not asserted.
  if (d.holdsDevice) {
    console.log(`  --   and it reports started=${started === '1'}, which is this machine's`
      + ` ${d.name} device answering, not a claim about this tree`);
  } else {
    check(started === '1', `and reports it started, which is what the grabber refuses on`);
  }
}

const defaultName = (said('default') ?? '').split(' ')[1];
const noargName = (said('noarg') ?? '').split(' ')[1];
check(defaultName !== undefined && defaultName === noargName,
  'CpuPacketPipeline() and CpuPacketPipeline(defaultColorDecoder()) build the same processor,'
  + ` so the default is one decision${defaultName === noargName ? '' : ` - ${noargName} against ${defaultName}`}`);
check(carried.some((d) => d.name === defaultName),
  `and it is one this build carries: ${defaultName}`);

console.log('\n2. the grabber: the names it offers against the library it loads');
if (!existsSync(GRABBER)) {
  cannotRun(`${GRABBER} does not exist - \`npm run build:native\` builds it beside the library.`
    + ` Section 1 above proved the library; nothing here proved the grabber.`);
}
const help = (() => {
  const r = spawnSync(GRABBER, ['--help'], { encoding: 'utf8' });
  return `${r.stderr}${r.stdout}`;
})();
const offered = /This build offers:\s*\n\s*([a-z ]+)/.exec(help)?.[1]?.trim().split(/\s+/) ?? [];
const wantOffered = carried.map((d) => d.flag);
check(offered.join(' ') === wantOffered.join(' '),
  `--help offers exactly the decoders the library carries: ${wantOffered.join(' ')}`
  + `${offered.join(' ') === wantOffered.join(' ') ? '' : ` - it offers ${offered.join(' ') || 'nothing this could read'}`}`);

const helpDefault = /This build offers:[\s\S]*?and defaults to ([a-z]+)\./.exec(help)?.[1];
const wantDefault = carried.find((d) => d.name === defaultName)?.flag;
check(helpDefault !== undefined && helpDefault === wantDefault,
  `and defaults to the one defaultColorDecoder answers: ${wantDefault}`
  + `${helpDefault === wantDefault ? '' : ` - it says ${helpDefault ?? 'a name this could not read'}`}`);

// Only the names this build does not carry are spawned, plus one that no build has. Those exit
// inside the argument pass. A carried name goes on to enumerateDevices and, with a sensor
// attached, opens it and streams until something kills the pipe, so this asks the carried half
// through `--help` above instead.
const spawnRefusal = (args) => {
  const r = spawnSync(GRABBER, args, { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, out: `${r.stderr}${r.stdout}` };
};
for (const d of DECODERS.filter((x) => !carried.includes(x))) {
  const { status, out } = spawnRefusal(['--color-decoder', d.flag]);
  // Exactly 1: the name was understood and refused. 2 would mean the grabber does not know the
  // spelling at all, and null means it was killed, which is not an answer to anything.
  check(status === 1 && new RegExp(`built without`).test(out),
    `--color-decoder ${d.flag} is understood and refused as missing, because this build does not`
    + ` carry it${status === 1 ? '' : ` - it exited ${status ?? 'on a signal'}`}`);
}
// Every carried name has to survive its own resolution arm. The grabber compares the enumerator
// it picked against the flag it was given, and `--check` runs that comparison and exits before
// it touches a bus, a device or a window, so a machine with a sensor attached is asked the same
// question as one without.
for (const d of carried) {
  const { status, out } = spawnRefusal(['--color-decoder', d.flag, '--check']);
  check(status === 0 && out.includes(`${d.flag} colour decode`),
    `--color-decoder ${d.flag} resolves to the enumerator that spells back to ${d.flag}`
    + `${status === 0 ? '' : ` - ${out.trim().split('\n').pop()}`}`);
}
{
  const { status, out } = spawnRefusal(['--color-decoder', 'nosuchdecoder']);
  check(status === 2, `a name no build has exits 2${status === 2 ? '' : ` - it exited ${status ?? 'on a signal'}`}`);
  check(carried.every((d) => out.includes(d.flag))
    && DECODERS.filter((d) => !carried.includes(d)).every((d) => !out.includes(d.flag)),
    'and the refusal names this build\'s decoders and no others');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${asserted} assertions, ${failed} failed`);
console.log('the library was built and read, and the grabber was asked only through --check and'
  + ' through names it refuses in its argument pass, so no device was opened and no frame decoded');
if (MUTATE) console.log(`it should redden: ${MUTATIONS[MUTATE].fails}`);
process.exit(failed ? 1 : 0);
