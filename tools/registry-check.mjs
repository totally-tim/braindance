// Proves that one registry drives the renderer, and that the panel is a view on it.
//
// Four claims, and they fail for different reasons, so they are checked apart.
//
// A parameter has to *land*. Setting it through the registry must reach the place
// the renderer actually reads - a uniform, a pass property, a pass `enabled` flag,
// the draw range, the drawing buffer - and several parameters do more than set a
// uniform, so the side effects are checked as side effects rather than assumed to
// come along. The landing sites are written out here rather than asked of the
// page, because a registry reporting its own values back would agree with itself
// whatever it did with them.
//
// The panel has to be a *view*. Both directions: a slider event has to move the
// registry, and a registry write has to move the slider and its readout. And the
// HTML has to carry no parameter data at all - no value, min, max, step or checked
// on a registry-owned input - or the range lives in two places again and step 6's
// headless renderer reads the copy that is wrong.
//
// The values have to *round-trip through an image*. Serialise the registry, render
// a pinned run and hash it, restore from the serialised set, render again: the
// same pixels. That is the property steps 5, 6 and 7 all rest on, so it gets a
// falsification control - every parameter is left out of the restore in turn, and
// omitting one has to change the image. Without that, the equality above would
// pass just as well against a registry wired to nothing.
//
// And nothing may have *moved*. The two built-in mode presets and the boot state
// are compared against the committed page rather than against a table typed in
// here, by serving `git show <rev>:web/{index.html,main.js}` into a second load.
// A table would only restate what the new code does.
//
//   node server/index.js --port 8080 --replay captures/sample.knct &
//   node tools/registry-check.mjs --url http://localhost:8080

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MessageParser, TYPE_FRAME } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// Everything the check reads about the repo is resolved against this file rather
// than against the working directory: the panel it inspects, the capture it pins,
// and the tree `git show` reads the before-arm out of. A tool that only runs from
// one directory is a tool that gets run from the wrong one.
const REPO = fileURLToPath(new URL('..', import.meta.url));

const URL_BASE = flag('--url', 'http://localhost:8080');
// The live recorder, which `/` served until the main menu took that path. Named
// once because the page is opened at it and the before-arm's markup is
// intercepted by it, and those two have to agree or the interception misses.
const RECORDER_PATH = '/record';
const CAPTURE = flag('--capture') ?? join(REPO, 'captures/sample.knct');
// Not HEAD: once step 3 is committed, HEAD is the registry and the before-arm would
// be comparing the tree against itself. And not a literal hash either, which is what
// this was until preparing the repository for release rewrote the history - stripping
// commit trailers with `git filter-repo` moves every hash after the first rewritten
// commit, so the pinned rev named nothing and the tool died inside `git show` with
// `invalid object name` before asserting anything. That exits non-zero and reads
// exactly like a check that ran and failed.
//
// A marker is content rather than identity, so it survives a rewrite. The refusal
// below stays the control: a search that resolved to the wrong commit trips it.
const BEFORE_REV = flag('--before') ?? revBeforeMarker('const PARAMS');

