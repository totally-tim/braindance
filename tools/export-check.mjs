// Proves the export: that the look is resolution-relative, that an exported frame
// is the frame the editor showed, that no wall clock reaches the render, and that
// the file ffmpeg produced is the one that was asked for.

import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
const URL_BASE = flag('--url', 'http://localhost:8080');

const BLACKWALL_LOOK = JSON.parse(
  readFileSync(new URL('../presets-builtin/blackwall.json', import.meta.url), 'utf8'),
).values;
// The editor. Named once because the page is opened at it and the cross-build arm's
// markup is intercepted by it, and those two have to agree or the interception misses.
const EDITOR_PATH = '/edit';
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
// Not HEAD: the moment this step is committed HEAD contains the reference scaling and the
// control arm would be the same build twice. A marker survives a history rewrite.
const BEFORE = flag('--before') ?? revBeforeMarker('bufferHeight / 1080.0');

function revBeforeMarker(marker) {
  const introduced = execFileSync(
    'git', ['-C', REPO, 'log', '-S', marker, '--format=%H', '--reverse', '--', 'web/main.js'],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  ).split('\n')[0].trim();
  if (!introduced) {
    throw new Error(`no commit in this history introduces ${JSON.stringify(marker)} to web/main.js`);
  }
  return `${introduced}^`;
}
// Bare names, resolved through PATH, because an absolute Homebrew default is a macOS path
// on a project that also ships to Linux and the Pi, and `jobs-check` spawns a bare ffprobe.
const FFMPEG = flag('--ffmpeg', 'ffmpeg');
const FFPROBE = flag('--ffprobe', 'ffprobe');
const SHOTS = flag('--shots');

// The editor's stage for every claim that is not about resolution, and the export's output
// size too, so no resize sits between the arm that exports and the arm that seeks. 16:9,
// which is a shape `EXPORT_SIZES` offers a resolution for.
const STAGE = { width: 640, height: 360 };
// A starting guess at the timeline strip's height, and only a guess - `setStage` measures
// the real one off the page and corrects the viewport.
const TIMELINE_H_GUESS = 148;

const SMALL = { width: 960, height: 600 };
const BIG = { width: 1920, height: 1200 };
const REF = { width: 1728, height: 1080 };

// The one arm that is not 1.6, and the aspect is the whole reason it is here: at 1.6 a
// reference taken from the width over 1728 and one taken from the height over 1080 are the
// same number, so every other arm is blind by construction to the wrong one.
const HD = { width: 1920, height: 1080 };
const NON_169 = { width: 1440, height: 1080 };
const HD_POINT_SIZE = 8;

const AT_SEC = 4;
// What `pointSize` was multiplied by when it became pixels at 1080p: the reference
// height over the 600-tall buffer the two presets were graded against.
const GRADED_HEIGHT = 600;
const POINT_SIZE_REBASE = 1080 / GRADED_HEIGHT;

const REBASE_LOOK = { far: 2.8, near: 0.05 };

const REBASE_FULL_LOOK = { ...REBASE_LOOK, bloom: 0 };
const EXPORT_FRAMES = 8;
const EXPORT_FPS = 30;

const RES_LOOK = { far: 4.0, near: 0.05, pointSize: 12 };

// Measured rather than chosen, and stated per pass because the passes differ. Every number is
// a mean absolute channel difference out of 255 on the coarse grid, or a ratio of mean
// luminance between the two sizes.
const CONTROL_MARGIN = 5;

const MUTATIONS = {
  // The guard removed at its source rather than door by door: one predicate answers for all
  // eighteen call sites, so this is the whole of it and no door can be left accidentally armed.
  // Must redden **ten** rows of section 9, measured: the six door rows, the render-finished row,
  // the document row, the backstop counter and the record row. Two of those are worth reading
  // rather than counting. The render does not merely draw the wrong look - an unguarded undo
  // re-enters the transport and the render dies with "reached the export 3 times, not once", so
  // the shipped defect is louder than a changed picture. And the counter reads 2 rather than 6,
  // because only the doors that commit reach the backstop: the four that do not are exactly why
  // the guard is at the doors and not at `history.commit`.
  //
  // The value row stays green, and that is the row being honest rather than weak: the last door
  // reloads the document the render started from, so the closing look is the opening one. It is
  // why the document is read after every press instead of only at the end.
  'edits-during-an-export-are-not-refused': {
    file: 'web/main.js',
    edits: [["function editsBlocked() {\n  if (exporting) return 'an export is running';\n  return null;\n}",
      'function editsBlocked() {\n  return null;\n}']],
    fails: 'section 9: every door lets a write through while a render is reading the document',
  },
  // The painter stops reaching the two bars while still keeping the reading, which is the half a
  // check reading `k.export.progress()` alone cannot see - `onProgress` fires either way, so a
  // row over the number proves the plumbing that was already there. Must redden exactly **one**
  // row, measured: the one reading the bar's width and its aria value. The chip's own row stays
  // green, because the count and the hiding are written below this loop rather than inside it,
  // and that split is deliberate - two rows over two writers, so a painter that reaches one and
  // not the other is named rather than averaged.
  'the-progress-bar-is-never-painted': {
    file: 'web/main.js',
    edits: [['  for (const bar of [ui.exportBar, ui.exportingBar]) {\n    if (!bar) continue;\n',
      '  for (const bar of []) {\n    if (!bar) continue;\n']],
    fails: 'section 9: the bar and the chip stop following the render they report',
  },
  // The container kept and the stream swapped, so only what is inside the .mov moves.
  'prores-writes-h264': { file: 'server/export.js', edits: [[
    "    args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],",
    "    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'],",
  ]] },
  // The sequence stops being a directory: `frameExt` null writes one animated file at its path.
  'pngseq-writes-one-file': { file: 'server/export.js', edits: [[
    "    ext: 'pngseq',\n    frameExt: 'png',",
    "    ext: 'pngseq',\n    frameExt: null,",
  ]] },
  // The dominant screen-space term goes back to framebuffer pixels.
  'pointsize-absolute': { file: 'effects-builtin/glyph/size.vert.glsl', edits: [[
    'gl_PointSize = clamp(pointSize * zoom * k / max(0.15, -mv.z), 1.0, 64.0);',
    'gl_PointSize = clamp(pointSize * zoom * (1.0 / max(0.15, -mv.z)), 1.0, 64.0);',
  ]] },
  // The sprite stops following the lens, so a longer lens thins a surface into dots.
  'lens-absolute': { file: 'effects-builtin/glyph/size.vert.glsl', edits: [[
    'gl_PointSize = clamp(pointSize * zoom * k / max(0.15, -mv.z), 1.0, 64.0);',
    'gl_PointSize = clamp(pointSize * k / max(0.15, -mv.z), 1.0, 64.0);',
  ]] },
  // The glyph branch's own base stops following the lens, so a half-mixed field thins under a
  // longer one while the fully mixed cell term still follows it.
  'glyph-base-lens-absolute': { file: 'effects-builtin/glyph/size.vert.glsl', edits: [[
    'float base = clamp(pointSize * zoom * k / dist, 1.0, 64.0);',
    'float base = clamp(pointSize * k / dist, 1.0, 64.0);',
  ]] },
  // The additive normalisation reads the size through the lens, so a big splat sums dimmer
  // through a longer one.
  'vsize-lensed': { file: 'web/cloud-shader.js', edits: [[
    'vSize = gl_PointSize / (k * zoom);',
    'vSize = gl_PointSize / k;',
  ]] },
  // Reading additive size in output pixels makes brightness change with output size.
  'vsize-framebuffer': { file: 'web/cloud-shader.js', edits: [[
    'vSize = gl_PointSize / (k * zoom);',
    'vSize = gl_PointSize / zoom;',
  ]] },
  // Grain and scanlines go back to being sized in framebuffer pixels.
  'grade-absolute': { file: 'web/grade-shader.js', edits: [[
    `      float k = resolution.y / 1080.0;
      vec2 ref = resolution / k;
      vec2 texel = 1.0 / ref;
      vec3 col;`,
    `      float k = 1.0;
      vec2 ref = resolution;
      vec2 texel = 1.0 / ref;
      vec3 col;`,
  ]] },
  // The smear's reach and its column width go back to framebuffer pixels, so a needle covers
  // half as much of the frame every time the buffer doubles.
  'mosh-buffer-sized': { file: 'web/mosh-shader.js', edits: [[
    `      float k = resolution.y / 1080.0;
      vec2 ref = resolution / k;
      vec2 texel = 1.0 / ref;
      vec3 fresh = texture2D(tNew, vUv).rgb;`,
    `      float k = 1.0;
      vec2 ref = resolution;
      vec2 texel = 1.0 / ref;
      vec3 fresh = texture2D(tNew, vUv).rgb;`,
  ]] },
  // The bloom chain sized against the drawing buffer again, where its halo halves in width every
  // time the buffer doubles.
  'bloom-buffer-sized': { file: 'web/bloom-pass.js', edits: [[
    `  const refWidth = (bufferWidth / bufferHeight) * 600;
  return { width: Math.max(1, refWidth / 2), height: 300 };`,
    '  return { width: Math.max(1, bufferWidth / 2), height: Math.max(1, bufferHeight / 2) };',
  ]],
    fails: 'the glow\'s chain following the buffer, which is the only live catcher in this suite '
      + 'for the reference the chain is frozen at. Its sibling `bloom-reference-1080` is NOT '
      + 'caught by anything here and is not a regression - `test/bloom-chain.test.mjs` is '
      + 'what holds that half',
  },
  // The chain frozen against 1080 rather than the height the look was graded at, so every output
  // size gets the same halo.
  'bloom-reference-1080': { file: 'web/bloom-pass.js', edits: [[
    `  const refWidth = (bufferWidth / bufferHeight) * 600;
  return { width: Math.max(1, refWidth / 2), height: 300 };`,
    `  const refWidth = (bufferWidth / bufferHeight) * 1080;
  return { width: Math.max(1, refWidth / 2), height: 540 };`,
  ]] },
  // The door stops refusing, so a clip renders without the effect it asked for.
  'export-ignores-missing-effects': { file: 'web/main.js', edits: [[
    '  const blocking = missing.filter((m) => !suppress.has(m.id));',
    '  const blocking = [];',
  ]],
    fails: 'the door on a clip whose look this build cannot draw whole. Reddens 4: the refusal '
      + 'row, the still-refused-for-the-other row, and the two in the leak block that stand '
      + 'on a refusal happening at all - the second document\'s export and the console line '
      + 'it drains. The suppress, record and complete rows stay green',
  },
  // The door answers a per-effect question globally, letting the second missing effect through on a
  // decision about the first.
  'suppress-is-global': { file: 'web/main.js', edits: [[
    '  const blocking = missing.filter((m) => !suppress.has(m.id));',
    '  const blocking = suppress.size ? [] : missing;',
  ]],
    fails: 'and the same door answering a per-effect question globally, which only the '
      + 'two-missing-effects row can see - with one missing, both implementations refuse '
      + 'nothing',
  },
  // The record loses the note that a layer was skipped.
  'deliverable-forgets-suppressed': { file: 'web/main.js', edits: [[
    '      project: serialiseProjectBody(suppressed.length ? { suppressed } : {}),',
    '      project: serialiseProjectBody(),',
  ]],
    fails: 'and the record\'s half: a file that went without a layer of the look and does not '
      + 'say so. One row',
  },
  // The click handler stops handing the door what the badge holds, so an operator can suppress an
  // effect and still be refused.
  'export-button-drops-the-suppression': { file: 'web/main.js', edits: [[
    '      suppressEffects: [...suppressedEffects],',
    '      suppressEffects: [],',
  ]] },
  // The suppression outlives the document it was made about: the clear goes, the prune stays.
  'suppression-outlives-its-document': { file: 'web/main.js', edits: [[
    '  if (suppressedEffects.size) {\n    suppressedEffects.clear();\n    paintMissingEffects();\n  }',
    '  // the clear this mutation removes',
  ]],
    fails: 'a suppression made about one clip carried into the next document opened, which is '
      + 'how it shipped: the loader prunes the set and two documents missing one effect are '
      + 'indistinguishable to a prune. Reddens the leak row and the refusal beside it, and '
      + 'leaves the keep row green, because the prune it does not touch is what makes a '
      + 'suppression survive an undo',
  },
  // Only the split reverts, so the claim cannot be carried by the other two.
  'rgbsplit-absolute': { file: 'effects-builtin/rgbsplit/split.grade.glsl', edits: [[
    'vec2 off = dir * rgbSplit * texel * 8.0;',
    'vec2 off = dir * rgbSplit * (1.0 / resolution) * 8.0;',
  ]] },
  // The region's falloff width stops being metres and becomes pixels-at-1080p.
  'region-in-metres': { file: 'web/cloud-shader.js', edits: [[
    '  return 1.0 - smoothstep(0.0, max(1e-4, regionSoft), sd);',
    '  return 1.0 - smoothstep(0.0, max(1e-4, regionSoft * bufferHeight / 1080.0), sd);',
  ]] },
  // The lateral crop planes stop being metres in the room and become a fraction of the frame.
  // Dividing the point by the scale is the same test as multiplying every face by it, and the
  // faces are not reachable from here: they are uniforms the shared box reads.
  'crop-in-pixels': { file: 'web/cloud-shader.js', edits: [[
    '  if (outsideLateral(pos.xy)) {',
    '  if (outsideLateral(pos.xy / (bufferHeight / 1080.0))) {',
  ]] },
  // The faint pass answers to the button alone, so a crop box left on puts the cut points into
  // the exported file.
  'cropoutside-reaches-the-export': { file: 'web/main.js', edits: [[
    '  uniforms.cropOutside.value = chromeOn && cropBoxLive() ? CROP_FAINT : 0;',
    '  uniforms.cropOutside.value = cropBoxLive() ? CROP_FAINT : 0;',
  ]] },
  // Both early returns go, so a point outside the box survives to the fragment stage and goes
  // on writing depth.
  'faint-survives-at-zero': { file: 'web/cloud-shader.js', edits: [
    [
      '  if (outsideCrop && cropOutside <= 0.0) {\n'
      + '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);\n'
      + '    gl_PointSize = 0.0;\n'
      + '    return;\n'
      + '  }',
      '  if (false) {\n'
      + '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);\n'
      + '    gl_PointSize = 0.0;\n'
      + '    return;\n'
      + '  }',
    ],
    [
      '    if (cropOutside <= 0.0) {\n'
      + '      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);\n'
      + '      gl_PointSize = 0.0;\n'
      + '      return;\n'
      + '    }',
      '    if (false) {\n'
      + '      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);\n'
      + '      gl_PointSize = 0.0;\n'
      + '      return;\n'
      + '    }',
    ],
  ] },
  'grain-continuous': { file: 'effects-builtin/grain/grain.grade.glsl', edits: [[
    'float n = hash(floor(vUv * ref) + fract(time) * 137.0);',
    'float n = hash(vUv * ref + fract(time) * 137.0);',
  ]] },
  // The take renders on the boot intrinsics again. The fetch stays, so only the write is gone.
  'intrinsics-defaults': { file: 'web/main.js', edits: [[
    `  uniforms.focal.value.set(opened.hello.fx, opened.hello.fy);
  uniforms.center.value.set(opened.hello.cx, opened.hello.cy);`,
    '  /* mutation: the hello is fetched and thrown away */',
  ]] },
  // A wall clock reaches the export's playhead. Sub-frame, because the point is
  // that a clock anywhere in the seam is enough - not that a large error is.
  'export-wall-clock': { file: 'web/main.js', edits: [[
    'const at = n / this.fps;',
    'const at = n / this.fps + (performance.now() % 1) * 1e-6;',
  ]] },
  // The export renders through a look of its own: a second render path that nearly agrees.
  'export-second-look': { file: 'web/main.js', edits: [[
    '    const gl = renderer.getContext();\n    if (gl.drawingBufferWidth !== width',
    '    grade.enabled = false;\n    const gl = renderer.getContext();\n    if (gl.drawingBufferWidth !== width',
  ]] },
  // One frame of the export is the frame before it. The count is still right, the
  // file still plays, and one program time now holds an image from another.
  'export-repeats-frame': { file: 'web/main.js', edits: [[
    '      await sink.send(this.pixels);',
    `      if (n !== this.from + 3) await sink.send(this.pixels);
      else await sink.send(this.held ?? this.pixels);
      this.held = this.pixels.slice();`,
  ]] },
  // The browser tells the encoder a rate it is not stepping at, so the file plays
  // at the wrong speed with every frame present and correct.
  'export-wrong-rate': { file: 'web/main.js', edits: [[
    '      fps,\n      frames: to - from + 1,',
    '      fps: fps * 2,\n      frames: to - from + 1,',
  ]] },
  // The frames leave the browser upside down, which every metadata probe in the
  // world reports as a perfectly correct video.
  'export-flipped': { file: 'web/main.js', edits: [[
    '    await sink.send(this.pixels);',
    `    {
        const w = this.width; const h = this.height; const row = w * 4;
        const flipped = new Uint8Array(this.pixels.length);
        for (let y = 0; y < h; y++) flipped.set(this.pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        await sink.send(flipped);
      }`,
  ]] },
  // The output size stops reaching the renderer, so an export at an unfamiliar
  // size silently delivers the preview's buffer instead.
  'export-ignores-size': { file: 'web/main.js', edits: [[
    `    outputSize = { w: width, h: height };
    resize();`,
    '    /* mutation: the output size is not applied */',
  ]] },
  // The reference is the drawing buffer's width over 1728 rather than its height over 1080, and
  // every term follows it.
  'scale-by-width': { file: 'web/main.js', edits: [
    [
      '  forEachLook(() => { uniforms.bufferHeight.value = buf.y; });',
      '  forEachLook(() => { uniforms.bufferHeight.value = buf.x * (1080 / 1728); });',
    ],
    [
      `      float k = resolution.y / 1080.0;
      vec2 ref = resolution / k;
      vec2 texel = 1.0 / ref;
      vec3 col;`,
      `      float k = resolution.x / 1728.0;
      vec2 ref = resolution / k;
      vec2 texel = 1.0 / ref;
      vec3 col;`,
      'web/grade-shader.js',
    ],
  ] },
  // The failure path reaches back to the output it did not write, which is the shape that shipped.
  'export-fail-unlinks-output': { file: 'server/export.js', edits: [
    // Make every export to the same name target the same directory, so a failed run can reach the
    // previous artifact at all.
    [
      `    const dirName = \`\${msg.name}.\${process.pid}-\${++sequence}\`;\n    const outputDir = join(outDir, dirName);\n    const output = join(outputDir, \`\${msg.name}.\${ext}\`);\n    const frameBytes = width * height * 4;\n    const temp = join(outDir, \`\${dirName}.part\`);`,
      `    const outputDir = join(outDir, msg.name);\n    const output = join(outputDir, \`\${msg.name}.\${ext}\`);\n    const frameBytes = width * height * 4;\n    const temp = join(outDir, \`\${msg.name}.part\`);`,
    ],
    // The regression: a failed run removes the final directory rather than its own scratch.
    [
      '    if (job) await rm(job.temp, { recursive: true, force: true }).catch(() => {});',
      '    if (job) await rm(job.outputDir, { recursive: true, force: true }).catch(() => {});',
    ],
  ] },
};

