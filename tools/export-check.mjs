// Proves the export: that the look is resolution-relative, that an exported frame
// is the frame the editor showed, that no wall clock reaches the render, and that
// the file ffmpeg produced is the one that was asked for.
//
// Six claims, separated because they fail for different reasons.
//
// **The take's intrinsics come from the take.** Cheapest, and first, because
// everything below renders geometry. The tool reads the hello out of the capture
// itself and asserts the page's uniforms carry it - and asserts they are *not* the
// boot defaults, because an assertion that only compared two numbers would pass on
// a page that had fetched nothing if the defaults happened to be right.
//
// **The look is resolution-relative, and was not.** The claim the whole step order
// exists for. The same pinned scene is rendered at a 960x600 and a 1920x1200
// drawing buffer - the document's own pair - the 2x arm is box-downsampled, and
// both are reduced again to a common coarse grid so per-pixel rasterisation
// aliasing is not mistaken for a look that moved. The control is the build at
// HEAD, served into a second page and put through the identical measurement: it
// has to differ, or an equality between two arms that both did nothing would read
// as a pass. Measured per term rather than only on the finished frame, because
// "the image is close enough" hides which term is wrong - and reverting any single
// one of them inside a cumulative table moved that table by less than its own
// sampling residual, so all three grade mutations passed until each term got a row
// of its own.
//
// **An exported frame is the frame the editor showed.** Not "looks like": the
// server hashes every frame that crosses the wire, the page hashes what its own
// seek to the same program time put on screen, and the two hashes have to be
// equal. Bit-exact rather than within a tolerance, because on this machine they
// are - a seek, a playback walk and an export at the same position produce
// byte-identical images, and asserting the weaker thing would leave room for a
// second render path that nearly agrees.
//
// **Export needs no wall clock.** The same export run twice in two separate page
// loads, compared on the hash of the raw RGBA stream the browser produced and on
// the bytes of the file. Two page loads rather than two runs in one, because a
// second run in the same page inherits module state the first left behind, and
// the claim is about the render rather than about that.
//
// **The file has the frames, the duration and the rate.** Probed by decoding
// rather than by reading the container's own header - `nb_frames` is a field the
// muxer writes and may leave empty, so counting it is trusting the command line
// one level further down. The lossless arm goes further and decodes every frame
// back to raw RGBA to compare against the hashes of what the browser sent, which
// makes orientation, channel order, frame order and frame count one assertion
// instead of four proxies.
//
// **A failed export leaves the last good one alone.** The only claim that does not
// go through a browser, because the failure path it is about lives in the server
// and a served page cannot reach it: the module is imported into a WebSocket server
// of this tool's own and driven from Node. Two ways of failing, an encoder that
// dies mid-write and one that never starts, because the code this replaced deleted
// the previous export's file on both of them.
//
//   node server/index.js --port 8080 --replay captures/sample.knct &
//   node tools/export-check.mjs --url http://localhost:8080
//   node tools/export-check.mjs --mutate pointsize-absolute   # must FAIL
//
// The fixture is the sample capture: 284 frames over 30.36s, median gap 64ms,
// mean 9.32fps. Every figure below is against that cadence rather than against a
// 30fps take nobody recorded.

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

// The shipped Blackwall look, read out of the document that ships it. Every arm below
// that used to say `setMode(4)` needs these twelve values and not just the crimson
// shading: bloom, trails, rgbSplit, scanlines and grain are the terms the grade rows
// measure, and a row that selected the reading alone would be measuring all five at
// zero while reporting on them by name. That is the dead-zone failure this file has
// already recorded three of, so the look comes from the product rather than from a
// list typed in here that could quietly stop matching it.
const BLACKWALL_LOOK = JSON.parse(
  readFileSync(new URL('../presets-builtin/blackwall.json', import.meta.url), 'utf8'),
).values;
// The editor, which `/?take=` opened until the main menu took `/`. Named once
// because the page is opened at it and the cross-build arm's markup is
// intercepted by it, and those two have to agree or the interception misses.
const EDITOR_PATH = '/edit';
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
// Not HEAD, for the same reason registry-check resolves one: the moment this step is
// committed, HEAD contains the reference scaling and the control arm would be the same
// build twice. The refusal below would catch it loudly, which is better than a silent
// pass and worse than not needing catching.
//
// Not a literal hash either, which is what this was until preparing the repository for
// release rewrote the history and every pinned SHA stopped resolving - see the longer
// note in registry-check. A marker is content, so it survives the rewrite that identity
// does not.
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
// Bare names, resolved through PATH, because an absolute Homebrew default is a macOS
// path on a project that also ships to Linux and the Pi - and `jobs-check` two files
// over has always spawned a bare `ffprobe`, so the pair disagreed about where ffmpeg
// lives while claiming to test the same pipeline. The flags stay for the case the
// default cannot serve: a second ffmpeg, or one deliberately off the path.
const FFMPEG = flag('--ffmpeg', 'ffmpeg');
const FFPROBE = flag('--ffprobe', 'ffprobe');
const SHOTS = flag('--shots');

// The editor's stage for every claim that is not about resolution, and it is the
// export's output size too - so the arm that exports and the arm that seeks are
// rendering into the same drawing buffer and no resize sits between them.
const STAGE = { width: 640, height: 400 };
// A starting guess at the timeline strip's height, and only a guess - `setStage`
// measures the real one off the page and corrects the viewport.
//
// **It used to be a constant, and that is the third time a strip-height change has
// arrived in a tool as a ten-second timeout that names nothing about the strip.** The
// bar became two rows, `--timeline-h` went 104 to 148, and this file - which never
// mentions the timeline except here - hung in `setStage` waiting for a buffer height
// the fit had made 44px shorter. `docs/instruments.md` records the same shape when
// the stage was first letterboxed and four tools found out one at a time. Measuring
// closes it: the next change to the strip is absorbed instead of discovered. It is
// deliberately not asserted against `--timeline-h` either - a tool that had to be
// edited whenever the strip grew is the copy that went stale here once already.
const TIMELINE_H_GUESS = 148;

// The document's own pair. Same 1.6 aspect, an exact 2x so the downsample is a
// clean box filter, and a 960x704 viewport at deviceScaleFactor 1 gives exactly
// the 960x600 buffer the resolution finding was measured at.
const SMALL = { width: 960, height: 600 };
const BIG = { width: 1920, height: 1200 };
// The reference height itself, at the same 1.6 aspect, for the cross-build arms.
// 1728x1080 rather than 1920x1080 because the arm it is compared against is
// 960x600, and two images of different aspect are two different framings.
const REF = { width: 1728, height: 1080 };

// The one arm that is not 1.6, and the aspect is the whole reason it is here.
// `bufferWidth / 1728` and `bufferHeight / 1080` are the same number at 1.6 - the
// same number, not merely close - so every other arm in this file is blind by
// construction to a reference taken from the width, while every size the export
// menu offers (1920x1080, 1280x720, 960x540, 3840x2160) is 16:9, where the two
// differ by 11.1%. This is the reference height itself at 16:9, so the correct k
// is exactly 1 here and a width-referenced one is 1.1111, and it divides the 8x5
// grid evenly - 240x216 tiles - so no tile straddles a pixel.
const HD = { width: 1920, height: 1080 };
// And the same question at a non-16:9 aspect, because the 16:9 arm does not cover
// the delivery the export menu also offers. 1440x1080 is 4:3, still 1080 tall so
// a height-referenced build has k=1 here too, but a width-referenced one has
// k = 1440/1728 = 0.8333. The grid divides evenly: 180x216 tiles.
const NON_169 = { width: 1440, height: 1080 };
// Asked of both builds as one drawn size, which is what makes that arm a comparison
// of two images rather than of two arithmetics: 8 reference pixels at k=1 on this
// build against 8 framebuffer pixels on a build that has no k. A multiple of the old
// build's 0.5 registry step as well as of this one's 0.1, so neither snaps it - and
// the arm reads both back rather than trusting that.
//
// The value is where it is because the probe has to stand where an 11% error is
// visible, and most of this scene's range is not that place. Splats overlap into a
// surface, so past a certain size growing every one of them by 11% only moves the
// silhouettes: measured under `scale-by-width` at this same buffer, 22px moves the
// lit fraction by 0.4% and 13.5px by 2.2%, while 8px moves it by 10.8% - the error
// itself, near enough. The floor is the point-size clamp, which bites at 5.6 here
// (the farthest drawn point is 5.6 times the nearest), and 8 draws 1.43..3.8px with
// the precondition below measuring both ends rather than assuming them.
const HD_POINT_SIZE = 8;

// Program seconds the resolution arms are rendered at, and the range the export
// claims are made over. 4.0s is inside the take and past its head, so the pre-roll
// is a computed one rather than one the start of the clip truncated.
const AT_SEC = 4;
// What `pointSize` was multiplied by when it became pixels at 1080p: the reference
// height over the 600-tall buffer the two presets were graded against.
const GRADED_HEIGHT = 600;
const POINT_SIZE_REBASE = 1080 / GRADED_HEIGHT;

// The look the cross-build arms compare, and neither value is a look choice. No
// `pointSize`: each build keeps its own preset, which is the thing being compared.
// `far` at 2.8 pulls the far cloud in until the *old* build clears the lower
// point-size clamp at a 600 buffer - at 4.0 it draws 0.80px points there, and a
// comparison partly about the clamp would say nothing about the rebase.
const REBASE_LOOK = { far: 2.8, near: 0.05 };
const EXPORT_FRAMES = 8;
const EXPORT_FPS = 30;

// The clip the resolution arms use. Neither value is a look choice. `far` at 4.0
// bounds how far the drawn cloud reaches, and `pointSize` at 12 is what lifts the
// farthest point above one pixel at the smaller of the two sizes: at Blackwall's
// own 8.1 the frame measures 0.80..2.1px at a 600 buffer, so the far cloud sits on
// the lower clamp and the comparison would be partly about the clamp. The
// precondition below measures both ends of the drawn frame and fails rather than
// assuming - it is what found the 0.80.
const RES_LOOK = { far: 4.0, near: 0.05, pointSize: 12 };