function revBeforeMarker(marker) {
  const introduced = execFileSync(
    'git', ['log', '-S', marker, '--format=%H', '--reverse', '--', 'web/main.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 },
  ).split('\n')[0].trim();
  if (!introduced) {
    throw new Error(`no commit in this history introduces ${JSON.stringify(marker)} to web/main.js`);
  }
  return `${introduced}^`;
}
// ------------------------------------------------------------------ mutations
//
// This file had no mutations for its whole life, and the rewrite that put the readings
// in the registry is what made that untenable. The blend is arithmetic in a shader
// compiled by a driver, and the two claims this tool now rests on - that a single
// reading is the identity and that a mix is a ratio - are precisely the kind that pass
// by construction when the instrument is pointed slightly wrong. A check nobody has
// broken on purpose is a check nobody knows the sensitivity of.
//
// Each entry names the row it must redden, and they are chosen to redden *different*
// rows: a mutation that fails everything cannot say which claim is load-bearing, which
// is the same reason `expand-shifts-by-a-block` exists beside `bind-ignores-grid` in
// monitor-check.
const MUTATIONS = {
  // Section 1b, the readRgb row and only that row. Alpha is the asymmetric half of this
  // blend and the place a rewrite of it actually breaks: three readings multiply
  // `alpha` and two do not, so the two that do not have to contribute a factor of
  // exactly 1.0 to the accumulator rather than nothing at all. A build that forgot
  // renders RGB completely transparent while every other reading stays correct.
  //
  // **This replaced a mutation that was caught for the wrong reason**, which is worth
  // recording because it is the failure this repo keeps producing in the direction that
  // looks like coverage. `blend-drops-alpha` removed the `* norm` from the alpha line
  // and claimed the three alpha-writing rows of 1b; measured, it left the whole of 1b
  // passing and reddened 8b instead - because at a single reading `norm` is 1.0 and
  // dropping a multiplication by 1.0 is not a mutation at all. It was a second, weaker
  // spelling of `mix-ignores-normalisation`, indistinguishable from it by the rows that
  // went red, so it could not tell anybody which claim was load-bearing.
  'rgb-contributes-no-alpha': {
    from: '    alphaFactor += readRgb;',
    to: '    alphaFactor += 0.0;',
    fails: 'the readRgb row of 1b, alone - the other four readings are untouched',
  },
  // Section 1b, the readGhost row and only that row. The three alpha-writing readings
  // had their expressions moved verbatim out of the old branches, so what is at risk
  // there is transcription rather than arithmetic - and a check that compared only
  // colour would pass a build that dropped a term from one of them.
  'ghost-alpha-term-dropped': {
    from: '    alphaFactor += (0.25 + 0.75 * rim + 0.25 * lum) * readGhost;',
    to: '    alphaFactor += (0.25 + 0.75 * rim) * readGhost;',
    fails: 'the readGhost row of 1b, alone - so 1b compares alpha and not just colour',
  },
  // Section 8b: the mix stops being a ratio while every single reading stays exactly
  // right, because dividing by 1.0 is what dividing by the sum already does when one
  // weight is 1 and the rest are 0. This is the mutation section 1b cannot see and the
  // whole reason 8b exists.
  'mix-ignores-normalisation': {
    from: 'float norm = readSum > 0.0 ? 1.0 / readSum : 0.0;',
    to: 'float norm = readSum > 0.0 ? 1.0 : 0.0;',
    fails: 'the scale-cancels row of 8b, with every row of 1b still passing',
  },
  // Section 8's falsification sweep: one weight reaches no pixel. Dropping it from the
  // restore then changes nothing, so it lands in the no-effect bucket, which is a
  // failure unless the name is in the declared exceptions - and it is not.
  // Its reach widened when the readings grew constants of their own, and the record says
  // so rather than being left at the number it was caught with once: switching the ghost
  // block off takes `ghostRim` and `ghostFill` into the no-effect bucket with it, because
  // a per-reading term is only observable through the reading it belongs to. Three names
  // in that bucket rather than one is the right answer here, and a fourth would mean a
  // parameter had quietly become reachable only from ghost.
  'weight-ignored': {
    from: '  if (readGhost > 0.0) {',
    to: '  if (false) {',
    fails: 'readGhost, ghostRim and ghostFill in the drop-one sweep, plus readGhost\'s 1b row',
  },
  // The duotone's amount reaches no pixel, and it takes the hue and the split down with
  // it - the `weight-ignored` shape one block up, for the same structural reason. Both of
  // those are only observable through the block this switches off, so three names land in
  // the no-effect bucket and none of them is declared there. Three is the right answer
  // and a fourth would mean some other parameter had quietly become reachable only
  // through the duotone.
  'duotone-ignored': {
    from: '  if (duotoneDepth > 0.0) {',
    to: '  if (false) {',
    fails: 'duotoneDepth, duotoneHue and duotoneSplit in the drop-one sweep',
  },
  // The sharper half of the one above, and the reason both are kept: the duotone goes on
  // working as a flat tint, so `duotoneDepth` still moves pixels and only the split stops
  // meaning anything. That is the difference between "the term is wired up" and "the term
  // is keyed on depth", and depth is the whole claim - a duotone that is not depth-keyed
  // cannot draw the silhouette this parameter exists for, which is exactly the shape of
  // failure that ships looking like a control that works.
  'duotone-ignores-depth': {
    from: '    float k = smoothstep(duotoneSplit - 0.5, duotoneSplit + 0.5, t);',
    to: '    float k = 0.5;',
    fails: 'duotoneSplit in the drop-one sweep, alone - the amount and the hue still reach pixels',
  },
  // The unit conversion dropped, which is a defect no image comparison can see the shape
  // of: the poles still turn, the picture still changes, and every sweep row that asks
  // whether the slider reaches a pixel goes on passing. What separates the two builds is
  // the number at the uniform, so the landing row is the only thing that can fail here.
  'duotone-hue-in-degrees': {
    from: '    apply: (v) => { uniforms.duotoneHue.value = THREE.MathUtils.degToRad(v); } },',
    to: '    apply: (v) => { uniforms.duotoneHue.value = v; } },',
    fails: 'the duotoneHue row of the one-at-a-time landing sweep, reporting "landed 47 want '
      + '0.8203047484373349", and the all-at-once row beside it - that second one is the same '
      + 'comparison over the whole set rather than a separate finding',
  },
  // The toe goes back to being the literal it was promoted from. Nothing about the
  // rendered default changes - that is the point, since the default *is* the literal - so
  // the only row that can see it is the drop-one sweep, where reverting a parameter that
  // reaches nothing changes no pixel.
  'crush-ignored': {
    from: '      col = max(col - crush, 0.0) * 1.12;',
    to: '      col = max(col - 0.018, 0.0) * 1.12;',
    fails: 'crush in the drop-one sweep, alone',
  },
  // The guard around the raster's default path removed, so the general form computes what
  // the old line computed instead of reaching it. Every value stays what it was and the
  // arithmetic is algebraically the same, which is the whole difficulty: a reader deleting
  // this branch as a redundant fast path would see nothing wrong, and the shipped Blackwall
  // document would start drawing a raster a hair off the one it was graded with.
  //
  // This control is also how the guard was justified rather than assumed. Run it and read
  // the raster row: red means the general form genuinely drifts and the branch is load
  // bearing, green means it does not and the branch should come out, because a fast path
  // that is bit-identical to the slow one is the second implementation this repo refuses.
  'raster-recomputes-the-default': {
    from: '        if (scanAxis.x == 0.0 && scanAxis.y == 1.0 && scanPitch == 1.3 && scanHard == 0.0) {',
    to: '        if (false) {',
    fails: 'the raster-at-0.35 row against the pinned build, and nothing else',
  },
  // The raster's axis nailed back to the frame's y, which is what it was before the angle
  // existed. Everything else about the raster goes on working - the pitch still sets the
  // line frequency and the hardness still squares the wave - so the only row that can see
  // it is the drop-one sweep, where an angle that reaches nothing changes no pixel when it
  // is reverted. This is the vertical column grille the whole of D1 is for, so a build
  // that quietly lost it would be drawing television scanlines under a green run.
  'raster-ignores-angle': {
    from: '          float coord = dot(vUv * ref, scanAxis);',
    to: '          float coord = vUv.y * ref.y;',
    fails: 'scanAngle in the drop-one sweep, alone',
  },
  // The pitch back to the literal it was promoted from. Its default *is* that literal, so
  // nothing about the shipped picture moves - which is the point, and which leaves the
  // drop-one sweep as the only thing that can tell the two builds apart.
  'raster-pitch-fixed': {
    from: '          float wave = sin(coord * scanPitch + time * 2.0) * 0.5 + 0.5;',
    to: '          float wave = sin(coord * 1.3 + time * 2.0) * 0.5 + 0.5;',
    fails: 'scanPitch in the drop-one sweep, alone',
  },
  // The duty cycle dropped, leaving the sine the term has always drawn. This is the
  // control that separates "the raster rotates and crowds" from "the raster is a grille",
  // and a build without it draws rotated softness at every setting - which looks like a
  // raster right up until you compare it against a reference frame.
  'raster-hard-ignored': {
    from: '          line = mix(wave, smoothstep(0.5 - w, 0.5 + w, wave), scanHard);',
    to: '          line = wave;',
    fails: 'scanHard in the drop-one sweep, alone',
  },
  // The tempting edit, planted: `crush` joins the four terms that gate the grade pass, so
  // the pass runs whenever the toe is non-zero, which is always. This is deliberately not
  // a well-behaved control and the whole set has to be read rather than the count. It
  // reddens the pass-gate row it is aimed at; then it reddens all five reading rows of
  // section 1b, because every reading at its defaults is now drawn through a Reinhard
  // curve the pinned build never applied; and then the boot comparison, because all four
  // gating terms report their pass on where the pinned build has it off. Seven rows for
  // one fact, measured rather than predicted - the first draft of this line guessed the
  // boot failure would arrive as four separate landing rows and it arrives as one row
  // naming four terms in its detail, which is the sort of thing only a run settles.
  //
  // Note what reddening 1b's readGhost row means here, since that row is red in every run
  // of this tool: it goes from its own standing 2 of 6 frames to 6 of 6. A row already
  // failing is exactly where a new defect hides, so the count is not the reading - the
  // frame tally is.
  'crush-gates-the-grade': {
    from: '  return grade.uniforms.rgbSplit.value > 0',
    to: '  return grade.uniforms.crush.value > 0 || grade.uniforms.rgbSplit.value > 0',
    fails: 'the pass-gate row for crush, all five rows of 1b (readGhost widening from 2 of 6 '
      + 'frames to 6 of 6), and the boot comparison naming all four gating terms',
  },
};

const MUTATE = flag('--mutate');
if (MUTATE && !Object.hasOwn(MUTATIONS, MUTATE)) {
  throw new Error(`unknown mutation ${JSON.stringify(MUTATE)} - have ${Object.keys(MUTATIONS).join(', ')}`);
}

// A run that died is not a run that found something, and under `--mutate` the two are
// indistinguishable to anything reading the exit code: a Playwright page that dropped
// its execution context exits non-zero with nothing asserted, which reads exactly like
// a caught mutation. So a crash gets its own verdict and its own code.
//
// This is not hypothetical here. `rgb-contributes-no-alpha` and `ghost-alpha-term-dropped`
// both reddened their intended row and then died on `Target page, context or browser has
// been closed` on their first run, and both reproduced cleanly on the next - the same
// several-WebGL-pages flake `export-check` retries by name. Without this handler each of
// those would have exited non-zero having asserted the right thing for the wrong reason,
// and the two are indistinguishable from outside. Not retried here, deliberately: a
// check that retried would have to decide which failures are real, and the verdict line
// saying DID NOT RUN costs one re-run and no judgement.
process.on('unhandledRejection', (err) => {
  console.log(`\n[registry] DID NOT RUN - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(2);
});
process.on('uncaughtException', (err) => {
  console.log(`\n[registry] DID NOT RUN - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(2);
});

// The mutated module, served into every page this file opens. Refused when the anchor
// is not found exactly once, for the reason every other tool here refuses it: a
// replacement that silently matched nothing would run the unmutated page and be
// recorded as the check having missed a bug it was never shown. And a mutation is a
// piece of source text, so it stops matching the moment the code it names is edited -
// the refusal is what surfaces that rather than a silent pass.
const mutatedSource = (() => {
  if (!MUTATE) return null;
  const js = readFileSync(join(REPO, 'web/main.js'), 'utf8');
  const { from, to } = MUTATIONS[MUTATE];
  const hits = js.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(`mutation ${MUTATE} matched its anchor ${hits} times, not once: ${JSON.stringify(from)}`);
  }
  return { js: js.replace(from, to), html: readFileSync(join(REPO, 'web/index.html'), 'utf8') };
})();

const HEADED = argv.includes('--headed');
const SOURCE_FRAMES = Number(flag('--frames', '6'));
const STRIDE = Number(flag('--stride', '4'));
const SUBSTEPS = Number(flag('--substeps', '3'));

const VIEW = { width: 640, height: 400 };
// The height the current editor gives its fixed application bar, and it is **measured
// off the page rather than declared here**. Historical comparison pages have no shell,
// so their viewport is shortened by the same amount to make both arms render the same
// content box rather than two different layouts - which means this number is not a
// note about the design, it is a term in the golden comparison. Written down as a
// literal it was 32 against a `web/nav.css` that says 38, and the two rows it feeds
// reddened with `renderScale: 589 -> 579` - a difference that is entirely this drift
// (`round(640 * (400-38)/400)` is 579) and reads exactly like the buffer regression
// the golden row exists to catch. So the after arm is opened first, the bar is
// measured, and the before arm is sized against what was measured.
let APP_BAR_HEIGHT = null;
let SHELL_CONTENT = null;
let COMPARISON_VIEW = null;
const shellGeometry = (barHeight) => {
  APP_BAR_HEIGHT = barHeight;
  SHELL_CONTENT = {
    width: Math.round(VIEW.width * ((VIEW.height - barHeight) / VIEW.height)),
    height: VIEW.height - barHeight,
  };
  COMPARISON_VIEW = { width: VIEW.width, height: VIEW.height + barHeight };
};
let RENDER_BUFFER = { width: VIEW.width, height: VIEW.height };
const POINTS = 512 * 424;
// THREE.NormalBlending and THREE.AdditiveBlending, by value, because the check
// reads the material rather than the registry.
const NORMAL_BLENDING = 1;
const ADDITIVE_BLENDING = 2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (x) => JSON.stringify(x);

// Playwright is not a dependency of this project - it is a tool the proofs reach
// for - so it is resolved from wherever it happens to be installed.
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

// ------------------------------------------------------------------- fixture

// Capture frame payloads back to back, wire format unchanged apart from the colour
// block being dropped, so the page parses them with the same field offsets the
// socket path uses and the depth is real sensor depth.
function buildFixture(path) {
  const parser = new MessageParser();
  const frames = [];
  for (const msg of parser.push(readFileSync(path))) {
    if (msg.type === TYPE_FRAME) frames.push(msg.payload);
  }
  if (frames.length < SOURCE_FRAMES * STRIDE) {
    throw new Error(`${path} has ${frames.length} frames, need ${SOURCE_FRAMES * STRIDE}`);
  }
  const out = [];
  for (let i = 0; i < SOURCE_FRAMES; i++) {
    const src = frames[i * STRIDE];
    const depthBytes = src.readUInt32LE(0);
    const payload = Buffer.alloc(16 + depthBytes);
    payload.writeUInt32LE(depthBytes, 0);
    payload.writeUInt32LE(0, 4); // colour dropped: JPEG decode is asynchronous
    src.copy(payload, 8, 8, 16); // the capture timestamp, verbatim
    src.copy(payload, 16, 16, 16 + depthBytes);
    out.push(payload);
  }
  return Buffer.concat(out);
}

// ------------------------------------------------------- where each value lands
//
// Written out independently of the registry. If `apply` stopped reaching one of
// these, every other check here would still pass and this one would not.

const LANDING = {
  pointSize: 'k.uniforms.pointSize.value',
  opacity: 'k.uniforms.opacity.value',
  exposure: 'k.uniforms.exposure.value',
  additive: '[k.material.blending, k.material.depthWrite, k.uniforms.softEdge.value]',
  near: 'k.uniforms.nearClip.value',
  far: 'k.uniforms.farClip.value',
  left: 'k.uniforms.cropL.value',
  right: 'k.uniforms.cropR.value',
  bottom: 'k.uniforms.cropB.value',
  top: 'k.uniforms.cropT.value',
  crop: 'k.uniforms.cropOn.value',
  interpolate: 'k.uniforms.interpolate.value',
  snapDelta: 'k.uniforms.snapDelta.value',
  fade: '[k.uniforms.fadeTime.value, k.geometry.drawRange.count]',
  wake: '[k.uniforms.wakeTime.value, k.geometry.drawRange.count]',
  noise: 'k.uniforms.noise.value',
  noiseScale: 'k.uniforms.noiseScale.value',
  noiseSpeed: 'k.uniforms.noiseSpeed.value',
  // The centre and the half-extents are three sliders landing in one vector each, so
  // the component is named here rather than the uniform - an apply that wrote the
  // whole vector, or wrote y where x was meant, reads identically at `.value`.
  regionX: 'k.uniforms.regionCentre.value.x',
  regionY: 'k.uniforms.regionCentre.value.y',
  regionZ: 'k.uniforms.regionCentre.value.z',
  regionW: 'k.uniforms.regionHalf.value.x',
  regionH: 'k.uniforms.regionHalf.value.y',
  regionD: 'k.uniforms.regionHalf.value.z',
  regionRound: 'k.uniforms.regionRound.value',
  regionSoft: 'k.uniforms.regionSoft.value',
  regionPush: 'k.uniforms.regionPush.value',
  regionNoise: 'k.uniforms.regionNoise.value',
  regionMask: 'k.uniforms.regionMask.value',
  glitch: 'k.uniforms.glitch.value',
  glitchDensity: 'k.uniforms.glitchDensity.value',
  glitchShove: 'k.uniforms.glitchShove.value',
  glitchTint: 'k.uniforms.glitchTint.value',
  glitchBands: 'k.uniforms.glitchBands.value',
  glitchRate: 'k.uniforms.glitchRate.value',
  spin: 'k.controls.autoRotate',
  // The five readings land on uniforms of their own name, which is the one place in
  // this table where the parameter and the uniform were deliberately made to match:
  // the shader reads them as a set, and a landing site that renamed them on the way
  // through would be a second table to keep in step with the first.
  readRgb: 'k.uniforms.readRgb.value',
  readDepth: 'k.uniforms.readDepth.value',
  readGhost: 'k.uniforms.readGhost.value',
  readContour: 'k.uniforms.readContour.value',
  readBlackwall: 'k.uniforms.readBlackwall.value',
  rgbSaturation: 'k.uniforms.rgbSaturation.value',
  depthGamma: 'k.uniforms.depthGamma.value',
  ghostRim: 'k.uniforms.ghostRim.value',
  ghostFill: 'k.uniforms.ghostFill.value',
  contourBands: 'k.uniforms.contourBands.value',
  // The one parameter here that is not a single uniform write: it is half a band's
  // width, and the shader takes the two edges it makes. Named as the pair rather than
  // as one of them for the reason the region's components are - an apply that wrote the
  // same edge twice, or moved one and not the other, reads identically at either one.
  contourWidth: '[k.uniforms.contourLo.value, k.uniforms.contourHi.value]',
  blackwallSweep: 'k.uniforms.blackwallSweep.value',
  scan: 'k.uniforms.scanAmount.value',
  rim: 'k.uniforms.rimAmount.value',
  thermal: 'k.uniforms.thermal.value',
  edges: 'k.uniforms.edges.value',
  duotoneDepth: 'k.uniforms.duotoneDepth.value',
  // Degrees on the slider and radians at the uniform, so this row is the conversion as
  // much as the arrival. An apply that handed the shader its degrees straight through
  // would read here as a perfectly ordinary number and spin the poles fifty-seven times
  // too far, which is a look nobody authored arriving through a slider that works.
  duotoneHue: 'k.uniforms.duotoneHue.value',
  duotoneSplit: 'k.uniforms.duotoneSplit.value',
  bloom: '[k.bloom.strength, k.bloom.enabled]',
  trails: '[k.afterimage.uniforms.damp.value, k.afterimage.enabled]',
  rgbSplit: '[k.grade.uniforms.rgbSplit.value, k.grade.enabled]',
  scanlines: '[k.grade.uniforms.scanlines.value, k.grade.enabled]',
  // The raster's three settings, and like `crush` below none of them carries
  // `k.grade.enabled` - they are settings of the master above rather than terms beside
  // it, so the pass is the master's to gate. The angle is degrees on the slider and
  // radians at the uniform, which makes its row the conversion as well as the arrival.
  // Named as the pair rather than as an angle, because that is what the registry
  // actually writes: an apply that moved one component and not the other, or wrote the
  // sine where the cosine belongs, reads identically at either one on its own.
  scanAngle: '[k.grade.uniforms.scanAxis.value.x, k.grade.uniforms.scanAxis.value.y].map((v) => Number(v.toFixed(9)))',
  scanPitch: 'k.grade.uniforms.scanPitch.value',
  scanHard: 'k.grade.uniforms.scanHard.value',
  grain: '[k.grade.uniforms.grain.value, k.grade.enabled]',
  vignette: '[k.grade.uniforms.vignette.value, k.grade.enabled]',
  // The fifth term in that pass, and **the missing `k.grade.enabled` beside it is the
  // assertion**. The four above gate the pass and so each has to carry whether it is on;
  // this one is a sub-control inside the pass and deliberately does not, because its
  // default is the literal it replaced and a gate on a non-zero default would hold the
  // grade open for every look there is. Pairing it here would make this row agree with a
  // build that gated it, which is the one build this landing site exists to refuse. What
  // proves the negative is the row in the pass-gate matrix below.
  crush: 'k.grade.uniforms.crush.value',
  denoise: 'k.uniforms.denoise.value',
  edgeTol: 'k.uniforms.edgeTol.value',
  renderScale: 'k.renderer.getContext().drawingBufferWidth',
  // The two levelling angles share one landing site, because a rotation is what they
  // are between them. `worldTilt()` answers off the cloud's own quaternion rather than
  // off the value the pair composes into, so this row is "the rotation reached the
  // object the renderer draws" rather than "the arithmetic was done". Rounded because
  // the comparison is a `JSON.stringify` equality and the expectation below rebuilds
  // the quaternion in a different order of operations - a ULP apart is not a finding.
  tilt: 'k.worldTilt().map((v) => Number(v.toFixed(9)))',
  roll: 'k.worldTilt().map((v) => Number(v.toFixed(9)))',
  camera: '[...k.programCamera.position.toArray(), ...k.programCamera.quaternion.toArray(), k.programCamera.fov]',
};

/**
 * The quaternion `tilt` and `roll` have to compose into: `Rx(tilt) * Rz(roll)`.
 *
 * Written out here rather than read back from the page on purpose. This is the one
 * place outside `web/main.js` that states the order, so the pair being composed the
 * other way round fails this row - where a tool that asked the page what order it used
 * would agree with the implementation by construction and could never see it.
 */
function levellingQuaternion(tiltDeg, rollDeg) {
  const t = (tiltDeg * (Math.PI / 180)) / 2;
  const r = (rollDeg * (Math.PI / 180)) / 2;
  const st = Math.sin(t); const ct = Math.cos(t);
  const sr = Math.sin(r); const cr = Math.cos(r);
  return [st * cr, -st * sr, ct * sr, ct * cr].map((v) => Number(v.toFixed(9)));
}

// What that landing site must read, given the value the registry was handed. The
// ones taking `all` are the parameters that share a side effect with another.
const EXPECT = {
  pointSize: (v) => v,
  opacity: (v) => v,
  exposure: (v) => v,
  additive: (v) => [v ? ADDITIVE_BLENDING : NORMAL_BLENDING, !v, v ? 1 : 0],
  near: (v) => v,
  far: (v) => v,
  left: (v) => v,
  right: (v) => v,
  bottom: (v) => v,
  top: (v) => v,
  crop: (v) => (v ? 1 : 0),
  interpolate: (v) => (v ? 1 : 0),
  snapDelta: (v) => v,
  fade: (v, all) => [v / 1000, v > 0 || all.wake > 0 ? POINTS * 2 : POINTS],
  wake: (v, all) => [v / 1000, all.fade > 0 || v > 0 ? POINTS * 2 : POINTS],
  noise: (v) => v,
  noiseScale: (v) => v,
  noiseSpeed: (v) => v,
  regionX: (v) => v,
  regionY: (v) => v,
  regionZ: (v) => v,
  regionW: (v) => v,
  regionH: (v) => v,
  regionD: (v) => v,
  regionRound: (v) => v,
  regionSoft: (v) => v,
  regionPush: (v) => v,
  regionNoise: (v) => v,
  regionMask: (v) => v,
  glitch: (v) => v,
  glitchDensity: (v) => v,
  glitchShove: (v) => v,
  glitchTint: (v) => v,
  glitchBands: (v) => v,
  glitchRate: (v) => v,
  spin: (v) => v,
  readRgb: (v) => v,
  readDepth: (v) => v,
  readGhost: (v) => v,
  readContour: (v) => v,
  readBlackwall: (v) => v,
  rgbSaturation: (v) => v,
  depthGamma: (v) => v,
  ghostRim: (v) => v,
  ghostFill: (v) => v,
  contourBands: (v) => v,
  // Written as the same double-precision arithmetic the registry does, so the two agree
  // bit for bit rather than nearly: the whole reason the edges are computed off the GPU
  // is that a half minus this width is a different float in float32, and a check that
  // rounded its expectation differently from the build would be measuring its own
  // arithmetic.
  contourWidth: (v) => [0.5 - v, 0.5 + v],
  blackwallSweep: (v) => v,
  scan: (v) => v,
  rim: (v) => v,
  thermal: (v) => v,
  edges: (v) => v,
  duotoneDepth: (v) => v,
  // The degrees-to-radians the registry does on the way through, written out here as the
  // same double arithmetic rather than read back off the page - three's `degToRad` is a
  // multiply by `Math.PI / 180` and so is this, which makes the equality exact instead of
  // nearly exact. A tool that asked the page what conversion it used would agree with the
  // implementation by construction and could never see a wrong one.
  duotoneHue: (v) => v * (Math.PI / 180),
  duotoneSplit: (v) => v,
  bloom: (v) => [v, v > 0],
  trails: (v) => [v, v > 0],
  // The four that share one pass, so each one's landing carries whether the pass is on
  // and every one of them has to name the other three. `vignette` joined them when it
  // stopped being a literal applied whenever the pass happened to run.
  rgbSplit: (v, all) => [v, v > 0 || all.scanlines > 0 || all.grain > 0 || all.vignette > 0],
  scanlines: (v, all) => [v, all.rgbSplit > 0 || v > 0 || all.grain > 0 || all.vignette > 0],
  // Same double arithmetic three's `degToRad` does, so the equality is exact rather than
  // near - and written out here rather than read back off the page, because a tool that
  // asked the page what conversion it used could never see a wrong one.
  // The same double arithmetic the registry does on the way through, so the two agree bit
  // for bit rather than nearly - and stated here rather than read back off the page,
  // because a tool that asked the page which axis it built could never see a wrong one.
  // Rounded on both sides, exactly as the levelling pair above is and for its reason:
  // the comparison is a `JSON.stringify` equality and this rebuilds the cosine in a
  // different order of operations from the registry, so the two land a ULP apart -
  // 0.4539904997395468 against 0.45399049973954686 at the scrambled 63 degrees. A ULP is
  // not a finding; an axis built the wrong way round still is, and still fails here.
  scanAngle: (v) => [Math.sin(v * (Math.PI / 180)), Math.cos(v * (Math.PI / 180))]
    .map((x) => Number(x.toFixed(9))),
  scanPitch: (v) => v,
  scanHard: (v) => v,
  grain: (v, all) => [v, all.rgbSplit > 0 || all.scanlines > 0 || v > 0 || all.vignette > 0],
  vignette: (v, all) => [v, all.rgbSplit > 0 || all.scanlines > 0 || all.grain > 0 || v > 0],
  // Reads its own value and nothing else, because it shares the pass without gating it -
  // so unlike the four above it names none of the others and none of them name it.
  crush: (v) => v,
  denoise: (v) => (v ? 1 : 0),
  edgeTol: (v) => v,
  // three floors width * pixelRatio, and the context runs at deviceScaleFactor 1.
  renderScale: (v) => Math.floor(RENDER_BUFFER.width * (v / 100)),
  // Both read the whole pair, because both land on the same rotation: a `tilt` set on
  // its own has to compose with whatever `roll` currently is, which the one-at-a-time
  // sweep leaves at its default and the all-at-once pass does not.
  tilt: (v, all) => levellingQuaternion(v, all.roll),
  roll: (v, all) => levellingQuaternion(all.tilt, v),
  camera: (v) => [...v.position, ...v.quaternion, v.fov],
};

// A scrambled but valid set: every value off its default and on its own step grid,
// every boolean flipped. This is what gets serialised, restored and hashed.
const SCRAMBLE = {
  pointSize: 9.5,
  opacity: 0.62,
  exposure: 2.05,
  additive: true,
  // Both non-zero and both off the other's axis, because the drop-one sweep reverts one
  // at a time: a scrambled set that levelled along a single axis would leave the other
  // parameter with nothing to undo, and it would land in the no-pixel bucket looking
  // like a parameter that does nothing. Off the half-degree grid's round numbers for
  // the same reason every other value here is - a step the slider can express, but not
  // one a hardcoded constant would plausibly be.
  tilt: 13.5,
  roll: -21.5,
  near: 0.35,
  far: 4.2,
  // **Left at its default, which is the one value in this table that is**, and the
  // reason is the same one the three region effects below give: it is a gate, and the
  // six faces either side of it are only observable through it. Flipped to `false` the
  // box stops biting, so `near`, `far` and the four lateral faces all render the same
  // image whatever they are set to, and six real parameters land in the no-pixel bucket
  // at once looking like parameters that do nothing.
  //
  // What that costs is this sweep's own view of `crop`: dropping it restores the value
  // it already has, so it changes nothing here and is declared in `NO_PIXEL_EFFECT`. A
  // drop-one sweep cannot see a parameter whose scrambled value is its default, and the
  // section below is where the switch is actually proven.
  crop: true,
  // The four lateral faces, placed against the same fixture the region is placed
  // against rather than picked: the cloud runs x [-2.31, 2.97] and y [-2.26, 1.63],
  // so each of these sits inside the extent on its own side and has something to cull,
  // while the box they make still contains the subject at the median (0.021, 0.019).
  // A plane outside the cloud would be a parameter the drop-one sweep below could not
  // see, which is the same trap the region's placement comment describes.
  left: -1.5,
  right: 1.5,
  bottom: -1.5,
  top: 1,
  // Flipped, and the drop-one sweep is what makes it worth stating. Reverting `crop` to
  // its default puts all six faces back to work against the four placed above and the
  // near/far pair above them - so the row it produces is a large one, and a build whose
  // switch reached the shader and nothing else, or nothing at all, cannot pass it. The
  interpolate: false,
  snapDelta: 410,
  fade: 260,
  wake: 830,
  noise: 0.08,
  noiseScale: 5.5,
  noiseSpeed: 1.45,
  // The master well up, because the five ceilings under it are only observable through
  // it: at a glitch of 0 no band tears, so density, shove, flare, band height and rate
  // would every one of them land in the no-pixel bucket together - the same argument the
  // region's three effects below are set for. The flare is above its default so it is
  // being raised onto the picture rather than lowered out of it.
  glitch: 0.31,
  glitchDensity: 0.62,
  glitchShove: 1.23,
  glitchTint: 4.35,
  glitchBands: 27,
  glitchRate: 13.5,
  // The region is placed rather than picked, because the sweep below drops each
  // parameter in turn and asserts the image moved - and a region floating in empty
  // space would leave all eight of its geometry parameters inert while looking like a
  // perfectly reasonable set of numbers. Measured against the six frames this fixture
  // is built from, unprojected with the take's own intrinsics and clipped to the
  // near/far above: the cloud runs x [-2.31, 2.97], y [-2.26, 1.63], z [-4.50, -0.50]
  // with its median point at (0.021, 0.019, -1.893), so the centre sits on the subject
  // and the surface passes through it rather than around it.
  //
  // What that buys, per parameter, as points whose region weight changes when that one
  // parameter alone reverts to its default - 957,783 points survive the clip:
  //
  //   regionX 14.49%   regionY 19.13%   regionZ 31.25%   regionW 27.96%
  //   regionH 44.20%   regionD 56.84%   regionRound 68.89%   regionSoft 21.31%
  //
  // The tightest is `regionX`, whose 0.05 step is one grid position off its default and
  // still moves 138,822 points. `regionSoft` is the one to watch if these are ever
  // retuned: it can only act in the shell outside the surface, so a falloff at its
  // default width against a region already swallowing the cloud would move nothing.
  regionX: 0.05,
  regionY: 0.15,
  regionZ: -1.9,
  regionW: 0.4,
  regionH: 0.4,
  regionD: 0.4,
  regionRound: 0.9,
  regionSoft: 0.6,
  // All three non-zero, because the eight above are only observable through them: with
  // push, scramble and mask all at their defaults the region has no effect to have, and
  // every geometry parameter would land in the no-pixel bucket at once. The mask is
  // well short of 1 for the same reason - a region that hid its contents outright would
  // make the displacement inside it invisible and take `regionPush` down with it.
  regionPush: 0.35,
  regionNoise: 0.5,
  regionMask: 0.4,
  spin: true,
  // All five readings live at once, which is what keeps every per-reading term in the
  // shader reachable from the one sweep this file runs. They are deliberately unequal:
  // an even split would make the normalisation divide by exactly 1.0 whichever way the
  // weights were read, so a build that summed them wrong would still agree here.
  readRgb: 0.4,
  readDepth: 0.3,
  readGhost: 0.2,
  readContour: 0.15,
  readBlackwall: 0.6,
  // The seven per-reading constants, every one off its default - and for the first two
  // that is the whole point rather than a habit. Their defaults are the identity: a
  // saturation of 1 and a gamma of 1 do nothing by construction, so leaving either at
  // its default would have the drop-one sweep below record it as a parameter that
  // cannot touch a pixel, which is true of the value and false of the parameter.
  //
  // `rgbSaturation` is also the one parameter in this table that needs an input the
  // pinned fixture does not carry. The fixture drops the colour block, so `hasColor` is
  // 0 and every point draws a flat grey - and saturation of grey is the identity at
  // every value, which is a dead zone rather than a value that does nothing. The sweep
  // plants a colour image for exactly that reason; see `plantColor` below.
  //
  // `blackwallSweep` is a speed, so it moves nothing in a frame at program time 0 and
  // the run below deliberately spans a second: at 0.9 against its default the scan plane
  // has travelled 0.62 of a period by the end of it.
  rgbSaturation: 1.6,
  depthGamma: 0.6,
  ghostRim: 1.4,
  ghostFill: 0.7,
  contourBands: 27,
  contourWidth: 0.25,
  blackwallSweep: 0.9,
  scan: 0.72,
  rim: 0.28,
  // Order matters here and nowhere else in this file: the comparison against the
  // serialised set is a JSON.stringify equality, so these keys have to sit in the order
  // PARAMS declares them. Put them anywhere else and the check fails with an empty
  // detail line, because every value matches and only the ordering does not.
  thermal: 0.6,
  edges: 0.45,
  // The duotone amount well up, because the two below are only observable through it -
  // the same argument the glitch master and the region's three effects are set on. At a
  // depth of 0 the poles never reach a pixel, so the hue and the split would both land in
  // the no-pixel bucket together looking like parameters that do nothing.
  duotoneDepth: 0.65,
  // Off the axis in both senses: a rotation big enough to move both poles well clear of
  // where they started, and not one of the right angles a hardcoded constant would
  // plausibly be. 47 degrees is on the step grid and is nobody's round number.
  duotoneHue: 47,
  // Off centre, so reverting it moves the crossover through the cloud rather than
  // symmetrically about it. The fixture's points run z [-4.50, -0.50] against a near/far
  // of 0.35/4.2, so a split at 0.36 puts the meeting plane inside the subject where the
  // default at 0.5 puts it behind them.
  duotoneSplit: 0.36,
  bloom: 1.35,
  trails: 0.44,
  rgbSplit: 2.3,
  scanlines: 0.61,
  // Off every axis the raster has a right angle at, so a build that rounded the angle to
  // the nearest quarter turn - or dropped it - draws a visibly different grille. The
  // master above is what makes these three observable at all: at a scanlines of 0 the
  // block never runs and all three would land in the no-pixel bucket together, which is
  // the argument the glitch ceilings and the region's three effects are set on.
  scanAngle: 63,
  // Well above the 1.3 it defaults to, so the lines are the dense column raster rather
  // than the television artifact - and a pitch that only moved a hair would be a
  // parameter the drop-one sweep could not separate from sampling noise.
  scanPitch: 4.7,
  // High enough that the wave is a grille rather than a sine, which is the state the
  // hardness exists to reach. At its default of 0 it is the identity by construction, so
  // leaving it there would have the sweep record it as a parameter that cannot touch a
  // pixel - the trap `rgbSaturation` and `depthGamma` above are set off their defaults for.
  scanHard: 0.82,
  grain: 0.37,
  vignette: 0.73,
  // Well above the 0.018 it defaults to, and the four terms above hold the pass open so
  // it is reachable at all - a toe inside a pass nothing switched on is the dead zone
  // this table's `rgbSaturation` comment describes, arriving by a different route.
  // Reverting it to its default lifts every unclamped pixel by 0.044 * 1.12, which is
  // about 12.6 of 255 and nothing a sampling residual explains.
  crush: 0.062,
  denoise: false,
  edgeTol: 340,
  renderScale: 85,
  // A unit quaternion, 30 degrees about Y, so the read-back is exact.
  camera: { position: [0.4, 0.9, 1.1], quaternion: [0, 0.25881904510252074, 0, 0.9659258262890683], fov: 42 },
};

// The closed list of parameters allowed to leave the image untouched when they are
// dropped from a restore, with the reason each one cannot reach the pixels here.
// Anything else landing in that bucket is a failure, which is what stops the sweep
// growing holes as later steps add parameters.
const NO_PIXEL_EFFECT = {
  // Not a parameter that fails to reach pixels - it is a switch over all six crop faces
  // and reaches them hard. It is invisible to *this method*: the sweep drops a parameter
  // and lets it fall back to its default, and `crop` is scrambled to its default because
  // flipping it would take the six faces beside it out of the picture. A drop-one sweep
  // cannot see a parameter it cannot drop. The section that does see it is
  // "the crop switch, which the sweep above cannot see", and this entry is a hole
  // without it.
  crop: 'its scrambled value is its default, because releasing the box would make the '
    + 'six faces it gates unobservable - proven instead by the section below',
  spin: 'auto-orbit only advances when the animation loop calls controls.update, '
    + 'and a pinned run has replaced the loop',
  camera: 'nothing draws the program camera on the pinned run - the viewport is the '
    + 'free camera - so a pose reaches the camera object and no pixel',
};

// ---------------------------------------------------------------- page helpers

const PAGE_HELPERS = `
  const k = globalThis.__kinect;
  const sha256 = async (bytes) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const pinCamera = (cam) => {
    cam.position.set(0, 0.1, 1.6);
    cam.lookAt(0, 0, -2.2);
    cam.updateMatrixWorld(true);
  };
`;

const landingReader = `(() => {
  const k = globalThis.__kinect;
  return { ${Object.entries(LANDING).map(([n, e]) => `${n}: (${e})`).join(', ')} };
})()`;

// The same reader with every expression allowed to come back undefined, and it is used
// on exactly one page: the revision the golden comparison plays back. That build
// predates some of these parameters, so reading `k.uniforms.regionCentre.value.x` there
// is a TypeError rather than a finding, and one throw takes the whole section with it.
//
// Deliberately *not* used for the current page. A LANDING entry naming a uniform this
// build does not have is a real bug in the check, and swallowing it on both arms would
// turn every such typo into a silent `undefined === undefined` pass - the shape this
// repo keeps finding, where an instrument stops being able to fail.
const tolerantLandingReader = `(() => {
  const k = globalThis.__kinect;
  const at = (f) => { try { return f(); } catch { return undefined; } };
  return { ${Object.entries(LANDING).map(([n, e]) => `${n}: at(() => (${e}))`).join(', ')} };
})()`;

const readLanding = (page) => page.evaluate(landingReader);

// Everything the two arms of the before/after comparison can both answer. No
// `k.params` here: the committed page has none, and a snapshot that only the new
// page could produce would compare nothing.
// `mode` and the `#modes` pressed states used to be in here, and they cannot be: the
// integer uniform and the five buttons exist on one side of this comparison only, so
// the field would read `0 -> undefined` at every stage and the arm would fail on the
// change it is meant to be measuring. What replaced the mode is five ordinary look
// parameters, which arrive in `dom` and `readouts` with every other slider - and the
// claim that each of them renders what its mode rendered is not a state comparison at
// all. It is section 1b, which hashes the framebuffer.
const snapshotWith = (reader) => `(() => {
  const k = globalThis.__kinect;
  return {
    landing: ${reader},
    fog: k.scene.fog.color.getHex(),
    dom: Object.fromEntries([...document.querySelectorAll('#panel input')]
      .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value])),
    // Range rows only. A readout is the number beside a slider, so a checkbox row has
    // none by design - and the monitor group added one in step 9, at which point this
    // map started calling .textContent on null and took the whole section down before
    // a single assertion ran. Filtering to the rows that are supposed to have a readout
    // is what the map always meant.
    //
    // The missing one is still reported rather than skipped: a *slider* that lost its
    // output is exactly the regression this map exists to catch, and it now shows up as
    // a differing value instead of as a crash.
    readouts: Object.fromEntries([...document.querySelectorAll('#panel .row')]
      .filter((r) => r.querySelector('input')?.type === 'range')
      .map((r) => [r.querySelector('input').id,
        r.querySelector('output')?.textContent ?? '(no output element)'])),
  };
})()`;

// ------------------------------------------------------------------- the pages

const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, and a run that quietly fell back to a software rasteriser would
// agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });

const fixture = buildFixture(CAPTURE);

// A page with no source of its own is this tree's page, which under `--mutate` means
// the mutated one. The arms that name a source are the historical revisions, and they
// are deliberately left alone: mutating the thing a comparison is measured *against*
// would move both sides and prove nothing.
async function openPage({
  source = mutatedSource,
  pin = false,
  viewportSize = VIEW,
  comparisonShell = false,
} = {}) {
  const page = await context.newPage();
  if (viewportSize.width !== VIEW.width || viewportSize.height !== VIEW.height) {
    await page.setViewportSize(viewportSize);
  }
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${msg.text()} @ ${JSON.stringify(msg.location())}`); });
  // A console error names no URL, so the response is recorded alongside it - a
  // 404 on the module and a 404 on the tab icon read identically otherwise, and
  // one of those is the check silently measuring a page that never loaded.
  page.on('response', (res) => { if (!res.ok()) errors.push(`${res.status()} ${res.url()}`); });

  // No frame may arrive. The look values under test do not depend on the stream,
  // and letting the server decide whether one lands would make a verdict that
  // flips between runs on an unchanged tree.
  await page.routeWebSocket(/.*/, () => { /* accepted, never connected */ });

  // The tab icon, answered rather than left to 404. The server has never served
  // one, and the console error it produces is indistinguishable from a real
  // failure to load - which would either be ignored by hand here, hiding the real
  // ones with it, or left to fail the run for a reason that is not about the page.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  let servedHtml = false;
  if (source) {
    // The panel and the module are served as one pair. The committed page reads
    // its ranges out of its own HTML, so pairing the old module with the new
    // markup would boot it on whatever a range input defaults to and the
    // comparison would be against a page that never existed.
    //
    // The predicate and the `goto` below read one constant rather than each
    // spelling the path. They used to name `/` and `/index.html` while the page
    // was opened at `/`, and the recorder has since moved to `/record` - two
    // places that must agree about a path and do not is how the before arm ends
    // up quietly loading the tree's own markup and printing two matching columns
    // under a heading that says they came from different code.
    await page.route((url) => url.pathname === RECORDER_PATH,
      (route) => { servedHtml = true; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: source.html }); });
    await page.route('**/main.js', (route) => route.fulfill({
      contentType: 'text/javascript; charset=utf-8', body: source.js,
    }));
  }
  if (pin) {
    await page.route('**/__pinned.bin', (route) => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: fixture,
    }));
  }

  await page.goto(URL_BASE + RECORDER_PATH, { waitUntil: 'load' });
  // Proof the interception held, for the same reason the focal reading below is
  // here. A predicate that stops matching pairs the old module with today's
  // markup, which throws at boot on the first parameter this tree has renamed -
  // and that arrives as a 30-second `waitForFunction` timeout naming nothing,
  // which is a wrong URL wearing the shape of a missing feature.
  if (source && !servedHtml) {
    throw new Error(`the page markup was never intercepted - landed on ${new URL(page.url()).pathname}, `
      + `so the ${BEFORE_REV} arm loaded the tree's own page`);
  }
  await page.waitForFunction(() => !!globalThis.__kinect);
  if (comparisonShell) {
    // The comparison build predates the fixed application bar. Canonicalise both
    // revisions onto its existing bottom-strip allocation before changing target
    // aspect, so the comparison viewport gives both the same 640x400 content box
    // through the same layout mechanism. The real current shell is measured separately
    // below and by editor-check; this arm is about shader identity across the old mode
    // boundary, at the fixed 640x400 frame it was originally calibrated against.
    await page.evaluate((height) => {
      const appBar = document.getElementById('appBar');
      if (appBar) appBar.style.display = 'none';
      const timeline = document.getElementById('timeline');
      timeline.hidden = false;
      timeline.style.height = `${height}px`;
      timeline.style.minHeight = `${height}px`;
      timeline.style.maxHeight = `${height}px`;
      dispatchEvent(new Event('resize'));
    }, APP_BAR_HEIGHT);
  }
  // **The page frames at the stage this tool asked for.** The editor letterboxes
  // itself to the export aspect now, so a viewport alone no longer decides the
  // drawing buffer: a 640x400 stage is 1.6, the menu's default is 16:9, and the fit
  // makes the buffer 640x360 with a 20px offset unless told otherwise. That moves
  // every buffer-size expectation and every pointer coordinate in this file.
  await page.evaluate('globalThis.__kinect.setTargetSize?.("640x400")');

  // Proof the interception held, independent of the readings it protects. The
  // sensor's hello carries fx as 366.031494 and the uniform defaults to exactly
  // 366, so the default still standing means nothing came over the socket.
  const focal = await page.evaluate('globalThis.__kinect.uniforms.focal.value.x');
  if (focal !== 366) throw new Error(`websocket interception failed - intrinsics arrived (focal.x=${focal})`);

  return { page, errors };
}