/**
 * The mutated source of every file the named mutation edits. Refused when an anchor is not
 * found exactly once: a replacement that matched nothing would run the unmutated build and be
 * recorded as the check having missed a bug it was never shown.
 */
function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) {
    throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  }
  const staged = new Map();
  for (const [from, to, where] of spec.edits) {
    const file = where ?? spec.file;
    if (!staged.has(file)) staged.set(file, readFileSync(join(REPO, file), 'utf8'));
    const source = staged.get(file);
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${file}, expected exactly 1: ${from}`);
    }
    staged.set(file, source.replace(from, to));
  }
  return [...staged].map(([file, body]) => ({ file, body }));
}

/**
 * Where a file under `web/` is reached from a browser. Matched on the whole pathname rather
 * than on the basename, because two modules could end in the same name.
 */
function servedAt(file) {
  if (file.startsWith('effects-builtin/')) {
    const parts = file.split('/');
    if (parts.length !== 3) {
      throw new Error(`${file} is not an effect package file - a chunk is <id>/<name> under effects-builtin/`);
    }
    return `/effects/${parts[1]}/file/${parts[2]}`;
  }
  if (!file.startsWith('web/')) {
    throw new Error(`${file} is not served to a browser, so a page mutation cannot reach it`);
  }
  return `/${file.slice('web/'.length)}`;
}

/**
 * What the server answers a file with, restated here because the interception has to answer
 * the same way: a chunk is `text/plain` in `server/index.js`.
 */
function contentTypeFor(file) {
  return file.endsWith('.glsl') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8';
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }

  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

let failures = 0;
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (label, detail = '') => console.log(`  ....  ${label}${detail ? `   ${detail}` : ''}`);
const fixed = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

const hello = await (await fetch(`${URL_BASE}/capture/${TAKE}/hello`)).json();
const index = await (await fetch(`${URL_BASE}/capture/${TAKE}/index`)).json();
const stamps = index.frames.stampMs;
const DURATION = (stamps[stamps.length - 1] - stamps[0]) / 1000;

const BOOT_DEFAULTS = { fx: 366, fy: 366, cx: 256, cy: 212 };

// Pixels never cross the wire - a 1920x1200 frame is nine megabytes and there are a dozen per
// run - so every reduction happens in the page and only the summary comes back.
const INSTALL = `(() => {
  const k = globalThis.__kinect;
  globalThis.__ex = {
    shots: new Map(),

    async sha(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    },

    // Both builds get the same intrinsics from the tool. The hello fetch landed in
    // the same commit as the resolution work, so leaving the two arms to their own
    // defaults would put a 45mm translation inside a measurement about point size.
    pinIntrinsics(fx, fy, cx, cy) {
      k.uniforms.focal.value.set(fx, fy);
      k.uniforms.center.value.set(cx, cy);
    },

    // The program camera, posed by value rather than orbited into place. The free
    // camera is mutated by accumulation through OrbitControls, so an arm that used
    // it would differ from its own repeat for reasons nothing here is about.
    pinCamera(pose) {
      k.setViewCamera(k.programCamera);
      k.params.set('camera', pose ?? { position: [0, 0.1, 1.6], quaternion: [0, 0, 0, 1], fov: 50 });
    },

    // What gl_PointSize the frame that is bound actually asked for, at both ends.
    // The depth frame is already on the CPU - bindDepth copies it into the texture's
    // own array - so this is the shader's arithmetic run again over the same points
    // with the same intrinsics and the same camera, rather than a bound argued from
    // the clip planes.
    //
    // Run again is the honest description and the limit of what this can claim. It
    // is a model of the vertex shader written in JS rather than a read of what the
    // shader drew, so it agrees with a page whose shader no longer does this: under
    // the pointsize-absolute mutation it prints the reference-scaled sizes while the
    // page draws 12px points. That is tolerable because it is a precondition rather
    // than a claim - it decides whether the clamps are out of the way, and the
    // clamps are a property of the scene and the camera rather than of the term
    // being mutated - but it is an assertion about a model of the code, and reading
    // the sizes back out of a transform-feedback pass is what would turn it into an
    // assertion about the frame. The output scale and reference lens are read off the page.
    drawnPointSizes(kScale) {
      const depth = k.uniforms.depthCurr.value.image.data;
      const fx = k.uniforms.focal.value.x;
      const fy = k.uniforms.focal.value.y;
      const cx = k.uniforms.center.value.x;
      const cy = k.uniforms.center.value.y;
      const near = k.uniforms.nearClip.value;
      const far = k.uniforms.farClip.value;
      const pointSize = k.uniforms.pointSize.value;
      const W = k.uniforms.resolution.value.x;
      const H = k.uniforms.resolution.value.y;
      k.programCamera.updateMatrixWorld(true);
      const m = k.programCamera.matrixWorldInverse.elements;
      let nearest = Infinity;
      let farthest = 0;
      let drawn = 0;
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const mm = depth[py * W + px];
          if (mm === 0) continue;
          const z = mm * 0.001;
          if (z < near || z > far) continue;
          // x negated: the mirror correction unproject in web/cloud-shader.js carries the
          // reasoning for. It reaches viewZ through m[2], so it only vanishes from this
          // row while the program camera happens to face straight down the axis.
          const X = (-(px + 0.5 - cx) / fx) * z;
          const Y = -((py + 0.5 - cy) / fy) * z;
          const Z = -z;
          // Column-major, the same product the vertex shader takes: -mv.z.
          const viewZ = -(m[2] * X + m[6] * Y + m[10] * Z + m[14]);
          if (viewZ <= 0) continue;
          drawn++;
          if (viewZ < nearest) nearest = viewZ;
          if (viewZ > farthest) farthest = viewZ;
        }
      }
      // The lens as the shader reads it; a build with no reference lens draws every lens alike.
      const zoom = k.uniforms.lensReference
        ? k.programCamera.projectionMatrix.elements[5] / k.uniforms.lensReference.value : 1;
      const at = (d) => (pointSize * kScale * zoom) / Math.max(0.15, d);
      return { drawn, nearest, farthest, largest: at(nearest), smallest: at(farthest) };
    },

    grab(label) {
      const gl = k.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      // A frame at any other size than the one staged is a measurement, not a finding.
      if (this.staged && (w !== this.staged[0] || h !== this.staged[1])) {
        throw new Error('the stage moved to ' + w + 'x' + h + ' after settling at ' + this.staged.join('x')
          + ', so ' + label + ' would be read at the wrong size');
      }
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      this.shots.set(label, { px, w, h });
      return { w, h };
    },

    // Box-downsample by an integer factor. This is what lets two different output
    // sizes be compared at all, and the box filter rather than a sample is the
    // whole point: it is the average of what the larger render put on the screen,
    // which is what the smaller one is trying to be.
    down(label, out, factor) {
      const { px, w, h } = this.shots.get(label);
      const W = Math.floor(w / factor);
      const H = Math.floor(h / factor);
      const dst = new Uint8Array(W * H * 4);
      const n = factor * factor;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let dy = 0; dy < factor; dy++) {
              for (let dx = 0; dx < factor; dx++) {
                sum += px[(((y * factor + dy) * w) + x * factor + dx) * 4 + c];
              }
            }
            dst[(y * W + x) * 4 + c] = Math.round(sum / n);
          }
        }
      }
      this.shots.set(out, { px: dst, w: W, h: H });
      return { w: W, h: H };
    },

    // The centre 1/factor of a frame, at full resolution: what a lens factor times longer
    // shows of the same pose, before its own magnification.
    crop(label, out, factor) {
      const { px, w, h } = this.shots.get(label);
      const W = Math.floor(w / factor);
      const H = Math.floor(h / factor);
      const x0 = Math.floor((w - W) / 2);
      const y0 = Math.floor((h - H) / 2);
      const dst = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        dst.set(px.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + W) * 4), y * W * 4);
      }
      this.shots.set(out, { px: dst, w: W, h: H });
      return { w: W, h: H };
    },

    // Mean luminance and how much of the frame is lit at all. These are the two the
    // document's failure is described in - the cloud goes sparse and dark - and
    // they survive the resampling that a per-pixel comparison cannot.
    lum(label) {
      const { px } = this.shots.get(label);
      let sum = 0;
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        sum += l;
        if (l > 8) lit++;
      }
      const n = px.length / 4;
      return { mean: sum / n, litPct: (lit / n) * 100 };
    },

    // High-frequency energy: how much neighbouring pixels differ. This is the only
    // measurement here that answers "is the grain the same size and the same
    // strength", and a per-pixel difference cannot - noise that has moved is as
    // different from noise that has thinned as it is from noise that has not
    // changed at all. Compared as a ratio between the two output sizes, it is a
    // direct read of whether a one-reference-pixel structure stayed one reference
    // pixel.
    texture(label) {
      const { px, w, h } = this.shots.get(label);
      const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      let sum = 0;
      let n = 0;
      for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          const l = lum(i);
          sum += Math.abs(l - lum(i + 4)) + Math.abs(l - lum(i + w * 4));
          n += 2;
        }
      }
      return sum / n;
    },

    // Mean luminance over a grid of tiles. Two builds cannot be compared pixel by
    // pixel - they are two pages, and the pixels never leave either of them - but
    // forty tile means travel cheaply and catch a difference that has moved rather
    // than merely changed the average.
    tiles(label, cols, rows) {
      const { px, w, h } = this.shots.get(label);
      const out = [];
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const x0 = Math.floor((tx * w) / cols);
          const x1 = Math.floor(((tx + 1) * w) / cols);
          const y0 = Math.floor((ty * h) / rows);
          const y1 = Math.floor(((ty + 1) * h) / rows);
          let sum = 0;
          let n = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * w + x) * 4;
              sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
              n++;
            }
          }
          out.push(sum / n);
        }
      }
      return out;
    },

    // Whether the fine structure of two images is in the same places, which is the
    // one question a difference cannot answer about noise. Both are high-passed -
    // luminance less the mean of its own 3x3 neighbourhood - and correlated. Grain
    // quantised onto a shared reference grid puts the same value at the same frame
    // fraction at any output size, so the two correlate; grain sampled continuously
    // gives a 2x render four unrelated values per reference cell, which average to
    // something that correlates with nothing.
    hpCorr(a, b) {
      const x = this.shots.get(a);
      const y = this.shots.get(b);
      const { w, h } = x;
      const hp = (s) => {
        const out = new Float32Array(w * h);
        const lum = (i) => 0.299 * s.px[i] + 0.587 * s.px[i + 1] + 0.114 * s.px[i + 2];
        for (let py = 1; py < h - 1; py++) {
          for (let px = 1; px < w - 1; px++) {
            let mean = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) mean += lum(((py + dy) * w + px + dx) * 4);
            }
            out[py * w + px] = lum((py * w + px) * 4) - mean / 9;
          }
        }
        return out;
      };
      const u = hp(x);
      const v = hp(y);
      let su = 0;
      let sv = 0;
      let n = 0;
      for (let i = 0; i < u.length; i++) { su += u[i]; sv += v[i]; n++; }
      const mu = su / n;
      const mv = sv / n;
      let cov = 0;
      let vu = 0;
      let vv = 0;
      for (let i = 0; i < u.length; i++) {
        const du = u[i] - mu;
        const dv = v[i] - mv;
        cov += du * dv;
        vu += du * du;
        vv += dv * dv;
      }
      return cov / Math.sqrt(vu * vv);
    },

    diff(a, b) {
      const x = this.shots.get(a);
      const y = this.shots.get(b);
      if (!x || !y) throw new Error('missing shot ' + (x ? b : a));
      if (x.w !== y.w || x.h !== y.h) {
        throw new Error('comparing ' + x.w + 'x' + x.h + ' against ' + y.w + 'x' + y.h);
      }
      let max = 0;
      let sum = 0;
      let differing = 0;
      for (let i = 0; i < x.px.length; i += 4) {
        const d = Math.max(
          Math.abs(x.px[i] - y.px[i]), Math.abs(x.px[i + 1] - y.px[i + 1]),
          Math.abs(x.px[i + 2] - y.px[i + 2]),
        );
        if (d > 0) {
          differing++;
          sum += d;
          if (d > max) max = d;
        }
      }
      const n = x.px.length / 4;
      return { max, mean: sum / n, pct: (differing / n) * 100 };
    },
  };
  return true;
})()`;

/**
 * One resolution arm: pin everything, render at wherever the buffer currently is, and measure
 * the point sizes the frame asked for. Those sizes are the precondition rather than a
 * curiosity: the comparison is only about the reference scaling where neither clamp binds.
 */
const RES_ARM = `async ({ label, look, at, resLook, camera }) => {
  const k = globalThis.__kinect;
  const ex = globalThis.__ex;
  // Blackwall, and the graded look it comes with rather than the reading alone. This
  // was k.setMode(4), which did both at once: it selected the shading *and* applied
  // twelve hardcoded values, and the note further down about arms inheriting "whatever
  // the previous one left" is about exactly that write. The readings are registry
  // parameters now and the look is a document, so the two halves are spelled out - and
  // reaching for the reading alone would have left bloom, trails, rgbSplit, scanlines
  // and grain at zero, which is every term the grade rows below are trying to measure.
  //
  // **Each build gets its own Blackwall, and that is the whole point of the branch.**
  // The obvious version of this merges today's look into every arm and lets the
  // unknown-name filter drop the readings on the older module. It is wrong, and wrong
  // in the units this file exists to be careful about: pointSize is pixels at 1080p
  // here and was pixels at the drawing buffer at the revision the cross-build arm
  // plays, so 8.1 written into that build is not the same size, it is 1.8 times too
  // big. Measured - the old arm drew 1.82..3.8px where it should draw 1.02..2.1px, and
  // the two rebase rows came back at luminance ratio 0.342 against an expected 1.0,
  // which reads as the entire look having failed to rebase. The build that still has
  // setMode has its own graded values and must be left to apply them.
  if (k.setMode) k.setMode(4);
  else k.params.apply(${JSON.stringify(BLACKWALL_LOOK)});
  // Only what the build in front of us declares. The cross-build arm plays an older
  // module, and today's OFF names parameters that build has never heard of - applying
  // them throws "unknown parameter noise" from inside the registry's own door, which is
  // the door doing its job. Dropped names are *returned* rather than swallowed: on the
  // current build the list must be empty, so a typo in a look still surfaces here
  // instead of being quietly skipped on every arm.
  const known = new Set(k.params.names());
  // Every arm starts with the region switched off unless its own look says otherwise.
  // Spelled out here rather than left to the rows because two of them - nobloom and
  // full - deliberately carry no OFF spread, since they are Blackwall entire; they
  // would inherit whatever the previous arm set, and the arms that render 1728x1080
  // and 1920x1200 run after the region rows have already been through. Measured with
  // this line absent: the two cross-build rows came back at luminance ratio 0.364 with
  // a worst tile of 48.7/255, which reads as the rebase having broken and was a mask
  // still fading the cloud. Zero is the default for all four, so this changes nothing
  // for any row that was here before.
  //
  // **The smear is here for the same reason and it is the sharper case**, because the rows that
  // inherit it are the rebase ones, whose whole job is to keep Blackwall's own values rather than
  // spreading an OFF. The row that raises the smear runs last in each size's pass, so without
  // this line every arm after it rendered through a MoshPass nobody asked for: measured the first
  // time as eighteen rows red at a luminance ratio of 1.87, and nine more after putting it in the
  // pipeline looks alone, where the rebase arms never see it.
  const REGION_BASE = {
    'noise.amount': 0, 'push.amount': 0, 'noise.region': 0, 'mask.amount': 0, 'datamosh.amount': 0,
    'glyph.amount': 0,
  };
  const merged = { ...REGION_BASE, ...resLook, ...look };
  const dropped = Object.keys(merged).filter((n) => !known.has(n));
  k.params.apply(Object.fromEntries(Object.entries(merged).filter(([n]) => known.has(n))));
  ex.pinCamera(camera);
  await k.timeline.settled();
  const t = k.timeline.transport();
  await t.seek(at);
  const size = ex.grab(label);
  const gl = k.renderer.getContext();
  // Read off the page rather than computed from the drawing buffer, so an arm
  // reports the reference the build in front of it *has* instead of the one this
  // tool assumes it has - the difference is the whole of the 16:9 arm below, where
  // a build referencing width puts 1200 in this uniform at an 1080-tall buffer. The
  // build at HEAD has no such uniform at all, which is the point of the control: its
  // k is 1 at every size.
  const kScale = k.uniforms.bufferHeight ? k.uniforms.bufferHeight.value / 1080 : 1;
  return {
    size,
    dropped,
    lum: ex.lum(label),
    kScale,
    refHeight: k.uniforms.bufferHeight ? k.uniforms.bufferHeight.value : null,
    pointSize: k.uniforms.pointSize.value,
    // The lens as the shader reads it and the cell the glyph field tiles, for modelling the
    // glyph branch's sprite the way drawnPointSizes models the plain one.
    zoom: k.uniforms.lensReference
      ? k.programCamera.projectionMatrix.elements[5] / k.uniforms.lensReference.value : 1,
    lensReference: k.uniforms.lensReference ? k.uniforms.lensReference.value : null,
    latticeCell: k.uniforms.latticeCell ? k.uniforms.latticeCell.value : null,
    sizes: ex.drawnPointSizes(kScale),
    tiles: ex.tiles(label, 8, 5),
    pointRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)),
    // **Which post passes actually ran, read off the composer rather than inferred
    // from the look that was applied.** Two builds handed the same look can still
    // render through different chains, because whether a pass runs is a *derived*
    // fact - and the three cross-build rows were red for exactly that. gradeNeeded()
    // gained a vignette term and a streak term; Blackwall carries vignette 0.55; the
    // look those arms spread zeroes rgbSplit, scanlines and grain and nothing else,
    // so the grade switched off on the pinned build and stayed on here, adding a
    // vignette, a Reinhard and a toe that subtracts 0.018 linear from every pixel.
    // That toe is what took the faint splat fringes under the lit threshold: 7.7% of
    // the coverage at an identical drawn point size, which is the reading that says a
    // reference cannot be the cause. A row comparing a ratio could only report the
    // difference; a row comparing this names it, and names it for any pass anybody
    // puts a derived gate on next.
    passes: k.composer.passes.map((p) => p.constructor.name + ':' + (p.enabled ? 'on' : 'off')),
  };
}`;

const { chromium } = await loadPlaywright();
const mutation = MUTATE ? mutatedSource(MUTATE) : null;
const inBrowser = (file) => file.startsWith('web/') || file.startsWith('effects-builtin/');
const pageMutants = (mutation ?? []).filter((m) => inBrowser(m.file));
const mutatedBody = pageMutants.find((m) => m.file === 'web/main.js')?.body ?? null;
const otherMutants = pageMutants.filter((m) => m.file !== 'web/main.js');
const mutantPath = mutatedBody !== null ? servedAt('web/main.js') : null;
// Counted rather than assumed, across every page this file opens on the current tree: any one of
// them failing to request the mutated module would leave the others carrying a run
// that never happened.
const mutantServedBy = new Map(pageMutants.map((m) => [m.file, 0]));
let mutantServed = 0;
if (MUTATE) {
  const where = mutation.map((m) => m.file).join(', ');
  console.log(`[export] MUTATED BUILD: ${MUTATE} in ${where} - this run is expected to FAIL`);
}

const pageErrors = [];

/**
 * A page on the take, with its errors collected and its GPU vouched for. One browser per page
 * rather than one browser with several pages: a second page in the same browser reliably loses
 * its execution context while an export is reading pixels back.
 */
async function openPage(viewport, source = mutatedBody, html = null) {
  // The full chromium build rather than the headless shell: the shell can land on
  // SwiftShader, which has no EXT_color_buffer_float, and a run that silently fell
  // back to a software rasteriser would agree with itself for the wrong reason.
  const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height + TIMELINE_H_GUESS },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => { errors.push(String(err)); pageErrors.push(String(err)); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    errors.push(msg.text());
    pageErrors.push(msg.text());
  });
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  let servedHtml = false;
  if (html) {
    await page.route((url) => url.pathname === EDITOR_PATH,
      (route) => { servedHtml = true; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }); });
  }
  for (const mutant of otherMutants) {
    const path = servedAt(mutant.file);
    await page.route((url) => url.pathname === path, (route) => {
      mutantServed++;
      mutantServedBy.set(mutant.file, mutantServedBy.get(mutant.file) + 1);
      route.fulfill({ contentType: contentTypeFor(mutant.file), body: mutant.body });
    });
  }
  if (source) {
    const path = source === mutatedBody ? mutantPath : servedAt('web/main.js');
    await page.route((url) => url.pathname === path, (route) => {
      if (source === mutatedBody) {
        mutantServed++;
        mutantServedBy.set('web/main.js', mutantServedBy.get('web/main.js') + 1);
      }
      route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: source });
    });
  }
  await page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
  if (html && !servedHtml) {
    throw new Error(`the page markup was never intercepted - landed on ${new URL(page.url()).pathname}, `
      + 'so the cross-build arm loaded the tree\'s own page');
  }
  await page.waitForFunction(() => !!globalThis.__kinect);
  await page.waitForFunction(() => !!globalThis.__kinect.timeline.transport(), null, { timeout: 20000 });
  // The transport exists before the take finishes building its timeline rows.
  await page.waitForFunction(() => !globalThis.__kinect.takeOpened || globalThis.__kinect.takeOpened(),
    null, { timeout: 60000 });
  await page.evaluate(INSTALL);
  await setStage(page, viewport);
  const gpu = await page.evaluate(() => {
    const gl = globalThis.__kinect.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  });
  if (/swiftshader|software|llvmpipe/i.test(gpu.renderer)) {
    throw new Error(`software rasteriser (${gpu.renderer}) - the result would prove nothing`);
  }
  if (!gpu.colorBufferFloat) throw new Error('no EXT_color_buffer_float: the surface memory is not running at float');
  if (gpu.buffer[0] !== viewport.width || gpu.buffer[1] !== viewport.height) {
    throw new Error(`the stage moved to ${gpu.buffer.join('x')} after settling at ${viewport.width}x${viewport.height}`);
  }
  return { page, errors, gpu, close: () => browser.close() };
}

/**
 * Runs a block on a page of its own, retrying a destroyed execution context - that failure is
 * Playwright and the GPU process rather than anything under test.
 */
async function onFreshPage(what, work, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const held = await openPage(STAGE);
    try {
      const value = await work(held.page);
      if (attempt > 1) note(`${what} needed ${attempt} attempts`, 'the browser dropped its execution context');
      return { ok: true, value };
    } catch (err) {
      const message = String(err.message ?? err);
      if (!/Execution context was destroyed|Target (page|closed)|crashed|promise was garbage collected/i.test(message)) {
        return { ok: false, error: message };
      }
      if (attempt >= attempts) return { ok: false, error: `${message} (${attempts} attempts)` };
    } finally {
      await held.close();
    }
  }
}

// The timeline height scales with the window, so resizing needs several corrections.
const STAGE_ATTEMPTS = 12;
/** Resizes the stage and waits for its drawing buffer to match the requested size. */
async function setStage(page, size) {
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    // Settled before the strip is measured, and the buffer read again after it lands: the lane
    // stack is built after the transport exists, so a strip measured before it has its rows grows
    // under the viewport that was just sized to it. That left the editor reading pixels at one
    // size while the export rendered at another, and every frame of section 4 mismatched.
    await page.evaluate('globalThis.__kinect.timeline.settled()').catch(() => {});
    const furniture = await page.evaluate(`(() => {
      const strip = document.getElementById('timeline');
      const appBar = document.getElementById('appBar');
      return {
        strip: strip && !strip.hidden ? Math.round(strip.getBoundingClientRect().height) : 0,
        shell: appBar && !appBar.hidden ? Math.round(appBar.getBoundingClientRect().height) : 0,
      };
    })()`);
    await page.setViewportSize({
      width: size.width,
      height: size.height + furniture.strip + furniture.shell,
    });
    // The resize event changes the timeline height; a synchronous resize can briefly match first.
    const held = await page.evaluate(`(async () => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      globalThis.__kinect.setOutputSize?.(${JSON.stringify(`${size.width}x${size.height}`)});
      await globalThis.__kinect.timeline.settled();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const gl = globalThis.__kinect.renderer.getContext();
      return [gl.drawingBufferWidth, gl.drawingBufferHeight];
    })()`);
    if (held[0] === size.width && held[1] === size.height) {
      await page.evaluate(`globalThis.__ex.staged = ${JSON.stringify(held)}`);
      return;
    }
    if (attempt === STAGE_ATTEMPTS) {
      throw new Error(`the stage settled at ${held.join('x')} rather than ${size.width}x${size.height}`);
    }
  }
}

const main = await openPage(STAGE);
// Exit 2 rather than a failed assertion: a suite that fails a row on a mutation run reads as a
// catch, so a mutation the page never asked for has to be the harness declining to run.
const unserved = [...mutantServedBy].filter(([, n]) => n === 0).map(([file]) => servedAt(file));
if (MUTATE && pageMutants.length > 0 && unserved.length > 0) {
  console.log(`\n[export] DID NOT RUN - ${MUTATE} was staged for ${unserved.join(', ')} and the page never `
    + 'requested it, so this run would have measured the unmutated build');
  process.exit(2);
}
console.log(`[export] ${main.gpu.renderer}`);
console.log(`[export] take ${TAKE}: ${stamps.length} frames, ${DURATION.toFixed(2)}s source, `
  + `${index.hash}`);
console.log(`[export] stage ${main.gpu.buffer.join('x')}, ffmpeg ${execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' }).split('\n')[0].split(' ')[2]}`);

console.log('\n[1] the take carries its own intrinsics');

{
  const got = await main.page.evaluate(`({
    focal: globalThis.__kinect.uniforms.focal.value.toArray(),
    center: globalThis.__kinect.uniforms.center.value.toArray(),
  })`);
  const want = [hello.fx, hello.fy, hello.cx, hello.cy];
  const have = [...got.focal, ...got.center];
  check(
    have.every((v, i) => v === want[i]),
    'the page unprojects on the hello recorded in the capture',
    `page ${have.map((v) => v.toFixed(6)).join(', ')} want ${want.map((v) => v.toFixed(6)).join(', ')}`,
  );
  const defaults = [BOOT_DEFAULTS.fx, BOOT_DEFAULTS.fy, BOOT_DEFAULTS.cx, BOOT_DEFAULTS.cy];
  check(
    want.some((v, i) => v !== defaults[i]),
    'and the fixture can tell the difference: its hello is not the boot defaults',
    `hello cx ${hello.cx}, cy ${hello.cy} against defaults ${BOOT_DEFAULTS.cx}, ${BOOT_DEFAULTS.cy}`,
  );
  const dx = (hello.cx - BOOT_DEFAULTS.cx) / hello.fx;
  const dy = (hello.cy - BOOT_DEFAULTS.cy) / hello.fy;
  note('the defaults would have cost',
    `${(Math.hypot(dx, dy) * 3000).toFixed(1)}mm of translation at 3m`);

  if (failures > 0) {
    console.log('\n[export] the intrinsics claim failed; everything below renders geometry, so the run stops here');
    await main.close();
    process.exit(1);
  }
}

console.log('\n[2] the look holds at a different output size, and did not before');

const LENS_CAMERA = { position: [0, 0.1, 1.6], quaternion: [0, 0, 0, 1] };
const NEAR_CAMERA = { position: [0, 0.1, -0.2], quaternion: [0, 0, 0, 1], fov: 50 };
const REGION_OFF = { 'noise.amount': 0, 'push.amount': 0, 'noise.region': 0, 'mask.amount': 0 };
// The crop planes wide open, and they are in `OFF` because an arm applies its look over
// whatever the previous one left - the sweep ends on the crop row.
const CROP_OPEN = { left: -7, right: 7, bottom: -7, top: 7 };
const OFF = {
  bloom: 0, trails: 0, 'rgbsplit.amount': 0, 'raster.amount': 0, 'grain.amount': 0, ...REGION_OFF, ...CROP_OPEN,
};

const CROSS_BUILD_OFF = { ...OFF, 'vignette.amount': 0, rgbSplit: 0, scanlines: 0, grain: 0 };

const asOldBuild = (look) => {
  const out = { ...look };
  for (const name of Object.keys(CROP_OPEN)) delete out[name];
  return out;
};

/**
 * Whether two arms rendered through the same chain of post passes. Handing two builds the same look
 * does not put them in the same pipeline, because every pass decides for itself whether it runs.
 */
const chainOf = (arm) => (arm.passes ?? [])
  .filter((p) => p.endsWith(':on'))
  .map((p) => p.split(':')[0])
  .join('+');
const sameChain = (a, b) => chainOf(a) !== '' && chainOf(a) === chainOf(b);

const REGION_AT_SUBJECT = {
  ...REGION_OFF,
  regionX: 0.05, regionY: 0.15, regionZ: -1.9,
  regionW: 0.4, regionH: 0.4, regionD: 0.4,
  regionRound: 0.9, regionSoft: 0.6,
};

const HD_LOOK = { ...CROSS_BUILD_OFF, additive: false, pointSize: HD_POINT_SIZE };
const PIPELINES = [
  ['points', { look: OFF }],
  ['splat', { look: { ...OFF, additive: true, pointSize: 7 }, camera: NEAR_CAMERA }],
  ['splat-large', {
    look: { ...OFF, 'vignette.amount': 0, exposure: 0.25, additive: true, pointSize: 60 },
    camera: { ...LENS_CAMERA, fov: 50 },
  }],
  ['trails', { look: { ...OFF, trails: 0.5 } }],
  ['rgbsplit', { look: { ...OFF, 'rgbsplit.amount': 1.6 } }],
  ['scanlines', { look: { ...OFF, 'raster.amount': 1 } }],
  ['grain', { look: { ...OFF, 'grain.amount': 1 } }],
  ['bloom', { look: { ...OFF, bloom: 0.5 } }],
  ['nobloom', { look: { bloom: 0 } }],
  ['full', { look: {} }],
  ['noise', { look: { ...OFF, ...REGION_OFF, 'noise.amount': 0.06, 'noise.scale': 4, 'noise.speed': 0 } }],
  ['regionpush', { look: { ...OFF, ...REGION_AT_SUBJECT, 'push.amount': 0.35 } }],
  ['regionmask', { look: { ...OFF, ...REGION_AT_SUBJECT, 'mask.amount': 0.5 } }],
  ['crop', { look: { ...OFF, ...REGION_OFF, left: -0.8, right: 0.8, bottom: -0.8, top: 0.8 } }],
  // The one row whose pass carries a frame of memory. `RES_ARM` reaches its position through a
  // real seek, so the pre-roll has run and the smear it measures has history behind it; the
  // refresh puts the last decode point a second before the arm's own position at 1.5s.
  ['datamosh', { look: { ...OFF,
    'datamosh.amount': 1,
    'datamosh.reach': 18,
    'datamosh.decay': 0.9,
    'datamosh.splay': 1,
    'datamosh.line': 0.55,
    'datamosh.grain': 4,
    'datamosh.refresh': 1.5,
  } }],
];

// Which measurement each row is judged on, per row because the terms live at different spatial
// frequencies. Grain and scanlines are one-pixel structures the coarse grid averages away, so
// they are judged on the full-resolution comparison; everything else is judged coarse, where
// per-pixel rasterisation differences do not count as the look having moved.
const RES_TOLERANCE = {
  points: { on: 'coarse', mean: 3.0, ratio: 0.005 },
  splat: { on: 'coarse', mean: 6.0, ratio: 0.005 },
  'splat-large': { on: 'coarse', mean: 6.0, ratio: 0.005 },
  trails: { on: 'coarse', mean: 1.6, ratio: 0.005 },
  rgbsplit: { on: 'coarse', mean: 2.2, ratio: 0.005 },
  scanlines: { on: 'fine', mean: 4.0, ratio: 0.005, corr: 0.88 },
  grain: { on: 'fine', mean: 4.0, ratio: 0.005, corr: 0.70 },
  bloom: { on: 'coarse', mean: 1.6, ratio: 0.03 },
  nobloom: { on: 'coarse', mean: 2.4, ratio: 0.005 },
  full: { on: 'coarse', mean: 2.6, ratio: 0.03 },
  noise: { on: 'coarse', mean: 2.0, ratio: 0.005 },
  regionpush: { on: 'coarse', mean: 1.8, ratio: 0.005 },
  regionmask: { on: 'coarse', mean: 1.5, ratio: 0.005 },
  crop: { on: 'coarse', mean: 0.9, ratio: 0.005 },
  // Measured on this rig: 3.088 clean against 5.791 under `--mutate mosh-buffer-sized`, so the
  // floor sits between the two rather than above both. The mutation also moves the luminance
  // ratio to 0.938, and either half alone catches it.
  datamosh: { on: 'coarse', mean: 4.0, ratio: 0.03 },
};

const ARMS = [];

async function armAt(page, opts) {
  await page.evaluate(
    `globalThis.__ex.pinIntrinsics(${[hello.fx, hello.fy, hello.cx, hello.cy].join(', ')})`,
  );
  const arm = await page.evaluate(`(${RES_ARM})(${JSON.stringify({ at: AT_SEC, resLook: RES_LOOK, ...opts })})`);
  ARMS.push([opts.label ?? '(unlabelled)', arm]);
  return arm;
}

async function resolutionSweep(page, pipelines) {
  const out = new Map();
  for (const [size, label] of [[SMALL, 'small'], [BIG, 'big']]) {
    await setStage(page, size);
    for (const [name, spec] of pipelines) {
      const opts = { label: `${name}-${label}`, look: spec.look, camera: spec.camera ?? null };
      out.set(`${name}-${label}`, await armAt(page, opts));
    }
  }
  const measured = new Map();
  for (const [name] of pipelines) {
    const m = await page.evaluate(`((n) => {
      const ex = globalThis.__ex;
      ex.down(n + '-big', n + '-bigDown', 2);
      ex.down(n + '-small', n + '-smallCoarse', 4);
      ex.down(n + '-big', n + '-bigCoarse', 8);
      return {
        fine: ex.diff(n + '-small', n + '-bigDown'),
        coarse: ex.diff(n + '-smallCoarse', n + '-bigCoarse'),
        texture: ex.texture(n + '-bigDown') / ex.texture(n + '-small'),
        corr: ex.hpCorr(n + '-small', n + '-bigDown'),
      };
    })(${JSON.stringify(name)})`);
    const small = out.get(`${name}-small`);
    const big = out.get(`${name}-big`);
    measured.set(name, { ...m, ratio: big.lum.mean / small.lum.mean, small, big });
  }
  return measured;
}

{
  const defs = await main.page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return Object.fromEntries(['left', 'right', 'bottom', 'top'].map((n) => [n, k.params.spec(n).default]));
  })()`);
  const drift = Object.entries(CROP_OPEN).filter(([n, v]) => defs[n] !== v);
  check(drift.length === 0, 'this file\'s idea of an open crop box is the registry\'s',
    drift.length ? drift.map(([n, v]) => `${n}: table ${v}, registry ${defs[n]}`).join('; ')
      : `all four at +/-${CROP_OPEN.right}m`);
}

const after = await resolutionSweep(main.page, PIPELINES);

await main.page.evaluate(`globalThis.__kinect.params.apply(${JSON.stringify(CROP_OPEN)})`);

{
  const leaked = [...after.entries()].flatMap(([label, arm]) => (arm?.dropped ?? [])
    .map((p) => `${label}:${p}`));
  check(leaked.length === 0,
    'every parameter every row asks for exists on this build',
    leaked.length ? leaked.join(' ') : `${after.size} arms, none dropped a name`);
}

const rebaseFullBig = await armAt(main.page, {
  label: 'rebase-full-big', look: {}, resLook: REBASE_FULL_LOOK,
});
const rebaseGlowBig = await armAt(main.page, {
  label: 'rebase-glow-big', look: {}, resLook: REBASE_LOOK,
});
await setStage(main.page, REF);
const rebaseFullRef = await armAt(main.page, {
  label: 'rebase-full-ref', look: {}, resLook: REBASE_FULL_LOOK,
});
const rebaseGlowRef = await armAt(main.page, {
  label: 'rebase-glow-ref', look: {}, resLook: REBASE_LOOK,
});

{
  const bad = [];
  for (const [name] of PIPELINES) {
    for (const arm of [after.get(name).small, after.get(name).big]) {
      const s = arm.sizes;
      if (s.smallest < 1 || s.largest > Math.min(64, arm.pointRange[1])) {
        bad.push(`${name}@${arm.size.h}: ${s.smallest.toFixed(2)}..${s.largest.toFixed(1)}px`);
      }
    }
  }
  const one = after.get('points');
  check(bad.length === 0,
    'neither point-size clamp is active in any arm, so the comparison is about the scaling',
    bad.length ? bad.join(' | ')
      : `points: ${one.small.sizes.smallest.toFixed(2)}..${one.small.sizes.largest.toFixed(1)}px at 600, `
        + `${one.big.sizes.smallest.toFixed(2)}..${one.big.sizes.largest.toFixed(1)}px at 1200, `
        + `over ${one.small.sizes.drawn} drawn points`);
}

{
  const arm = after.get('splat-large').small;
  const smallest = arm.sizes.smallest / arm.kScale;
  check(smallest > 10.8, 'the large splats exceed the additive normalization threshold',
    `smallest ${smallest.toFixed(2)} reference pixels, threshold 10.8`);
}

console.log('  ....  term            fine mean   coarse mean   lum ratio   texture   hp corr   judged on');
for (const [name, m] of after) {
  const tol = RES_TOLERANCE[name];
  note(`${name.padEnd(14)} ${fixed(m.fine.mean).padStart(9)} ${fixed(m.coarse.mean).padStart(13)} `
    + `${fixed(m.ratio, 4).padStart(11)} ${fixed(m.texture, 4).padStart(9)} ${fixed(m.corr, 4).padStart(9)}   `
    + `${tol ? tol.on : 'reported only'}`);
}

for (const [name, tol] of Object.entries(RES_TOLERANCE)) {
  const m = after.get(name);
  const d = m[tol.on];
  const corrOk = !tol.corr || m.corr >= tol.corr;
  check(d.mean <= tol.mean && Math.abs(m.ratio - 1) <= tol.ratio && corrOk,
    `${name}: 1920x1200 is 960x600 at twice the size`,
    `${tol.on} mean ${fixed(d.mean)} <= ${tol.mean}, luminance ratio ${fixed(m.ratio, 4)} within ${tol.ratio}`
    + (tol.corr ? `, fine structure correlates ${fixed(m.corr, 4)} >= ${tol.corr}` : ''));
}

let rebaseOld = null;
let rebaseFullOld = null;
let rebaseGlowOld = null;
let rebaseHdOld = null;
let rebaseNon169Old = null;
{
  let src = execFileSync('git', ['-C', REPO, 'show', `${BEFORE}:web/main.js`], { encoding: 'utf8', maxBuffer: 1e9 });
  if (src.includes('bufferHeight / 1080.0')) {
    throw new Error(`${BEFORE} already has the resolution work: the control would be the same build twice`);
  }
  // The pinned build is the old point size, not the old geometry. The unprojection's x sign
  // changed after this rev, so left alone the old arm draws the room reflected and the rows
  // below disagree for two reasons at once.
  const OLD_UNPROJECT_X = '     (pixel.x + 0.5 - center.x) / focal.x * z,';
  const xHits = src.split(OLD_UNPROJECT_X).length - 1;
  if (xHits !== 1) {
    throw new Error(`${BEFORE}:web/main.js states the unprojection's x ${xHits} times, expected exactly 1`
      + ' - refusing to compare a mirrored build against an unmirrored one and report it as point size');
  }
  src = src.replace(OLD_UNPROJECT_X, '    -(pixel.x + 0.5 - center.x) / focal.x * z,');
  const beforeHtml = execFileSync('git', ['-C', REPO, 'show', `${BEFORE}:web/index.html`], { encoding: 'utf8', maxBuffer: 1e9 });
  const before = await openPage(SMALL, src, beforeHtml);
  const measured = await resolutionSweep(before.page, PIPELINES.filter(([n]) => n === 'points' || n === 'nobloom'));

  await setStage(before.page, SMALL);
  rebaseOld = await armAt(before.page, {
    label: 'rebase-old', look: asOldBuild({ ...CROSS_BUILD_OFF, pointSize: RES_LOOK.pointSize }),
  });
  rebaseFullOld = await armAt(before.page, {
    label: 'rebase-full-old', look: {}, resLook: REBASE_FULL_LOOK,
  });
  rebaseGlowOld = await armAt(before.page, {
    label: 'rebase-glow-old', look: {}, resLook: REBASE_LOOK,
  });
  await setStage(before.page, HD);
  rebaseHdOld = await armAt(before.page, {
    label: 'rebase-hd-old', look: asOldBuild(HD_LOOK),
  });
  await setStage(before.page, NON_169);
  rebaseNon169Old = await armAt(before.page, {
    label: 'rebase-non169-old', look: asOldBuild(HD_LOOK),
  });
  await before.close();
  for (const name of ['points', 'nobloom']) {
    const m = measured.get(name);
    note(`${BEFORE} ${name.padEnd(8)} ${fixed(m.fine.mean).padStart(9)} ${fixed(m.coarse.mean).padStart(13)} ${fixed(m.ratio, 4).padStart(11)} ${fixed(m.texture, 4).padStart(9)}`);
  }
  for (const name of ['points', 'nobloom']) {
    const m = measured.get(name);
    const tol = RES_TOLERANCE[name];
    const holds = m[tol.on].mean <= tol.mean && Math.abs(m.ratio - 1) <= tol.ratio;
    const margin = Math.abs(m.ratio - 1) / tol.ratio;
    check(!holds && margin >= CONTROL_MARGIN,
      `the control fails the same assertion at ${name}: at ${BEFORE} the scene at 2x is a different image`,
      `luminance ratio ${fixed(m.ratio, 4)} is ${margin.toFixed(1)}x the ${tol.ratio} tolerance, `
      + `${tol.on} mean ${fixed(m[tol.on].mean)} against ${tol.mean}`);
  }
}