// ------------------------------------------------------------------- thresholds
//
// Measured rather than chosen, and stated per pass because the passes differ.
// Every number is a mean absolute channel difference out of 255 on the coarse
// grid, or a ratio of mean luminance between the two sizes.
//
// The residual that is left is sampling, not look: a 2x render box-downsampled is
// a better estimate of the same continuous image than the 1x render is, so the two
// cannot be bit-equal however correct the look is, and the smaller of the two sizes
// is the aliased one. Measured on this pair, on this tree, with the pointSize 12
// `RES_LOOK` below: the point pass lands at a fine mean of 1.013, a coarse mean of
// 0.459 and a luminance ratio of 0.9999. One octave up - 1920x1200 against
// 3840x2400, measured while this step was written and on the pinned Blackwall scene
// rather than on this constant - the point pass alone came to 0.137, which is the
// residual being sampling rather than look, said as a number.
//
// The two accumulating passes are looser and for a reason worth naming: the
// afterimage is `max(new, damp * old)` and the tone map is `col / (1 + col)`, and
// neither is linear, so the average of a 2x render is not the value either would
// have produced from the average. That is arithmetic rather than a look that
// drifted, and it is why the band widens as passes are added.
// How far the control has to be outside the band, as a multiple of the tolerance
// it is being held to. The control is not a second threshold - it is the *same*
// predicate, required to be false - and this is only here so a control that failed
// by a hair could not be recorded as the measurement working. HEAD lands at a
// luminance ratio of 0.749 on the point pass and 0.160 on the full look against
// tolerances of 0.02 and 0.04, so it is 12x and 21x outside.
const CONTROL_MARGIN = 5;

