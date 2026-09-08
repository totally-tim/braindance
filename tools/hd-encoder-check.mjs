#!/usr/bin/env node
// Link and run the shipped encoder with a gated output sink. No sensor or libfreenect2 build.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_HEADER_BYTES } from '../web/key-stream.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
const MUTATIONS = {
  'pair-borrows-newer-colour': {
    file: 'native/grabber.cpp',
    edits: [['      if (!depthWork.empty()\n',
      '      if (!depthWork.empty()) {\n'
      + '        { std::lock_guard<std::mutex> lock(m_); colourWork = latestColour_; }\n'
      + '        if (encodedColour != colourWork) {\n'
      + '          if (!encodeColour(colourJpeg, colourWork->pixels, colourWork->ts, colourWork->format,\n'
      + '              payload, &colourBuf, &colourSize)) break;\n'
      + '          encodedColour = colourWork;\n'
      + '        }\n'
      + '      }\n'
      + '      if (!depthWork.empty()\n']],
    fails: 'the backlog identity and decoded-pixel rows; it replaces the captured colour while the first JPEG is blocked',
  },
  'key-range-unbounded': {
    file: 'native/grabber.cpp',
    edits: [['keyRangeM_ = std::fmin(rangeM, 65.535f);', 'keyRangeM_ = rangeM;']],
    fails: 'the bounded range and empty out-of-range rows',
  },
  'rgbx-read-as-bgrx': {
    file: 'native/grabber.cpp',
    edits: [['jpeg, pixels.data(), CW, 0, CH, format,', 'jpeg, pixels.data(), CW, 0, CH, TJPF_BGRX,']],
    fails: 'the RGBX red/blue row',
  },
  'held-colour-gets-depth-time': {
    file: 'native/grabber.cpp',
    edits: [['    std::memcpy(p, &colourTs, 8);   p += 8;', '    std::memcpy(p, &ts, 8);         p += 8;']],
    fails: 'the slow-colour identity row',
  },
};
const fail = (reason) => { console.error(`[hd-encoder] DID NOT RUN: ${reason}`); process.exit(2); };
if (MUTATE && !MUTATIONS[MUTATE]) fail(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
let source = readFileSync(join(REPO, 'native/grabber.cpp'), 'utf8');
if (MUTATE) for (const [from, to] of MUTATIONS[MUTATE].edits) {
  if (source.split(from).length !== 2) fail(`mutation anchor does not match once: ${from}`);
  source = source.replace(from, to);
}
const start = source.indexOf('class HdEncoder {');
const end = source.indexOf('// Low light on lets', start);
if (start < 0 || end < 0) fail('encoder extraction anchors moved');
const constants = [...source.matchAll(/^static const (?:uint32_t|int) (?:TYPE_COLOR|TYPE_KEY|KEY_DEPTH_LEVELS|KEY_JPEG_QUALITY|CW|CH) = .*?;/gm)];
if (constants.length !== 6) fail('encoder constants moved');
const cxx = process.env.CXX || 'c++';
let flags = [];
try { flags = execFileSync('pkg-config', ['--cflags', '--libs', 'libturbojpeg'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/); }
catch {
  const prefix = ['/opt/homebrew/opt/jpeg-turbo', '/usr/local/opt/jpeg-turbo'].find((p) => existsSync(join(p, 'include/turbojpeg.h')));
  flags = prefix ? [`-I${prefix}/include`, `-L${prefix}/lib`, '-lturbojpeg'] : ['-lturbojpeg'];
}
const scratch = mkdtempSync(join(tmpdir(), 'hd-encoder-'));
try {
  writeFileSync(join(scratch, 'encoder-under-test.h'), constants.map((m) => m[0]).join('\n')
    + `\nstatic const int KEY_HEADER_BYTES = ${KEY_HEADER_BYTES};\n` + source.slice(start, end));
  const binary = join(scratch, 'check');
  const build = spawnSync(cxx, ['-std=c++11', '-O1', '-pthread', `-I${scratch}`,
    join(REPO, 'test/fixtures/hd-encoder.cpp'), ...flags, '-o', binary], { encoding: 'utf8' });
  if (build.status !== 0) fail(`C++ compiler and TurboJPEG are required: ${build.error?.message ?? build.stderr}`);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  const summary = /\[hd-encoder\] (\d+) assertions, (\d+) failed/.exec(run.stdout ?? '');
  if (!summary || run.error || run.signal || run.status === 2) fail(run.error?.message ?? `encoder run did not finish (${run.status}, ${run.signal})`);
  const failures = Number(summary[2]);
  if (MUTATE) {
    console.log(`[hd-encoder] should fail: ${MUTATIONS[MUTATE].fails}`);
    console.log(failures ? `[hd-encoder] caught (${failures} failed assertions)` : '[hd-encoder] NOT CAUGHT');
    process.exitCode = 1;
  } else process.exitCode = failures ? 1 : 0;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