for (const [label, arm, glow] of [
  ['1728x1080', rebaseFullRef, rebaseGlowRef],
  ['1920x1200', rebaseFullBig, rebaseGlowBig],
]) {
  const clear = [rebaseFullOld, arm].every((a) => a.sizes.smallest >= 1 && a.sizes.largest <= 64);
  const ends = `old at 960x600 ${rebaseFullOld.sizes.smallest.toFixed(2)}..`
    + `${rebaseFullOld.sizes.largest.toFixed(1)}px, new at ${label} `
    + `${arm.sizes.smallest.toFixed(2)}..${arm.sizes.largest.toFixed(1)}px`;
  const worstFull = Math.max(...arm.tiles.map((v, i) => Math.abs(v - rebaseFullOld.tiles[i])));
  const ratioFull = arm.lum.mean / rebaseFullOld.lum.mean;
  const chains = sameChain(arm, rebaseFullOld);
  const worstGlow = Math.max(...glow.tiles.map((v, i) => Math.abs(v - rebaseGlowOld.tiles[i])));
  const ratioGlow = glow.lum.mean / rebaseGlowOld.lum.mean;
  check(clear && chains && Math.abs(ratioFull - 1) <= 0.02 && worstFull <= 2.0,
    `and the whole look bar the glow rebases, not just the points: Blackwall at ${label} is Blackwall at 960x600`,
    `${ends}; luminance ratio ${fixed(ratioFull, 5)}, worst of 40 tile means ${fixed(worstFull)}/255; `
    + `chain ${chainOf(arm)} against ${chainOf(rebaseFullOld)}; bloom is left out because the `
    + `pinned build's glow is three's pass and this one's is ours - with it up the same pair reads `
    + `${fixed(ratioGlow, 5)} and ${fixed(worstGlow)}/255 through ${chainOf(glow)} against `
    + `${chainOf(rebaseGlowOld)}`);
}