// =============================================================== 1. before/after

console.log(`[registry] nothing moved: boot state against ${BEFORE_REV}`);

const beforeSource = {
  js: execFileSync('git', ['show', `${BEFORE_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  html: execFileSync('git', ['show', `${BEFORE_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
};
// Once step 3 is committed, a bare --before HEAD would serve the registry into
// both arms and print two matching columns under a heading that says they came
// from different code. Refusing beats that.
if (beforeSource.js.includes('const PARAMS')) {
  throw new Error(`${BEFORE_REV}:web/main.js already contains the registry - pass an earlier rev with --before`);
}

// This used to walk every mode, then Blackwall and out of it twice, because the
// interesting case was the transition rather than the state: entering wrote twelve
// look values and leaving wrote them back. There is no such transition to walk any
// more, and its absence is the change rather than a gap in the check - selecting a
// reading writes the reading and nothing else, which is what "look and shading are
// one thing" cost the mode. A walk asserting that entering Blackwall still rewrites
// twelve sliders would be asserting the weld that was removed.
//
// So this arm compares boot state alone, and the claim it used to make about the
// readings is made properly one section down: not "the sliders agree" but "the
// framebuffer is identical", which is the equality the old walk was standing in for.

// The program pose at a few positions, read in the same task as the render so the
// live loop cannot re-render at 0 underneath the reading. Nothing draws the
// program camera here, which is exactly why it is worth reading: the pose moved
// from a mutation to a value the registry applies, and three orients cameras down
// -Z where it orients everything else down +Z, so a slip would be invisible until
// something drew the frustum.
//
// **This is no longer compared against the earlier revision, and the reason is a
// deletion rather than a tolerance.** At that revision the pose came from a
// placeholder orbit - a slow revolution, one turn per hundred seconds - which step
// 5 replaced with the camera track the design always called for. There is nothing
// left to compare it to: with no camera keys the pose is now a clip's single
// static value, which is the deliberate behaviour and is asserted as such below.
// The moving case is proved in `keyframe-check`, against a track rather than
// against a placeholder.
const readPoses = `(() => {
  const k = globalThis.__kinect;
  const out = {};
  for (const t of [0.7, 1.9]) {
    k.renderProgramFrame(t);
    out[t] = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
  }
  return out;
})()`;

async function bootState(opts, reader = landingReader) {
  const { page, errors } = await openPage(opts);
  const out = { boot: await page.evaluate(snapshotWith(reader)) };
  const poses = await page.evaluate(readPoses);
  return { out, poses, errors, page };
}

// **The after arm goes first, because it is what says how tall the bar is.** The
// before arm's viewport is derived from that measurement, so the order is a
// dependency rather than a preference.
const afterArm = await bootState({});
const measuredBar = await afterArm.page.evaluate(
  "Math.round(document.getElementById('appBar').getBoundingClientRect().height)");
await afterArm.page.close();
if (!Number.isFinite(measuredBar) || measuredBar <= 0) {
  throw new Error(`the application bar measured ${measuredBar}px - the shell this arm is compared against is not on the page`);
}
shellGeometry(measuredBar);
console.log(`  the shell's application bar measures ${APP_BAR_HEIGHT}px, `
  + `so the content box both arms render is ${SHELL_CONTENT.width}x${SHELL_CONTENT.height}`);

const beforeArm = await bootState(
  { source: beforeSource, viewportSize: SHELL_CONTENT },
  tolerantLandingReader,
);
await beforeArm.page.close();

// The camera is left out of the landing comparison, alone among the twenty-five,
// and only here. Every other parameter lands on the same uniform it landed on
// before the registry existed, so an equality is a regression test. The camera's
// landing site at that revision was a placeholder orbit computed from `t` inside
// the render, and step 5 deleted it - so the two arms are being asked to agree
// about a value one of them derives from something the other does not have. The
// pose is still swept, still restored and still checked against what the camera
// object holds, further down; it is only this one before/after that has nothing
// left to say.
const GOLDEN_SKIP = new Set(['camera']);

// The one value that legitimately moved, and it is rescaled rather than skipped.
//
// Step 6 made every screen-space term relative to a 1080p reference, which changed
// what `pointSize` *means*: it is pixels at 1080p now, where it used to be pixels
// at whatever buffer the look happened to be graded against - the 600-tall one the
// design document's resolution A/B calls the good size. So both presets and the
// registry default took the factor 1080/600, and comparing the raw number across
// that change would be comparing two different quantities.
//
// Skipping it the way the camera is skipped would have been weaker than what this
// replaces. The camera has nothing left to compare against, because the placeholder
// orbit it used to come from was deleted; `pointSize` has an exact expected value,
// so the equality becomes an equality against that instead of going away. A value
// that moved by any other factor still fails here.
const POINT_SIZE_REBASE = 1080 / 600;
const GOLDEN_RESCALE = { pointSize: POINT_SIZE_REBASE };

// Parameters that did not exist at BEFORE_REV, so there is no earlier value to hold
// them to. This is the `camera` case rather than the `pointSize` case - nothing left to
// compare against - but it is not a skip, and the difference is what keeps it honest:
// a name is only excused here if the *earlier* arm answered `undefined`, which is the
// signature of a uniform, a slider and a readout that genuinely were not there. Put a
// name in this set that did exist at that revision and it still fails, because its old
// value is a number and a number is not undefined.
//
// What that leaves proven is the claim worth making about an added look parameter: the
// twenty-five that were already here render and read back exactly as they did, so
// twelve new sliders at their defaults changed no image. Whether the new ones reach the
// pixels at all is section 9's question, not this one's.
const GOLDEN_ABSENT = new Set([
  'noise', 'noiseScale', 'noiseSpeed',
  'regionX', 'regionY', 'regionZ', 'regionW', 'regionH', 'regionD',
  'regionRound', 'regionSoft', 'regionPush', 'regionNoise', 'regionMask',
  'thermal', 'edges',
  // The four lateral crop faces. They are excused here on the same terms as the rest -
  // the pinned revision has no such control, so there is nothing on that side to hold
  // them to - and the excuse costs nothing, because the defaults are the bounds: a
  // build with these planes wide open renders exactly what a build without them
  // renders. That equality is the row above, and it is the reason this arm still means
  // something with four more parameters in it.
  'left', 'right', 'bottom', 'top',
  // The switch over all six of them, and it is excused on the strongest version of the
  // terms the four faces above are: not merely that the pinned revision has no such
  // control, but that its default is the state that revision was permanently in. A build
  // whose box always bites renders exactly what a build with a switch defaulting to
  // biting renders, so this arm is unchanged by the switch existing. What happens when
  // it is *off* is not excused anywhere - it is asserted three ways in "the crop switch,
  // which the sweep above cannot see".
  'crop',
  // The two levelling angles, excused on exactly the crop faces' terms and for exactly
  // their reason: the pinned revision has no such control, and the default is the
  // identity rotation, so a build that levels the room by nothing renders what a build
  // that cannot level it at all renders. That equality is what the row above is
  // asserting, and it is why this arm still means something with two more parameters
  // in it. Whether they reach the pixels when they are *not* zero is section 9's
  // question, and the drop-one sweep there answers it.
  'tilt', 'roll',
  // Not registry parameters at all - the monitor's stream controls, which arrived with
  // step 9 and carry their own bounds in the markup. They are in this set for the same
  // reason as the rest: the earlier revision has no such control, so there is nothing
  // to hold them to here. What they *are* held to is `monitor-check`.
  'monDivisor', 'monStride', 'monAcceptCost',
  // The five readings, which are the parameters this comparison exists to be honest
  // about. At that revision the reading was an integer uniform behind five buttons,
  // so there is no earlier slider, readout or value to hold these to - the `camera`
  // case, not the `pointSize` case. What makes the excuse safe rather than convenient
  // is that their defaults are the boot mode: `readRgb` at 1 with the other four at 0
  // is what `mode == 0` was, so a build with them renders exactly what a build without
  // them rendered, which is precisely the equality the rest of this arm is measuring.
  // That the equality actually holds is not taken on trust here either - section 1b
  // hashes the framebuffer of each reading against the mode it replaced.
  'readRgb', 'readDepth', 'readGhost', 'readContour', 'readBlackwall',
  // The seven constants each reading is made of, excused on exactly the terms above and
  // for a reason that is the same sentence twice over. At the pinned revision every one
  // of these was a literal inside a mode branch, so there is no earlier slider, readout
  // or value to hold them to - and each one defaults to the literal it replaced, so a
  // build with them renders precisely what a build without them rendered. That is the
  // equality this arm measures, and section 1b is where it stops being an excuse and
  // becomes a framebuffer hash: every one of these lives inside a reading, so a default
  // that drifted moves that reading's image and fails there by name.
  'rgbSaturation', 'depthGamma', 'ghostRim', 'ghostFill',
  'contourBands', 'contourWidth', 'blackwallSweep',
  // The five ceilings under the glitch master, on exactly those terms: at the pinned
  // revision each was a literal inside the vertex stage's glitch block, and each
  // defaults to the literal it replaced, so a build carrying them tears identically to
  // one without them. What holds them to that is section 1b, which renders at parameter
  // defaults - a default that drifted off its literal would move whichever readings the
  // torn bands reach and fail there by name rather than being excused here.
  'glitchDensity', 'glitchShove', 'glitchTint', 'glitchBands', 'glitchRate',
  // `vignette` is here on different terms from everything above it, and the difference
  // is worth the sentence. It was a literal too, but it is the one promoted literal that
  // does NOT keep its old value: the behaviour it replaces is conditional - 0.55 while
  // some other grade term held the pass open, 0 while none did - so no default can
  // reproduce both branches. It defaults to the branch the parameter defaults are in,
  // which is why section 1b still agrees with a build from before it existed. The look
  // that did carry a vignette, `blackwall.json`, now names 0.55 for itself.
  'vignette',
  // The duotone's three, on the plainest version of these terms: nothing at the pinned
  // revision resembles them, and all three default to the identity - a depth of 0 never
  // enters the block, so a build carrying them draws precisely what a build without them
  // drew. That equality is what this arm measures, and section 1b is where it stops being
  // an excuse and becomes a framebuffer hash, since the duotone sits after the blend and
  // would move every one of the five readings if its default reached a pixel.
  'duotoneDepth', 'duotoneHue', 'duotoneSplit',
  // `crush` is here on `vignette`'s terms turned the other way up, and the contrast is
  // the reason it gets its own sentence. It was a literal too, and unlike the vignette it
  // *keeps* the value it replaced - so the excuse is the strong one rather than the
  // conditional one: 0.018 is what the grade always subtracted, and a build whose toe is
  // a uniform sitting at 0.018 draws what a build with the literal drew. What it cannot
  // be excused for is gating the pass, which nothing here would see and the pass-gate
  // matrix asserts directly.
  'crush',
  // The raster's three, on the terms the glitch ceilings are excused by: at the pinned
  // revision the pitch was a literal inside the wave and the other two did not exist in
  // any form, and each defaults to the behaviour that build had - an angle of zero along
  // the frame's y, the pitch's own 1.3, and a hardness whose zero is the identity. So a
  // build carrying them draws precisely what a build without them drew, which is the
  // equality this arm measures. That it holds is not taken on trust: section 1b renders
  // at parameter defaults, where the raster block does not run at all, and the drop-one
  // sweep is where the three are shown to reach pixels once the master is up.
  'scanAngle', 'scanPitch', 'scanHard',
  // The program-out size, on the same terms and for the same reason: not a registry
  // parameter, no such control at the earlier revision, and its own bounds live in the
  // handler that parses it rather than in the markup. What it is held to is
  // `vcam-check`, whose section 5 asserts the drawing buffer really is the size this
  // box says and not the window's. `progMode` is not here because it is a `select`
  // and the snapshot walks `#panel input` - if it ever becomes an input it will
  // arrive here as a failure, which is the right way round.
  'progSize',
  // A file chooser is a control over a document, not a registry parameter. It arrived
  // with look import and has no earlier value to hold against the pre-registry page;
  // section 12 of editor-check drives the file through validation and back into the
  // renderer, while this tool's markup scan still refuses any parameter data in HTML.
  'tPresetFile',
]);
const absentBefore = (name, before) => GOLDEN_ABSENT.has(name) && before === undefined;

// The mirror, and it needs the mirrored evidence. `warp` and `warpSpeed` drove a fixed
// three-term sine field; the noise field replaced them, so their old values describe a
// displacement this build cannot produce and there is no rescale that recovers one from
// the other - the sine's amplitude and the noise's are both metres, but of different
// fields. A name is only excused if the *current* arm answers undefined, so putting one
// here that still exists fails on its own value.
const GOLDEN_REMOVED = new Set(['warp', 'warpSpeed']);
const removedSince = (name, after) => GOLDEN_REMOVED.has(name) && after === undefined;

const rescaled = (name, before, after) => {
  const factor = GOLDEN_RESCALE[name];
  if (!factor) return false;
  const x = Number(before);
  const y = Number(after);
  return Number.isFinite(x) && Number.isFinite(y) && y === x * factor;
};

for (const stage of Object.keys(beforeArm.out)) {
  const a = beforeArm.out[stage];
  const b = afterArm.out[stage];
  const unexplained = (field) => (typeof a[field] === 'object' && a[field]
    // Keyed off the union rather than the earlier arm's keys, because a parameter this
    // build added is absent from `a` entirely - iterating `a` alone would step straight
    // past every new name and call that agreement.
    ? [...new Set([...Object.keys(a[field]), ...Object.keys(b[field] ?? {})])]
      .filter((sub) => !eq(a[field][sub], b[field][sub])
        && !GOLDEN_SKIP.has(sub) && !rescaled(sub, a[field][sub], b[field][sub])
        && !absentBefore(sub, a[field][sub]) && !removedSince(sub, b[field][sub]))
    : []);
  const differing = Object.keys(a).filter((field) => {
    if (eq(a[field], b[field])) return false;
    if (typeof a[field] !== 'object' || !a[field]) return true;
    return unexplained(field).length > 0;
  });
  const detail = differing.map((field) => {
    const keys = unexplained(field);
    return keys.length
      ? `${field}{${keys.map((s) => `${s}: ${show(a[field][s])} -> ${show(b[field][s])}`).join(', ')}}`
      : `${field}: ${show(a[field])} -> ${show(b[field])}`;
  }).join('; ');
  check(differing.length === 0, `${stage.padEnd(10)} identical to ${BEFORE_REV}`, detail);
}

// And the rescale is asserted rather than assumed, at every stage of the walk and
// on all three views of the value - the uniform it lands on, the slider and the
// readout - so a preset re-tuned by hand to something near 1.8 would fail here.
{
  const wrong = [];
  const seen = [];
  for (const stage of Object.keys(beforeArm.out)) {
    for (const field of ['landing', 'dom', 'readouts']) {
      const x = Number(beforeArm.out[stage][field]?.pointSize);
      const y = Number(afterArm.out[stage][field]?.pointSize);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (field === 'landing') seen.push(`${stage} ${x}->${y}`);
      if (y !== x * POINT_SIZE_REBASE) wrong.push(`${stage}.${field} ${x} -> ${y}`);
    }
  }
  check(wrong.length === 0,
    `and pointSize moved by exactly 1080/600 everywhere it appears, because its unit did`,
    wrong.length ? wrong.join('; ') : seen.join(', '));
}

// The fixed shell gives the renderer 32 fewer vertical pixels. With the proof's
// 640x400 target aspect that content box is 589x368. The historical page has no target
// fit, so it is opened directly at that content size; both arms must then land on the
// same exact buffer rather than gaining a layout exception in the golden comparison.
check(
  beforeArm.out.boot.landing.renderScale === SHELL_CONTENT.width
    && afterArm.out.boot.landing.renderScale === SHELL_CONTENT.width,
  'and renderScale lands on exactly the fixed shell content fit',
  `${beforeArm.out.boot.landing.renderScale}->${afterArm.out.boot.landing.renderScale}, `
    + `wanted ${SHELL_CONTENT.width}->${SHELL_CONTENT.width}`,
);

// With no camera keys the pose is a single value the clip holds, so two renders at
// different program times land on the same place. That is the whole of the
// locked-off case and it is worth asserting rather than assuming: a render that
// still computed a pose from `t` would move here, which is the placeholder coming
// back by accident.
check(eq(afterArm.poses['0.7'], afterArm.poses['1.9']),
  'with no camera keys the program pose is the clip\'s single value at every program time',
  eq(afterArm.poses['0.7'], afterArm.poses['1.9']) ? '' : show(afterArm.poses));
console.log(`  pose at 0.7s ${show(afterArm.poses['0.7'].position.map((x) => +x.toFixed(6)))} `
  + `q ${show(afterArm.poses['0.7'].quaternion.map((x) => +x.toFixed(6)))}`);

if (beforeArm.errors.length || afterArm.errors.length) {
  console.log(`  page errors: ${[...beforeArm.errors, ...afterArm.errors].join(' | ')}`);
  failures++;
}

// ================================ 1b. each reading renders what its mode rendered

// The claim the whole look/shading merge rests on, and the only one in this file that
// compares two revisions by their pixels rather than by their state.
//
// Dissolving `mode` into five weights rewrote the arithmetic every fragment goes
// through: what was one branch of a five-way `if` is now a weighted sum divided by
// the sum of the weights. The intent is that a single reading at 1.0 is arithmetically
// the identity - `x * 1.0 / 1.0` - so every look ever authored, every saved project and
// every preset renders the pixels it always did. That is an argument, and an argument
// about floating point in a shader compiled by a driver is worth exactly nothing until
// it is hashed.
//
// **Why this is not section 1 with another field bolted on.** Section 1 compares
// uniforms, slider values and readouts. It cannot answer this: the mode and the five
// weights exist on opposite sides of the comparison, so there is no field the two arms
// could both fill in. And its before-arm is deliberately a *pre-registry* revision -
// `--before` refuses any rev containing `const PARAMS` - which is a page with no
// `k.drive` and therefore no way to read a pixel at all.
//
// So this arm takes its own revision. `--against` wants the commit before the readings
// landed, which is a rev that has both the registry and the drive harness: exactly the
// rev `--before` will not accept. Two flags because they are two different questions.
// Before the readings are committed there is no commit introducing them, so the
// marker resolves to nothing and HEAD is the correct answer - that is the whole of
// the working-tree case, where the change under test is exactly what is uncommitted.
// Falling back is only safe because of the refusal below: if this ever silently
// resolved to a rev that already has the readings, the arm would compare the tree
// against itself and print five matching hashes as a pass.
const AGAINST_REV = flag('--against')
  ?? (execFileSync('git', ['log', '-S', 'readBlackwall', '--format=%H', '--', 'web/main.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
    ? revBeforeMarker('readBlackwall')
    : 'HEAD');

// Each reading, and the mode it was. The old build selects by writing the integer
// uniform directly rather than by clicking its button, and that is the point of the
// arm rather than a shortcut: `setMode(4)` applied a hardcoded twelve-value preset on
// the way past, so a click would be comparing the reading *plus a look* against the
// reading alone, and the whole reason this change exists is that those were welded.
// What is under test is the reading.
const READING_WAS = { readRgb: 0, readDepth: 1, readGhost: 2, readContour: 3, readBlackwall: 4 };

console.log(`\n[registry] each reading renders what its mode rendered, at ${AGAINST_REV}`);

{
  const againstSource = {
    js: execFileSync('git', ['show', `${AGAINST_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
    html: execFileSync('git', ['show', `${AGAINST_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  };
  // The mirror of section 1's refusal, and it runs the other way. That one refuses a rev
  // that already has the registry; this one refuses a rev that already has the readings,
  // because serving today's page into both arms would print five matching hashes under a
  // heading claiming they came from different code - which is the failure mode this file
  // has recorded happening once already.
  if (againstSource.js.includes('readBlackwall')) {
    throw new Error(`${AGAINST_REV}:web/main.js already contains the readings - pass an earlier rev with --against`);
  }
  if (!againstSource.js.includes('uniforms.mode.value')) {
    throw new Error(`${AGAINST_REV}:web/main.js has no mode uniform to compare against`);
  }

  // **The old arm is the old readings, not the old geometry.** The unprojection's x sign
  // changed after this rev: the sensor's frames arrive horizontally mirrored and this build
  // undoes them, which `unproject` in `web/main.js` carries the reasoning for. Left alone,
  // the pinned build draws the room reflected and every row below reports 6 of 6 frames
  // differing over a change that has nothing to do with a reading - measured, before this
  // was here: all five rows plus the raster, uniformly, where at HEAD five of the six pass.
  //
  // **This is the rule the raster arm below already states, arriving at a divergence that
  // has no parameter to express it.** That one hands the two builds different `vignette`
  // values because a promotion in `40ab241` baked the corner falloff into one of them, on
  // the principle that each build has to be given the values that mean the same picture in
  // its own vocabulary rather than the same numbers. A geometry difference has no value to
  // hand over, so the vocabulary is the source text and the patch goes here.
  //
  // Guarded the way the mutations are, and for the same reason: the text has to appear
  // exactly once or this refuses to run. A rev where it stopped matching would otherwise
  // quietly become a comparison against un-normalised geometry that reports differences as
  // findings about the readings, which is the one failure this whole section is arranged to
  // avoid. It is one entry because there has been one intentional geometry change; a second
  // belongs beside it rather than folded into it, so the list stays a readable account of
  // how this build differs from the one it is held against.
  const OLD_UNPROJECT_X = '     (pixel.x + 0.5 - center.x) / focal.x * z,';
  const MIRRORED_UNPROJECT_X = '    -(pixel.x + 0.5 - center.x) / focal.x * z,';
  const xHits = againstSource.js.split(OLD_UNPROJECT_X).length - 1;
  if (xHits !== 1) {
    throw new Error(`${AGAINST_REV}:web/main.js states the unprojection's x ${xHits} times, expected exactly 1`
      + ' - refusing to compare a mirrored build against an unmirrored one and report it as a reading');
  }
  againstSource.js = againstSource.js.replace(OLD_UNPROJECT_X, MIRRORED_UNPROJECT_X);

  // Both arms are pinned to the same frames and the same camera, so the only thing
  // that differs between them is the shader. `params.reset()` first on each, because a
  // reading has to be measured against the same defaults the other arm booted with.
  const hashesFor = async (opts, select, cases = READING_WAS, extra = '') => {
    const { page: p, errors } = await openPage({ ...opts, pin: true });
    await p.evaluate(async () => {
      const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
      globalThis.__kinect.drive.pin(buffer);
    });
    const at = await p.evaluate(`(() => {
      const times = globalThis.__kinect.drive.times();
      return times.slice(0, ${SOURCE_FRAMES});
    })()`);
    const meta = await p.evaluate(`(() => {
      const k = globalThis.__kinect;
      const gl = k.renderer.getContext();
      const box = k.renderer.domElement.getBoundingClientRect();
      return {
        window: [innerWidth, innerHeight],
        canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        css: [box.x, box.y, box.width, box.height],
        composer: [k.composer.renderTarget1.width, k.composer.renderTarget1.height],
        afterimage: [k.afterimage._textureComp.width, k.afterimage._textureComp.height],
        cameraAspect: k.freeCamera.aspect,
        bufferHeight: k.uniforms.bufferHeight.value,
      };
    })()`);
    const out = {};
    for (const [reading, mode] of Object.entries(cases)) {
      out[reading] = await p.evaluate(`(async () => {
        ${PAGE_HELPERS}
        k.params.reset();
        ${select}
        ${extra}
        k.drive.reset();
        pinCamera(k.freeCamera);
        const hashes = [];
        for (const t of ${JSON.stringify(at)}) {
          k.drive.stepTo(t);
          hashes.push(await sha256(k.drive.readPixels()));
        }
        return hashes;
      })()`.replace(/\$MODE/g, String(mode)).replace(/\$READING/g, JSON.stringify(reading)));
    }
    await p.close();
    return { out, errors, meta };
  };

  const oldArm = await hashesFor(
    { source: againstSource, viewportSize: COMPARISON_VIEW, comparisonShell: true },
    'k.uniforms.mode.value = $MODE;',
  );
  const newArm = await hashesFor(
    { viewportSize: COMPARISON_VIEW, comparisonShell: true },
    'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
  );
  console.log(`  comparison geometry old ${JSON.stringify(oldArm.meta)} new ${JSON.stringify(newArm.meta)}`);

  for (const [reading, mode] of Object.entries(READING_WAS)) {
    const a = oldArm.out[reading];
    const b = newArm.out[reading];
    const first = a.findIndex((h, i) => h !== b[i]);
    check(eq(a, b),
      `${reading.padEnd(13)} at 1.0 is bit-identical to mode ${mode} at ${AGAINST_REV}`,
      // **Which frames, not which frame.** Reporting only the first mismatch cannot
      // tell a transient from a divergence, and those are different findings: one
      // frame out of a walk is a warm-up the two builds enter differently, while every
      // frame from some index on is a term that has actually changed. `readGhost` is
      // the row that needed asking - it disagrees at exactly one frame of however many
      // are walked - and the old detail line looked identical either way.
      first < 0
        ? `${a.length} frames`
        : `${a.filter((h, i) => h !== b[i]).length} of ${a.length} frames differ, first at `
          + `${first}: ${a[first].slice(0, 12)} vs ${b[first].slice(0, 12)} `
          + `(mismatched: ${a.map((h, i) => (h === b[i] ? null : i)).filter((i) => i !== null).join(', ')})`);
  }

  // ---- the grade term whose default is not zero, at the value the shipped look uses.
  //
  // **The five rows above cannot see the raster at all, and that is worth saying plainly
  // rather than leaving as a gap somebody finds later.** They render at parameter
  // defaults, `scanlines` defaults to 0, and the whole raster block sits behind
  // `if (scanlines > 0.0)` - so a run that came back bit-identical has measured the
  // branch being added and not one line of the arithmetic inside it. Every mutation in
  // this file's table is likewise blind to it, because the drop-one sweep compares arms
  // of one build against each other rather than against a build from before.
  //
  // What makes that a hole rather than a nicety is `presets-builtin/blackwall.json`,
  // which names `scanlines: 0.35`. The generalisation replaced an inline expression with
  // a coordinate through a local, which is exactly the substitution `docs/measurement.md`
  // records producing a third image out of two that were each bit-identical - so "the
  // defaults reach the old expression" is a claim about a compiler, and the shipped look
  // is what pays if it is wrong. `determinism-check` and `export-check` both read that
  // file and deliberately *follow* it rather than pinning it, so neither would notice.
  //
  // One reading, so the raster is the only thing that can differ between the arms, and
  // **Blackwall rather than colour, which is a correction rather than a preference.**
  // Written on `readRgb` first, this arm was an arm lit by a single source: the pinned
  // build selects a reading by integer mode and cannot mix, so one reading is all either
  // side gets, and `--mutate rgb-contributes-no-alpha` then renders black on both of them.
  // They compare identical, the control reports `0 of 6 frames differ with the master
  // off`, and the whole section fires against a mutation with nothing to do with the
  // raster - which is the last entry in `docs/instruments.md`, reproduced in the tool that
  // entry is about. Blackwall writes its own alpha and the readRgb block is guarded on a
  // weight this arm leaves at zero, so no reading's mutation can switch this probe off.
  //
  // It is also the more faithful choice: `blackwall.json` is the document that names a
  // scanlines of 0.35, so this arm now stands where the shipped look actually stands.
  //
  // **The two arms are handed different values on purpose, and the first version of this
  // row was wrong for exactly the reason that sounds like a bug.** Raising the raster
  // opens the grade pass on both builds, and the pinned one bakes its corner falloff into
  // that pass as `mix(1.0, vig, 0.55)` where this one reads a `vignette` parameter that
  // defaults to 0. So the obvious arrangement - the same look on both sides - compares a
  // frame with a vignette against a frame without one, and reports 6 of 6 frames differing
  // over a promotion that landed in `40ab241` and has nothing to do with the raster. Named
  // here, the two arms draw the same corner falloff and the raster is what is left.
  //
  // This is the units error `export-check`'s cross-build arm already records, arriving
  // from the other direction: **each build has to be given the values that mean the same
  // picture in its own vocabulary**, not the same numbers. `blackwall.json` names 0.55 for
  // precisely this reason.
  const RASTER_LOOK = "k.params.set('scanlines', 0.35);";
  const RASTER_NEW_LOOK = `${RASTER_LOOK} k.params.set('vignette', 0.55);`;
  {
    const rasterOld = await hashesFor(
      { source: againstSource, viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.uniforms.mode.value = $MODE;',
      { readBlackwall: 4 },
      RASTER_LOOK,
    );
    const rasterNew = await hashesFor(
      { viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
      { readBlackwall: 4 },
      RASTER_NEW_LOOK,
    );
    const a = rasterOld.out.readBlackwall;
    const b = rasterNew.out.readBlackwall;
    const first = a.findIndex((h, i) => h !== b[i]);
    check(eq(a, b),
      `and the raster at the shipped look's 0.35 is bit-identical to the one line it replaced, at ${AGAINST_REV}`,
      first < 0
        ? `${a.length} frames, angle 0 pitch 1.3 hardness 0`
        : `${a.filter((h, i) => h !== b[i]).length} of ${a.length} frames differ, first at `
          + `${first}: ${a[first].slice(0, 12)} vs ${b[first].slice(0, 12)}`);
    // The control, and this row is the reason the one above is not vacuous. Two arms that
    // both drew no raster at all would compare bit-identical just as happily, so the
    // sweep has to be shown to have something in it: raising the master has to move the
    // picture on the build under test.
    const flat = rasterNew.out.readBlackwall;
    const lit = (await hashesFor(
      { viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
      { readBlackwall: 4 },
      "k.params.set('scanlines', 0.0); k.params.set('vignette', 0.55);",
    )).out.readBlackwall;
    check(!eq(flat, lit),
      'and the raster is actually drawing at that value, so the equality above is about something',
      `${flat.filter((h, i) => h !== lit[i]).length} of ${flat.length} frames differ with the master off`);
  }

  // The falsification control, and it is the reason the five rows above mean anything.
  // Five hashes agreeing across two revisions would agree just as well if the pinned
  // run rendered nothing at all, or rendered the same thing whatever was selected - a
  // black frame is bit-identical to a black frame. So the readings have to differ from
  // *each other*: five distinct images on each side, which is what makes "identical
  // across the revisions" a statement about the readings rather than about the harness.
  for (const [armName, arm] of [['old', oldArm], ['new', newArm]]) {
    const distinct = new Set(Object.values(arm.out).map((hs) => hs.join('|'))).size;
    check(distinct === Object.keys(READING_WAS).length,
      `and the ${armName} arm's five readings are five different images`,
      `${distinct} distinct of ${Object.keys(READING_WAS).length}`);
  }

  if (oldArm.errors.length || newArm.errors.length) {
    console.log(`  page errors: ${[...oldArm.errors, ...newArm.errors].join(' | ')}`);
    failures++;
  }
}

// ============================================================ the working page

const main = await openPage({ pin: true });
const { page } = main;
RENDER_BUFFER = await page.evaluate(`(() => {
  const gl = globalThis.__kinect.renderer.getContext();
  return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
})()`);

const declared = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  return Object.fromEntries(k.params.names().map((n) => [n, k.params.spec(n)]));
})()`);

// `LANDING` gets a coverage row of its own below; `SCRAMBLE` had none, and a
// parameter the registry declares but this table has never heard of arrives as
// `Error: left is a scalar: it takes a finite number, got undefined` from three
// frames inside `params.set`. That names the parameter and nothing about the reason,
// and it is a crash rather than a finding - so the tool exits 2 having tested
// nothing while looking like it failed. Refused here instead, in a sentence.
//
// Exit 2 rather than a failed assertion because a scrambled set missing a parameter
// cannot sweep the registry it claims to sweep: the run did not happen.
{
  const missing = Object.keys(declared).filter((n) => !(n in SCRAMBLE));
  if (missing.length) {
    console.log(`[registry] DID NOT RUN - the registry declares ${missing.join(', ')} and SCRAMBLE has no `
      + 'value for them, so the scrambled set is not the whole registry. Add one on its own step grid, '
      + 'in the order PARAMS declares it - the serialised comparison below is a JSON.stringify equality '
      + 'and is sensitive to key order.');
    process.exit(2);
  }
}

// =========================================================== 2. the declaration

console.log('\n[registry] the declaration');
{
  const names = Object.keys(declared);
  check(eq(names.sort(), Object.keys(LANDING).sort()),
    `every declared parameter has a landing site here (${names.length})`,
    show(names.filter((n) => !(n in LANDING))));

  const kinds = { scalar: [], step: [], pose: [] };
  const tags = { look: [], composition: [], view: [] };
  let bad = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!kinds[spec.kind]) bad.push(`${name} kind=${spec.kind}`);
    else kinds[spec.kind].push(name);
    if (!tags[spec.tag]) bad.push(`${name} tag=${spec.tag}`);
    else tags[spec.tag].push(name);
    // Every checkbox holds until the next key, because lerping a boolean is
    // meaningless - so a boolean declared scalar is a keyframe bug waiting for
    // step 5 rather than a cosmetic slip.
    if (typeof spec.default === 'boolean' && spec.kind !== 'step') bad.push(`${name} is boolean but kind=${spec.kind}`);
    // Keyed off the type of the default rather than off the kind: `normalise`
    // sends every non-boolean, non-pose value down the scalar branch, so a
    // future numeric step-kind parameter declared without a range would clamp
    // against undefined and store NaN.
    if (typeof spec.default === 'number' && !(spec.min < spec.max && spec.step > 0)) {
      bad.push(`${name} is numeric but has no usable range`);
    }
  }
  check(bad.length === 0, 'every parameter carries a usable kind, tag and range', bad.join('; '));
  check(kinds.scalar.length > 0 && kinds.step.length > 0 && kinds.pose.length > 0,
    'all three interpolation kinds are in use',
    `scalar ${kinds.scalar.length}, step ${kinds.step.length} (${kinds.step.join(',')}), pose ${kinds.pose.join(',')}`);
  console.log(`        look ${tags.look.length}: ${tags.look.join(' ')}`);
  console.log(`        composition ${tags.composition.length}: ${tags.composition.join(' ')}`);
  console.log(`        view ${tags.view.length}: ${tags.view.join(' ')}`);

  // This row used to assert the opposite: `!('mode' in declared)`, on the reasoning
  // that a mode key would rewrite twelve other tracks at the instant it fired. That
  // reasoning was about the twelve values `setMode` bundled in, not about the reading,
  // and unbundling it removed both the bundle and the objection. The row is inverted
  // rather than deleted because the property is still worth pinning down - it is just
  // the other property now, and a build that reintroduced an integer mode beside the
  // weights would fail here.
  check(!('mode' in declared), 'there is no mode parameter left to keyframe against');
  const readings = await page.evaluate('globalThis.__kinect.readings()');
  const missing = readings.filter((n) => !(n in declared));
  check(readings.length > 0 && missing.length === 0,
    'every reading is a registry parameter',
    missing.length ? `not declared: ${missing.join(', ')}` : readings.join(' '));
  // Scalar and look, both load-bearing and for different reasons. `step` would hold
  // until the next key, which is a reading that snaps rather than dissolves - the one
  // capability this change exists to add. And `view` would keep them out of a preset
  // and out of the undo snapshot, which is where the mode effectively sat.
  const wrongSpec = readings.filter((n) => declared[n].kind !== 'scalar' || declared[n].tag !== 'look');
  check(wrongSpec.length === 0,
    'and each one is a look-tagged scalar, so it presets and it dissolves',
    wrongSpec.length ? wrongSpec.map((n) => `${n} kind=${declared[n].kind} tag=${declared[n].tag}`).join('; ')
      : `${readings.length} readings`);
}

// ================================== 2b. the write path refuses what it cannot hold

// `params.apply(JSON.parse(projectFile))` is the path this registry advertises, so
// the values that arrive there are the ones worth being hostile about. A coercion
// that turns a truncated or hand-edited project into a plausible-looking look is
// worse than a throw, because nothing downstream can tell it happened.
console.log('\n[registry] bad values are refused rather than coerced');
{
  // Each case is JS source evaluated in the page rather than a value serialised
  // into it. That is not fussiness: JSON.stringify turns NaN and undefined into
  // null, so a table of literals would quietly test null three times over while its
  // labels claimed otherwise - an instrument lying about what it just proved.
  const REJECT = [
    ['camera', '{ position: [1, 2], quaternion: [0, 0, 0, 1], fov: 50 }', 'a short position'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0], fov: 50 }', 'a short quaternion'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1] }', 'no fov at all'],
    ['camera', "{ position: ['1', '2', '3'], quaternion: [0, 0, 0, 1], fov: 50 }", 'strings for a position'],
    ['camera', '{ position: [1, 2, NaN], quaternion: [0, 0, 0, 1], fov: 50 }', 'a NaN component'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: NaN }', 'a NaN fov'],
    ['camera', 'null', 'null for a pose'],
    ['bloom', 'null', 'null for a scalar'],
    ['bloom', "''", 'an empty string for a scalar'],
    ['bloom', "'1.5'", 'a numeric string for a scalar'],
    ['bloom', 'NaN', 'NaN for a scalar'],
    ['bloom', 'undefined', 'a missing value for a scalar'],
    ['additive', 'null', 'null for a step'],
    ['additive', "'false'", 'the string "false" for a step'],
    ['additive', '1', 'a number for a step'],
    ['additive', 'undefined', 'a missing value for a step'],
  ];
  const ACCEPT = [
    ['camera', JSON.stringify(SCRAMBLE.camera)],
    ['bloom', '1.5'],
    ['additive', 'true'],
  ];
  const asCases = (rows) => rows
    .map(([name, expr]) => `{ name: ${JSON.stringify(name)}, value: ${expr} }`)
    .join(', ');

  const outcome = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const out = { rejected: [], leaked: [], accepted: [], camera: null };
    for (const { name, value } of [${asCases(REJECT)}]) {
      const before = JSON.stringify(k.params.get(name));
      let threw = false;
      try { k.params.set(name, value); } catch { threw = true; }
      out.rejected.push(threw);
      // A refusal that had already written half of itself would be worse than the
      // coercion it replaced, so the stored value has to be untouched.
      if (JSON.stringify(k.params.get(name)) !== before) out.leaked.push(name);
    }
    for (const { name, value } of [${asCases(ACCEPT)}]) {
      let ok = false;
      try { k.params.set(name, value); ok = true; } catch (e) { ok = String(e); }
      out.accepted.push(ok);
    }
    out.camera = [...k.programCamera.position.toArray(), k.programCamera.fov, k.programCamera.projectionMatrix.elements[0]];
    k.params.reset();
    return out;
  })()`);

  const missed = REJECT.filter((_, i) => !outcome.rejected[i]).map(([n, , why]) => `${n}: ${why}`);
  check(missed.length === 0, `all ${REJECT.length} malformed values throw`, missed.join('; '));
  check(outcome.leaked.length === 0, 'and a refusal writes nothing at all', outcome.leaked.join(' '));
  check(outcome.accepted.every((x) => x === true), 'while well-formed values still go through',
    outcome.accepted.filter((x) => x !== true).join('; '));
  // NaN reaching the pose is the specific failure this guards: it never throws, it
  // just poisons the projection matrix, and live viewing hides it because the next
  // frame rewrites the pose from program time.
  check(outcome.camera.every(Number.isFinite), 'and nothing left NaN on the camera', show(outcome.camera));
}

console.log('\n[registry] a serialised project is document state, never view state');
{
  const sets = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      byDefault: Object.keys(k.params.values()),
      everything: Object.keys(k.params.values(k.params.names())),
      look: k.params.names('look'),
      view: k.params.names('view'),
      composition: k.params.names('composition'),
    };
  })()`);
  const leaked = sets.view.filter((n) => sets.byDefault.includes(n));
  check(leaked.length === 0,
    'values() leaves view state out, so an undo snapshot cannot swallow it', leaked.join(' '));
  check(sets.composition.every((n) => sets.byDefault.includes(n))
    && sets.look.every((n) => sets.byDefault.includes(n)),
    `and carries all ${sets.look.length} look and ${sets.composition.length} composition parameters`);
  check(sets.everything.length === sets.byDefault.length + sets.view.length,
    'while view state is still reachable by naming it', `${sets.everything.length} named explicitly`);
}

// ================================================== 3. the HTML holds no data

console.log('\n[registry] the panel carries no parameter data of its own');
{
  // The strong form of this row, and it had to become the strong form: the panel's rows
  // are generated from the registry now, so no registry-owned input appears in the
  // markup at all - and the old row, which kept the inputs whose id is a parameter and
  // asserted none of them carried a range, passed on an empty set having examined
  // nothing. A row that cannot fail is worse than no row, because it reads as coverage.
  //
  // So the claim is the one generation actually makes, with the count printed beside it
  // and a floor under the scan for the same reason `syntax-check` refuses to pass on
  // finding no files: a regex that stopped matching `<input` would otherwise report a
  // clean panel about nothing. What the markup still legitimately carries is the sensor
  // and monitor controls, the retime slider, the export name and the preset file picker -
  // eight, none of them registry-owned - and the floor sits well under that deliberately,
  // because this row is about the scan working rather than about the number. A gate set at
  // exactly today's count would fail the next honest markup edit, which is the zero-margin
  // threshold this repo has already been bitten by once.
  //
  // The second clause is the sharper half. `id="..."` is matched with double quotes, so an
  // input written with single quotes would parse as having no id, drop out of the owned
  // comparison, and be reported as a clean panel - the regex failing in precisely the
  // direction that looks like a pass. Every input tag has to yield an id or the scan is
  // not reading what it claims to read.
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  const owned = new Set(Object.keys(declared));
  const tags = html.match(/<input[^>]*>/g) ?? [];
  const ids = tags.map((tag) => tag.match(/id="([^"]+)"/)?.[1]).filter(Boolean);
  const MARKUP_INPUT_FLOOR = 4;
  check(tags.length >= MARKUP_INPUT_FLOOR && ids.length === tags.length,
    `the markup scan found the inputs it is supposed to read (${tags.length} of at least ${MARKUP_INPUT_FLOOR}, all with ids)`,
    `${ids.join(' ')}`);
  const inMarkup = ids.filter((id) => owned.has(id));
  check(inMarkup.length === 0,
    `no registry-owned input is written in the markup at all - every one of the ${owned.size} `
    + 'is generated from the registry, so there is no second copy of a range to drift',
    inMarkup.join(' '));

  const stamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const out = {};
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) { out[name] = null; continue; }
      out[name] = el.type === 'checkbox'
        ? { checked: el.checked }
        : { min: el.min, max: el.max, step: el.step, value: el.value,
            out: el.parentElement.querySelector('output')?.textContent };
    }
    return out;
  })()`);
  const wrong = [];
  for (const [name, spec] of Object.entries(declared)) {
    const el = stamped[name];
    if (spec.tag === 'composition') {
      if (el !== null) wrong.push(`${name} is composition but has a control`);
      continue;
    }
    if (el === null) { wrong.push(`${name} has no control`); continue; }
    if ('checked' in el) {
      if (el.checked !== spec.default) wrong.push(`${name} checked=${el.checked} want ${spec.default}`);
      continue;
    }
    if (el.min !== String(spec.min) || el.max !== String(spec.max) || el.step !== String(spec.step)) {
      wrong.push(`${name} range ${el.min}..${el.max}/${el.step} want ${spec.min}..${spec.max}/${spec.step}`);
    }
    if (el.value !== String(spec.default)) wrong.push(`${name} value=${el.value} want ${spec.default}`);
    if (el.out !== String(spec.default)) wrong.push(`${name} readout=${el.out} want ${spec.default}`);
  }
  check(wrong.length === 0, 'every control has its range, default and readout stamped from the registry', wrong.join('; '));
}

// ========================================================== 4. every value lands

console.log('\n[registry] every parameter round-trips to where the renderer reads it');
{
  const probe = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    return { values: k.params.values(k.params.names()), landing: ${landingReader} };
  })()`);

  const wrong = [];
  for (const [name, value] of Object.entries(SCRAMBLE)) {
    const { values, landing } = await probe({ [name]: value });
    if (!eq(values[name], value)) {
      wrong.push(`${name} stored ${show(values[name])} not ${show(value)}`);
      continue;
    }
    const want = EXPECT[name](values[name], values);
    if (!eq(landing[name], want)) wrong.push(`${name} landed ${show(landing[name])} want ${show(want)}`);
  }
  check(wrong.length === 0, `all ${Object.keys(SCRAMBLE).length} parameters land one at a time`, wrong.join('; '));

  // The whole set at once, so a parameter that only lands when nothing else moved
  // does not slip through.
  const { values, landing } = await probe(SCRAMBLE);
  const together = Object.keys(SCRAMBLE)
    .filter((n) => !eq(landing[n], EXPECT[n](values[n], values)))
    .map((n) => `${n}=${show(landing[n])}`);
  check(together.length === 0, 'and all of them at once', together.join('; '));
}

console.log('\n[registry] the side effects that are not a uniform write');
{
  const setAndRead = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    return {
      drawRange: k.geometry.drawRange.count,
      bloom: k.bloom.enabled, trails: k.afterimage.enabled, grade: k.grade.enabled,
      blending: k.material.blending, depthWrite: k.material.depthWrite, softEdge: k.uniforms.softEdge.value,
      buffer: [k.renderer.getContext().drawingBufferWidth, k.renderer.getContext().drawingBufferHeight],
    };
  })()`);

  // The ghost half of the geometry is drawn when either persistence term can shed
  // and left out of the draw range when neither can, so the matrix is the test.
  const range = [];
  for (const [fade, wake, want] of [[0, 0, POINTS], [10, 0, POINTS * 2], [0, 10, POINTS * 2], [120, 550, POINTS * 2]]) {
    const r = await setAndRead({ fade, wake });
    if (r.drawRange !== want) range.push(`fade=${fade} wake=${wake} -> ${r.drawRange} want ${want}`);
  }
  check(range.length === 0, 'fade and wake move the draw range together', range.join('; '));

  const gates = [];
  for (const [values, want] of [
    [{ bloom: 0, trails: 0, rgbSplit: 0, scanlines: 0, grain: 0, vignette: 0 }, { bloom: false, trails: false, grade: false }],
    [{ bloom: 0.05 }, { bloom: true, trails: false, grade: false }],
    [{ trails: 0.01 }, { bloom: false, trails: true, grade: false }],
    [{ rgbSplit: 0.05 }, { bloom: false, trails: false, grade: true }],
    [{ scanlines: 0.01 }, { bloom: false, trails: false, grade: true }],
    [{ grain: 0.01 }, { bloom: false, trails: false, grade: true }],
    // The fourth term sharing that pass, and the one that used to ride on the other
    // three: raised on its own it has to bring the pass up by itself, or the vignette
    // is back to being a thing you can only have by asking for something else.
    [{ vignette: 0.01 }, { bloom: false, trails: false, grade: true }],
    // The fifth term in that pass, and the only one whose expectation is `false`. `crush`
    // shares the grade and deliberately does not gate it, so this row is the negative
    // asserted rather than left as an omission - an omission would pass on a build that
    // gated it, and gating it is the tempting edit, because every neighbour above does.
    //
    // What it would cost is why the row is worth its line. The toe defaults to 0.018 and
    // not to 0, so `crush > 0` is true of every document there has ever been: the pass
    // would run for the four shipped presets that ask for no grade at all, each paying a
    // full-screen read and write to be put through a Reinhard curve nobody graded them
    // through, and section 1b would redden on all five readings at once against a build
    // from before the registry existed.
    [{ crush: 0.5 }, { bloom: false, trails: false, grade: false }],
    // The raster's three settings, on `crush`'s terms and each for its own reason. The
    // pitch is the one that would fail loudest if it gated, since it defaults to 1.3 and
    // so is non-zero in every document there has ever been; the angle and the hardness
    // would merely switch a full-screen pass on to rotate and square a raster whose master
    // is off, which is the no-op this row exists to refuse. All three are settings of
    // `scanlines`, and the pass is the master's to gate.
    [{ scanAngle: 90 }, { bloom: false, trails: false, grade: false }],
    [{ scanPitch: 6 }, { bloom: false, trails: false, grade: false }],
    [{ scanHard: 1 }, { bloom: false, trails: false, grade: false }],
  ]) {
    const r = await setAndRead(values);
    const got = { bloom: r.bloom, trails: r.trails, grade: r.grade };
    if (!eq(got, want)) gates.push(`${show(values)} -> ${show(got)} want ${show(want)}`);
  }
  check(gates.length === 0, 'a zero value switches its pass off rather than running it as a no-op', gates.join('; '));

  const blend = [];
  for (const on of [true, false]) {
    const r = await setAndRead({ additive: on });
    const want = { blending: on ? ADDITIVE_BLENDING : NORMAL_BLENDING, depthWrite: !on, softEdge: on ? 1 : 0 };
    const got = { blending: r.blending, depthWrite: r.depthWrite, softEdge: r.softEdge };
    if (!eq(got, want)) blend.push(`additive=${on} -> ${show(got)} want ${show(want)}`);
  }
  check(blend.length === 0, 'additive drives blending, depth write and the sprite falloff together', blend.join('; '));

  const scales = [];
  for (const v of [40, 100, 200]) {
    const r = await setAndRead({ renderScale: v });
    const want = [
      Math.floor(RENDER_BUFFER.width * v / 100),
      Math.floor(RENDER_BUFFER.height * v / 100),
    ];
    if (!eq(r.buffer, want)) scales.push(`renderScale=${v} -> ${show(r.buffer)} want ${show(want)}`);
  }
  check(scales.length === 0, 'render scale resizes the drawing buffer', scales.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ============================================================ 5. the UI is a view

console.log('\n[registry] the panel is a view, in both directions');
{
  // Direction one: the control moves, the registry follows. The event is the one a
  // drag produces - `input` on a range, `change` on a checkbox - so this exercises
  // the listener the user reaches, not a function the check picked.
  const fromControl = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const spec = k.params.spec(name);
      if (el.type === 'checkbox') {
        el.checked = !spec.default;
        el.dispatchEvent(new Event('change'));
        if (k.params.get(name) !== !spec.default) wrong.push(name + ' -> ' + k.params.get(name));
        continue;
      }
      const target = ${JSON.stringify(SCRAMBLE)}[name];
      el.value = String(target);
      el.dispatchEvent(new Event('input'));
      if (k.params.get(name) !== target) wrong.push(name + ' -> ' + k.params.get(name));
    }
    return wrong;
  })()`);
  check(fromControl.length === 0, 'moving a control writes the registry', fromControl.join('; '));

  // Direction two: the registry moves, the control and its readout follow. This is
  // the direction a keyframe, a preset and a restored project all arrive from, and
  // a panel that did not follow would show the previous look while rendering the
  // new one.
  const fromRegistry = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const value = ${JSON.stringify(SCRAMBLE)}[name];
      k.params.set(name, value);
      if (el.type === 'checkbox') {
        if (el.checked !== value) wrong.push(name + ' checkbox=' + el.checked);
        continue;
      }
      if (el.value !== String(value)) wrong.push(name + ' slider=' + el.value + ' want ' + value);
      const out = el.parentElement.querySelector('output');
      if (out && out.textContent !== String(value)) wrong.push(name + ' readout=' + out.textContent);
    }
    return wrong;
  })()`);
  check(fromRegistry.length === 0, 'writing the registry moves the control and its readout', fromRegistry.join('; '));

  // Out of range and off the step grid, from both sides. The registry has to do the
  // clamping and snapping itself rather than lean on the DOM for it, or a value set
  // headlessly by step 6 lands on the uniform unsnapped while the same value set
  // through a slider lands snapped, and the panel and the image disagree.
  const clamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el || el.type === 'checkbox') continue;
      const spec = k.params.spec(name);
      // Below, above, a value that rounds down, and a tie that has to round up -
      // the tie is the one where the registry's arithmetic and the browser's
      // step alignment could part company without either looking wrong.
      for (const raw of [spec.min - 1000, spec.max + 1000, spec.min + spec.step * 0.4, spec.min + spec.step * 6.5]) {
        const stored = k.params.set(name, raw);
        if (stored < spec.min || stored > spec.max) wrong.push(name + ' ' + raw + ' -> ' + stored);
        else if (el.value !== String(stored)) wrong.push(name + ' ' + raw + ' -> registry ' + stored + ', slider ' + el.value);
      }
    }
    return wrong;
  })()`);
  check(clamped.length === 0, 'out-of-range and off-grid values clamp and snap the same way the slider does', clamped.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ================================================ 6. presets are user actions only

console.log('\n[registry] a preset can only be applied by a user action');
{
  // A look to apply, written here rather than taken from the page. It used to be
  // `k.presets.BLACKWALL`, a hardcoded constant the module exported for this and for
  // `setMode` to bundle in - and the bundling is what the readings replaced, so the
  // constant went with it. A preset is a document now, and what this section is about
  // is the guard rather than any particular look, so two values are enough.
  const A_LOOK = { bloom: 0.5, trails: 0.5 };

  const guard = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();

    // Outside evaluation it has to work, or the check below would pass on a
    // preset path that was simply broken.
    let outside = 'applied';
    try { k.applyPreset(${JSON.stringify(A_LOOK)}); } catch (e) { outside = String(e); }
    const applied = k.params.get('bloom');
    k.params.reset();

    // Inside one, it has to refuse. The probe rides three's own pre-render hook,
    // which fires from inside renderProgramFrame, so this is the timeline calling
    // rather than the check pretending to be it.
    const seen = {};
    k.scene.onBeforeRender = () => {
      k.scene.onBeforeRender = () => {};
      try { k.applyPreset(${JSON.stringify(A_LOOK)}); seen.preset = 'applied'; }
      catch (e) { seen.preset = 'refused'; }
      // An ordinary parameter write must stay legal: that is exactly what step 5's
      // tracks do every frame, and what the camera already does.
      try { k.params.set('bloom', 0.25); seen.param = 'written'; }
      catch (e) { seen.param = String(e); }
      // And a reading is one of those writes now. This row used to be its opposite -
      // "selecting a mode during evaluation is refused" - and the inversion is the
      // capability rather than a relaxed guard: a mode was refused *because* selecting
      // one applied a twelve-value preset behind it, so it could never be a track. A
      // reading writes one number, which is what a track does every frame, so refusing
      // it here would be refusing the dissolve this change exists to allow.
      try { k.params.set('readBlackwall', 1); seen.reading = 'written'; }
      catch (e) { seen.reading = String(e); }
    };
    k.drive.stepTo(0);
    k.scene.onBeforeRender = () => {};

    return { outside, applied, seen, bloomAfter: k.params.get('bloom'), readingAfter: k.params.get('readBlackwall') };
  })()`);

  check(guard.outside === 'applied' && guard.applied === 0.5,
    'applying a preset outside evaluation writes it', `bloom=${guard.applied}`);
  check(guard.seen.preset === 'refused', 'applying a preset during evaluation is refused', show(guard.seen.preset));
  check(guard.seen.param === 'written' && guard.bloomAfter === 0.25,
    'an ordinary parameter write during evaluation still works', `bloom=${guard.bloomAfter}`);
  check(guard.seen.reading === 'written' && guard.readingAfter === 1,
    'and a reading is an ordinary write, so a track can dissolve one under the playhead',
    `readBlackwall=${guard.readingAfter}`);

  // What a preset carries is the look tag and nothing else, so the tag has to be
  // the thing that selects it rather than a label beside a hand-written list.
  const selection = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const chosen = k.params.names('look');
    k.params.set('camera', ${JSON.stringify(SCRAMBLE.camera)});
    k.params.set('renderScale', 60);
    const captured = k.params.values(chosen);

    // Move everything, then apply the captured look back. A preset that moved the
    // camera would not be a preset, it would be a saved project.
    k.params.apply(${JSON.stringify(SCRAMBLE)});
    k.applyPreset(captured);
    return {
      chosen,
      captured: Object.keys(captured),
      camera: k.params.get('camera'),
      renderScale: k.params.get('renderScale'),
      bloom: k.params.get('bloom'),
      near: k.params.get('near'),
    };
  })()`);

  check(!selection.captured.includes('camera') && !selection.captured.includes('spin')
    && !selection.captured.includes('renderScale'),
    'the default preset selection is the look tag, so composition and view stay out',
    `${selection.captured.length} parameters`);
  check(selection.captured.includes('near') && selection.captured.includes('far'),
    'and the depth clip is in it, as a look control whose default selection can be unpicked');
  check(eq(selection.camera, SCRAMBLE.camera),
    'applying a look leaves the camera exactly where it was', show(selection.camera.position));
  check(selection.renderScale === 85, 'and leaves view state to the viewer', `renderScale=${selection.renderScale}`);
  check(selection.bloom === 0 && selection.near === 0.05,
    'while the look values it does carry are written', `bloom=${selection.bloom} near=${selection.near}`);

  await page.evaluate('globalThis.__kinect.params.reset()');
}

// ============================================ 7. the render path writes the camera

console.log('\n[registry] the camera pose goes in through the registry, not around it');
{
  // Two keys a metre apart, so "moves with program time" is a claim about a track
  // rather than about a placeholder that happened to animate. The wild pose is
  // written first and has to lose: with keys on the track the evaluator overwrites
  // it, which is the property that makes a keyed parameter keyed at all.
  const camera = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const wild = ${JSON.stringify(SCRAMBLE.camera)};
    k.params.set('camera', wild);
    const written = [k.params.get('camera'), k.programCamera.position.toArray()];

    const q = [0, 0, 0, 1];
    k.keyframes.setTracks({ camera: [
      { t: 0, value: { position: [-1, 0.2, 1], quaternion: q, fov: 50 } },
      { t: 2, value: { position: [1, 0.2, 1], quaternion: q, fov: 50 } },
    ] });

    k.drive.reset();
    k.drive.stepTo(0.4);
    const stored = k.params.get('camera');
    const onCamera = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
    k.drive.stepTo(0.9);
    const later = k.params.get('camera');
    k.keyframes.setTracks({});
    return { written, stored, onCamera, later };
  })()`);

  check(eq(camera.written[0], SCRAMBLE.camera) && eq(camera.written[1], SCRAMBLE.camera.position),
    'a pose written through the registry reaches the camera object');
  // The load-bearing one. If the render path posed the camera directly, the
  // registry would still be holding the wild pose while the camera had moved -
  // so agreement here is what says the write goes through the registry.
  check(eq(camera.stored, camera.onCamera),
    'after a render the registry holds the pose the camera is actually at',
    `${show(camera.stored.position)} vs ${show(camera.onCamera.position)}`);
  check(!eq(camera.stored.position, SCRAMBLE.camera.position),
    'and it is the pose the track asked for, not the one the check wrote');
  check(!eq(camera.stored.position, camera.later.position),
    'and it moves with program time', `${show(camera.stored.position)} -> ${show(camera.later.position)}`);
}