// ------------------------------------------------------------------- mutations
//
// Each breaks exactly one claim. Most live in `web/main.js` because that is what
// the page can be served a different copy of, and two of those - the rate and the
// flip - are about what the *file* ends up being, written as the browser lying to
// the encoder rather than as the encoder misbehaving, which exercises the same
// assertion from the only side a served page can reach.
//
// The last claim here is about the server's own failure path, which no served page
// can reach at all, so each mutation names the file it edits and the claim that
// needs a mutated server imports one instead of routing it through a browser. One
// table rather than one per target: a mutation is a piece of source text and the
// exactly-once refusal below is the whole safety property, so splitting the
// namespace would only make it possible to have two rules about it.
const MUTATIONS = {
  // **The container kept and the stream swapped.** `prores` goes on writing a `.mov`,
  // so the extension row and every path the sidecar builds are untouched, and only what
  // is inside it moves - which is the half a row asking about the filename cannot see.
  // Aimed at `server/export.js` rather than at the bundle because the codec table is the
  // thing that decides, and the browser never sees it.
  'prores-writes-h264': { file: 'server/export.js', edits: [[
    "    args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],",
    "    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'],",
  ]] },
  // The sequence stops being a sequence: `frameExt` null is what `export.js` documents as
  // the answer to "is this artifact a directory", so nulling it writes one animated file
  // at the path the row expects a directory at. `readdirSync` then throws ENOTDIR, loudly,
  // which is the direction this row is built to fail in - a PNG sequence that quietly
  // became one file is the defect the count exists to refuse.
  'pngseq-writes-one-file': { file: 'server/export.js', edits: [[
    "    ext: 'pngseq',\n    frameExt: 'png',",
    "    ext: 'pngseq',\n    frameExt: null,",
  ]] },
  // The dominant screen-space term goes back to framebuffer pixels.
  'pointsize-absolute': { file: 'web/main.js', edits: [[
    'gl_PointSize = clamp(pointSize * k / max(0.15, -mv.z), 1.0, 64.0);',
    'gl_PointSize = clamp(pointSize * (1.0 / max(0.15, -mv.z)), 1.0, 64.0);',
  ]] },
  // The additive normalisation reads the drawn size instead of the reference one,
  // so the same look sums four times too bright at twice the resolution. Only the
  // varying moves: the point size itself stays resolution-relative, which is what
  // makes this a test of the normalisation rather than of the term above.
  'vsize-framebuffer': { file: 'web/main.js', edits: [[
    'vSize = gl_PointSize / k;',
    'vSize = gl_PointSize;',
  ]] },
  // Grain and scanlines go back to being sized in framebuffer pixels.
  'grade-absolute': { file: 'web/main.js', edits: [[
    `      float k = resolution.y / 1080.0;
      vec2 ref = resolution / k;`,
    `      float k = 1.0;
      vec2 ref = resolution;`,
  ]] },
  // The bloom chain goes back to being sized against the drawing buffer, which is
  // where the design had it and where its halo's width in frame-fractions halves
  // every time the buffer doubles.
  'bloom-buffer-sized': { file: 'web/main.js', edits: [[
    `  const refWidth = (buf.x / buf.y) * 600;
  bloom.setSize(Math.max(1, refWidth / 2), 300);`,
    '  bloom.setSize(Math.max(1, buf.x / 2), Math.max(1, buf.y / 2));',
  ]] },
  // The chain is frozen, but against 1080 rather than against the height the look
  // was graded at. Resolution-independent and wrong: every output size gets the
  // same halo, 1.8x tighter than Blackwall was ever tuned for. This is the one a
  // per-size comparison cannot see, because both sizes agree about it.
  'bloom-reference-1080': { file: 'web/main.js', edits: [[
    `  const refWidth = (buf.x / buf.y) * 600;
  bloom.setSize(Math.max(1, refWidth / 2), 300);`,
    `  const refWidth = (buf.x / buf.y) * 1080;
  bloom.setSize(Math.max(1, refWidth / 2), 540);`,
  ]] },
  // Only the split reverts, so the claim cannot be carried by the other two.
  'rgbsplit-absolute': { file: 'web/main.js', edits: [[
    'vec2 off = dir * rgbSplit * texel * 8.0;',
    'vec2 off = dir * rgbSplit * (1.0 / resolution) * 8.0;',
  ]] },
  // The grain stops being quantised onto the reference grid, so four sub-pixels of
  // a 2x render draw four unrelated values and average to a quarter of the
  // variance.
  // The region's falloff width stops being metres and becomes pixels-at-1080p, which is
  // the one mistake the whole world-space family is built to avoid. It is the exact
  // shape of `grade-absolute` and `pointsize-absolute` pointed at the new terms: the
  // same slider then describes a different shape at every output size, and the two
  // region rows must say so while `noise` and the eight terms above stay clean.
  'region-in-metres': { file: 'web/main.js', edits: [[
    '  return 1.0 - smoothstep(0.0, max(1e-4, regionSoft), sd);',
    '  return 1.0 - smoothstep(0.0, max(1e-4, regionSoft * bufferHeight / 1080.0), sd);',
  ]] },
  // The lateral crop planes stop being metres in the room and become a fraction of
  // the frame - the same mistake `region-in-metres` plants one term over. Four numbers
  // that named a box a subject stood in now name a different box at every output size,
  // so the `crop` row must say so while `noise` and the two region rows stay clean.
  'crop-in-pixels': { file: 'web/main.js', edits: [[
    '  if (cropOn == 1.0 && (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT)) {',
    '  float cropScale = bufferHeight / 1080.0;\n'
    + '  if (cropOn == 1.0 && (pos.x < cropL * cropScale || pos.x > cropR * cropScale\n'
    + '   || pos.y < cropB * cropScale || pos.y > cropT * cropScale)) {',
  ]] },
  // The faint pass stops reading the chrome flag and answers to the button alone, so a
  // box left on while somebody exports puts the cut points into the file. This is the
  // whole reason the uniform is derived rather than assigned, and the edit is one term.
  'cropoutside-reaches-the-export': { file: 'web/main.js', edits: [[
    '  uniforms.cropOutside.value = chromeOn && showCropBox ? CROP_FAINT : 0;',
    '  uniforms.cropOutside.value = showCropBox ? CROP_FAINT : 0;',
  ]] },
  // Both early returns go, so a point outside the box always survives to the fragment
  // stage - invisible at `cropOutside` zero, because `vMask` multiplies its alpha to
  // nothing, and still writing depth the whole time. Alpha does not stop a splat
  // occluding: `depthWrite` is on, so the cut half of a room goes on hiding the half
  // that was kept, and the picture with the box off quietly loses geometry that is not
  // cropped at all.
  'faint-survives-at-zero': { file: 'web/main.js', edits: [
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
  'grain-continuous': { file: 'web/main.js', edits: [[
    'float n = hash(floor(vUv * ref) + fract(time) * 137.0);',
    'float n = hash(vUv * ref + fract(time) * 137.0);',
  ]] },
  // The take renders on the boot intrinsics again. The fetch stays, so the route
  // and the refusal are still exercised and only the write is gone - a mutation
  // that removed the fetch would also be testing whether a take opens at all.
  'intrinsics-defaults': { file: 'web/main.js', edits: [[
    `  uniforms.focal.value.set(hello.fx, hello.fy);
  uniforms.center.value.set(hello.cx, hello.cy);`,
    '  /* mutation: the hello is fetched and thrown away */',
  ]] },
  // A wall clock reaches the export's playhead. Sub-frame, because the point is
  // that a clock anywhere in the seam is enough - not that a large error is.
  'export-wall-clock': { file: 'web/main.js', edits: [[
    'const at = n / this.fps;',
    'const at = n / this.fps + (performance.now() % 1) * 1e-6;',
  ]] },
  // The export renders through a look of its own: a second render path that
  // nearly agrees, which is the failure the single-renderer decision exists to
  // prevent.
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
  // The reference is the drawing buffer's *width* over 1728 rather than its height
  // over 1080, and every screen-space term follows it: the point size through the
  // `bufferHeight` uniform, the grade's grid through its own.
  //
  // This is the mutation the 16:9 arm below exists for, and it is worth being
  // precise about how invisible it is without one. 1728x1080 is 1.6, so at that
  // aspect the two references are the same number - not close, the same: 1080/1728
  // is 0.625 exactly in binary, and 1920/1728 and 1200/1080 are both 10/9 rounded
  // once. Every other arm in this tool is 1.6 (960x600, 1920x1200, 1728x1080, the
  // 640x400 stage), so this mutation is bit-identical on all of them and leaves
  // every one of their assertions passing - while every size the export menu
  // offers is 16:9, where it draws 11.1% too large.
  'scale-by-width': { file: 'web/main.js', edits: [
    [
      '  uniforms.bufferHeight.value = buf.y;',
      '  uniforms.bufferHeight.value = buf.x * (1080 / 1728);',
    ],
    [
      '      float k = resolution.y / 1080.0;',
      '      float k = resolution.x / 1728.0;',
    ],
  ] },
  // The failure path reaches back to the output it did not write. This is the
  // shape that shipped: ffmpeg opens the previous good file with `-y` and `fail`
  // unlinks it, so an export that dies after a frame destroys the file the last
  // good export left there and leaves that export's job.json describing a path
  // with nothing at it.
  'export-fail-unlinks-output': { file: 'server/export.js', edits: [
    // Make every export to the same name target the same directory, so a failed
    // run is able to destroy the previous good artifact. Without this the unique
    // per-attempt directory is a fresh path and `fail` cannot reach anything but
    // its own scratch.
    [
      `    const dirName = \`\${msg.name}.\${process.pid}-\${++sequence}\`;\n    const outputDir = join(outDir, dirName);\n    const output = join(outputDir, \`\${msg.name}.\${ext}\`);\n    const frameBytes = width * height * 4;\n    const temp = join(outDir, \`\${dirName}.part\`);`,
      `    const outputDir = join(outDir, msg.name);\n    const output = join(outputDir, \`\${msg.name}.\${ext}\`);\n    const frameBytes = width * height * 4;\n    const temp = join(outDir, \`\${msg.name}.part\`);`,
    ],
    // The regression: a failed run removes the final directory rather than its own
    // scratch directory, so it deletes the previous good video and sidecar.
    [
      '    if (job) await rm(job.temp, { recursive: true, force: true }).catch(() => {});',
      '    if (job) await rm(job.outputDir, { recursive: true, force: true }).catch(() => {});',
    ],
  ] },
};

/**
 * The mutated source of whichever file the named mutation edits.
 *
 * The exactly-once refusal is the point of the function. A replacement that
 * silently matched nothing would run the unmutated build and be recorded as this
 * tool having missed a bug it was never shown - and because a mutation is a piece
 * of source text, it stops matching the moment the code it names is edited, which
 * is the only warning anyone gets that an anchor has gone stale.
 */
function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) {
    throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  }
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: ${from}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

// ------------------------------------------------------------------- playwright

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

// --------------------------------------------------------------------- reporting

let failures = 0;
let checks = 0;
const check = (ok, label, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (label, detail = '') => console.log(`  ....  ${label}${detail ? `   ${detail}` : ''}`);
const fixed = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

// ------------------------------------------------------------------- the capture
//
// Read by the tool, from the same routes the page reads, so the expectations below
// are a second reader's rather than the transport confirming its own arithmetic.

const hello = await (await fetch(`${URL_BASE}/capture/${TAKE}/hello`)).json();
const index = await (await fetch(`${URL_BASE}/capture/${TAKE}/index`)).json();
const stamps = index.frames.stampMs;
const DURATION = (stamps[stamps.length - 1] - stamps[0]) / 1000;

// What a page that fetched nothing would be rendering on - `web/main.js`'s uniform
// block. The intrinsics claim needs these, because "the page has the right numbers"
// is only evidence if the wrong numbers are different numbers.
const BOOT_DEFAULTS = { fx: 366, fy: 366, cx: 256, cy: 212 };

// --------------------------------------------------------------- in-page helpers
//
// Pixels never cross the wire - a 1920x1200 frame is nine megabytes and there are
// a dozen of them per run - so every reduction and comparison happens in the page
// and only the summary comes back.
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
    // assertion about the frame. Its one input that is read off the page rather than
    // modelled is kScale, below.
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
          // x negated: the mirror correction unproject in web/main.js carries the
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
      const at = (d) => (pointSize * kScale) / Math.max(0.15, d);
      return { drawn, nearest, farthest, largest: at(nearest), smallest: at(farthest) };
    },

    grab(label) {
      const gl = k.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
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

// One resolution arm: pin everything, render at wherever the buffer currently is,
// and measure the point sizes the frame actually asked for.
//
// Those sizes are the precondition rather than a curiosity. The comparison is only
// about the reference scaling where neither clamp bound is active, and whether they
// are is a property of the scene rather than of the look - the nearest and farthest
// drawn point decide it. So the arm walks the depth frame that is bound, unprojects
// it with the same intrinsics the shader uses, transforms it with the same camera,
// and reports the extremes. Bounding it algebraically off the far clip was tried and
// is wrong twice over: a point at the far clip can be half as far again off-axis, and
// the 0.15 floor in the shader is a floor rather than the nearest point.
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
  const REGION_BASE = { noise: 0, regionPush: 0, regionNoise: 0, regionMask: 0 };
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
    sizes: ex.drawnPointSizes(kScale),
    tiles: ex.tiles(label, 8, 5),
    pointRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)),
  };
}`;

// --------------------------------------------------------------------- the pages

const { chromium } = await loadPlaywright();
const mutation = MUTATE ? mutatedSource(MUTATE) : null;
// Only a page mutation is served into the browser. A server mutation leaves every
// page on the tree's own build, because the claim it breaks is one no page can see.
const mutatedBody = mutation?.file === 'web/main.js' ? mutation.body : null;
if (MUTATE) console.log(`[export] MUTATED BUILD: ${MUTATE} in ${mutation.file} - this run is expected to FAIL`);

const pageErrors = [];

/**
 * A page on the take, with its errors collected and its GPU vouched for.
 *
 * One browser per page rather than one browser with several pages, and it is not
 * tidiness. A second page in the same browser reliably loses its execution context
 * partway through an export here - two WebGL2 contexts with float render targets
 * and a 640x400 readback a frame is enough to take the renderer process down - and
 * that failure arrives as `Execution context was destroyed`, which is precisely the
 * shape this repo has already been burned by twice: a run that exits non-zero with
 * nothing having been tested. Separate browsers also make the determinism claim
 * stronger, since two exports that agree agree across two processes.
 *
 * `source` serves a different `web/main.js` into it: the mutated build, or the
 * build at HEAD for the resolution control. Anything else gets the tree's.
 */
// `html` is served alongside `source` and is only ever passed by the cross-build arm.
// The panel and the module are one pair: a build's `PARAMS` throws at boot if any
// parameter it declares has no control in the markup, so an older module served against
// today's index.html dies on the first parameter this tree has renamed - and it dies
// before `__kinect` exists, which arrives as a 30-second timeout in `openPage` rather
// than as anything naming a panel. That is exactly how the noise field's arrival was
// first reported. `registry-check` has served the pair since step 3; this is the same fix.
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
    // The predicate and the `goto` below read one constant. They used to name `/`
    // and `/index.html` while the page was opened at `/?take=`, and the editor has
    // since moved to `/edit?take=` - two places spelling the same path separately
    // is how the cross-build arm ends up loading today's markup and comparing this
    // tree against itself.
    await page.route((url) => url.pathname === EDITOR_PATH,
      (route) => { servedHtml = true; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }); });
  }
  if (source) {
    await page.route('**/main.js', (route) => route.fulfill({
      contentType: 'text/javascript; charset=utf-8', body: source,
    }));
  }
  await page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
  // The interception, enforced rather than assumed - and this is the exact
  // misdiagnosis the paragraph above records. A predicate that stops matching
  // leaves the old module against today's index.html, which throws at boot before
  // `__kinect` exists and surfaces as the 30-second timeout on the next line,
  // naming a page that never loaded rather than a URL that never matched.
  if (html && !servedHtml) {
    throw new Error(`the page markup was never intercepted - landed on ${new URL(page.url()).pathname}, `
      + 'so the cross-build arm loaded the tree\'s own page');
  }
  await page.waitForFunction(() => !!globalThis.__kinect);
  await page.waitForFunction(() => !!globalThis.__kinect.timeline.transport(), null, { timeout: 20000 });
  await page.evaluate(INSTALL);
  // **Every page frames at the stage it was opened with**, and it gets there by
  // measuring the strip rather than by believing `TIMELINE_H_GUESS`. The editor
  // letterboxes itself to the export aspect, so a viewport alone no longer decides the
  // buffer: `STAGE` is 640x400 and 1.6, the menu's default is 16:9, and without a
  // correction the fit made the buffer 640x360 while the export beside it wrote
  // 640x400. Nine of nine frames then differed, and the row that catches it is the one
  // comparing the editor's own image against what crossed the wire.
  //
  // **It used to only set the target size, and the guess was the rest of the answer.**
  // That made the constant a second copy of `--timeline-h`, and the copy went stale
  // the first time the strip grew - a row of the overview took the strip from 148 to
  // 170, the fit came out 22px short, and the same nine-of-nine mismatch came back on
  // a build with nothing wrong with it. `keyframe-check` has measured-then-corrected
  // since it was written, for exactly this reason; this is that, here.
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
  return { page, errors, gpu, close: () => browser.close() };
}

/**
 * Runs a block on a page of its own, retrying a destroyed execution context.
 *
 * That failure is Playwright and the GPU process rather than anything under test -
 * the server log shows the export it happened during completing normally, with all
 * its frames - and it has bitten this repo twice already, both times as a run that
 * exited non-zero having tested nothing. It is retried rather than absorbed: the
 * count is printed, and a block that never completes fails its claim like anything
 * else. Anything that is not that error propagates on the first attempt, because a
 * check that retried real failures would be a check that reports whichever attempt
 * it liked.
 *
 * **`Resulting promise was garbage collected` is the same failure wearing a third
 * name**, and it was added to the pattern on evidence rather than on the family
 * resemblance. Playwright says it when the execution context is disposed while an
 * evaluate's promise is still pending, which is the same renderer going away that
 * produces the other two - and the determinism section is where it lands, because
 * that is the one place three browsers render a full export back to back. Measured
 * across three consecutive runs on an otherwise unchanged tree: run 0 failed, then
 * run 1 failed and run 0 passed, then all 42 assertions passed. A failure that moves
 * between arms and then stops is not a defect in what is under test, and the row it
 * reddens - "both determinism runs completed" - is exactly the row that would have
 * caught a real one.
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
      // `promise was garbage collected` is the same failure wearing a different message:
      // a pending `page.evaluate` whose execution context went away. Seen twice in about
      // ten runs of this file, both times in section 4 and both times passing on the very
      // next run with nothing changed - which is the shape that teaches people to re-run a
      // gating check until it goes green. Retried on the same terms as its sibling, with
      // the count printed, so a genuine hang still fails rather than being absorbed.
      //
      // Both sides of this merge found it independently and wrote the same fix; the
      // pattern here is the broader of the two, since the message arrives with and
      // without its `Resulting` prefix.
      if (!/Execution context was destroyed|Target (page|closed)|crashed|promise was garbage collected/i.test(message)) {
        return { ok: false, error: message };
      }
      if (attempt >= attempts) return { ok: false, error: `${message} (${attempts} attempts)` };
    } finally {
      await held.close();
    }
  }
}

/**
 * Resizes the stage and waits for the drawing buffer to actually become it.
 *
 * **The target size goes with the viewport, because the editor is letterboxed now.**
 * The stage is fitted to the aspect the export menu is set to, so what you frame is
 * what you get - which means a viewport alone no longer decides the buffer. Asking
 * for a 960x600 stage against a 16:9 target used to hang here for ten seconds
 * waiting for a height of 600 that the fit had made 540. Saying both is the honest
 * request: this tool's arms are deliberately not all one aspect, and that is the
 * whole point of them.
 */
async function setStage(page, size) {
  // The fixed furniture's real height, off the page. The strip is `--timeline-h` plus
  // a row per lane, and the Pencil shell adds its application bar above the stage. One
  // measurement is normally exact; the second pass earns its keep if a lane appeared
  // between the read and the resize, which changes the strip and therefore the stage.
  for (let attempt = 1; attempt <= 2; attempt++) {
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
    // Optional, because the cross-build arms load an older `main.js` on purpose and
    // that build has no letterbox - its buffer is the viewport, which is exactly what
    // the wait below already expects. Guarding here rather than branching at the call
    // sites keeps one function that means "put the stage at this size" on both builds.
    await page.evaluate(`globalThis.__kinect.setTargetSize?.(${JSON.stringify(`${size.width}x${size.height}`)})`);
    try {
      await page.waitForFunction(
        `(() => {
          const gl = globalThis.__kinect.renderer.getContext();
          return gl.drawingBufferWidth === ${size.width} && gl.drawingBufferHeight === ${size.height};
        })()`,
        null, { timeout: attempt === 1 ? 5000 : 10000 },
      );
      return;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

const main = await openPage(STAGE);
console.log(`[export] ${main.gpu.renderer}`);
console.log(`[export] take ${TAKE}: ${stamps.length} frames, ${DURATION.toFixed(2)}s source, `
  + `${index.hash}`);
console.log(`[export] stage ${main.gpu.buffer.join('x')}, ffmpeg ${execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' }).split('\n')[0].split(' ')[2]}`);

// ---------------------------------------------------------- 1. the intrinsics
//
// First and cheapest, and the run stops if it fails: everything below renders
// geometry, and geometry built on the wrong intrinsics is wrong in a way no later
// comparison can see - both arms of every equality here would be wrong identically
// and agree.

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
  // The falsification control for this claim. Without it the assertion above would
  // pass on a page that fetched nothing, on any sensor whose intrinsics happen to
  // be the nominal ones.
  const defaults = [BOOT_DEFAULTS.fx, BOOT_DEFAULTS.fy, BOOT_DEFAULTS.cx, BOOT_DEFAULTS.cy];
  check(
    want.some((v, i) => v !== defaults[i]),
    'and the fixture can tell the difference: its hello is not the boot defaults',
    `hello cx ${hello.cx}, cy ${hello.cy} against defaults ${BOOT_DEFAULTS.cx}, ${BOOT_DEFAULTS.cy}`,
  );
  // What the old path was actually costing, computed rather than asserted: the
  // centre offset is a pixel shift, and a pixel at the sensor's focal length is a
  // fixed angle, so the error grows with depth.
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

// ------------------------------------------------- 2. the look is resolution-relative

console.log('\n[2] the look holds at a different output size, and did not before');

// One row per term rather than one cumulative pipeline, and that is the difference
// between a check that catches things and one that does not. Measured both ways: a
// cumulative table put grain, scanlines and the split into a single "grade" row,
// and reverting any one of them moved that row by less than the row's own sampling
// residual, so all three mutations passed. Each term now has a row where its own
// answer is the only thing in it.
//
// The near camera is the same rule applied to the additive normalisation. It is
// clamped to 1 for every point beyond 0.83m, so at the default framing it is inert
// on this fixture and a mutation of it changed nothing at all - the probe has to
// stand where the term is actually doing something.
const NEAR_CAMERA = { position: [0, 0.1, -0.2], quaternion: [0, 0, 0, 1], fov: 50 };
// The four effects that make the region's eight geometry parameters mean anything. With
// all of them at zero the region is inert whatever its extents say.
//
// **These belong in `OFF` itself, and that is the whole of what makes the region rows
// safe to add.** An arm applies its look over whatever the previous arm left - nothing
// resets - and the arms walk every row at 960x600 and then every row again at 1920x1200.
// So a region row at the end of the first pass is still in force when the second pass
// starts, and the mask it left on faded the cloud through every row of the larger size.
// Measured that way: all nine pre-existing rows failed with luminance ratios of 0.52 to
// 0.86 against a 0.005 band, while the region rows themselves passed at 1.0000 - a
// result that reads exactly like the look having stopped holding across output size, and
// was entirely the tool's own state. Zeroing them here costs nothing, because zero is
// what they already default to.
const REGION_OFF = { noise: 0, regionPush: 0, regionNoise: 0, regionMask: 0 };
// The crop planes wide open, and they are in `OFF` for the reason the region's
// effects are: **an arm applies its look over whatever the previous one left.** The
// sweep runs every pipeline at the small size and then every pipeline at the big one,
// so the last row of the small pass is the state the first row of the big pass starts
// from - and the crop row is last. Measured with these four absent from `OFF`: the
// `crop` row itself passed at ratio 0.9999 while all eight rows above it failed, with
// coarse means of 3.9 to 10.7, because their big arms were rendering a cropped cloud
// against an uncropped small one. Asserted against the registry's own defaults below,
// so "wide open" cannot drift from what the sliders mean by it.
const CROP_OPEN = { left: -7, right: 7, bottom: -7, top: 7 };
const OFF = { bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, ...REGION_OFF, ...CROP_OPEN };

/**
 * The same look with the crop planes taken out, for the arms that run against the
 * pinned older build.
 *
 * That build predates these four parameters and `specOf` throws on a name it has
 * never heard of, so `params.apply` aborts **partway through the object** - and what
 * survives depends on key order. `HD_LOOK` spreads `OFF` first and sets `pointSize`
 * last, so the old arm was rendering at the wrong point size and the cross-build
 * rebase rows failed at luminance ratios of 0.9548 and 0.9528 against a 0.02 band.
 * The rows were right and the look handed to them was not.
 *
 * `registry-check` has the same idea as `GOLDEN_ABSENT`: a build is only answerable
 * for parameters it declares.
 */
const asOldBuild = (look) => {
  const out = { ...look };
  for (const name of Object.keys(CROP_OPEN)) delete out[name];
  return out;
};

// The region itself, on the subject. Everything here is metres in the sensor frame, and
// that is the claim the two rows using it exist to enforce: not one of these is a
// screen-space length, so the same numbers must draw the same shape at 600 and at 1200,
// with no `bufferHeight / 1080` anywhere in the path. `region-in-metres` is the control.
const REGION_AT_SUBJECT = {
  ...REGION_OFF,
  regionX: 0.05, regionY: 0.15, regionZ: -1.9,
  regionW: 0.4, regionH: 0.4, regionD: 0.4,
  regionRound: 0.9, regionSoft: 0.6,
};

// The look the 16:9 arm compares, and the additive switch in it is the difference
// between a comparison and a mistake. A splat's alpha is normalised against its own
// size - 116.64/vSize^2 in reference pixels here, 36/vSize^2 in framebuffer pixels
// at HEAD - so the two builds agree about that term only where the drawn size is
// the graded one, which is a 600-tall buffer and nowhere else. Measured with it on
// at 1080: 0.241 here against 0.0744 there, which lands as a 12.9% luminance ratio
// and a 28.7/255 worst tile that say nothing at all about the reference the arm is
// asking about. With additive off the alpha is a smoothstep on gl_PointCoord and
// the point size is the only screen-space term left standing, which is the term the
// mutation moves. The normalisation has its own mutation - `vsize-framebuffer` -
// and the splat pipeline above is where that one lands.
const HD_LOOK = { ...OFF, additive: false, pointSize: HD_POINT_SIZE };
const PIPELINES = [
  ['points', { look: OFF }],
  // **A smaller point than the default, and the clamp is the reason.** The shader
  // draws `clamp(pointSize * bufferHeight / 1080 / max(0.15, -mv.z), 1.0, 64.0)`, and
  // this arm stands the camera inside the cloud so the splats overlap - which puts its
  // nearest points on the `0.15` floor, where the size is `pointSize * k / 0.15`. At
  // the default that is 88.9px at 1200, over the ceiling, and the precondition below
  // correctly refuses to compare two output sizes through a clamped tail. Seven keeps
  // both arms inside the band by arithmetic rather than by luck: 51.9px at 1200 and
  // 25.9px at 600 at the near end, and the far end stays over a pixel for anything
  // inside the 6m clip. Additive blending is what this arm is about and a smaller
  // point blends the same way.
  ['splat', { look: { ...OFF, additive: true, pointSize: 7 }, camera: NEAR_CAMERA }],
  ['trails', { look: { ...OFF, trails: 0.5 } }],
  ['rgbsplit', { look: { ...OFF, rgbSplit: 1.6 } }],
  // Both at full rather than at the preset's 0.35 and 0.22. At preset strength the
  // grain is about one part in 255 and reverting it to framebuffer pixels moved
  // every number here by 4%, which is a probe standing where the answer is the
  // same either way. At full strength the same revert is unmissable.
  ['scanlines', { look: { ...OFF, scanlines: 1 } }],
  ['grain', { look: { ...OFF, grain: 1 } }],
  // Bloom was the one term the design said needed nothing, on the grounds that it
  // already runs at half the drawing buffer. Half the buffer makes its cost
  // proportional and its appearance anything but - a fixed tap count per mip
  // against a mip chain that scales - so it is sized against the reference now
  // like everything else, and it is asserted here like everything else.
  ['bloom', { look: { ...OFF, bloom: 0.5 } }],
  // Blackwall entire, and Blackwall with the one term the document is wrong about
  // switched off. The second is the row the claim is asserted on, because the first
  // cannot pass while bloom is what it is - and a tolerance loose enough to admit
  // bloom would admit everything else too.
  ['nobloom', { look: { bloom: 0 } }],
  ['full', { look: {} }],
  // The world-space terms, last on purpose. An arm applies its look over whatever the
  // previous one left - the Blackwall look goes on and nothing resets the rest - so a
  // region row placed higher up would leak its geometry into every row below it and
  // move calibrations that were measured without it. At the end it can only inherit,
  // and each of these names every term it depends on rather than relying on that.
  //
  // One row per term, because a cumulative row cannot say which one broke: step 6
  // found three grade mutations surviving a combined comparison by less than its own
  // sampling residual. `noise` is the field, `regionpush` the displacement and
  // `regionmask` the fade, and the two region rows share the falloff that
  // `region-in-metres` attacks.
  //
  // The region is placed where the points are rather than anywhere convenient: the
  // sample capture's cloud runs z [-4.50, -0.50] with its median point at
  // (0.021, 0.019, -1.893), so this sits on the subject with its surface passing
  // through the cloud instead of enclosing it or missing it.
  ['noise', { look: { ...OFF, ...REGION_OFF, noise: 0.06, noiseScale: 4, noiseSpeed: 0 } }],
  ['regionpush', { look: { ...OFF, ...REGION_AT_SUBJECT, regionPush: 0.35 } }],
  ['regionmask', { look: { ...OFF, ...REGION_AT_SUBJECT, regionMask: 0.5 } }],
  // The four lateral crop faces, and they belong in this family for the same reason
  // the region does: they are metres in the sensor frame, so the same four numbers
  // have to cut the same box out of the room at 600 and at 1200. `crop-in-pixels` is
  // the control.
  //
  // The box is placed around the subject rather than at a convenient number - the
  // cloud runs x [-2.31, 2.97] and y [-2.26, 1.63] with its median at (0.021, 0.019),
  // so +/-0.8 sits inside the extent on all four sides and each face has something to
  // cull. A box enclosing the whole cloud would leave this row measuring an uncropped
  // image at two sizes, which is the `points` row again under a different name.
  ['crop', { look: { ...OFF, ...REGION_OFF, left: -0.8, right: 0.8, bottom: -0.8, top: 0.8 } }],
];

// Which measurement each row is judged on, and it is per row because the terms live
// at different spatial frequencies. Grain and scanlines are one-reference-pixel and
// one-in-2.7-pixel structures, and the coarse grid averages both of them away - so
// they are judged on the full-resolution comparison, where reverting them moves the
// number by 5x and 3x. Everything else is judged coarse, where per-pixel
// rasterisation aliasing is not mistaken for a look that moved.
// Each mean is about twice what this build measures - 0.459 against 1.0 on the
// point row, 1.043 against 2.6 on the full one - and the ratios are not, which is
// what the number that used to sit here got wrong by about 5x. Measured on this
// tree: seven of the nine rows depart from a ratio of 1 by 0.0009 or less against a
// 0.005 band, and the two bloom-bearing rows depart by 0.0035 and 0.0046, which is
// 70% and 92% of a band that size. A regression detector with 8% of its range left
// is one GPU driver away from being a coin toss, so those two rows carry 0.01
// instead - and the widening is one the mutations pay for rather than a shrug.
// `bloom-buffer-sized` puts those rows at departures of 0.0648 and 0.0807, which is
// 6.5x and 8.1x the wider band, and it fails their coarse means as well at 10.629
// and 13.955 against 1.6 and 2.6. `bloom-reference-1080` departs by 0.0018 and
// 0.0024 and is not caught on these rows at either band, which is not a gap: a
// per-size comparison cannot see a chain that is wrong by a constant factor because
// both sizes agree about it, and the two cross-build rows further down are what
// catch it. Wider bands on the other seven were tried first and are what let three
// of the mutations through, so those stay as tight as the sampling residual allows
// rather than as wide as the result permits.
//
// What the widening cost, since a threshold change that only reports what it bought
// is half a measurement. Two mutations lose an assertion to it, and both lose the
// same one: `grade-absolute` and `rgbsplit-absolute` used to fail the `full` row on
// its ratio at departures of 0.0080 and 0.0079, which cleared 0.005 and sit inside
// 0.01. Neither escapes - they still fail four and two other rows respectively,
// including the per-term row that names what actually broke - so what was lost is a
// duplicate verdict from the cumulative row rather than a catch. It was also a thin
// one: against a clean residual of 0.0046 on that row, a departure of 0.0080 is 1.7x
// the noise, which is the kind of margin this file refuses to call a detection when
// it finds one anywhere else. The per-term rows are load-bearing here and `full` is
// the integration row, which is the same conclusion the cumulative-table rule in
// `docs/instruments.md` reached from the other direction.
//
// One bound this table does not cover, named here rather than left to be found:
// both arms are 600 and 1200 and the export menu goes to 2160. Bloom's bright pass
// reads the full-resolution frame into a chain frozen at 600 with one bilinear tap
// per destination texel, so it point-samples a 2:1 region of the frame at 600, 4:1
// at 1200 and 7.2:1 at 2160 - the undersampling grows with the output size while
// the chain does not, and only the first two of those are measured. A 4K export
// inherits the constancy claim by extrapolation, and closing that wants an arm at
// 3840x2160 against 1920x1080 rather than an argument.
const RES_TOLERANCE = {
  points: { on: 'coarse', mean: 1.0, ratio: 0.005 },
  splat: { on: 'coarse', mean: 1.2, ratio: 0.005 },
  trails: { on: 'coarse', mean: 1.6, ratio: 0.005 },
  rgbsplit: { on: 'coarse', mean: 2.2, ratio: 0.005 },
  // These two are judged on the correlation rather than on a difference, and the
  // difference is kept only as a second signal. Reverting the reference grid moves
  // the scanline row's mean by 33% and the grain row's by 20% - both inside any
  // tolerance the sampling residual leaves room for - while moving the correlation
  // from 0.94 to 0.77 and from 0.78 to 0.59. A structure that has moved is as
  // different from one that has not as it is from one that has thinned, which is
  // exactly what a mean absolute difference cannot tell apart.
  scanlines: { on: 'fine', mean: 4.0, ratio: 0.005, corr: 0.88 },
  grain: { on: 'fine', mean: 4.0, ratio: 0.005, corr: 0.70 },
  // The two rows the bloom residual lands in, and the only two whose ratio band is
  // wider than 0.005. It was 0.01, set between measured departures of 0.0035 and
  // 0.0046 and mutant departures of 0.0648 and 0.0807.
  //
  // **The clean end of that pair is a property of the room, not of the build, and on
  // this tree it is three times what it was.** Bloom's chain is frozen at the 600-tall
  // buffer the look was graded on while everything else is expressed against 1080p -
  // CLAUDE.md's "both are correct and do not reconcile them" - so the halo really is
  // tighter at 1200 than at 600, and how much luminance that costs depends on how much
  // of the frame is bright enough to bloom. Measured here: 0.0108 and 0.0114 clean
  // against 0.679 and 0.836 under `pointsize-absolute`, both arms, one run each at
  // 960x600 against 1920x1200. So the band is 0.03, which the clean numbers sit at 38%
  // of and the mutant numbers clear by twenty-three times. Widening it is not the same
  // as admitting bloom: `nobloom` still carries the constancy claim at 0.005, which is
  // why the two rows exist separately.
  bloom: { on: 'coarse', mean: 1.6, ratio: 0.03 },
  nobloom: { on: 'coarse', mean: 2.4, ratio: 0.005 },
  full: { on: 'coarse', mean: 2.6, ratio: 0.03 },
  // The three world-space rows. Every band here sits between a measured clean number
  // and a measured mutant one rather than being chosen to fit.
  //
  // Clean, coarse mean and luminance ratio: noise 0.319/1.0002, regionpush 0.489/1.0001,
  // regionmask 0.388/1.0000. Those ratios are the tightest in the table by an order of
  // magnitude, and they should be - not one of these terms is a screen-space length, so
  // there is nothing for the output size to scale. The nine rows above sit at 0.9991 to
  // 1.0046 because a rasterised sprite grid does not resample perfectly; these three
  // move the *world*, which is the same world at either size.
  //
  // Under `region-in-metres`: regionpush 1.865/1.0028 and regionmask 0.510/0.9915, while
  // noise stays at 0.319/1.0002 to the last digit because the noise field never touches
  // the falloff. So the mutation names the two rows that share the term rather than
  // reddening the file, which is the whole reason these are three rows and not one.
  //
  // Which measurement carries each row differs, and it is worth saying which. The push
  // row is caught on the mean - 0.489 clean against 1.865 mutant, with the band at 1.0
  // roughly twice the one and half the other. The mask row is caught on the ratio, at a
  // departure of 0.0085 against a clean residual of 0.0002, which is 40x the noise; its
  // mean barely moves (0.388 to 0.510), so the 0.9 band is deliberately loose rather
  // than squeezed onto a difference that is not the signal.
  noise: { on: 'coarse', mean: 0.8, ratio: 0.005 },
  regionpush: { on: 'coarse', mean: 1.0, ratio: 0.005 },
  regionmask: { on: 'coarse', mean: 0.9, ratio: 0.005 },
  // The crop is a cull rather than a shade, so the two sizes either keep the same
  // points or they do not - there is no partial term to average away and no soft edge
  // to alias. It gets the same band as its neighbours rather than a looser one,
  // because a row whose signal is a hard yes or no should not be the row with room in
  // it, and `crop-in-pixels` has to clear that band by a wide margin to count.
  crop: { on: 'coarse', mean: 0.9, ratio: 0.005 },
};

// One arm at whatever size the page is currently at, with the intrinsics pinned so
// the hello fetch - which landed in the same commit as the resolution work - is not
// part of any difference measured here.
async function armAt(page, opts) {
  await page.evaluate(
    `globalThis.__ex.pinIntrinsics(${[hello.fx, hello.fy, hello.cx, hello.cy].join(', ')})`,
  );
  return page.evaluate(`(${RES_ARM})(${JSON.stringify({ at: AT_SEC, resLook: RES_LOOK, ...opts })})`);
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
  // The 2x arm is box-downsampled to the 1x arm's size, and then both are reduced
  // again to a common coarse grid. The second reduction is what stops per-pixel
  // rasterisation aliasing - which is a sampling difference and not a look one -
  // from being counted as the look having moved.
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

// `CROP_OPEN` says what "no crop" is, and the registry is what decides it. Held
// against each other rather than trusted, because the two only agree today: raise
// `CROP_LIMIT` in `web/main.js` and this table would go on resetting the planes to
// seven while the sliders opened to more, which would leave every row here rendering
// a quietly cropped cloud and calling it the baseline.
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

// The sweep ends on the crop row, and an arm applies its look over whatever the
// previous one left - so every arm below this that passes `look: {}` would go on
// rendering a cloud cropped to +/-0.8m. Measured with this line absent: the two
// cross-build rebase rows failed at luminance ratios of 0.9548 and 0.9528 against a
// 0.02 band, with the numbers unchanged whichever old-build arm was corrected, which
// is what said the leak was on this side rather than that one.
//
// Put back here rather than named in each arm below, because "the sweep leaves the
// page as it found it" is one statement where the alternative is a list that has to
// stay complete as arms are added.
await main.page.evaluate(`globalThis.__kinect.params.apply(${JSON.stringify(CROP_OPEN)})`);

// The other half of the drop-unknown rule in `RES_ARM`. Filtering a look to what the
// page declares is only safe on the cross-build arm; on this build every name in every
// row must land, or a row is silently measuring a term it never set - which is the
// difference between a look holding across output sizes and a look that was never
// applied. Reported here so the permission to drop cannot spread past the one arm
// that needs it.
{
  const leaked = Object.entries(after).flatMap(([name, arms]) => Object.entries(arms)
    .flatMap(([size, arm]) => (arm?.dropped ?? []).map((p) => `${name}@${size}:${p}`)));
  check(leaked.length === 0,
    'every parameter every row asks for exists on this build', leaked.join(' '));
}

// This build's whole look at two sizes, against the graded look at 600 below.
//
// **Nothing is resampled, and that is the method rather than a shortcut.** The
// comparison is on the mean luminance of each cell of an 8x5 grid, and a tile mean
// is a frame-fraction: the grid lands on the same fractions of the frame at any
// size, so the tile mean of a 1920x1200 render *is* the tile mean of its 2:1
// downsample, exactly, with no filter in between. Every size here divides the grid
// evenly - 960x600 gives 120x120 tiles, 1920x1200 gives 240x240, 1728x1080 gives
// 216x216 - so no tile straddles a pixel either.
//
// Two sizes rather than one, and mutation testing says keep both. 1728x1080 is the
// reference height itself, which is what the rebase claims in so many words, and it
// is the arm whose label needs no explaining. 1920x1200 is twice the graded height,
// so the point sizes come out at exactly 2x the old build's and a reader can check
// the arithmetic in the printed range.
//
// **The reference arm is blind to the reference scaling, which is why the other one
// is here.** At 1728x1080 the scale factor is exactly 1, so `pointsize-absolute` -
// which deletes that factor - changes nothing at all there and the arm passes. It is
// caught at 1920x1200. Each arm sees something the other cannot: the 1080 one
// isolates whether the chain is frozen in the right place, the 1200 one whether the
// scaling exists. Dropping either would leave a mutation uncaught, and this was found
// by running one rather than by reading the code.
const rebaseFullBig = await armAt(main.page, {
  label: 'rebase-full-big', look: {}, resLook: REBASE_LOOK,
});
await setStage(main.page, REF);
const rebaseFullRef = await armAt(main.page, {
  label: 'rebase-full-ref', look: {}, resLook: REBASE_LOOK,
});

// The precondition, measured rather than argued: with a clamp active the comparison
// would be about the clamp instead of about the reference scaling, and the smaller
// of the two sizes is where the lower bound bites.
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

// The control: the same measurement on the build at HEAD, which has to fail it,
// and the one arm that compares the two builds against each other rather than each
// against itself.
let rebaseOld = null;
let rebaseFullOld = null;
let rebaseHdOld = null;
let rebaseNon169Old = null;
{
  let src = execFileSync('git', ['-C', REPO, 'show', `${BEFORE}:web/main.js`], { encoding: 'utf8', maxBuffer: 1e9 });
  if (src.includes('bufferHeight / 1080.0')) {
    throw new Error(`${BEFORE} already has the resolution work: the control would be the same build twice`);
  }
  // The pinned build is the old *point size*, not the old geometry. The unprojection's x
  // sign changed after this rev - the sensor's frames arrive horizontally mirrored and this
  // build undoes them, `unproject` in `web/main.js` carries the reasoning - so left alone
  // the old arm draws the room reflected and the cross-build rows below disagree for two
  // reasons at once. They were already failing at this rev for the first reason, which is a
  // separate finding recorded in `docs/instruments.md`; the point of normalising here is
  // that whoever diagnoses them is not also chasing a mirror. Measured: with this in place
  // the worst of forty tile means on the Blackwall arms returns to the 1.02/0.95 it reads
  // at HEAD, from the 22.19/22.14 an un-normalised arm reports.
  //
  // Guarded exactly once, like `registry-check`'s copy of this and like the mutations: a rev
  // where the text stopped matching would silently become a comparison against un-normalised
  // geometry, reported as a finding about point size.
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

  // The re-tune, measured across the two builds rather than argued from the factor.
  //
  // `pointSize` is pixels at 1080p now and was pixels at the buffer before, so the
  // two builds are asked for the same *drawn* size at one buffer: 12 on the old
  // build, and 12 x 1080/600 on this one, which is 21.6 reference pixels drawn at
  // a 600-tall buffer as 12. If the rebase is right the two images are the same
  // image, and both the sprite size and the additive normalisation say so - the
  // alpha term is clamp(0.25 d^2, 0.05, 1) on both sides once 36 becomes 116.64,
  // which is the unique constant that leaves it unchanged under a 1.8x rebase.
  //
  // Points only, because the grade and bloom legitimately changed at 600: their
  // terms are 1080p-referred now, which is the whole point, and including them
  // would be asking the re-tune to answer for something else.
  await setStage(before.page, SMALL);
  rebaseOld = await armAt(before.page, {
    label: 'rebase-old', look: asOldBuild({ ...OFF, pointSize: RES_LOOK.pointSize }),
  });
  // And the same question asked of the whole look rather than of the point pass.
  // The points-only arm above cannot see the grade or the bloom - deliberately,
  // because both are 1080p-referred now and would confound the point size - which
  // means it also cannot see a bloom rebased against the wrong reference. This one
  // can: the graded look at the buffer it was graded at, against this build's look
  // at twice that, which is where the whole rebase either holds or does not.
  rebaseFullOld = await armAt(before.page, {
    label: 'rebase-full-old', look: {}, resLook: REBASE_LOOK,
  });
  // The other half of the 16:9 arm, and the reason it is taken here rather than
  // computed: this build has no reference of any kind, so 22 is 22 drawn pixels at
  // 1920x1080 whatever anyone believes about aspects. Anything the two builds
  // disagree about at that buffer is this tree's reference reading the wrong
  // dimension of it.
  await setStage(before.page, HD);
  rebaseHdOld = await armAt(before.page, {
    label: 'rebase-hd-old', look: asOldBuild(HD_LOOK),
  });
  // And the same cross-build at a non-16:9 aspect, so the 16:9 arm is not the only
  // aspect the product ships in. The old build is still the no-reference control;
  // here a height-referenced build has k=1 because the height is 1080, but a
  // width-referenced one has k = 1440/1728 = 0.8333.
  await setStage(before.page, NON_169);
  rebaseNon169Old = await armAt(before.page, {
    label: 'rebase-non169-old', look: asOldBuild(HD_LOOK),
  });
  await before.close();
  for (const name of ['points', 'nobloom']) {
    const m = measured.get(name);
    note(`${BEFORE} ${name.padEnd(8)} ${fixed(m.fine.mean).padStart(9)} ${fixed(m.coarse.mean).padStart(13)} ${fixed(m.ratio, 4).padStart(11)} ${fixed(m.texture, 4).padStart(9)}`);
  }
  // The control is the same predicate rather than a second threshold, required to
  // be false and required to be a long way from true - a control that failed by a
  // hair would say the measurement is noisy rather than that it works.
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

// The whole look across the two builds, at both of this build's sizes. Every label
// here names the buffers the arm actually rendered into, because a row that claims
// 1080p while measuring 1200 is a label claiming coverage the instrument does not
// have - which is the shape of the JSON.stringify case this repo already has a rule
// about.
for (const [label, arm] of [['1728x1080', rebaseFullRef], ['1920x1200', rebaseFullBig]]) {
  // The clamp precondition again, on both cross-build arms, because the old build
  // draws its own preset's point size rather than the sweep's.
  const clear = [rebaseFullOld, arm].every((a) => a.sizes.smallest >= 1 && a.sizes.largest <= 64);
  const ends = `old at 960x600 ${rebaseFullOld.sizes.smallest.toFixed(2)}..`
    + `${rebaseFullOld.sizes.largest.toFixed(1)}px, new at ${label} `
    + `${arm.sizes.smallest.toFixed(2)}..${arm.sizes.largest.toFixed(1)}px`;
  const worstFull = Math.max(...arm.tiles.map((v, i) => Math.abs(v - rebaseFullOld.tiles[i])));
  const ratioFull = arm.lum.mean / rebaseFullOld.lum.mean;
  check(clear && Math.abs(ratioFull - 1) <= 0.02 && worstFull <= 2.0,
    `and the whole look rebases, not just the points: Blackwall at ${label} is Blackwall at 960x600`,
    `${ends}; luminance ratio ${fixed(ratioFull, 5)}, worst of 40 tile means ${fixed(worstFull)}/255`);
}

{
  await setStage(main.page, SMALL);
  const newLook = await armAt(main.page, {
    label: 'rebase-new', look: { ...OFF, pointSize: RES_LOOK.pointSize * POINT_SIZE_REBASE },
  });
  const worst = Math.max(...newLook.tiles.map((v, i) => Math.abs(v - rebaseOld.tiles[i])));
  const ratio = newLook.lum.mean / rebaseOld.lum.mean;
  // Read back off each page rather than taken from the constants above. Two arms
  // that agree perfectly are evidence only if they were two arms: without this an
  // equality between one image and itself would read exactly like a rebase that
  // works, and it would keep reading that way forever.
  const twoBuilds = rebaseOld.kScale === 1 && newLook.kScale === SMALL.height / 1080
    && rebaseOld.pointSize === RES_LOOK.pointSize
    && newLook.pointSize === RES_LOOK.pointSize * POINT_SIZE_REBASE;
  check(twoBuilds && Math.abs(ratio - 1) <= 0.01 && worst <= 1.0,
    `the 1080p-referred preset is the old preset, both drawn at 960x600: same size, same image`,
    `pointSize ${rebaseOld.pointSize} with no reference at ${BEFORE} against ${newLook.pointSize} `
    + `at k=${fixed(newLook.kScale, 4)} here: luminance ratio ${fixed(ratio, 5)}, `
    + `worst of 40 tile means ${fixed(worst)}/255`);
}

// And the same question at 16:9, which is the only arm here that can answer it.
//
// Every other comparison in this section is at aspect 1.6, and at 1.6 a reference
// taken from the drawing buffer's width over 1728 and one taken from its height
// over 1080 are the same number - so all of them pass on a build that references
// the width, and all of them would keep passing. Every size the export menu offers
// is 16:9, where the two differ by 11.1%, so the region this tool could not see was
// exactly the region the product ships in. `scale-by-width` is the mutation that
// says so: it fails this row and leaves every other assertion in this file passing.
//
// The shape is the one above, because it is the tightest one available: one buffer,
// one drawn point size, two builds. Nothing is resampled and nothing is reframed -
// the two arms render the same scene into the same 1920x1080 buffer - so what is
// left is whether this build's k is 1 there, which is what "pixels at 1080p" means.
// Like the 1728x1080 arm it is blind to `pointsize-absolute`, since k is 1 here and
// deleting it changes nothing: the 1920x1200 arm is what catches that, and dropping
// either of them would leave a mutation uncaught.
//
// The obvious way to do this does not work, and it is worth saying so because it is
// the first thing anyone reaches for. Adding a 16:9 *pair* to the sweep above - two
// sizes of one aspect, compared with each other the way 960x600 and 1920x1200 are -
// reproduces the blindness in a new aspect rather than removing it. Under
// `scale-by-width` a 960x540 and a 1920x1080 arm still differ by exactly 2, because
// so do their widths, and the same holds for any reference linear in the buffer.
// Self-consistency between two sizes of one aspect cannot see which length the
// reference was taken from; only its *ratio* enters, and every candidate reference
// gives the same ratio. What breaks the symmetry is a build that has no reference at
// all, which is why this arm is cross-build at one buffer and why it costs a second
// browser rather than a second render.
{
  await setStage(main.page, HD);
  const hdNew = await armAt(main.page, {
    label: 'rebase-hd-new', look: HD_LOOK,
  });
  const worst = Math.max(...hdNew.tiles.map((v, i) => Math.abs(v - rebaseHdOld.tiles[i])));
  const ratio = hdNew.lum.mean / rebaseHdOld.lum.mean;
  // How much of the frame is lit at all, which is the term that actually answers
  // this. Point size is a coverage term before it is a brightness one: mean
  // luminance is carried by the bright cores, which saturate and barely move, while
  // the lit fraction is the splats' own footprint. Measured under the mutation at
  // this buffer and this size, the lit fraction moves 10.8% - the size error itself
  // - where the mean moves 2.1% and the worst tile 0.934/255, which would sit inside
  // the band its sibling arm uses. Judging this row on the mean would have been a
  // row that reported the right thing about the wrong number.
  const litRatio = hdNew.lum.litPct / rebaseHdOld.lum.litPct;
  // Both registries have to have taken the size they were asked for - the old
  // build's step is 0.5 and this one's 0.1 - or this is a comparison about a snap.
  const asked = hdNew.pointSize === HD_POINT_SIZE && rebaseHdOld.pointSize === HD_POINT_SIZE;
  const clear = [hdNew, rebaseHdOld].every((a) => a.sizes.smallest >= 1 && a.sizes.largest <= 64);
  check(asked && clear && Math.abs(litRatio - 1) <= 0.01 && Math.abs(ratio - 1) <= 0.01 && worst <= 1.0,
    'and it holds at 16:9, where a width reference and a height reference are different numbers',
    `the page's own reference is ${fixed(hdNew.refHeight, 1)} at a ${hdNew.size.w}x${hdNew.size.h} `
    + `buffer, where a width-referenced build reads 1200; pointSize ${hdNew.pointSize} at `
    + `k=${fixed(hdNew.kScale, 4)} against ${rebaseHdOld.pointSize} with no reference at ${BEFORE}, `
    + `drawn ${hdNew.sizes.smallest.toFixed(2)}..${hdNew.sizes.largest.toFixed(1)}px; `
    + `lit ${fixed(hdNew.lum.litPct, 4)}% against ${fixed(rebaseHdOld.lum.litPct, 4)}% is a ratio of `
    + `${fixed(litRatio, 5)}, luminance ratio ${fixed(ratio, 5)}, `
    + `worst of 40 tile means ${fixed(worst)}/255`);
}

// The same cross-build question at 4:3. The 16:9 arm is not enough on its own:
// a width reference is wrong there by 11.1%, but at 4:3 with the same 1080 height it
// is wrong by 16.7% in the other direction - and, more importantly, the export menu
// also ships non-16:9 sizes. The grid is 180x216 tiles, so it still divides evenly.
{
  await setStage(main.page, NON_169);
  const non169New = await armAt(main.page, {
    label: 'rebase-non169-new', look: HD_LOOK,
  });
  const worst = Math.max(...non169New.tiles.map((v, i) => Math.abs(v - rebaseNon169Old.tiles[i])));
  const ratio = non169New.lum.mean / rebaseNon169Old.lum.mean;
  const litRatio = non169New.lum.litPct / rebaseNon169Old.lum.litPct;
  const asked = non169New.pointSize === HD_POINT_SIZE && rebaseNon169Old.pointSize === HD_POINT_SIZE;
  const clear = [non169New, rebaseNon169Old].every((a) => a.sizes.smallest >= 1 && a.sizes.largest <= 64);
  check(asked && clear && Math.abs(litRatio - 1) <= 0.01 && Math.abs(ratio - 1) <= 0.01 && worst <= 1.0,
    'and it holds at 4:3, where a width reference and a height reference are also different numbers',
    `the page's own reference is ${fixed(non169New.refHeight, 1)} at a ${non169New.size.w}x${non169New.size.h} `
    + `buffer, where a width-referenced build reads 900; pointSize ${non169New.pointSize} at `
    + `k=${fixed(non169New.kScale, 4)} against ${rebaseNon169Old.pointSize} with no reference at ${BEFORE}, `
    + `drawn ${non169New.sizes.smallest.toFixed(2)}..${non169New.sizes.largest.toFixed(1)}px; `
    + `lit ${fixed(non169New.lum.litPct, 4)}% against ${fixed(rebaseNon169Old.lum.litPct, 4)}% is a ratio of `
    + `${fixed(litRatio, 5)}, luminance ratio ${fixed(ratio, 5)}, `
    + `worst of 40 tile means ${fixed(worst)}/255`);
}

console.log('\n[3] the crop box is editing furniture and cannot reach an exported pixel');

// The box itself is drawn on a canvas of its own and could not reach `readPixels` if it
// tried. What *can* is the pass that comes with it: while the box is on screen, points
// the crop cuts draw faintly instead of vanishing, and that is a uniform on the same
// shader every exported frame goes through. A viewer setting one edit away from being in
// somebody's deliverable is the `hd-reaches-recorder` class, so it is asserted here in
// the tool that owns the exported bytes.
//
// **The mechanism under test is that the uniform is derived rather than assigned.** It
// reads the chrome flag the export already clears around its render, so the export does
// not have to know the faint pass exists. `cropoutside-reaches-the-export` cuts that
// dependency and must redden the first row.
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

  // The control, and it comes first because the row below is an equality: two identical
  // images prove nothing if the faint pass never reaches a pixel in the first place, and
  // a build whose `cropOutside` was stuck at zero would pass the export row perfectly.
  check(shown.sha !== hidden.sha,
    'the faint pass reaches the rendered image while the editor is showing the box',
    `${shown.sha.slice(0, 12)} shown against ${hidden.sha.slice(0, 12)} with the box off`);
  check(exporting.sha === hidden.sha && exporting.outside === 0,
    'and an exported frame is byte-identical with the box shown and with it hidden',
    `${exporting.sha.slice(0, 12)} mid-export against ${hidden.sha.slice(0, 12)} with the box off`);

  // **And with the box off the crop is a cull, not a fade to nothing.** A point kept
  // alive at alpha zero is invisible and still writes depth, so the half of a room the
  // crop removed goes on hiding the half it kept - which is a picture missing geometry
  // that was never cropped, in the state every exported frame is rendered in.
  //
  // **Read as "cutting the front of the room shows you the back of it"**, which needs no
  // brightness threshold tuned to a fixture and is exactly what an invisible occluder
  // cannot do. A near plane at 1.5m removes the foreground; on a build that culls, the
  // rays it was standing in front of come through and light pixels the uncropped picture
  // has nothing on. On a build that keeps it at alpha zero, the foreground goes on
  // occluding and those pixels stay dark - the picture is missing geometry the crop
  // never touched, in the state every exported frame is rendered in.
  //
  // The two rows above cannot see this because both of their arms carry the same holes.
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
  // Two thousand, sitting between two measurements rather than just under one: this
  // fixture reveals 3776 pixels through the gap the cull leaves, and 993 with
  // `faint-survives-at-zero` keeping the foreground alive to occlude. It is a ratio and
  // not a presence, because a cloud is sprites rather than a surface and rays get
  // through a stack of invisible points anyway - which is also why the lit-pixel counts
  // beside it separate the two builds by 3% and are printed rather than asserted on. A
  // near plane at 2.5m with the lateral faces wide open is what makes the ratio big
  // enough to divide: it puts the bulk of the room in front of what survives, where
  // 1.5m left too little foreground and the two builds came out 225 against 154.
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

// The main page has said everything it has to say, and it is closed here. Every
// claim below runs on a page of its own, one browser at a time: two live WebGL
// pages while an export is reading pixels back is a renderer process this machine
// will sometimes kill, and that arrives as `Execution context was destroyed`.
if (SHOTS) await main.page.screenshot({ path: join(SHOTS, `export-check${MUTATE ? `-${MUTATE}` : ''}.png`) });
await main.close();

// ------------------------------------------- 3. an exported frame is the editor's

console.log('\n[4] an exported frame is the frame the editor showed at that program time');

// Both arms in one page and at the editor's own stage, so no resize and no second
// page load sits between the two things being compared. The export's output size
// is the editor's drawing buffer for the same reason.
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
  // The control for the equality above: the frames have to differ from each other,
  // or an export of one image repeated would match an editor that also never moved.
  const distinct = new Set(got).size;
  check(distinct === got.length,
    'and the frames are not all the same image, so the equality is about position',
    `${distinct} distinct frames of ${got.length}`);
}

// ---------------------------------------------------- 4. no wall clock anywhere

console.log('\n[5] the same export twice is the same bytes');

const RERUN = {
  width: STAGE.width, height: STAGE.height, fps: EXPORT_FPS,
  from: 0, to: EXPORT_FRAMES, name: 'check-repeat', codec: 'h264',
};

// Deliberately neither the editor's stage nor its aspect: 4:3 against the stage's
// 1.6, so a file that came out at the preview's size is wrong in two ways at once.
//
// Only its container is measured, never its pixels, and that is a decision rather
// than an oversight. Bringing this export into the look comparison would need a
// lossless arm at 800x600 so the decode is an equality rather than an argument
// about codec loss, a tile reduction written a second time on the Node side because
// the existing one lives in the page, and a fourth browser on the old build to have
// anything to compare against - the graded look at 600 is the only reference this
// tool has, and 800x600 is the one 4:3 size where the two builds' bloom chains
// coincide. What that would buy is the aspect question, and the 16:9 arm in section
// 2 answers the aspect question against two page renders for the cost of two arms
// on browsers that are already open. So this stays a metadata claim, and its
// pixels are covered indirectly: the lossless arm above proves export pixels are
// the editor's at the stage size, and section 2 proves the look holds at a size and
// an aspect the editor is not.
const ODD_SIZE = {
  width: 800, height: 600, fps: EXPORT_FPS,
  from: 0, to: 3, name: 'check-size', codec: 'h264',
};

const twice = [];
for (let i = 0; i < 2; i++) {
  // A separate browser each time, and never two at once. A second run inside one
  // page would inherit whatever module state the first left behind, and the claim
  // is about the render rather than about that.
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

// ------------------------------------------------------------- 5. the file

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
    // Counted by decoding, not read off the container. `nb_frames` is a field the
    // muxer writes and may leave empty, so trusting it would move "trusting the
    // command line" one level down rather than removing it.
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

  // The strongest form the claim can take, and the only one that can catch an
  // upside-down file: decode every frame back to raw RGBA and hash it against what
  // the browser sent. ffv1 is lossless, so this is an equality rather than an
  // argument about how much codec loss is acceptable - and the vertical flip the
  // encoder applies has to come back out for the bytes to match, which is what
  // makes orientation part of the same assertion.
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

  // **The two deliverables the dialog offers that nothing here encoded.** The format
  // segments were proved as far as the document they write and no further, so `prores`
  // and `pngseq` were two buttons whose whole journey past `setExportCodec` was
  // untested - and they are the two entries in `CODECS` that differ from `h264` in the
  // things that break: one changes the container, the other stops the artifact being a
  // file at all.
  //
  // They are asserted differently on purpose. A ProRes deliverable is a `.mov` and the
  // question is what stream is inside it, so `probe` answers. A PNG sequence is a
  // **directory** - `server/export.js` says so in as many words, and `frameExt` is the
  // field that decides it - so probing it as a file is not a weaker version of the same
  // row, it is a row that cannot run. Counting what landed in the directory is the only
  // form the claim has here, and the per-frame size still has to come from ffprobe
  // because a file that exists is not a picture of the right shape.
  const movRun = await onFreshPage('the ProRes deliverable', async (page) =>
    page.evaluate(`globalThis.__kinect.export.run(${JSON.stringify({ ...LOSSLESS, name: 'check-mov', codec: 'prores' })})`));
  if (movRun.ok) {
    const p = probe(movRun.value.output);
    const wantFrames = EXPORT_FRAMES + 1;
    // The codec name as well as the extension, because a `.mov` carrying h264 is exactly
    // what a table that lost its `args` would write, and it is the shape a row asking
    // only about the container passes.
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
    // `readdirSync` on a path that is not a directory throws ENOTDIR, which is the
    // failure this row wants to be loud about rather than to catch: an artifact that
    // stopped being a directory is the defect, not a condition to handle.
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

  // Output resolution is an ordinary export setting, which is the property the
  // resolution work above exists to make true - so one export is asked for at a
  // size the editor is not, and the file is measured rather than the request
  // echoed. Every other export here runs at the editor's own buffer, where an
  // output size that never reached the renderer would look exactly like one that
  // did.
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

  // And what the job record says, since the queue that will read it does not exist
  // yet and a field nobody writes is a field nobody can retrofit.
  const record = JSON.parse(readFileSync(`${lossless.done.output}.job.json`, 'utf8'));
  check(typeof record.renderer === 'string' && record.renderer.length > 0
    && record.capture === index.hash && record.project !== null && typeof record.project === 'object',
  'the job record names its renderer class, its capture by hash and its project',
  `renderer ${JSON.stringify(record.renderer)}, capture ${String(record.capture).slice(0, 20)}…`);
}

// ------------------------------------ 6. a failed export leaves the last one alone

console.log('\n[7] a failed export leaves the previous file and its record exactly as they were');

// The one claim here that does not go through the running server, because it cannot:
// what it is about is a path inside `server/export.js`, and a page can be served a
// different `web/main.js` but nothing can serve a running server a different module.
// So this imports the module - the tree's copy, or the mutated one under `--mutate`
// - into a WebSocket server of its own on an ephemeral port and drives it from Node
// with the three messages the page sends. Both arms reach it the same way, so the
// mutation is the only difference between them, and the wiring the running server
// adds on top is what claims 3 to 5 above already exercise.
//
// The failure is an ordinary path rather than a corner. The export name defaults to
// the take's id, so every "tweak the look and export again" reuses it, and the code
// this replaced had ffmpeg open the previous good file with `-y` while `fail`
// unlinked it by name: a second export that died after one frame left no video and
// the *first* export's job.json still sitting beside it, describing a successful
// render of a path with nothing at it.
{
  const outDir = join(REPO, 'exports');
  // The same directory the running server writes into, and the name is what keeps
  // the two apart: `check-atomic` belongs to this claim and nothing else here or in
  // the server ever asks for it, so the file this claim is watching is one only
  // this claim writes.
  const NAME = 'check-atomic';
  // The actual file path is returned in the `ready` message, because the encoder
  // now writes each export into a unique directory and `done.output` is the video
  // file inside it.
  // Start with no previous `check-atomic` artifact or scratch in the way, because
  // the claim is about what this run leaves behind, not what an earlier run did.
  for (const f of readdirSync(outDir).filter((f) => f.startsWith(NAME))) {
    rmSync(join(outDir, f), { recursive: true, force: true });
  }
  let OUT = null;
  let SIDECAR = null;
  // Small and cheap: this claim is about which files exist afterwards, and a 64x48
  // frame proves that exactly as well as a 1080p one. Even dimensions because h264
  // subsamples chroma, and h264 because that is the codec the menu defaults to.
  const SHAPE = { name: NAME, width: 64, height: 48, fps: EXPORT_FPS, frames: 2, codec: 'h264' };
  const FRAME_BYTES = SHAPE.width * SHAPE.height * 4;
  const frameOf = (n) => Buffer.alloc(FRAME_BYTES, 24 + n * 96);

  const scratch = mkdtempSync(join(tmpdir(), 'export-check-'));
  const serverSource = mutation?.file === 'server/export.js'
    ? mutation.body
    : readFileSync(join(REPO, 'server/export.js'), 'utf8');
  let copies = 0;

  // One server on the module under test. A fresh copy per call rather than one
  // import: `FFMPEG` is read at module load, and the arm below that has to watch an
  // encoder fail to start needs a module whose encoder does not exist.
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

  // The page's side of the protocol, one message at a time so an arm can say "wait
  // for the ack, *then* corrupt the next frame" rather than firing everything and
  // reading the wreckage.
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
  // Everything the socket has left to say. The server closes only after `fail` has
  // finished its own cleanup - the unlink is awaited before the close - so reaching
  // the close here means the directory below is in its final state.
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
  // Encoders that do not exist are the second half of the same bug: the old `fail`
  // deleted `job.output` whether or not this run had ever written a byte of it.
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

    // **The two formats the dialog gained, asked here rather than only in section 5, and
    // the reason is delivery.** Section 5 exports through the server named by `--url`,
    // which is a process this tool did not start and cannot stage - so a mutation of
    // `server/export.js` reaches nothing there, and a control aimed at it runs the clean
    // build and reports itself caught-by-nothing at exit 0. Measured exactly that way
    // before this block existed: `prores-writes-h264` came back 45/45 passed, NOT CAUGHT,
    // with the section 5 rows green because the build under them was never mutated. That
    // is the silent-delivery failure this suite already carries two entries about.
    //
    // This section imports the module itself, `serverSource` carries the mutation, so the
    // claim about what a codec writes is asked where an edit to the codec table can be
    // seen. Section 5 keeps its rows: they are the end-to-end confirmation through the
    // real server, and this is the half that can be falsified.
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
        // A sequence is a directory, so `readdirSync` is the question and its ENOTDIR is
        // the answer when the artifact has stopped being one. Counting the frames is the
        // only form this claim has - probing the path as a file cannot run at all.
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

    // (c) An export that dies mid-encode, under the same name. The ack is the
    // precondition that makes this arm mean anything: it is sent once the frame has
    // reached ffmpeg's stdin, so an ack proves the encoder was alive and writing
    // when the run was killed, rather than the run having failed before it began.
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

    // The falsification control for the cleanup half: the failed runs each wrote a
    // scratch file, and if either had left one behind, "the output is untouched"
    // would be true of a directory that had quietly filled up with half-muxed video.
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

// --------------------------------------------------------------------- shutdown

check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));

console.log(`\n[export] ${checks - failures}/${checks} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