{
  await setStage(main.page, SMALL);
  const newLook = await armAt(main.page, {
    label: 'rebase-new',
    look: { ...CROSS_BUILD_OFF, pointSize: RES_LOOK.pointSize * POINT_SIZE_REBASE },
  });
  const worst = Math.max(...newLook.tiles.map((v, i) => Math.abs(v - rebaseOld.tiles[i])));
  const ratio = newLook.lum.mean / rebaseOld.lum.mean;
  const twoBuilds = rebaseOld.kScale === 1 && newLook.kScale === SMALL.height / 1080
    && rebaseOld.pointSize === RES_LOOK.pointSize
    && newLook.pointSize === RES_LOOK.pointSize * POINT_SIZE_REBASE
    && sameChain(newLook, rebaseOld);
  check(twoBuilds && Math.abs(ratio - 1) <= 0.01 && worst <= 1.0,
    `the 1080p-referred preset is the old preset, both drawn at 960x600: same size, same image`,
    `pointSize ${rebaseOld.pointSize} with no reference at ${BEFORE} against ${newLook.pointSize} `
    + `at k=${fixed(newLook.kScale, 4)} here: luminance ratio ${fixed(ratio, 5)}, `
    + `worst of 40 tile means ${fixed(worst)}/255; chain ${chainOf(newLook)} against `
    + `${chainOf(rebaseOld)}`);
}