// ============================== 8. serialise, restore, and the same pixels back

console.log('\n[registry] serialise, restore, and the image comes back byte for byte');

// The reading the sweep runs in is now part of the scrambled set rather than a click
// that precedes it, and that is a repair rather than a translation. This used to click
// the Blackwall button, because `scan` and `rim` reach the shader only inside that
// branch and a sweep run in RGB would have found them inert - a real hole, correctly
// closed for the parameters that existed then. The same hole reopened wider the moment
// the readings became parameters: `params.reset()` boots `readRgb` at 1, so a sweep
// that did not say otherwise would run entirely in RGB and record `scan`, `rim` and
// every future per-reading term as unable to touch a pixel.
//
// So `SCRAMBLE` carries all five readings non-zero, and every reading's block is live
// in every image the sweep hashes. That is the "what do all my arms agree about"
// question asked of this file's own sweep, which had exactly one arm and one answer.
await page.evaluate(async () => {
  const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
  globalThis.__kinect.drive.pin(buffer);
});

// And a colour image, because one parameter is only observable through one.
//
// `pin` above switches colour off - a JPEG decode is asynchronous and a pinned run that
// raced it would hash a frame whose colour had or had not arrived - so every point in
// every arm below draws the flat `vec3(0.7)` the shader falls back to. Saturation of a
// uniform grey is the identity at every value, so `rgbSaturation` would have come out of
// the drop-one sweep as a parameter that cannot reach a pixel: a probe standing in a
// dead zone, reporting a clean pass on a build that had the term backwards.
//
// Four saturated pixels rather than a photograph, and the bytes live here rather than in
// the page so this arm owns its own input. Both samplers are pointed at the one texture,
// so nothing depends on which side of the pair `mixT` favours at a given position.
await page.evaluate(`globalThis.__kinect.drive.plantColor(${JSON.stringify([
  220, 30, 40, 255, 30, 200, 90, 255,
  40, 70, 230, 255, 230, 200, 40, 255,
])}, 2, 2)`);
// Asserted rather than assumed, because the arm it exists for is a *negative* result
// otherwise: a plant that silently failed leaves the grey behind, `rgbSaturation` lands
// in the no-effect bucket, and the sweep reports a parameter that cannot reach a pixel
// as though it had measured one.
{
  const planted = await page.evaluate('globalThis.__kinect.uniforms.hasColor.value');
  check(planted === 1,
    'the sweep runs against a colour image, so a colour term is not measured on grey',
    `hasColor ${planted}`);
}