{
  await setStage(main.page, HD);
  const hdNew = await armAt(main.page, {
    label: 'rebase-hd-new', look: HD_LOOK,
  });
  const worst = Math.max(...hdNew.tiles.map((v, i) => Math.abs(v - rebaseHdOld.tiles[i])));
  const ratio = hdNew.lum.mean / rebaseHdOld.lum.mean;
  const litRatio = hdNew.lum.litPct / rebaseHdOld.lum.litPct;
  // Both registries have to have taken the size they were asked for - the old
  // build's step is 0.5 and this one's 0.1 - or this is a comparison about a snap.
  const asked = hdNew.pointSize === HD_POINT_SIZE && rebaseHdOld.pointSize === HD_POINT_SIZE
    && sameChain(hdNew, rebaseHdOld);
  const clear = [hdNew, rebaseHdOld].every((a) => a.sizes.smallest >= 1 && a.sizes.largest <= 64);
  check(asked && clear && Math.abs(litRatio - 1) <= 0.01 && Math.abs(ratio - 1) <= 0.01 && worst <= 1.0,
    'and it holds at 16:9, where a width reference and a height reference are different numbers',
    `the page's own reference is ${fixed(hdNew.refHeight, 1)} at a ${hdNew.size.w}x${hdNew.size.h} `
    + `buffer, where a width-referenced build reads 1200; pointSize ${hdNew.pointSize} at `
    + `k=${fixed(hdNew.kScale, 4)} against ${rebaseHdOld.pointSize} with no reference at ${BEFORE}, `
    + `drawn ${hdNew.sizes.smallest.toFixed(2)}..${hdNew.sizes.largest.toFixed(1)}px; `
    + `lit ${fixed(hdNew.lum.litPct, 4)}% against ${fixed(rebaseHdOld.lum.litPct, 4)}% is a ratio of `
    + `${fixed(litRatio, 5)}, luminance ratio ${fixed(ratio, 5)}, `
    + `worst of 40 tile means ${fixed(worst)}/255; chain ${chainOf(hdNew)} against `
    + `${chainOf(rebaseHdOld)}`);
}

{
  await setStage(main.page, NON_169);
  const non169New = await armAt(main.page, {
    label: 'rebase-non169-new', look: HD_LOOK,
  });
  const worst = Math.max(...non169New.tiles.map((v, i) => Math.abs(v - rebaseNon169Old.tiles[i])));
  const ratio = non169New.lum.mean / rebaseNon169Old.lum.mean;
  const litRatio = non169New.lum.litPct / rebaseNon169Old.lum.litPct;
  const asked = non169New.pointSize === HD_POINT_SIZE && rebaseNon169Old.pointSize === HD_POINT_SIZE
    && sameChain(non169New, rebaseNon169Old);
  const clear = [non169New, rebaseNon169Old].every((a) => a.sizes.smallest >= 1 && a.sizes.largest <= 64);
  check(asked && clear && Math.abs(litRatio - 1) <= 0.01 && Math.abs(ratio - 1) <= 0.01 && worst <= 1.0,
    'and it holds at 4:3, where a width reference and a height reference are also different numbers',
    `the page's own reference is ${fixed(non169New.refHeight, 1)} at a ${non169New.size.w}x${non169New.size.h} `
    + `buffer, where a width-referenced build reads 900; pointSize ${non169New.pointSize} at `
    + `k=${fixed(non169New.kScale, 4)} against ${rebaseNon169Old.pointSize} with no reference at ${BEFORE}, `
    + `drawn ${non169New.sizes.smallest.toFixed(2)}..${non169New.sizes.largest.toFixed(1)}px; `
    + `lit ${fixed(non169New.lum.litPct, 4)}% against ${fixed(rebaseNon169Old.lum.litPct, 4)}% is a ratio of `
    + `${fixed(litRatio, 5)}, luminance ratio ${fixed(ratio, 5)}, `
    + `worst of 40 tile means ${fixed(worst)}/255; chain ${chainOf(non169New)} against `
    + `${chainOf(rebaseNon169Old)}`);
}

// Compare the same surface: the wide frame's centre against the long frame reduced by its zoom.
const LENS_ZOOM = 2;
// The graded lens is the one the camera boots with, read off the registry rather than written here.
const PROGRAM_FOV = await main.page.evaluate("globalThis.__kinect.params.spec('camera').default.fov");
const LENS_LONG_FOV = (2 * Math.atan(Math.tan((PROGRAM_FOV * Math.PI) / 360) / LENS_ZOOM) * 180) / Math.PI;
// The vignette is frame-space; leaving it on would compare different shading on the same surface.
// The glyph arm is a quarter mixed, so the branch's own base term carries three quarters of
// every sprite: a half mix caught the base mutation at 1.7x the tolerance, this at 2.4x. The
// point size and cell put the farthest sprite above the 16-pixel legibility band on this
// fixture, where at 40 and 0.05 m it was 10.2 px and the row read the crossfade.
const LENS_GLYPH = 0.25;
const LENS_PIPELINES = [
  ['lens-points', { look: { ...OFF, 'vignette.amount': 0, additive: false, pointSize: 24 } }],
  ['lens-splat', { look: { ...OFF, 'vignette.amount': 0, additive: true, pointSize: 40 } }],
  ['lens-glyph', {
    look: { ...OFF, 'vignette.amount': 0, additive: false, pointSize: 64, cell: 0.12, 'glyph.amount': LENS_GLYPH },
  }],
];
const LENS_TOLERANCE = {
  'lens-points': { mean: 3.0, ratio: 0.01 },
  'lens-splat': { mean: 6.0, ratio: 0.01 },
  'lens-glyph': { mean: 6.0, ratio: 0.01 },
};
// The glyph branch's sprite at a view distance, as size.vert.glsl writes it: the plain sprite
// mixed with the cell, both through the lens.
const glyphSpriteAt = (arm, d) => {
  const base = Math.min(64, Math.max(1, (arm.pointSize * arm.kScale * arm.zoom) / Math.max(0.15, d)));
  const cell = (arm.latticeCell * arm.lensReference * 540 * arm.kScale * arm.zoom) / Math.max(0.15, d);
  return { base, mixed: base * (1 - LENS_GLYPH) + cell * LENS_GLYPH };
};

{
  await setStage(main.page, REF);
  const measured = new Map();
  for (const [name, spec] of LENS_PIPELINES) {
    const wide = await armAt(main.page, {
      label: `${name}-wide`, look: spec.look, camera: { ...LENS_CAMERA, fov: PROGRAM_FOV },
    });
    const long = await armAt(main.page, {
      label: `${name}-long`, look: spec.look, camera: { ...LENS_CAMERA, fov: LENS_LONG_FOV },
    });
    const m = await main.page.evaluate(`((n, z) => {
      const ex = globalThis.__ex;
      ex.crop(n + '-wide', n + '-wideCentre', z);
      ex.down(n + '-long', n + '-longDown', z);
      ex.down(n + '-wideCentre', n + '-wideCoarse', 4);
      ex.down(n + '-longDown', n + '-longCoarse', 4);
      // The control: the long frame against the wide one shrunk rather than cropped, which is
      // a different picture unless the lens never reached the render.
      ex.down(n + '-wide', n + '-wideShrunk', z);
      ex.down(n + '-wideShrunk', n + '-shrunkCoarse', 4);
      return {
        fine: ex.diff(n + '-wideCentre', n + '-longDown'),
        coarse: ex.diff(n + '-wideCoarse', n + '-longCoarse'),
        control: ex.diff(n + '-shrunkCoarse', n + '-longCoarse'),
        ratio: ex.lum(n + '-longDown').mean / ex.lum(n + '-wideCentre').mean,
        controlRatio: ex.lum(n + '-longDown').mean / ex.lum(n + '-wideShrunk').mean,
      };
    })(${JSON.stringify(name)}, ${LENS_ZOOM})`);
    measured.set(name, { ...m, wide, long });
  }

  const bad = [];
  for (const [name, m] of measured) {
    for (const arm of [m.wide, m.long]) {
      const s = arm.sizes;
      if (s.smallest < 1 || s.largest > Math.min(64, arm.pointRange[1])) {
        bad.push(`${name} at ${arm.size.w}x${arm.size.h}: ${s.smallest.toFixed(2)}..${s.largest.toFixed(1)}px`);
      }
    }
  }
  const one = measured.get('lens-splat');
  check(bad.length === 0,
    'neither point-size clamp is active through either lens, so the comparison is about the lens',
    bad.length ? bad.join(' | ')
      : `lens-splat: ${one.wide.sizes.smallest.toFixed(2)}..${one.wide.sizes.largest.toFixed(1)}px at `
        + `${fixed(PROGRAM_FOV, 2)} degrees, ${one.long.sizes.smallest.toFixed(2)}..`
        + `${one.long.sizes.largest.toFixed(1)}px at ${fixed(LENS_LONG_FOV, 2)}`);
  // The glyph sprite has to sit above the 16-pixel legibility band through both lenses and
  // under the base clamp and the hardware ceiling through the long one, or a point would
  // change from character to dust between the two frames for a reason that is not the lens.
  {
    const g = measured.get('lens-glyph');
    const wideFar = glyphSpriteAt(g.wide, g.wide.sizes.farthest);
    const longNear = glyphSpriteAt(g.long, g.long.sizes.nearest);
    const ceiling = Math.min(255 * g.long.kScale, g.long.pointRange[1]);
    check(wideFar.mixed >= 16 && longNear.base < 64 && longNear.mixed < ceiling,
      'the glyph sprite is legible through both lenses and clamped through neither, so the glyph row is about the lens',
      `mixed ${wideFar.mixed.toFixed(1)}px at the farthest point through ${fixed(PROGRAM_FOV, 2)} degrees, `
      + `base ${longNear.base.toFixed(1)}px and mixed ${longNear.mixed.toFixed(1)}px at the nearest through `
      + `${fixed(LENS_LONG_FOV, 2)}, against 16, 64 and ${ceiling}`);
  }

  for (const [name, m] of measured) {
    const tol = LENS_TOLERANCE[name];
    const margin = Math.min(m.control.mean / tol.mean, Math.abs(m.controlRatio - 1) / tol.ratio);
    check(margin >= CONTROL_MARGIN,
      `${name}: the lens reached the render - the long frame is not the wide one shrunk`,
      `coarse mean ${fixed(m.control.mean)} against ${tol.mean}, luminance ratio ${fixed(m.controlRatio, 4)} `
      + `against ${tol.ratio}: ${margin.toFixed(1)}x the tolerance`);
    check(m.coarse.mean <= tol.mean && Math.abs(m.ratio - 1) <= tol.ratio,
      `${name}: a ${fixed(LENS_LONG_FOV, 2)}-degree lens is the centre of the ${fixed(PROGRAM_FOV, 2)}-degree frame at ${LENS_ZOOM}x`,
      `coarse mean ${fixed(m.coarse.mean)} <= ${tol.mean}, fine mean ${fixed(m.fine.mean)}, `
      + `luminance ratio ${fixed(m.ratio, 4)} within ${tol.ratio}`);
  }
}

console.log('\n[3] the crop box is editing furniture and cannot reach an exported pixel');

{
  const arm = async (label, { box, chrome, near = 0.05, crop = true, wide = false }) => main.page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const ex = globalThis.__ex;
    k.keyframes.chrome.set(true);
    if (k.cropBoxShown() !== ${box}) document.getElementById('cropBox').click();
    // Straight to the flag rather than through a button, because this is the state an
    // export puts the page into: \`exportClip\` sets it and calls \`placeChrome\`, which is
    // where the faint pass is meant to be recomputed.
    k.keyframes.chrome.set(${chrome});
    const faces = ${wide} ? [['left', -7], ['right', 7], ['bottom', -7], ['top', 7], ['far', 9.5]]
      : [['left', -0.8], ['right', 0.8], ['bottom', -0.8], ['top', 0.8], ['far', 3]];
    for (const [n, v] of [...faces, ['near', ${near}], ['crop', ${crop}]]) {
      k.params.set(n, v);
    }
    await k.timeline.settled();
    await k.timeline.transport().seek(${AT_SEC});
    ex.grab('${label}');
    return { outside: k.cropOutside(), sha: await ex.sha(ex.shots.get('${label}').px) };
  })()`);

  const shown = await arm('cropShown', { box: true, chrome: true });
  const exporting = await arm('cropExporting', { box: true, chrome: false });
  const hidden = await arm('cropHidden', { box: false, chrome: true });

  console.log(`  ....  faint pass   shown ${shown.outside}, mid-export ${exporting.outside}, `
    + `box off ${hidden.outside}`);

  check(shown.sha !== hidden.sha,
    'the faint pass reaches the rendered image while the editor is showing the box',
    `${shown.sha.slice(0, 12)} shown against ${hidden.sha.slice(0, 12)} with the box off`);
  check(exporting.sha === hidden.sha && exporting.outside === 0,
    'and an exported frame is byte-identical with the box shown and with it hidden',
    `${exporting.sha.slice(0, 12)} mid-export against ${hidden.sha.slice(0, 12)} with the box off`);

  const cut = await arm('cropCut', { box: false, chrome: true, near: 2.5, wide: true });
  const whole = await arm('cropWhole', { box: false, chrome: true, near: 2.5, crop: false, wide: true });
  const revealed = await main.page.evaluate(`(() => {
    const ex = globalThis.__ex;
    const a = ex.shots.get('cropCut').px;
    const b = ex.shots.get('cropWhole').px;
    const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    let seen = 0;
    let litCut = 0;
    let litWhole = 0;
    for (let i = 0; i < a.length; i += 4) {
      const la = lum(a, i);
      const lb = lum(b, i);
      if (la > lb + 8) seen++;
      if (la > 8) litCut++;
      if (lb > 8) litWhole++;
    }
    return { seen, litCut, litWhole };
  })()`);
  note('cutting the first 2.5m of the room',
    `${revealed.seen} pixels the released picture has nothing on; `
    + `${revealed.litCut} lit with the near plane biting against ${revealed.litWhole} released`);
  check(revealed.seen > 2000,
    'and with the box off the crop is a cull, so what it removes stops occluding what it kept',
    `${revealed.seen} revealed, ${revealed.litCut} lit against ${revealed.litWhole} released`);
}

// Left in the state the rows below expect, since this section moved six parameters.
await main.page.evaluate(`(() => {
  const k = globalThis.__kinect;
  if (k.cropBoxShown()) document.getElementById('cropBox').click();
  k.keyframes.chrome.set(true);
  // The switch among them, because the last arm above ran with it off - without it
  // this block leaves the state its own comment says it restores, and every row below
  // would render with the box released.
  k.params.reset(['left', 'right', 'bottom', 'top', 'near', 'far', 'crop']);
})()`);

if (SHOTS) await main.page.screenshot({ path: join(SHOTS, `export-check${MUTATE ? `-${MUTATE}` : ''}.png`) });
await main.close();

console.log('\n[4] an exported frame is the frame the editor showed at that program time');

const EDITOR_ARM = `(async ({ frames, fps }) => {
  const k = globalThis.__kinect;
  const ex = globalThis.__ex;
  // The graded look, not the reading alone - see BLACKWALL_LOOK. setMode(4) used to be
  // both in one call, and this arm depended on the half it did not name.
  k.applyPreset(${JSON.stringify(BLACKWALL_LOOK)});
  ex.pinCamera();
  await k.timeline.settled();
  const t = k.timeline.transport();
  t.outputFps = fps;
  const out = [];
  // Each one reached the way a user parks the playhead there: an accurate seek
  // from wherever the last one left it, pre-rolled from a reset.
  for (let n = 0; n <= frames; n++) {
    await t.seek(n / fps);
    out.push(await ex.sha(k.drive.readPixels()));
  }
  return out;
})`;

const LOSSLESS = {
  width: STAGE.width, height: STAGE.height, fps: EXPORT_FPS,
  from: 0, to: EXPORT_FRAMES, name: 'check-lossless', codec: 'lossless',
};

const shown = await onFreshPage('the editor-equals-export run', async (page) => {
  const editorHashes = await page.evaluate(
    `${EDITOR_ARM}(${JSON.stringify({ frames: EXPORT_FRAMES, fps: EXPORT_FPS })})`,
  );
  const done = await page.evaluate(`globalThis.__kinect.export.run(${JSON.stringify(LOSSLESS)})`);
  return { editorHashes, done };
});

check(shown.ok, 'the export ran',
  shown.ok ? `${shown.value.done.frames} frames to ${shown.value.done.output}` : shown.error);

const lossless = shown.ok ? { ok: true, done: shown.value.done } : { ok: false, error: shown.error };

if (shown.ok) {
  const { editorHashes, done } = shown.value;
  const got = done.frameHashes;
  const same = got.filter((h, i) => h === editorHashes[i]).length;
  check(same === editorHashes.length,
    'every frame that crossed the wire is byte-identical to the editor\'s own image there',
    `${same}/${editorHashes.length} frames matched`);
  const firstBad = got.findIndex((h, i) => h !== editorHashes[i]);
  if (firstBad >= 0) {
    note('first mismatch', `frame ${firstBad}: export ${got[firstBad].slice(0, 16)} editor ${editorHashes[firstBad].slice(0, 16)}`);
  }
  const distinct = new Set(got).size;
  check(distinct === got.length,
    'and the frames are not all the same image, so the equality is about position',
    `${distinct} distinct frames of ${got.length}`);
}

console.log('\n[5] the same export twice is the same bytes');

const RERUN = {
  width: STAGE.width, height: STAGE.height, fps: EXPORT_FPS,
  from: 0, to: EXPORT_FRAMES, name: 'check-repeat', codec: 'h264',
};

const ODD_SIZE = {
  width: 800, height: 450, fps: EXPORT_FPS,
  from: 0, to: 3, name: 'check-size', codec: 'h264',
};

const twice = [];
for (let i = 0; i < 2; i++) {
  const run = await onFreshPage(`determinism run ${i}`, async (page) => {
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      // The graded look, not the reading alone - see BLACKWALL_LOOK.
      k.applyPreset(${JSON.stringify(BLACKWALL_LOOK)});
      globalThis.__ex.pinCamera();
      await k.timeline.settled();
    })()`);
    return page.evaluate(`globalThis.__kinect.export.run(${JSON.stringify(RERUN)})`);
  });
  twice.push(run.ok ? { ok: true, done: run.value } : run);
  if (run.ok) {
    const file = createHash('sha256').update(readFileSync(run.value.output)).digest('hex');
    twice[i].fileHash = `sha256:${file}`;
  }
}

if (twice.every((r) => r.ok)) {
  check(twice[0].done.streamHash === twice[1].done.streamHash,
    'the raw RGBA the browser produced is identical across two page loads',
    `${twice[0].done.streamHash.slice(0, 23)}… twice`);
  check(twice[0].fileHash === twice[1].fileHash,
    'and so is the file, so nothing downstream carries a clock either',
    `${twice[0].fileHash.slice(0, 23)}…`);
} else {
  check(false, 'both determinism runs completed',
    twice.map((r, i) => (r.ok ? `run ${i} ok` : `run ${i}: ${r.error}`)).join(' | '));
}

console.log('\n[6] the file has the frames, the duration and the rate that were asked for');

const probe = (path) => {
  const raw = execFileSync(FFPROBE, [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate,codec_name',
    '-show_entries', 'format=duration', '-of', 'json', path,
  ], { encoding: 'utf8' });
  const json = JSON.parse(raw);
  const s = json.streams[0];
  const [num, den] = s.r_frame_rate.split('/').map(Number);
  return {
    width: s.width,
    height: s.height,
    frames: Number(s.nb_read_frames),
    fps: num / den,
    codec: s.codec_name,
    duration: Number(json.format.duration),
  };
};