const positions = await page.evaluate(`(() => {
  const times = globalThis.__kinect.drive.times();
  const out = [];
  for (let i = 0; i < times.length - 1; i++) {
    for (let r = 0; r < ${SUBSTEPS}; r++) out.push(times[i] + (times[i + 1] - times[i]) * (r / ${SUBSTEPS}));
  }
  return out;
})()`);

const runWith = `async ({ values, positions }) => {
  ${PAGE_HELPERS}
  k.params.reset();
  k.params.apply(values);
  k.drive.reset();
  pinCamera(k.freeCamera);
  const out = [];
  for (const t of positions) {
    k.drive.stepTo(t);
    out.push(await sha256(k.drive.readPixels()));
  }
  return out;
}`;
const run = (values) => page.evaluate(`(${runWith})(${JSON.stringify({ values, positions })})`);

const serialised = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  k.params.reset();
  k.params.apply(${JSON.stringify(SCRAMBLE)});
  return JSON.parse(JSON.stringify(k.params.values(k.params.names())));
})()`);

const defaults = await page.evaluate(
  "(() => { const k = globalThis.__kinect; k.params.reset(); return JSON.parse(JSON.stringify(k.params.values(k.params.names()))); })()");

const scrambledRun = await run(SCRAMBLE);
const defaultRun = await run(defaults);
const restoredRun = await run(serialised);

console.log(`  ${positions.length} images per run over `
  + `${positions[0].toFixed(3)}s to ${positions[positions.length - 1].toFixed(3)}s, `
  + `${new Set(scrambledRun).size} of them distinct`);

check(eq(scrambledRun, restoredRun),
  'the restored set reproduces the run exactly',
  eq(scrambledRun, restoredRun) ? '' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== restoredRun[i])}`);