if (lossless.ok && twice[0]?.ok) {
  for (const [label, run] of [['lossless', lossless], ['h264', twice[0]]]) {
    const p = probe(run.done.output);
    const wantFrames = EXPORT_FRAMES + 1;
    check(p.frames === wantFrames && p.width === STAGE.width && p.height === STAGE.height,
      `${label}: the file decodes to the frames and the size that were asked for`,
      `${p.frames} frames of ${p.width}x${p.height} in ${p.codec}, wanted ${wantFrames} of ${STAGE.width}x${STAGE.height}`);
    check(p.fps === EXPORT_FPS && Math.abs(p.duration - wantFrames / EXPORT_FPS) < 1 / EXPORT_FPS,
      `${label}: at the rate and for the duration that were asked for`,
      `${p.fps}fps, ${p.duration.toFixed(3)}s, wanted ${EXPORT_FPS}fps and ${(wantFrames / EXPORT_FPS).toFixed(3)}s`);
  }

  const decoded = execFileSync(FFMPEG, [
    '-v', 'error', '-i', lossless.done.output, '-vf', 'vflip',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { maxBuffer: 1 << 30 });
  const frameBytes = STAGE.width * STAGE.height * 4;
  const back = [];
  for (let i = 0; i * frameBytes < decoded.length; i++) {
    back.push(createHash('sha256').update(decoded.subarray(i * frameBytes, (i + 1) * frameBytes)).digest('hex'));
  }
  const matched = back.filter((h, i) => h === lossless.done.frameHashes[i]).length;
  check(back.length === lossless.done.frameHashes.length && matched === back.length,
    'decoded back, the file is byte-for-byte the frames the browser sent, right way up and in order',
    `${matched}/${lossless.done.frameHashes.length} frames matched`);

  const movRun = await onFreshPage('the ProRes deliverable', async (page) =>
    page.evaluate(`globalThis.__kinect.export.run(${JSON.stringify({ ...LOSSLESS, name: 'check-mov', codec: 'prores' })})`));
  if (movRun.ok) {
    const p = probe(movRun.value.output);
    const wantFrames = EXPORT_FRAMES + 1;
    check(movRun.value.output.endsWith('.mov') && p.codec === 'prores'
      && p.frames === wantFrames && p.width === STAGE.width && p.height === STAGE.height,
      'prores: the deliverable is a .mov holding a ProRes stream of the frames that were asked for',
      `${movRun.value.output.split('/').pop()}: ${p.frames} frames of ${p.width}x${p.height} in ${p.codec}, `
      + `wanted ${wantFrames} of ${STAGE.width}x${STAGE.height} in prores`);
  } else {
    check(false, 'prores: the deliverable is a .mov holding a ProRes stream of the frames that were asked for', movRun.error);
  }

  const seqRun = await onFreshPage('the PNG sequence deliverable', async (page) =>
    page.evaluate(`globalThis.__kinect.export.run(${JSON.stringify({ ...LOSSLESS, name: 'check-pngseq', codec: 'pngseq' })})`));
  if (seqRun.ok) {
    const dir = seqRun.value.output;
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const wantFrames = EXPORT_FRAMES + 1;
    check(files.length === wantFrames,
      'pngseq: the artifact is a directory holding one numbered PNG per frame',
      `${files.length} png files in ${dir.split('/').pop()}, wanted ${wantFrames}`
      + (files.length ? ` - first ${files[0]}, last ${files[files.length - 1]}` : ''));
    if (files.length) {
      const p = probe(join(dir, files[0]));
      check(p.codec === 'png' && p.width === STAGE.width && p.height === STAGE.height,
        'and each of them is a PNG of the size that was asked for',
        `${files[0]}: ${p.width}x${p.height} in ${p.codec}, wanted ${STAGE.width}x${STAGE.height} in png`);
    }
  } else {
    check(false, 'pngseq: the artifact is a directory holding one numbered PNG per frame', seqRun.error);
  }

  const odd = await onFreshPage('the unfamiliar-size export', async (page) => {
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      // The graded look, not the reading alone - see BLACKWALL_LOOK.
      k.applyPreset(${JSON.stringify(BLACKWALL_LOOK)});
      globalThis.__ex.pinCamera();
      await k.timeline.settled();
    })()`);
    return page.evaluate(`globalThis.__kinect.export.run(${JSON.stringify(ODD_SIZE)})`);
  });
  if (odd.ok) {
    const p = probe(odd.value.output);
    check(p.width === ODD_SIZE.width && p.height === ODD_SIZE.height
      && p.frames === ODD_SIZE.to - ODD_SIZE.from + 1,
    'an export at a size the editor is not renders at that size',
    `${p.width}x${p.height}, ${p.frames} frames, from a ${STAGE.width}x${STAGE.height} editor`);
  } else {
    check(false, 'the unfamiliar-size export ran', odd.error);
  }

  const record = JSON.parse(readFileSync(`${lossless.done.output}.job.json`, 'utf8'));
  check(typeof record.renderer === 'string' && record.renderer.length > 0
    && Array.isArray(record.captures) && record.captures.length === 1
    && record.captures[0] === index.hash
    && record.project !== null && typeof record.project === 'object',
  'the job record names its renderer class, every clip capture by hash and its project',
  `renderer ${JSON.stringify(record.renderer)}, captures ${JSON.stringify(record.captures)}`);
}

console.log('\n[7] a failed export leaves the previous file and its record exactly as they were');

// The one claim here that does not go through the running server, because it cannot: what it
// is about is a path inside `server/export.js`, and nothing can serve a running server a
// different module. So this imports it into a server of its own on an ephemeral port.
{
  const outDir = join(REPO, 'exports');
  const NAME = 'check-atomic';
  for (const f of readdirSync(outDir).filter((f) => f.startsWith(NAME))) {
    rmSync(join(outDir, f), { recursive: true, force: true });
  }
  let OUT = null;
  let SIDECAR = null;
  const SHAPE = { name: NAME, width: 64, height: 48, fps: EXPORT_FPS, frames: 2, codec: 'h264' };
  const FRAME_BYTES = SHAPE.width * SHAPE.height * 4;
  const frameOf = (n) => Buffer.alloc(FRAME_BYTES, 24 + n * 96);

  const scratch = mkdtempSync(join(tmpdir(), 'export-check-'));
  const serverSource = mutation?.find((m) => m.file === 'server/export.js')?.body
    ?? readFileSync(join(REPO, 'server/export.js'), 'utf8');
  let copies = 0;

  const exportServer = async (ffmpeg) => {
    const modPath = join(scratch, `export-${++copies}.mjs`);
    writeFileSync(modPath, serverSource);
    const had = Object.hasOwn(process.env, 'FFMPEG') ? process.env.FFMPEG : null;
    process.env.FFMPEG = ffmpeg;
    const mod = await import(pathToFileURL(modPath).href);
    if (had === null) delete process.env.FFMPEG;
    else process.env.FFMPEG = had;
    const http = createServer();
    const wss = new WebSocketServer({ server: http, perMessageDeflate: false, maxPayload: mod.MAX_FRAME_BYTES });
    const lines = [];
    wss.on('connection', (ws) => mod.handleExportSocket(ws, { outDir, log: (line) => lines.push(line) }));
    await new Promise((ready) => http.listen(0, '127.0.0.1', ready));
    return {
      port: http.address().port,
      lines,
      close: () => new Promise((done) => { wss.close(); http.close(done); }),
    };
  };

  const socketTo = async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/export`);
    const queue = [];
    let waiting = null;
    const push = (m) => { queue.push(m); const w = waiting; waiting = null; w?.(); };
    ws.on('message', (d) => push(JSON.parse(d.toString('utf8'))));
    ws.on('error', (err) => push({ error: `the socket failed: ${err.message}` }));
    ws.on('close', () => push({ closed: true }));
    await new Promise((open, failed) => { ws.once('open', open); ws.once('error', failed); });
    return {
      send: (m) => ws.send(Buffer.isBuffer(m) ? m : JSON.stringify(m)),
      async next() {
        while (!queue.length) await new Promise((wake) => { waiting = wake; });
        return queue.shift();
      },
    };
  };

  const untilReady = async (sock) => {
    for (;;) {
      const m = await sock.next();
      if (m.ready) return m.ready;
      if (m.error) return { error: m.error };
      if (m.closed) return { error: 'the socket closed before the export was ready' };
    }
  };
  const settle = async (sock) => {
    const out = { acks: 0, done: null, error: null };
    for (;;) {
      const m = await sock.next();
      if (m.closed) return out;
      if (m.ack) out.acks++;
      if (m.done) out.done = m.done;
      if (m.error) out.error ??= m.error;
    }
  };

  const server = await exportServer(FFMPEG);
  const noEncoder = await exportServer(join(scratch, 'ffmpeg-that-is-not-here'));

  try {
    // (a) A good export, so there is something for the failing ones to destroy.
    const good = await socketTo(server.port);
    good.send({ begin: SHAPE });
    const ready = await untilReady(good);
    OUT = ready.output;
    SIDECAR = `${OUT}.job.json`;
    for (let n = 0; n < SHAPE.frames; n++) good.send(frameOf(n));
    good.send({ end: true });
    const first = await settle(good);
    check(!!first.done && existsSync(OUT) && existsSync(SIDECAR),
      'a good export lands its file and its record together',
      first.done
        ? `${first.done.frames} frames, ${first.done.bytes} bytes at ${OUT}`
        : `no done message: ${first.error ?? 'the socket just closed'}`);
    if (!first.done || !existsSync(OUT) || !existsSync(SIDECAR)) {
      throw new Error('the good export did not produce a file to protect');
    }

    for (const [codec, wantExt] of [['prores', 'mov'], ['pngseq', 'pngseq']]) {
      const sock = await socketTo(server.port);
      sock.send({ begin: { ...SHAPE, name: `${NAME}-${codec}`, codec } });
      const armReady = await untilReady(sock);
      if (armReady.error) {
        check(false, `${codec}: the module writes the artifact its codec table names`, armReady.error);
        continue;
      }
      for (let n = 0; n < SHAPE.frames; n++) sock.send(frameOf(n));
      sock.send({ end: true });
      const out = await settle(sock);
      const path = armReady.output;
      if (!out.done) {
        check(false, `${codec}: the module writes the artifact its codec table names`,
          `no done message: ${out.error ?? 'the socket just closed'}`);
        continue;
      }
      if (codec === 'pngseq') {
        let files = null;
        let why = '';
        try {
          files = readdirSync(path).filter((f) => f.endsWith('.png'));
        } catch (err) { why = err.code ?? err.message; }
        check(files !== null && files.length === SHAPE.frames,
          `${codec}: the module writes the artifact its codec table names`,
          files === null
            ? `${path.split('/').pop()} is not a directory: ${why}`
            : `${files.length} png frames in ${path.split('/').pop()}, wanted ${SHAPE.frames}`);
      } else {
        const p = probe(path);
        check(path.endsWith(`.${wantExt}`) && p.codec === codec,
          `${codec}: the module writes the artifact its codec table names`,
          `${path.split('/').pop()} holds ${p.codec}, wanted a .${wantExt} holding ${codec}`);
      }
    }
    const fileBefore = createHash('sha256').update(readFileSync(OUT)).digest('hex');
    const recordBefore = readFileSync(SIDECAR, 'utf8');
    // Whole bytes rather than field by field, because the claim is that the record
    // was not touched rather than that it is still plausible.
    const intact = () => (existsSync(OUT) && existsSync(SIDECAR)
      && createHash('sha256').update(readFileSync(OUT)).digest('hex') === fileBefore
      && readFileSync(SIDECAR, 'utf8') === recordBefore);
    const state = () => (existsSync(OUT)
      ? `${OUT} is ${readFileSync(OUT).length} bytes, record ${existsSync(SIDECAR) ? 'present' : 'gone'}`
      : `${OUT} is gone`);

    // (b) An export whose encoder never starts, under the same name. It has written
    // nothing, so there is nothing it may remove - and this arm runs before the one
    // below so that neither depends on the other having left the file alone.
    const stillborn = await socketTo(noEncoder.port);
    stillborn.send({ begin: SHAPE });
    await untilReady(stillborn);
    const second = await settle(stillborn);
    check(second.error !== null && intact(),
      'an export whose encoder never started removes nothing under that name',
      `${second.error ?? 'it did not fail'}; ${state()}`);

    const dying = await socketTo(server.port);
    dying.send({ begin: SHAPE });
    await untilReady(dying);
    dying.send(frameOf(0));
    let acks = 0;
    for (;;) {
      const m = await dying.next();
      if (m.ack) { acks++; break; }
      if (m.error || m.closed) break;
    }
    // A frame of the wrong length: the one thing the server refuses loudly, and the
    // shortest route to a run that dies with the encoder already running.
    dying.send(Buffer.alloc(FRAME_BYTES - 1));
    const third = await settle(dying);
    check(acks === 1 && third.error !== null && intact(),
      'and an export that dies mid-encode leaves the previous file and its record byte-identical',
      `${acks} frame acked by the encoder, then ${third.error ?? 'no error'}; ${state()}`);

    const leftovers = readdirSync(outDir).filter((f) => f.startsWith(`${NAME}.`) && (f.includes('.part.') || f.endsWith('.part')));
    check(leftovers.length === 0,
      'and neither failed run left its scratch behind',
      leftovers.length ? leftovers.join(', ') : `nothing matching ${NAME}.*.part* in exports/`);
  } finally {
    await server.close();
    await noEncoder.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('\n[8] an export is refused while the clip needs an effect this build lacks, and a suppression is per effect');

// The missing effect is staged rather than uninstalled, because there is no uninstall in this
// build: a look name whose dotted prefix is a valid effect id that nothing here has shipped.
const MISSING_A = { id: 'sparkle', version: '1.0.0' };
const MISSING_B = { id: 'drizzle', version: '2.1.0' };

/**
 * The document under test, built out of the page's own serialiser rather than typed here: a
 * hand-written project stops being what `restoreProject` accepts the moment the shape moves.
 */
const PARKED_ARM = `((opts) => {
  const k = globalThis.__kinect;
  const base = k.library.serialiseProjectBody();
  const doc = JSON.parse(JSON.stringify(base));
  for (const m of opts.missing) {
    doc.look.params[m.id + '.amount'] = 0.6;
    doc.look.params[m.id + '.size'] = 3.25;
    doc.look.params[m.id + '.hue'] = 210;
    doc.look.params[m.id + '.jitter'] = 0.125;
    doc.look.tracks[m.id + '.amount'] = [
      { t: 0, value: 0, easeOut: [[0.42, 0]], easeIn: [[0.58, 1]] },
      { t: 2, value: 0.9, easeOut: [[0.42, 0]], easeIn: [[0.58, 1]] },
    ];
    doc.look.tracks[m.id + '.hue'] = [{ t: 0.5, value: 10, easeOut: [[0.1, 0.2]], easeIn: [[0.3, 0.4]] }];
    doc.requires = [...(doc.requires ?? []), { id: m.id, version: m.version }];
  }
  return { base, doc };
})`;

const parkedRun = await onFreshPage('the missing-effect export run', async (page) => {
  const attempt = async (project, options) => page.evaluate(`(async (a) => {
    globalThis.__kinect.library.restoreProject(a.project);
    await globalThis.__kinect.timeline.settled();
    try {
      const done = await globalThis.__kinect.export.run(a.options);
      return { ok: true, output: done.output, frames: done.frames, frameHashes: done.frameHashes };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
  })(${JSON.stringify({ project: project, options: options })})`);

  const declared = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return [...new Set(k.params.names('look').filter((n) => n.includes('.')).map((n) => n.slice(0, n.indexOf('.'))))];
  })()`);
  const one = await page.evaluate(`${PARKED_ARM}(${JSON.stringify({ missing: [MISSING_A] })})`);
  const two = await page.evaluate(`${PARKED_ARM}(${JSON.stringify({ missing: [MISSING_A, MISSING_B] })})`);

  const shot = { width: STAGE.width, height: STAGE.height, fps: EXPORT_FPS, from: 0, to: 2, codec: 'lossless' };
  return {
    declared,
    complete: { ...await attempt(one.base, { ...shot, name: 'check-missing-none' }), doc: one.base },
    refused: await attempt(one.doc, { ...shot, name: 'check-missing-refused' }),
    suppressed: await attempt(one.doc, { ...shot, name: 'check-missing-suppressed', suppressEffects: [MISSING_A.id] }),
    partial: await attempt(two.doc, { ...shot, name: 'check-missing-partial', suppressEffects: [MISSING_A.id] }),
    badge: await page.evaluate(`(() => [...document.querySelectorAll('#tMissing .missingfx')]
      .map((e) => ({ effect: e.dataset.effect, text: e.querySelector('b').textContent })))()`),
    throughTheUi: await (async () => {
      await page.evaluate(`(() => {
        globalThis.__kinect.library.restoreProject(${JSON.stringify(one.doc)});
      })()`);
      await page.evaluate('globalThis.__kinect.timeline.settled()');
      await page.click('#tMissing button[data-suppress="sparkle"]');
      const pressed = await page.evaluate(
        `document.querySelector('#tMissing button[data-suppress="sparkle"]').getAttribute('aria-pressed')`,
      );
      await page.locator('#outputMenuButton').click();
      await page.locator('#menuExport').click();
      await page.fill('#tExportName', 'check-missing-ui');
      await page.locator('#tExport').click();
      await page.waitForFunction(
        `!/starting|frame /.test(document.getElementById('tExportNote').textContent)`,
        null, { timeout: 180000 },
      );
      return { pressed, note: await page.evaluate("document.getElementById('tExportNote').textContent") };
    })(),
    leak: await (async () => {
      await page.locator('#exportClose').click();
      const pressedFor = (id) => page.evaluate(
        `document.querySelector('#tMissing button[data-suppress="${id}"]')?.getAttribute('aria-pressed') ?? 'absent'`,
      );
      const restore = (doc) => page.evaluate(`(async (d) => {
        globalThis.__kinect.library.restoreProject(d);
        await globalThis.__kinect.timeline.settled();
      })(${JSON.stringify(doc)})`);
      await restore(one.base);
      await restore(one.doc);
      await page.click('#tMissing button[data-suppress="sparkle"]');
      const inA = await pressedFor('sparkle');
      await page.evaluate(`globalThis.__kinect.library.loadProject('check-missing-leak', ${JSON.stringify(two.doc)})`);
      await page.evaluate('globalThis.__kinect.timeline.settled()');
      const inB = await pressedFor('sparkle');
      const errorsBefore = pageErrors.length;
      await page.locator('#outputMenuButton').click();
      await page.locator('#menuExport').click();
      await page.fill('#tExportName', 'check-missing-leak');
      await page.locator('#tExport').click();
      await page.waitForFunction(
        `!/starting|frame /.test(document.getElementById('tExportNote').textContent)`,
        null, { timeout: 180000 },
      );
      const note = await page.evaluate("document.getElementById('tExportNote').textContent");
      await page.locator('#exportClose').click();
      const drained = [];
      for (let i = pageErrors.length - 1; i >= errorsBefore; i--) {
        if (/this clip requires .* not installed here/.test(pageErrors[i])) {
          drained.push(pageErrors.splice(i, 1)[0]);
        }
      }
      await restore(one.doc);
      if (await pressedFor('sparkle') !== 'true') {
        await page.click('#tMissing button[data-suppress="sparkle"]');
      }
      const beforeUndo = await pressedFor('sparkle');
      await restore(one.doc);
      return { inA, inB, note, drained: drained.length, beforeUndo, afterUndo: await pressedFor('sparkle') };
    })(),
  };
});

if (!parkedRun.ok) {
  check(false, 'the missing-effect run completed', parkedRun.error);
} else {
  const r = parkedRun.value;
  const clash = [MISSING_A.id, MISSING_B.id].filter((id) => r.declared.includes(id));
  check(clash.length === 0,
    'the two effects these rows are about really are absent from this build',
    `${r.declared.length} installed: ${r.declared.join(', ')}${clash.length ? ` - and ${clash.join(', ')} is among them` : ''}`);

  check(r.refused.ok === false
    && String(r.refused.error).includes(`${MISSING_A.id} ${MISSING_A.version}`),
  'a clip whose requires name a missing effect refuses to export, naming the id and the version',
  r.refused.ok ? 'the export ran' : r.refused.error);

  const said = r.badge.find((e) => e.effect === MISSING_B.id);
  check(r.badge.length === 2 && said?.text.includes(`${MISSING_B.id} ${MISSING_B.version}`),
    'and the badge names each of them with the version the document asked for',
    r.badge.map((e) => e.text).join(' | ') || 'no badge entries');

  check(r.suppressed.ok === true,
    'and with that effect suppressed the export proceeds and writes a file',
    r.suppressed.ok ? `${r.suppressed.frames} frames to ${r.suppressed.output}` : r.suppressed.error);

  if (r.suppressed.ok) {
    const record = JSON.parse(readFileSync(`${r.suppressed.output}.job.json`, 'utf8'));
    const got = record.project?.suppressed;
    check(Array.isArray(got) && got.length === 1
      && got[0].id === MISSING_A.id && got[0].version === MISSING_A.version,
    'and the deliverable\'s own document records what that render went without',
    JSON.stringify(got ?? null));
    const kept = Object.keys(record.project?.look?.params ?? {}).filter((n) => n.startsWith(`${MISSING_A.id}.`));
    check(kept.length === 4,
      'and it still carries the parked values, so the record says what was skipped rather than rewriting the clip',
      `${kept.length} parked keys in the deliverable's document: ${kept.join(', ')}`);
  }

  if (r.suppressed.ok && r.complete.ok) {
    const a = r.complete.frameHashes ?? [];
    const b = r.suppressed.frameHashes ?? [];
    const same = a.length > 0 && a.length === b.length && a.every((h, i) => h === b[i]);
    check(same, 'and what it drew is the same picture the document without those keys draws',
      `${a.filter((h, i) => h === b[i]).length}/${a.length} frames identical`);
  }

  check(r.partial.ok === false
    && String(r.partial.error).includes(`${MISSING_B.id} ${MISSING_B.version}`)
    && !String(r.partial.error).includes(`${MISSING_A.id} `),
  'suppressing one missing effect leaves the export refused for the other, and names only the other',
  r.partial.ok ? 'the export ran' : r.partial.error);

  check(r.throughTheUi?.pressed === 'true'
    && /check-missing-ui/.test(r.throughTheUi?.note ?? '')
    && !/refused|failed/.test(r.throughTheUi?.note ?? ''),
  'and a suppression pressed in the badge is the one the export button spends, driven through both controls',
  `aria-pressed ${r.throughTheUi?.pressed}, note ${JSON.stringify(r.throughTheUi?.note ?? null)}`);

  check(r.leak?.inA === 'true' && r.leak?.inB === 'false',
    'a suppression made on one document is not carried into the next document opened, even one missing the same effect',
    `pressed in A: ${r.leak?.inA}, then in B: ${r.leak?.inB}`);
  check(/sparkle/.test(r.leak?.note ?? '') && /export failed/.test(r.leak?.note ?? ''),
    'and the export the second document asks for is refused again, naming the effect nobody authorised it to go without',
    JSON.stringify(r.leak?.note ?? null));
  check(r.leak?.drained === 1,
    'and that refusal is the one console line this block adds, taken back out of the sweep by name rather than filtered out of it',
    `${r.leak?.drained} drained`);
  check(r.leak?.beforeUndo === 'true' && r.leak?.afterUndo === 'true',
    'while a restore of the same document keeps it, which is what makes the decision survive an undo',
    `before ${r.leak?.beforeUndo}, after ${r.leak?.afterUndo}`);

  check(r.complete.ok === true, 'a complete document exports with no refusal at all',
    r.complete.ok ? `${r.complete.frames} frames to ${r.complete.output}` : r.complete.error);
  if (r.complete.ok) {
    const record = JSON.parse(readFileSync(`${r.complete.output}.job.json`, 'utf8'));
    check(!Object.hasOwn(record.project ?? {}, 'suppressed'),
      'and its deliverable records no suppression, because there was nothing to suppress',
      `suppressed ${JSON.stringify(record.project?.suppressed ?? null)}`);
  }
}

console.log('\n[9] an edit is refused while a render runs, and the file is the document the record names');
// One Ctrl+Z during an export used to change the look halfway through the delivered file, and the
// job record beside it - serialised once when the sink is built - then described the look at the
// start. So the record was a lie about the file next to it and a re-render from it produced a
// different video. The window is the whole export rather than a few microtasks, so nothing here
// is timed: `exportClip` sets its flag before its first await, so the doors below are pressed in
// the same task that starts the render and the render is still running for every one of them.
{
  const GUARD = {
    width: STAGE.width, height: STAGE.height, fps: EXPORT_FPS,
    from: 0, to: EXPORT_FRAMES, name: 'check-guard', codec: 'lossless',
  };
  const guarded = await onFreshPage('the edit-during-export run', async (page) => {
    await setStage(page, STAGE);
    return page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const note = () => document.getElementById('tNote').textContent;
      // A value away from its default and committed, so the document under the render is one
      // this section put there and the undo below has somewhere to land.
      k.params.set('opacity', 0.42);
      k.keyframes.undo.commit();
      const before = JSON.stringify(k.library.serialiseProjectBody());
      const opacityBefore = k.params.get('opacity');

      // One door per rendered frame, pressed from inside the render's own progress callback.
      // That is the reported scenario - a hand landing part-way through a long render - rather
      // than a burst before the first frame, and it is still deterministic: the callback fires
      // once per frame, so door N is pressed while frame N is on the way to the encoder.
      const doors = [];
      const samples = [];
      const presses = [
        ['a look value', () => k.params.set('opacity', 0.93)],
        ['an undo', () => k.keyframes.undo.pop()],
        ['a keyframe', () => k.keyframes.toggle('opacity')],
        ['a speed change', () => k.keyframes.setSpeed(2)],
        ['a trim', () => k.editor.setClipRange(0.1, 0.4)],
        ['a project load', () => k.library.loadProject('check-guard-doc', JSON.parse(before))],
      ];
      const running = k.export.run(Object.assign(${JSON.stringify(GUARD)}, {
        onProgress: (n, total) => {
          const bar = document.getElementById('exportBar');
          samples.push({
            n,
            total,
            width: bar.firstElementChild.style.width,
            aria: bar.getAttribute('aria-valuenow'),
            chipShown: !document.getElementById('tExporting').hidden,
            chipText: document.getElementById('tExportingCount').textContent,
          });
          const door = presses[n - 1];
          if (!door) return;
          document.getElementById('tNote').textContent = '';
          let threw = null;
          try { door[1](); } catch (e) { threw = e.message; }
          // Read straight after the press rather than only at the end: a door that moved the
          // document and a later door that moved it back would leave the closing comparison
          // agreeing with itself, and the frames in between are the file.
          doors.push({
            what: door[0],
            said: note(),
            threw,
            doc: JSON.stringify(k.library.serialiseProjectBody()),
          });
        },
      }));
      const startedRunning = k.export.running();

      // Held rather than thrown: a render that a door broke is a finding this section reports,
      // and every door pressed before the break still has its row.
      let failed = null;
      let done = null;
      try { done = await running; } catch (e) { failed = e.message; }
      return {
        startedRunning,
        doors,
        samples,
        failed,
        before,
        after: JSON.stringify(k.library.serialiseProjectBody()),
        opacityBefore,
        opacityAfter: k.params.get('opacity'),
        editsDuringExport: k.export.editsDuringExport(),
        endProgress: k.export.progress(),
        barHidden: document.getElementById('exportBar').hidden,
        chipHidden: document.getElementById('tExporting').hidden,
        output: done === null ? null : done.output,
      };
    })()`);
  });

  if (!guarded.ok) {
    check(false, 'the edit-during-export run completed', guarded.error);
  } else {
    const g = guarded.value;
    check(g.startedRunning === true && g.doors.length === 6,
      'the render was running while every one of the six doors was pressed, one per frame',
      `running ${g.startedRunning}, ${g.doors.length} of 6 pressed`);
    // Kept beside the door rows rather than after them: a render a door broke is the same defect
    // arriving louder, and a section that only reported the look moving would call this a crash.
    check(g.failed === null,
      'and the render finished, so an edit reaching it does not merely change the picture but is '
      + 'refused before it can disturb the frame accounting either',
      g.failed === null ? 'completed' : g.failed.slice(0, 130));
    // Every door, one row, so a door that stops refusing is named rather than averaged away.
    for (const door of g.doors) {
      check(/an export is running/.test(door.said),
        `${door.what} is declined, and the editor says why rather than doing nothing`,
        door.said ? `"${door.said.slice(0, 90)}"` : 'the editor said nothing at all');
    }
    check(g.opacityAfter === g.opacityBefore,
      'the value a hand tried to move is where it was, so the refusal was a refusal and not a '
      + 'message beside a write that happened anyway',
      `${g.opacityBefore} before, ${g.opacityAfter} after, and 0.93 was asked for`);
    const moved = g.doors.filter((d) => d.doc !== g.before);
    check(g.doors.length === 6 && moved.length === 0,
      'and the whole document is byte-identical after every one of the six presses, which is the '
      + 'claim the rows above are each one door of',
      moved.length
        ? `${moved.length} of ${g.doors.length} left it changed: ${moved.map((d) => d.what).join(', ')}`
        : `${g.before.length} bytes, unchanged at all ${g.doors.length} presses`);
    check(g.after === g.before,
      'and it is that document again when the render ends, so nothing landed late',
      g.after === g.before ? `${g.before.length} bytes` : 'the document moved');
    // The backstop, and the row that covers the doors this section does not know about: a writer
    // reaching the document during a render increments it whether or not anything drove it here.
    check(g.editsDuringExport === 0,
      'and no edit reached the document by a door this section never pressed',
      `${g.editsDuringExport} recorded`);

    // A floor first, because every row below it is over this list and a row over an empty list
    // passes. A render this short can be sampled few times, so the floor is one rather than many.
    check(g.samples.length > 0,
      'the render was caught part-way at least once, so the rows below are about something',
      `${g.samples.length} samples, reaching frame `
      + `${Math.max(0, ...g.samples.map((x) => x.n))} of ${EXPORT_FRAMES + 1}`);
    const offBy = g.samples.filter((x) => {
      const percent = String(Math.round((x.n / x.total) * 100));
      return x.width !== `${percent}%` || x.aria !== percent;
    });
    check(g.samples.length > 0 && offBy.length === 0,
      'and the bar the dialog draws is the fraction the render reports, in its width and in what '
      + 'it tells a screen reader',
      offBy.length
        ? `${offBy.length} of ${g.samples.length} disagree, first ${JSON.stringify(offBy[0])}`
        : `${g.samples.length} samples agreeing, last ${JSON.stringify(g.samples.at(-1) ?? null)}`);
    const unseen = g.samples.filter((x) => !x.chipShown || x.chipText !== `${x.n}/${x.total}`);
    check(g.samples.length > 0 && unseen.length === 0,
      'and the application bar carries the same count all the while, so a render whose dialog is '
      + 'shut is still visible',
      unseen.length ? `${unseen.length} of ${g.samples.length} hidden or mislabelled`
        : `chip read ${g.samples.at(-1)?.chipText ?? 'nothing'} last`);
    check(g.samples.some((x) => x.total === EXPORT_FRAMES + 1),
      'and the total it counts against is the frame count that was asked for',
      `totals ${JSON.stringify([...new Set(g.samples.map((x) => x.total))])} against ${EXPORT_FRAMES + 1}`);
    check(g.endProgress === null && g.barHidden === true && g.chipHidden === true,
      'and both bars are put away when it finishes, so a finished render does not leave a full '
      + 'one standing',
      `progress ${JSON.stringify(g.endProgress)}, bar hidden ${g.barHidden}, chip hidden ${g.chipHidden}`);

    // The record beside the file. `serialiseProjectBody` reads `timeline.outputFps`, and the
    // export sets that to its own rate before the sink is built, so the one term that is allowed
    // to differ is substituted rather than excused - anything else differing is the defect.
    if (g.output === null) {
      check(false, 'the job record is the document the frames were rendered from',
        'the render did not finish, so there is no record beside a file to read');
    } else {
    const record = JSON.parse(readFileSync(`${g.output}.job.json`, 'utf8'));
    const expected = { ...JSON.parse(g.before), outputFps: GUARD.fps };
    check(JSON.stringify(record.project) === JSON.stringify(expected),
      'and the job record is the document the frames were rendered from, so a re-render from it '
      + 'produces this file rather than another one',
      JSON.stringify(record.project) === JSON.stringify(expected)
        ? `${JSON.stringify(record.project).length} bytes agreeing`
        : `record opacity ${record.project?.clips?.[0]?.params?.opacity}, document `
          + `${JSON.parse(g.before).clips?.[0]?.params?.opacity}`);
    }
  }
}

{
  const blind = ARMS.filter(([, a]) => chainOf(a) === '').map(([label]) => label);
  check(ARMS.length > 0 && blind.length === 0,
    'every arm published the chain it rendered through, so the rows comparing chains had chains',
    blind.length
      ? `${blind.length} of ${ARMS.length} arms came back with no passes: ${blind.join(', ')}`
      : `${ARMS.length} arms, each naming its passes; ${ARMS.map(([l, a]) => `${l} ${chainOf(a)}`).join(', ')}`);
}

check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));

console.log(`\n[export] ${checks - failures}/${checks} passed, ${failures} failed`);
if (MUTATE && MUTATIONS[MUTATE]?.fails) console.log(`[export] it should redden: ${MUTATIONS[MUTATE].fails}`);
process.exit(failures > 0 ? 1 : 0);