// Strictly equal, not merely the same size: every value here is already on its
// own step grid, so anything the registry did to one of them on the way in and
// back out is a normalisation bug rather than a rounding it was asked for.
check(eq(serialised, JSON.parse(JSON.stringify(SCRAMBLE))),
  `the serialised set is the scrambled set, value for value (${Object.keys(serialised).length} parameters)`,
  Object.keys(SCRAMBLE).filter((n) => !eq(serialised[n], SCRAMBLE[n]))
    .map((n) => `${n}: ${show(serialised[n])} not ${show(SCRAMBLE[n])}`).join('; '));
// The blunt control: if the registry were not driving the renderer at all, the
// defaults would render the same images as the scrambled set and the equality
// above would be arithmetic rather than evidence.
check(!eq(scrambledRun, defaultRun), 'and the defaults do not - the registry is what the image depends on');
check(new Set(scrambledRun).size > positions.length / 2, 'the input moves across the run');

// =================================== 8b. the mix is a mix, and it normalises

// **The one property this file could not otherwise fail on, and it needed an oracle
// nothing else here provides.** Section 1b compares each reading against the revision
// before the weights existed, which is the strongest evidence available for a *single*
// reading - and it is silent about mixing by construction, because a single reading at
// 1.0 divides by 1.0 and any normalisation whatsoever is the identity there. Section 8
// above compares a build against itself, so a build that mixed wrongly but consistently
// reproduces its own run exactly and passes. The old build cannot mix at all, so there
// is no earlier revision to hash against either.
//
// What is left is an identity the correct implementation satisfies and a wrong one does
// not: the weights are a ratio, so scaling all of them by any constant must render the
// *same image*. sum(k*w*c) / sum(k*w) cancels the k. A build dividing by a constant
// instead of by the sum, or by the number of live readings, changes brightness the
// moment the scale changes - while staying bit-identical on every single-reading arm,
// which is exactly the shape section 1b cannot see.
console.log('\n[registry] the readings mix as a ratio, so their scale cancels');
{
  // Deliberately not equal to each other and deliberately not summing to 1, so neither
  // a build that ignored the denominator nor one that assumed the weights were already
  // normalised can agree with the correct answer by luck.
  const RATIO = { readRgb: 0.4, readDepth: 0.3, readGhost: 0.2, readContour: 0, readBlackwall: 0 };
  const scaled = (k) => Object.fromEntries(Object.entries(RATIO).map(([n, v]) => [n, v * k]));

  const atOne = await run(scaled(1));
  const atTwo = await run(scaled(2));
  check(eq(atOne, atTwo),
    'doubling every weight renders the identical image, because a ratio has no scale',
    eq(atOne, atTwo) ? `${atOne.length} frames` : `first divergence at image ${atOne.findIndex((h, i) => h !== atTwo[i])}`);

  // And the control for that row, because two identical images prove nothing if the
  // weights reach no pixel: the mix has to differ from each of the readings it is made
  // of. Without this, a build that ignored the weights entirely would pass the row
  // above perfectly - it renders the same image for every input, which is the strongest
  // possible form of "the scale cancels".
  const solo = {};
  for (const name of Object.keys(RATIO)) {
    solo[name] = await run({ ...Object.fromEntries(Object.keys(RATIO).map((n) => [n, 0])), [name]: 1 });
  }
  const sameAsSolo = Object.keys(RATIO).filter((n) => eq(atOne, solo[n]));
  check(sameAsSolo.length === 0,
    'and the mix is none of the readings it is made of',
    sameAsSolo.length ? `identical to ${sameAsSolo.join(', ')} alone` : 'distinct from all five');
}

console.log('\n[registry] the falsification control: each parameter left out of the restore in turn');
{
  const noEffect = [];
  const changed = [];
  for (const name of Object.keys(serialised)) {
    const partial = { ...serialised };
    delete partial[name];
    const hashes = await run(partial);
    if (eq(hashes, scrambledRun)) noEffect.push(name);
    else changed.push(name);
  }
  console.log(`  omitting any of these changed the image: ${changed.join(' ')}`);
  const unexplained = noEffect.filter((n) => !(n in NO_PIXEL_EFFECT));
  for (const name of noEffect.filter((n) => n in NO_PIXEL_EFFECT)) {
    console.log(`  ${name} left the image unchanged, as declared: ${NO_PIXEL_EFFECT[name]}`);
  }
  check(unexplained.length === 0,
    `every parameter outside the declared exceptions changes the image when it is dropped`,
    unexplained.length ? `unexplained: ${unexplained.join(' ')}` : '');
  check(changed.length > 0 && noEffect.length === Object.keys(NO_PIXEL_EFFECT).length,
    `${changed.length} of ${Object.keys(serialised).length} parameters are proven to reach the pixels`);
}

// The switch that gates the crop, which the sweep above declares it cannot see: it is
// scrambled to its default so the six faces it gates stay observable, and dropping a
// parameter that is already at its default changes nothing. So it is proven here
// instead, and the second row is the one that carries the design decision.
//
// **`crop` covers all six faces and not the four lateral ones.** That was very nearly
// got wrong on the grounds that `nearClip`/`farClip` also normalise the depth ramp, so
// releasing them would re-grade every point still inside the box - which is true of a
// switch that opened the values and false of this one, because it gates the discard and
// leaves the uniforms where the document put them. The second row is what keeps the
// design honest under a later edit: it authors nothing but the depth pair, so the only
// thing the switch has left to release is `near` and `far`.
console.log('\n[registry] the crop switch, which the sweep above cannot see');
{
  const released = await run({ ...SCRAMBLE, crop: false });
  check(!eq(scrambledRun, released),
    'releasing the crop changes the image, against the six faces the scrambled set authors',
    eq(scrambledRun, released) ? 'identical' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== released[i])}`);

  // The scrambled set with the four lateral faces put back to their own defaults, which
  // are their bounds - so the only thing the switch has left to release is the depth
  // pair. The bounds are read off the registry rather than named here, which would be
  // this file carrying a second copy of `CROP_LIMIT`.
  //
  // **The rest of the scrambled look comes along, and that is a repair.** The arm was
  // written as `{ near, far }` alone, which leaves every reading at its default - one
  // source, `readRgb`, carrying the whole image. `--mutate rgb-contributes-no-alpha`
  // then renders black on both arms, they compare identical, and this row fired against
  // a mutation that has nothing to do with the crop. A probe lit by five readings cannot
  // be switched off by one of them.
  const depthOnly = {
    ...SCRAMBLE,
    left: defaults.left,
    right: defaults.right,
    bottom: defaults.bottom,
    top: defaults.top,
  };
  const depthBiting = await run(depthOnly);
  const depthReleased = await run({ ...depthOnly, crop: false });
  check(!eq(depthBiting, depthReleased),
    'and it reaches the depth pair, not only the four lateral faces',
    eq(depthBiting, depthReleased) ? 'identical with only near/far authored' : 'the box releases in depth too');

  // The control for both rows. Two images that differ prove the switch does something;
  // they do not prove it does the *right* thing, and the thing it must not do is move
  // the planes. A build whose release opened `nearClip`/`farClip` instead of skipping
  // the test would pass both rows above and fail this one, because the depth ramp is
  // normalised against those two uniforms and every surviving point would be recoloured.
  const landing = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.set('near', ${SCRAMBLE.near});
    k.params.set('far', ${SCRAMBLE.far});
    k.params.set('crop', false);
    const off = [k.uniforms.nearClip.value, k.uniforms.farClip.value];
    k.params.set('crop', true);
    return { off, on: [k.uniforms.nearClip.value, k.uniforms.farClip.value] };
  })()`);
  check(eq(landing.off, landing.on) && eq(landing.on, [SCRAMBLE.near, SCRAMBLE.far]),
    'and it releases by not testing rather than by moving the planes, so the depth ramp is unchanged',
    `nearClip/farClip released ${JSON.stringify(landing.off)}, applied ${JSON.stringify(landing.on)}`);
}

// ------------------------------------------------------------------- verdict

if (main.errors.length) {
  console.log(`\n[registry] page errors:\n  ${main.errors.join('\n  ')}`);
  failures++;
}

await browser.close();

if (MUTATE) {
  // Three outcomes, three exit codes, because two of them are routinely confused for
  // each other. `registration-check` reserves 2 for "the harness did not run" on the
  // same reasoning and this joins it rather than inventing a fourth convention: a
  // mutation that failed to compile, or a Playwright page that died, is not a mutation
  // that was caught, and the difference is invisible to anything reading exit codes
  // alone. The rows above are the answer - read which ones fired, not how many.
  const caught = failures > 0;
  console.log(`\n[registry] mutation ${MUTATE} ${caught
    ? `caught, as required (${failures} assertions fired)`
    : 'NOT CAUGHT'}`);
  console.log(`           it should redden: ${MUTATIONS[MUTATE].fails}`);
  process.exit(caught ? 0 : 1);
}

console.log(`\n[registry] ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
