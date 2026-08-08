// Proves the keyframe layer: that the three interpolation kinds are the curves the
// design names, that evaluating at a program position writes those values through
// the registry, that the retime curve maps program time to source time including a
// hold, that the pre-roll a curve needs is a window on it rather than a tangent,
// and that undo restores the document and never the view.
//
// Six claims, separated because they fail for different reasons.
//
// **The interpolations are the curves, not curves.** Every expected value here is
// computed by this tool from its own implementation, never read back from the page
// and compared to itself. Each kind carries a falsification control that has to
// *disagree*: an eased scalar against a straight lerp, a step against a lerp, a
// Catmull-Rom against a straight line. Without those a check would pass on a page
// that lerped everything, since a lerp agrees with every other interpolation at
// the keys and this would only ever be sampling near them if nobody said otherwise.
// The Catmull-Rom also gets an anchor rather than only a control: on evenly spaced
// keys the non-uniform form the page implements must equal the textbook uniform
// formula exactly, which ties it to something outside both implementations.
//
// **Evaluation goes through the registry and asks for nothing.** The values have
// to arrive on `params.get`, and the evaluation must schedule no seek - an
// evaluator that announced its writes would have each render schedule a repaint
// which renders which schedules more, and the symptom is a tab that gets slower
// rather than an error. Counted, not assumed.
//
// **A keyframed look still seeks the way it plays.** Step 4's central property
// with tracks moving under it, and the pre-roll still has to suffice.
//
// **The retime curve, including a hold.** The mapping is checked against source
// times this tool computes from the index it fetched itself, and the pre-roll's
// window query is checked against this tool's own walk over its own curve. The
// hold is the case the old slope-at-a-point arithmetic answered "no frames needed"
// for, so the number it would have produced is printed beside the one the window
// gives, and a seek run at the old number has to land somewhere else.
//
// **Undo is document state and only document state.** Orbiting, scrubbing and
// dropping render scale have to leave the stack untouched, and a slider drag has
// to push once on release rather than once per pointer move.
//
// **The editor's furniture is not in the frame.** The camera path, its nodes and
// the top-down draw on a canvas of their own, so the rendered image has to be
// byte-identical with them on and off. This is the check that keeps them there:
// the first version of this feature scissored a top-down into the render buffer
// and it broke step 4's frame-identity claim.
//
//   node server/index.js --port 8080 --replay captures/sample.knct &
//   node tools/keyframe-check.mjs --url http://localhost:8080
//   node tools/keyframe-check.mjs --mutate pose-linear     # must FAIL
//
// The fixture is the sample capture and it is not a 30fps take: 284 frames over
// 30.36s, median gap 64ms, mean 9.32fps. Every source figure below is against that
// cadence rather than against an assumed even 33ms.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
const URL_BASE = flag('--url', 'http://localhost:8080');
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
const SHOTS = flag('--shots');

const STAGE = { width: 640, height: 400 };
// A first guess at the timeline strip; the real height is measured after load and the
// viewport corrected. See the resize below the goto.
const CHROME_H_GUESS = 148;

// How far apart two images may be and still count as the same landing, and how far
// apart a control has to be before its difference means anything. Between them is
// a band where a result proves nothing either way, and a run landing there fails
// rather than picking a side. Same two numbers as step 4, for the same reasons.
const SAME_MAX = 2;
const CONTROL_MIN = 16;
const CONTROL_MIN_PCT = 1.0;

// How close an evaluated value has to be to the one this tool computed. Both sides
// are doubles running the same arithmetic in different orders, so this is a float
// tolerance and nothing more - a wrong interpolation is wrong by hundredths.
const VALUE_EPS = 1e-9;
// Scalars land on the registry's step grid, so a comparison against an unsnapped
// expectation has to allow half a step. The snapping itself is step 3's claim.
const halfStep = (spec) => spec.step / 2 + 1e-9;

// ------------------------------------------------------------------- mutations
//
// Each breaks exactly one claim, and the tool refuses a mutation whose text it
// could not find exactly once - a replacement that silently matched nothing would
// run the unmutated page and be recorded as the check having missed a bug it was
// never shown.
const MUTATIONS = {
  // Ease handles stop bending the timing, so every scalar segment is a straight
  // lerp whatever its handles say.
  'ease-ignored': [[
    `function easeAt(a, b, x) {
  const u = easeParam(a[0], b[0], x);
  return bez(a[1], b[1], u);
}`,
    'function easeAt(a, b, x) { return x; }',
  ]],
  // A step track interpolates, which is the one thing a boolean cannot do.
  'step-lerps': [[
    `function stepAt(keys, t) {
  const i = keyBefore(keys, t);
  return keys[i < 0 ? 0 : i].value;
}`,
    `function stepAt(keys, t) {
  const i = keyBefore(keys, t);
  if (i < 0 || i >= keys.length - 1) return keys[i < 0 ? 0 : i].value;
  const u = (t - keys[i].t) / Math.max(1e-9, keys[i + 1].t - keys[i].t);
  return u < 0.5 ? keys[i].value : keys[i + 1].value;
}`,
  ]],
  // The camera corners on straight lines between its keys.
  'pose-linear': [[
    `  const position = [0, 1, 2].map((axis) => hermite(
    a.value.position[axis], b.value.position[axis],
    tangentAt(keys, i, axis), tangentAt(keys, i + 1, axis),
    span, u,
  ));`,
    `  const position = [0, 1, 2].map((axis) => a.value.position[axis]
    + (b.value.position[axis] - a.value.position[axis]) * u);`,
  ]],
  // The carried finding, put back: the pre-roll reads the slope at the target and
  // multiplies, instead of asking how far back the curve covers the span. A hold
  // then answers "no frames needed" for the case that needs the most.
  'preroll-slope-at-target': [[
    '    const back = retime.framesBackFor(programSec, surfaceSec, this.outputFps, this.lastFrame);',
    `    // Step 4's two lines restored verbatim, zero-slope branch and all: the slope
    // at a point times a frame count, and a hold answering "no frames needed" for
    // the case that needs the most. The window query goes unused, which is the
    // shape of the finding - a tangent has no window to ask about.
    const sourcePerFrame = Math.abs(retime.slopeAt(programSec)) / this.outputFps;
    const back = { frames: sourcePerFrame > 0 ? Math.ceil(surfaceSec / sourcePerFrame) : 0, covered: true };`,
  ]],
  // The retime stops being a curve and goes back to a constant slope.
  'retime-ignores-keys': [[
    `    if (keys.length === 1) return keys[0].value + (programSec - keys[0].t) * this.rate;
    return scalarAt(keys, programSec, EXTEND_ENDS);`,
    '    return programSec * this.rate;',
  ]],
  // The evaluator announces its writes, so every evaluated frame schedules an
  // accurate seek, which evaluates, which schedules more.
  'evaluator-repaints': [[
    `  withoutRepaint(() => {
    for (const track of tracks.values()) {
      if (track.keys.length === 0) continue;
      if (borrowed && borrowed.has(track.name)) continue;
      params.set(track.name, track.valueAt(t));
    }
  });`,
    `  for (const track of tracks.values()) {
    if (track.keys.length === 0) continue;
    if (borrowed && borrowed.has(track.name)) continue;
    params.set(track.name, track.valueAt(t));
  }`,
  ]],
  // The undo snapshot takes the whole registry rather than document state, so
  // dropping render scale for performance lands on the stack and pressing undo
  // puts it back.
  // Re-anchored for v3. The line this names moved into `serialiseProjectBody`'s `look`
  // block and grew an explicit tag argument, so the old text matched nothing and the
  // tool refused the mutation - correctly, and silently as far as anything reading only
  // the exit code was concerned. The claim is unchanged: the snapshot is document state,
  // so widening it to the whole registry has to be caught.
  'undo-includes-view': [[
    "      params: params.values(params.names('look')),",
    '      params: params.values(params.names()),',
  ]],
  // Undo pushes on every input event rather than on the end of the interaction, so
  // one slider drag is two hundred levels.
  // Re-anchored: the listener's local was renamed `el` to `input`, and a one-word rename
  // is enough to kill a control outright - this one proves that a slider drag is a single
  // undo step, and it had stopped running while reading as though it had. Caught by
  // `syntax-check`'s anchor row rather than by anybody noticing; `docs/instruments.md`
  // carries the case file.
  'undo-on-input': [[
    "      input.addEventListener('input', () => writeFromControl(name, Number(input.value)));",
    "      input.addEventListener('input', () => { writeFromControl(name, Number(input.value)); history.commit(); });",
  ]],
  // A seek plans its span once and never looks again, which is what the code did
  // before a curve could move under it. The hazard is older than step 5 - the speed
  // slider mutates `retime.rate` outside the transport's exclusive queue, so a
  // committed step 4 could hit it too - it is only far harder to reach without a
  // drag rewriting the curve on every pointer move.
  'seek-plans-once': [[
    `    let planned = this.planSeek(programSec, options.frames);
    for (let attempt = 0; !this.source.resident(planned.from, planned.to); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        // Overtaken, not broken. The hand that moved the curve has already queued a
        // repaint, so this operation is stale before it finishes and the useful
        // thing to do is stand down quietly rather than shout - a drag rewrites the
        // curve on every pointer move, and an error per move is an instrument
        // crying wolf at its own user. Asking for a repaint here is what makes the
        // quiet safe: it guarantees a successor, so standing down costs a frame
        // rather than leaving a stale image nobody could attribute to anything.
        this.overtaken++;
        if (this.overtaken > SEEK_OVERTAKEN_LIMIT) {
          this.overtaken = 0;
          throw new Error(
            \`\${SEEK_OVERTAKEN_LIMIT} seeks in a row were overtaken before they could land: \`
            + 'the span a seek plans is not becoming resident, which is not a moving curve',
          );
        }
        requestRepaint();
        return null;
      }
      await this.source.ensure(planned.from, planned.to);
      planned = this.planSeek(programSec, options.frames);
    }`,
    `    const planned = this.planSeek(programSec, options.frames);
    await this.source.ensure(planned.from, planned.to);`,
  ]],
  // The pre-roll goes back to reading the uniforms, which hold the look at wherever
  // the playhead was parked rather than the look at the target.
  // The surface half alone. It used to carry the trails half too, which made it two
  // claims in one mutation and left it stale the moment the trails half changed
  // shape - and a stale mutation is refused rather than run, which is the guard
  // working but not a catch. `trails-damp-at-target` is the trails half's own.
  'preroll-reads-uniforms': [[
    `    const surfaceSec = (valueAtProgram('fade', programSec)
      + valueAtProgram('wake', programSec)) / 1000;`,
    '    const surfaceSec = uniforms.fadeTime.value + uniforms.wakeTime.value;',
  ]],
  // The trails half of the pre-roll goes back to the closed form, which is the
  // product over the window only while damp is constant.
  'trails-damp-at-target': [[
    `    const back2 = this.trailsFramesBack(programSec);
    const trails = back2.frames;`,
    `    const dampNow = valueAtProgram('trails', programSec);
    const back2 = { covered: true };
    const trails = dampNow > 0 ? Math.ceil(Math.log(AFTERIMAGE_RESIDUAL) / Math.log(dampNow)) : 0;`,
  ]],
  // Orientation stops interpolating and holds the earlier key. Every quaternion is
  // still a unit quaternion and every key is still hit exactly, which is what made
  // this invisible while the test rotations were identities.
  'pose-no-slerp': [[
    `  slerpA.fromArray(a.value.quaternion);
  slerpB.fromArray(b.value.quaternion);
  slerpA.slerp(slerpB, u);`,
    '  slerpA.fromArray(a.value.quaternion);',
  ]],
  // The retime's editing doors stop holding a key inside its neighbours, so a drag
  // can author a curve that runs downhill.
  'retime-unclamped': [
    [`  const floor = i > 0 ? keys[i - 1].value : 0;
  const ceiling = i < keys.length - 1 ? keys[i + 1].value : timeline.source.duration;
  key.value = Math.max(floor, Math.min(ceiling, key.value));`,
      '  key.value = Math.max(0, Math.min(timeline.source.duration, key.value));'],
    ['      if (keys[i].value < keys[i - 1].value) {', '      if (false) {'],
  ],
  // The handle half of the retime guard goes away while the key-value half stays, so
  // a curve whose keys ascend can still be bent downhill inside a segment. Its own
  // mutation rather than part of `retime-unclamped`, because they are two claims:
  // one is about where a key may sit, the other about where its handles may.
  'retime-handle-unchecked': [[
    '        if (!h.every((c) => c >= 0 && c <= 1)) {',
    '        if (false) {',
  ]],
  // The animation loop stops catching, so the pair source's refusal escapes it and
  // three never asks for another frame.
  'tick-uncaught': [[
    `    try {
      this.tickNow(nowMs);
    } catch (err) {`,
    `    if (true) {
      this.tickNow(nowMs);
      return;
    }
    try {
      this.tickNow(nowMs);
    } catch (err) {`,
  ]],
  // The furniture goes back inside the frame, which is where it was first written
  // and where it broke step 4.
  'chrome-in-frame': [[
    `    if (postEnabled()) composer.render(dt);
    else renderer.render(scene, viewCamera);`,
    `    if (postEnabled()) composer.render(dt);
    else renderer.render(scene, viewCamera);
    drawChromeIntoFrame();`,
  ], [
    'function drawChrome() {',
    `function drawChromeIntoFrame() {
  if (!chromeOn) return;
  const { h } = stageSize();
  const rect = insetRect();
  const held = new THREE.Color();
  renderer.getClearColor(held);
  const heldAlpha = renderer.getClearAlpha();
  renderer.setScissor(rect.x, h - rect.y - rect.h, rect.w, rect.h);
  renderer.setScissorTest(true);
  renderer.setClearColor(0x0d1014, 1);
  renderer.clear(true, false, false);
  renderer.setScissorTest(false);
  renderer.setClearColor(held, heldAlpha);
}
function drawChrome() {`,
  ]],
};

function mutatedSource() {
  const path = join(REPO, 'web/main.js');
  let source = readFileSync(path, 'utf8');
  const edits = MUTATIONS[MUTATE];
  if (!edits) {
    throw new Error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  }
  for (const [from, to] of edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${MUTATE} matched ${hits} times, expected exactly 1: ${from.slice(0, 70)}…`);
    }
    source = source.replace(from, to);
  }
  return source;
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

// ------------------------------------------------ values into the page as source
//
// Never `JSON.stringify`. This repo has already been bitten once by it: a table of
// malformed values passed into a page as JSON turned `NaN` and `undefined` into
// `null`, so three cases labelled NaN were silently testing null a second and
// third time. Nothing here is deliberately malformed, but the labels would lie the
// same way if it ever were, and one emitter that cannot do that is cheaper than
// remembering which call sites are safe.
function src(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    // Enough digits that a double round-trips exactly, which matters because the
    // page snaps scalars to a step grid and a value a hair off its grid lands one
    // step away.
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(src).join(', ')}]`;
  return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${src(v)}`).join(', ')}}`;
}

// ------------------------------------------ this tool's own interpolation
//
// Written here rather than imported from the page, because a check that asked the
// page for both the answer and the expectation would agree with itself whatever
// the arithmetic was. Where the formulation could reasonably be the same as the
// page's - a cubic is a cubic - the algorithm differs: the Bezier parameter is
// found by plain bisection over sixty halvings rather than by Newton, and the
// spline is anchored against the textbook uniform formula below.

const LIN_OUT = [1 / 3, 1 / 3];
const LIN_IN = [2 / 3, 2 / 3];

const bez1 = (a, b, u) => {
  const v = 1 - u;
  return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
};

function paramAt(ax, bx, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bez1(ax, bx, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const easeOf = (key) => key.easeOut ?? LIN_OUT;
const easeIn = (key) => key.easeIn ?? LIN_IN;

function before(keys, t) {
  let i = -1;
  for (let k = 0; k < keys.length; k++) if (keys[k].t <= t) i = k;
  return i;
}

function scalarAt(keys, t, extend = false) {
  if (keys.length === 0) return 0;
  if (keys.length === 1) return keys[0].value;
  const i = before(keys, t);
  if (i < 0) {
    if (!extend) return keys[0].value;
    return keys[0].value + (t - keys[0].t) * endSlope(keys, 0, 0);
  }
  if (i >= keys.length - 1) {
    if (!extend) return keys[keys.length - 1].value;
    return keys[keys.length - 1].value
      + (t - keys[keys.length - 1].t) * endSlope(keys, keys.length - 2, 1);
  }
  const a = keys[i];
  const b = keys[i + 1];
  const x = (t - a.t) / (b.t - a.t);
  const u = paramAt(easeOf(a)[0], easeIn(b)[0], x);
  return a.value + (b.value - a.value) * bez1(easeOf(a)[1], easeIn(b)[1], u);
}

/** The segment's slope at one of its ends, by a one-sided difference. */
function endSlope(keys, i, side) {
  const a = keys[i];
  const b = keys[i + 1];
  const h = 1e-7;
  const x = side === 0 ? h : 1 - h;
  const at = (xx) => {
    const u = paramAt(easeOf(a)[0], easeIn(b)[0], xx);
    return a.value + (b.value - a.value) * bez1(easeOf(a)[1], easeIn(b)[1], u);
  };
  return (at(Math.min(1, x + h)) - at(Math.max(0, x - h))) / ((b.t - a.t) * (Math.min(1, x + h) - Math.max(0, x - h)));
}

function stepValueAt(keys, t) {
  const i = before(keys, t);
  return keys[i < 0 ? 0 : i].value;
}

/**
 * Slerp, written from the definition rather than from three's implementation: the
 * shorter arc between two unit quaternions, at the angle between them.
 *
 * This is here because orientation was, for three rounds of this check, entirely
 * unverified - every test quaternion was the identity, so a page that dropped the
 * rotation on the floor and returned the first key's forever would have passed
 * every assertion. That is the instrument asserting what it does not enforce, on
 * the one interpolation kind whose maths is not in the spec.
 */
function slerp(qa, qb, u) {
  let [bx, by, bz, bw] = qb;
  let dot = qa[0] * bx + qa[1] * by + qa[2] * bz + qa[3] * bw;
  // The shorter arc. Two quaternions and their negations name the same rotation, so
  // a negative dot means the direct path is the long way round the sphere.
  if (dot < 0) {
    dot = -dot;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (dot > 0.9995) {
    // Nearly parallel: the sine below goes to zero and the division with it, so
    // this is a lerp and a renormalise, which is what the arc becomes in the limit.
    const out = [0, 1, 2, 3].map((i) => qa[i] + ([bx, by, bz, bw][i] - qa[i]) * u);
    const len = Math.hypot(...out) || 1;
    return out.map((v) => v / len);
  }
  const theta = Math.acos(dot);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - u) * theta) / sin;
  const wb = Math.sin(u * theta) / sin;
  return [0, 1, 2, 3].map((i) => qa[i] * wa + [bx, by, bz, bw][i] * wb);
}

/** A quaternion for a rotation of `deg` about a unit axis, so the keys are real poses. */
function quatAbout(axis, deg) {
  const half = (deg * Math.PI) / 360;
  const sin = Math.sin(half);
  const len = Math.hypot(...axis) || 1;
  return [(axis[0] / len) * sin, (axis[1] / len) * sin, (axis[2] / len) * sin, Math.cos(half)];
}

/** The angle between two unit quaternions, in degrees. What a wrong slerp gets wrong. */
function quatAngle(qa, qb) {
  const dot = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** Non-uniform Catmull-Rom in Hermite form, tangents divided by neighbour time. */
function poseValueAt(keys, t) {
  if (keys.length === 1) return keys[0].value;
  const i = before(keys, t);
  if (i < 0) return keys[0].value;
  if (i >= keys.length - 1) return keys[keys.length - 1].value;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const u = (t - a.t) / span;
  // The end keys are mirrored one segment outside the path, which is what the
  // textbook clamp means once the parameter is time rather than an index.
  const at = (k) => {
    if (k < 0) return { t: 2 * keys[0].t - keys[1].t, value: keys[0].value };
    if (k > keys.length - 1) {
      return { t: 2 * keys[keys.length - 1].t - keys[keys.length - 2].t, value: keys[keys.length - 1].value };
    }
    return keys[k];
  };
  const tangent = (k, axis) => {
    const lo = at(k - 1);
    const hi = at(k + 1);
    return (hi.value.position[axis] - lo.value.position[axis]) / (hi.t - lo.t);
  };
  const u2 = u * u;
  const u3 = u2 * u;
  const position = [0, 1, 2].map((axis) => (2 * u3 - 3 * u2 + 1) * a.value.position[axis]
    + (u3 - 2 * u2 + u) * span * tangent(i, axis)
    + (-2 * u3 + 3 * u2) * b.value.position[axis]
    + (u3 - u2) * span * tangent(i + 1, axis));
  return {
    position,
    quaternion: slerp(a.value.quaternion, b.value.quaternion, u),
    fov: a.value.fov + (b.value.fov - a.value.fov) * u,
  };
}

/** The textbook uniform Catmull-Rom, for the evenly spaced anchor only. */
function uniformCatmull(points, s) {
  const n = points.length - 1;
  const i = Math.min(Math.floor(s * n), n - 1);
  const u = s * n - i;
  const g = (k) => points[Math.max(0, Math.min(n, k))];
  const [p0, p1, p2, p3] = [g(i - 1), g(i), g(i + 1), g(i + 2)];
  return [0, 1, 2].map((d) => 0.5 * ((2 * p1[d])
    + (-p0[d] + p2[d]) * u
    + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u * u
    + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u * u * u));
}

/** Program to source, the way the page's curve does it: linear outside the keys. */
const retimeAt = (curve, t) => (curve.keys.length === 0
  ? t * curve.rate
  : (curve.keys.length === 1
    ? curve.keys[0].value + (t - curve.keys[0].t) * curve.rate
    : scalarAt(curve.keys, t, true)));

/**
 * How many output frames back the curve has to reach to cover `span` source
 * seconds ending at `t`. This tool's own walk over its own curve, which is what
 * the page's number is compared against.
 */
function framesBack(curve, t, span, fps, ceiling) {
  if (!(span > 0)) return 0;
  const at = retimeAt(curve, t);
  for (let n = 1; n <= ceiling; n++) {
    if (at - retimeAt(curve, t - n / fps) >= span - 1e-9) return n;
  }
  return ceiling;
}

/** What the arithmetic this replaced would have said: the tangent at the target. */
function framesBackByTangent(curve, t, span, fps) {
  const h = 1e-6;
  const slope = Math.abs((retimeAt(curve, t + h) - retimeAt(curve, t - h)) / (2 * h));
  const perFrame = slope / fps;
  return perFrame > 0 ? Math.ceil(span / perFrame) : 0;
}

// ------------------------------------------------------------------- the index

const index = await (await fetch(`${URL_BASE}/capture/${TAKE}/index`)).json();
const stamps = index.frames.stampMs;
const TIMES = stamps.map((s) => (s - stamps[0]) / 1000);
const SOURCE_DURATION = TIMES[TIMES.length - 1];

function bracketOf(sourceSec) {
  let lo = 0;
  let hi = TIMES.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (TIMES[mid] <= sourceSec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ------------------------------------------------------------------- reporting

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) failures++;
};
const show = (d) => `max ${d.max}/255, mean ${d.mean.toFixed(4)}, ${d.pct.toFixed(3)}% of pixels differ`;
const worst = (xs) => xs.reduce((a, b) => Math.max(a, b), 0);

// --------------------------------------------------------------- the test curves
//
// One ramp and one hold, both anchored at the origin the way the page's curve is,
// and both sized against the sample take's real 30.36s rather than a round number.
//
// The ramp runs slow then fast, so the pre-roll question has a different answer at
// either end of it - which is the whole point of asking it as a window.
const RAMP = {
  rate: 1,
  keys: [
    { t: 0, value: 0 },
    { t: 6, value: 3 },
    { t: 10, value: 15 },
  ],
};
// A four-second freeze in the middle. Source time stops, so no capture frame is
// crossed and the surface memory holds whatever it held when the freeze began -
// which is why a pre-roll here has to reach back through the whole hold.
const HOLD = {
  rate: 1,
  keys: [
    { t: 0, value: 0 },
    { t: 4, value: 8 },
    { t: 7, value: 8 },
    { t: 11, value: 16 },
  ],
};
// A speed ramp drawn with ease handles rather than as straight segments, so the
// slope is changing at every position rather than only at the knees. This is the
// shape a hand-drawn ramp actually has, and the one where a tangent at the target
// is furthest from the truth.
const EASED_RAMP = {
  rate: 1,
  keys: [
    { t: 0, value: 0, easeOut: [0.85, 0.05], easeIn: LIN_IN },
    { t: 10, value: 20, easeOut: LIN_OUT, easeIn: [0.15, 0.95] },
  ],
};
const FLAT = { rate: 1, keys: [] };

// --------------------------------------------------------------- in-page helpers

const INSTALL = `(() => {
  const k = globalThis.__kinect;
  globalThis.__kf = {
    shots: new Map(),

    async sha(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    },

    // The viewport draws the free camera and OrbitControls mutates it by
    // accumulation, so it is pinned at the head of every arm and read back at the
    // tail. Drift here would make two images differ for a reason that has nothing
    // to do with keyframes, and the check would blame the wrong thing.
    pinCamera() {
      const cam = k.freeCamera;
      k.controls.target.set(0, 0, -2.2);
      cam.position.set(0, 0.1, 1.6);
      cam.lookAt(0, 0, -2.2);
      k.controls.update(0);
      cam.updateMatrixWorld(true);
    },
    camera() {
      return [...k.freeCamera.position.toArray(), ...k.freeCamera.quaternion.toArray()]
        .map((v) => v.toFixed(9)).join(',');
    },

    counters() { return { ...k.timeline.counters }; },
    since(before) {
      const now = this.counters();
      return Object.fromEntries(Object.keys(now).map((key) => [key, now[key] - before[key]]));
    },

    grab(label) {
      const pixels = k.drive.readPixels();
      this.shots.set(label, pixels);
      return pixels;
    },

    diff(a, b) {
      const x = this.shots.get(a);
      const y = this.shots.get(b);
      if (!x || !y) throw new Error('missing shot ' + (x ? b : a));
      if (x.length !== y.length) throw new Error('shots are different sizes: ' + x.length + ' vs ' + y.length);
      let max = 0;
      let sum = 0;
      let differing = 0;
      for (let i = 0; i < x.length; i += 4) {
        const d = Math.max(
          Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]),
        );
        if (d > 0) {
          differing++;
          sum += d;
          if (d > max) max = d;
        }
      }
      const pixels = x.length / 4;
      return { max, mean: sum / pixels, differing, pixels, pct: (differing / pixels) * 100 };
    },
  };
  return true;
})()`;

// ------------------------------------------------------------------- the page

const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, which has no EXT_color_buffer_float, and a run that silently fell
// back to a software rasteriser would agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({
  viewport: { width: STAGE.width, height: STAGE.height + CHROME_H_GUESS },
  deviceScaleFactor: 1,
});

const page = await context.newPage();
const errors = [];
// Every recorded error carries the section that was running when it arrived. An
// error with no section attached is a sentence you then have to bisect the run to
// place, and this check has already spent a round doing exactly that.
let section = 'startup';
const say = console.log.bind(console);
console.log = (...parts) => {
  const heading = String(parts[0] ?? '').match(/^\n== (.+) ==$/);
  if (heading) section = heading[1];
  say(...parts);
};
const note = (text) => errors.push(`${section} | ${String(text).split('\n')[0]}`);

// Errors a section provokes on purpose. Registered rather than filtered at the end,
// and each one has to actually arrive: a fragment that matched nothing means the
// section stopped provoking what it was written to provoke, which is the same
// silence as a mutation that no longer matches its anchor.
const expected = [];
const expectError = (fragment, why) => expected.push({ fragment, why, seen: false });
page.on('pageerror', (err) => note(err));
page.on('console', (msg) => { if (msg.type() === 'error') note(msg.text()); });
page.on('response', (res) => { if (!res.ok()) note(`${res.status()} ${res.url()}`); });
await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

if (MUTATE) {
  const source = mutatedSource();
  await page.route('**/main.js', (route) => route.fulfill({
    contentType: 'text/javascript; charset=utf-8', body: source,
  }));
  console.log(`[keyframe] MUTATED BUILD: ${MUTATE} - this run is expected to FAIL`);
}

// The editor, which `/?take=` opened until the main menu took `/`. The take stays in
// the query and only the path moves - a page opened at the old root would land on the
// menu, which defines no `__kinect`, so the wait below would spend thirty seconds
// timing out on a page that was never going to answer.
await page.goto(`${URL_BASE}/edit?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__kinect);
// **The page frames at the stage this tool asked for.** The editor letterboxes
// itself to the export aspect now, so a viewport alone no longer decides the
// drawing buffer: a 640x400 stage is 1.6, the menu's default is 16:9, and the fit
// makes the buffer 640x360 with a 20px offset unless told otherwise. That moves
// every buffer-size expectation and every pointer coordinate in this file.
await page.evaluate('globalThis.__kinect.setTargetSize?.("640x400")');
// The viewport is then sized to whatever the strip actually is, measured off the
// page. `CHROME_H_GUESS` is a first guess and nothing more: it was 104 while the bar was
// one row, the bar became two, and the stage quietly came out 570x356 while every
// number in this file - including the `insetPct` denominator near the end - went on
// being computed against 640x400. Nothing failed, which is the point: the figures
// were simply about a smaller picture than the one they named.
{
  const strip = await page.evaluate(`(() => {
    const el = document.getElementById('timeline');
    return el && !el.hidden ? Math.round(el.getBoundingClientRect().height) : 0;
  })()`);
  await page.setViewportSize({ width: STAGE.width, height: STAGE.height + strip });
}
await page.waitForFunction(() => !!globalThis.__kinect.timeline.transport(), null, { timeout: 20000 });
await page.evaluate(INSTALL);

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

console.log(`[keyframe] ${gpu.renderer}`);
console.log(`[keyframe] stage ${gpu.buffer.join('x')}, take ${TAKE}: ${TIMES.length} frames, `
  + `${SOURCE_DURATION.toFixed(2)}s source at ${((TIMES.length - 1) / SOURCE_DURATION).toFixed(2)} fps mean`);

// A build that never settles takes the page down with it rather than failing an
// assertion, and a stack trace is a worse verdict than a sentence. An evaluator
// that announced its writes is exactly that shape: each evaluated frame schedules
// a seek, which renders a pre-roll, which evaluates - so the renderer process runs
// out of memory long before any assertion here can be reached. Reported as what it
// is rather than left to crash the tool.
const lost = (err) => {
  const line = String(err?.message ?? err).split('\n')[0];
  console.log(`  FAIL  the page stopped answering, so the run could not finish   ${line}`);
  console.log('\n[keyframe] FAIL (the page was lost)');
  process.exit(1);
};
process.on('unhandledRejection', lost);
process.on('uncaughtException', lost);

const settle = () => page.evaluate('globalThis.__kinect.timeline.settled()');
const diff = (a, b) => page.evaluate(`globalThis.__kf.diff(${src(a)}, ${src(b)})`);
const setTracks = (spec) => page.evaluate(`globalThis.__kinect.keyframes.setTracks(${src(spec)})`);
const setRetime = (curve) => page.evaluate(`globalThis.__kinect.keyframes.setRetime(${src(curve)})`);
const specOf = (name) => page.evaluate(`globalThis.__kinect.params.spec(${src(name)})`);

// Applying one of the shipped looks, which every section below that needs persistence
// switched on used to do by clicking `#modes button[data-mode="4"]`.
//
// The mechanical translation would have been `params.set('readBlackwall', 1)` and it
// would have been wrong everywhere it appears. What those clicks were reaching for is
// stated in the comment above each of them - "the one preset that switches both
// accumulators on at once" - and the accumulators are `trails`, `fade` and `wake`, none
// of which is the reading. Selecting the crimson shading with the whole grade at zero
// would leave every pre-roll cost in this file at nothing, and the sections measuring
// what a pre-roll costs would have gone green measuring a renderer with no persistence
// in it. The looks are read out of the documents that ship them for the same reason
// they were clicked rather than typed: so no look value is invented here.
const applyLook = (look) => page.evaluate(`globalThis.__kinect.applyPreset(${src(look)})`);
const shippedLook = (name) => JSON.parse(
  readFileSync(new URL(`../presets-builtin/${name}.json`, import.meta.url), 'utf8'),
).values;
const BLACKWALL_LOOK = shippedLook('blackwall');
const RGB_LOOK = shippedLook('rgb');

// ============================ 0. the evaluator asks for nothing, probed first
//
// Ahead of everything else, and deliberately so. `params.set` announces every
// write, the timeline answers an announcement by scheduling an accurate seek, and
// an evaluator writing its track values without the suppression has every frame
// schedule a seek, which renders a pre-roll, which evaluates, which schedules
// more. That does not fail an assertion - it takes the renderer process down with
// it, several minutes later, somewhere further along. So the cheapest form of the
// claim runs before anything expensive, and a failure stops the run here rather
// than dragging a dead page through five more sections.
console.log('\n== 0. an evaluated frame schedules no work of its own ==');
{
  await setRetime(FLAT);
  await setTracks({ bloom: [{ t: 0, value: 0.5 }, { t: 4, value: 3 }] });
  // On a budget, because the failure this probe exists to catch does not return an
  // answer at all: the transport's own settle helper waits on a queue that is
  // growing faster than it drains, so the page neither answers nor errors until the
  // renderer runs out of memory some minutes later. A minute is far more than a
  // healthy build needs - the same probe answers in well under a second - and it
  // turns a ten-minute death into a sentence.
  const probe = await Promise.race([
    new Promise((resolve) => { setTimeout(() => resolve('timeout'), 60000); }),
    page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const kf = globalThis.__kf;
    const t = k.timeline.transport();
    await t.seek(0);
    await k.timeline.settled();
    const before = kf.counters();
    for (let i = 0; i < 4; i++) k.renderProgramFrame(t.programSec);
    return kf.since(before);
  })()`),
  ]);
  if (probe === 'timeout') {
    check(false, 'an evaluated frame schedules no seek',
      'the page did not answer within 60s, which is what a seek storm looks like from out here');
  } else {
    console.log(`  4 bare renders at a resident position scheduled ${probe.seeks} seeks and ${probe.drafts} drafts`);
    check(probe.seeks === 0 && probe.drafts === 0, 'an evaluated frame schedules no seek',
      `${probe.seeks} seeks, ${probe.drafts} drafts`);
  }
  if (failures) {
    console.log('\n  the remaining sections were not run: a build that storms cannot be measured');
    console.log(`\n[keyframe] FAIL (${failures})`);
    await browser.close();
    process.exit(1);
  }
}

// ===================================== 1. the three interpolations are the curves

console.log('\n== 1. scalar with ease handles, step, and pose ==');

// Deliberately not linear: an ease-out into an ease-in, so the curve is a long way
// from the straight line between the same two values through most of the segment.
// A check run on default handles would agree with a lerp everywhere and prove
// nothing about handles at all.
const EASED = [
  { t: 0, value: 0, easeOut: [0.75, 0], easeIn: LIN_IN },
  { t: 4, value: 5, easeOut: [0.2, 0.9], easeIn: [0.25, 1] },
  { t: 9, value: 1, easeOut: LIN_OUT, easeIn: [0.6, 0.05] },
];
const STEPS = [
  { t: 0, value: false },
  { t: 3, value: true },
  { t: 7.5, value: false },
];
// Four keys unevenly spaced in time, so the non-uniform tangents matter: two of
// them are 1.2s apart and two are 5s apart, and the uniform formula would give the
// tight pair the same tangent as the loose one and lurch out of it.
// Every orientation is a real rotation and no two are the same, which took three
// rounds to become true: with identity quaternions throughout, a page that never
// slerped at all returned the right answer everywhere. They are also about two
// different axes, so a slerp that interpolated component-wise - the plausible wrong
// implementation - leaves the unit sphere between them and reads as a roll.
const PATH = [
  { t: 0, value: { position: [-1.2, 0.1, 1.4], quaternion: quatAbout([0, 1, 0], -55), fov: 50 } },
  { t: 1.2, value: { position: [-0.5, 0.5, 0.9], quaternion: quatAbout([0, 1, 0], -18), fov: 50 } },
  { t: 6.2, value: { position: [0.6, 0.35, 0.8], quaternion: quatAbout([1, 0.4, 0], 34), fov: 42 } },
  { t: 9, value: { position: [1.3, 0.05, 1.5], quaternion: quatAbout([0, 1, 0], 61), fov: 60 } },
  // The last pair is deliberately more than a half turn apart the naive way round,
  // so its dot product is negative and slerp has to take the shorter arc by negating
  // one of them. Without it every consecutive pair here was positive - 0.948, 0.928,
  // 0.879 - and a page that dropped the flip passed the whole section.
  { t: 12, value: { position: [1.6, 0.2, 0.9], quaternion: quatAbout([0, 1, 0], -170), fov: 55 } },
];

{
  await setTracks({ bloom: EASED, additive: STEPS, camera: PATH });
  const at = [];
  for (let i = 0; i <= 48; i++) at.push((i / 48) * 12);

  const read = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const at = ${src(at)};
    return {
      bloom: at.map((t) => k.keyframes.valueAt('bloom', t)),
      additive: at.map((t) => k.keyframes.valueAt('additive', t)),
      camera: at.map((t) => k.keyframes.valueAt('camera', t)),
    };
  })()`);

  const bloomSpec = await specOf('bloom');
  const expectedBloom = at.map((t) => scalarAt(EASED, t));
  const bloomErr = worst(read.bloom.map((v, i) => Math.abs(v - expectedBloom[i])));
  // The falsification control: the same keys read as a straight lerp. If the page
  // ignored its handles this would be the answer, so the two have to be far apart
  // or the comparison above is not about handles.
  const lerped = at.map((t) => scalarAt(EASED.map((k) => ({ ...k, easeOut: LIN_OUT, easeIn: LIN_IN })), t));
  const lerpGap = worst(read.bloom.map((v, i) => Math.abs(v - lerped[i])));

  console.log(`  bloom, ease-out into ease-in over 3 keys: worst error ${bloomErr.toExponential(1)} `
    + `against this tool's own bezier; a straight lerp of the same keys is ${lerpGap.toFixed(3)} away`);
  check(bloomErr <= halfStep(bloomSpec), 'a scalar track is the eased curve its handles describe',
    `worst ${bloomErr.toExponential(2)} against a half-step of ${halfStep(bloomSpec).toFixed(4)}`);
  check(lerpGap > 20 * halfStep(bloomSpec),
    'and the handles are doing something, because a lerp of the same keys is elsewhere',
    `${lerpGap.toFixed(3)} apart`);

  const expectedStep = at.map((t) => stepValueAt(STEPS, t));
  const stepWrong = read.additive.filter((v, i) => v !== expectedStep[i]).length;
  // A step track's control is any interpolation at all: the value has to be one of
  // the two the keys hold and nothing between them, at every position.
  const between = read.additive.filter((v) => typeof v !== 'boolean').length;
  console.log(`  additive, 3 step keys: ${read.additive.length - stepWrong} of ${at.length} positions `
    + `hold the earlier key; ${between} landed on something that is not a boolean`);
  check(stepWrong === 0, 'a step track holds the earlier value until the next key', `${stepWrong} wrong`);
  check(between === 0, 'and never lands between two, which is what a lerped boolean would do');

  const expectedPose = at.map((t) => poseValueAt(PATH, t));
  const poseErr = worst(read.camera.map((v, i) => worst(
    v.position.map((x, axis) => Math.abs(x - expectedPose[i].position[axis])),
  )));
  const fovErr = worst(read.camera.map((v, i) => Math.abs(v.fov - expectedPose[i].fov)));
  // The control: the same keys with straight lines between them. A Catmull-Rom
  // agrees with a lerp at every key and departs between them, so this is the whole
  // of the difference the spec asked for.
  const straight = at.map((t) => {
    const i = before(PATH, t);
    if (i < 0 || i >= PATH.length - 1) return PATH[Math.max(0, Math.min(PATH.length - 1, i))].value.position;
    const u = (t - PATH[i].t) / (PATH[i + 1].t - PATH[i].t);
    return [0, 1, 2].map((d) => PATH[i].value.position[d]
      + (PATH[i + 1].value.position[d] - PATH[i].value.position[d]) * u);
  });
  const straightGap = worst(read.camera.map((v, i) => worst(
    v.position.map((x, axis) => Math.abs(x - straight[i][axis])),
  )));
  console.log(`  camera, 4 unevenly spaced pose keys: worst position error ${poseErr.toExponential(1)} m, `
    + `fov ${fovErr.toExponential(1)}; straight lines between the same keys are ${straightGap.toFixed(3)} m away`);
  check(poseErr < VALUE_EPS, 'a pose track runs a Catmull-Rom through its positions',
    `worst ${poseErr.toExponential(2)} m`);
  check(fovErr < VALUE_EPS, 'and carries fov with it', `worst ${fovErr.toExponential(2)}`);

  // Orientation, on its own, because it was the gap. Two measurements: how far the
  // page's quaternion is from this tool's slerp, and how far a page that never
  // interpolated at all would be - the second is what the first was silently
  // passing against while every test rotation was the identity.
  const angleErr = worst(read.camera.map((v, i) => quatAngle(v.quaternion, expectedPose[i].quaternion)));
  const held = at.map((t) => {
    const i = before(PATH, t);
    return PATH[Math.max(0, Math.min(PATH.length - 1, i))].value.quaternion;
  });
  const heldGap = worst(read.camera.map((v, i) => quatAngle(v.quaternion, held[i])));
  const unit = worst(read.camera.map((v) => Math.abs(Math.hypot(...v.quaternion) - 1)));
  console.log(`  orientation across the same ${at.length} positions: worst ${angleErr.toExponential(1)}° from `
    + `this tool's own slerp; holding the earlier key instead would be ${heldGap.toFixed(1)}° out, `
    + `and every quaternion is unit to ${unit.toExponential(1)}`);
  // A thousandth of a degree, not the 1e-9 the positions get. Both sides compute the
  // same arc, but three reaches it through `atan2` where this tool reaches it
  // through `acos`, and two float paths to one angle do not agree to the last bit.
  // The number that makes the threshold meaningful is the control below it: the
  // wrong answer is 51.9° out, so this sits five orders inside the gap it has to
  // separate rather than being chosen to let the result through.
  check(angleErr < 1e-3, 'and slerps its orientation along the shorter arc',
    `worst ${angleErr.toExponential(2)}° against a 1e-3° tolerance`);
  check(heldGap > 5,
    'and it is genuinely interpolating, because holding the earlier key lands elsewhere',
    `${heldGap.toFixed(1)}° apart`);
  check(unit < 1e-9, 'and stays on the unit sphere, which a component-wise lerp would not',
    `worst ${unit.toExponential(2)} off unit`);
  // And the fixture has a pair that needs the shorter arc at all. Without one the
  // whole slerp comparison passes on a page that never negates, because every
  // direct path is already the short one.
  const dots = PATH.slice(1).map((key, i) => PATH[i].value.quaternion
    .reduce((sum, x, j) => sum + x * key.value.quaternion[j], 0));
  console.log(`  consecutive dot products ${dots.map((d) => d.toFixed(3)).join(' ')} - `
    + `${dots.filter((d) => d < 0).length} of ${dots.length} need the arc flipped`);
  check(dots.some((d) => d < -0.1),
    'and at least one pair is far enough round that the shorter arc is the negated one',
    dots.map((d) => d.toFixed(3)).join(' '));
  check(straightGap > 0.02,
    'and it is genuinely a spline, because straight lines through the same keys land elsewhere',
    `${straightGap.toFixed(3)} m apart`);
}

// ---------------- 1b. the spline is anchored to something outside both implementations

// On evenly spaced keys the non-uniform form and the textbook uniform Catmull-Rom
// are the same curve. That is what makes the page's tangents-over-time formulation
// a generalisation rather than a different spline wearing the name, and it ties the
// result to a formula neither this tool nor the page invented.
console.log('\n== 1b. evenly spaced keys agree with the textbook uniform formula ==');
{
  const EVEN = [[-1.3, 0.2, 0.15], [-0.55, 0.5, 0.55], [0.5, 0.35, 0.45], [1.25, 0.1, 0.1]];
  const keys = EVEN.map((position, i) => ({ t: i * 2, value: { position, quaternion: [0, 0, 0, 1], fov: 50 } }));
  await setTracks({ camera: keys });
  const at = [];
  for (let i = 0; i <= 30; i++) at.push((i / 30) * 6);
  const read = await page.evaluate(
    `${src(at)}.map((t) => globalThis.__kinect.keyframes.valueAt('camera', t).position)`,
  );
  const err = worst(read.map((p, i) => {
    const u = uniformCatmull(EVEN, at[i] / 6);
    return worst(p.map((x, axis) => Math.abs(x - u[axis])));
  }));
  console.log(`  4 keys 2s apart, 31 positions: worst disagreement ${err.toExponential(1)} m`);
  check(err < 1e-12, 'the non-uniform form is the uniform one when the spacing is uniform',
    `worst ${err.toExponential(2)} m`);
}

// ============================== 2. evaluating writes those values through the registry

console.log('\n== 2. evaluation at a program position writes what the tracks say ==');
{
  await setRetime(FLAT);
  await setTracks({ bloom: EASED, additive: STEPS, camera: PATH });
  await settle();

  // Reached by seeking rather than by calling the seam bare, because the indexed
  // source refuses to render a frame it has not fetched - correctly, and that
  // refusal is step 2's. The position read back is the transport's own, since the
  // playhead is an integer output frame and 0.9s is not one.
  const probes = [0.9, 2.7, 5.4, 8.1];
  const read = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const transport = k.timeline.transport();
    const out = [];
    for (const p of ${src(probes)}) {
      await transport.seek(p);
      const t = transport.programSec;
      out.push({
        t,
        bloom: k.params.get('bloom'),
        additive: k.params.get('additive'),
        camera: k.params.get('camera'),
        // Off the objects the shader and the renderer actually read, so this is
        // "the value reached the image" rather than "the registry remembers it".
        bloomStrength: k.bloom.strength,
        bloomEnabled: k.bloom.enabled,
        blending: k.material.blending,
        cameraPosition: k.programCamera.position.toArray(),
      });
    }
    return out;
  })()`);

  const bloomSpec = await specOf('bloom');
  const snap = (v) => {
    const clamped = Math.min(bloomSpec.max, Math.max(bloomSpec.min, v));
    return bloomSpec.min + Math.round((clamped - bloomSpec.min) / bloomSpec.step) * bloomSpec.step;
  };
  let bloomBad = 0;
  let stepBad = 0;
  let poseBad = 0;
  let landingBad = 0;
  for (const row of read) {
    if (Math.abs(row.bloom - snap(scalarAt(EASED, row.t))) > halfStep(bloomSpec)) bloomBad++;
    if (row.additive !== stepValueAt(STEPS, row.t)) stepBad++;
    const want = poseValueAt(PATH, row.t);
    if (worst(row.camera.position.map((x, i) => Math.abs(x - want.position[i]))) > VALUE_EPS) poseBad++;
    if (Math.abs(row.bloomStrength - row.bloom) > 1e-12) landingBad++;
    if (worst(row.cameraPosition.map((x, i) => Math.abs(x - row.camera.position[i]))) > 1e-12) landingBad++;
  }
  console.log(`  ${probes.length} program positions, three kinds each: `
    + `bloom ${read.map((r) => r.bloom.toFixed(2)).join(' ')} · `
    + `additive ${read.map((r) => (r.additive ? 'on' : 'off')).join(' ')} · `
    + `camera x ${read.map((r) => r.camera.position[0].toFixed(3)).join(' ')}`);
  check(bloomBad === 0, 'a scalar track lands on the registry at the value its curve says', `${bloomBad} wrong`);
  check(stepBad === 0, 'and a step track does', `${stepBad} wrong`);
  check(poseBad === 0, 'and the pose does', `${poseBad} wrong`);
  check(landingBad === 0,
    'and every one of them reaches the object the renderer reads, not just the registry',
    `${landingBad} disagreements between registry and landing site`);

  // The falsification control. The same reader against the values from a
  // *different* program position has to disagree - otherwise a page that wrote
  // one constant everywhere would pass everything above.
  const shifted = read.filter((row, i) => {
    const other = probes[(i + 1) % probes.length];
    return Math.abs(row.bloom - snap(scalarAt(EASED, other))) < halfStep(bloomSpec);
  }).length;
  check(shifted === 0,
    'and the values are position-dependent, so a constant would not have passed the above',
    `${shifted} of ${probes.length} positions also match a different position's value`);

  // The suppression, measured around bare renders at a position already resident so
  // the seek that fetched it is not inside the window. `params.set` announces every
  // write and the timeline answers an announcement with an accurate seek, so an
  // evaluator writing three values per frame without the suppression would schedule
  // three seeks per frame - each of which renders a pre-roll, which evaluates,
  // which schedules more. It never settles, and the symptom is a slow tab.
  const delta = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const kf = globalThis.__kf;
    const t = k.timeline.transport();
    await t.seek(5.0);
    await k.timeline.settled();
    const before = kf.counters();
    const at = t.programSec;
    for (let i = 0; i < 6; i++) k.renderProgramFrame(at);
    const immediately = kf.since(before);
    // And nothing left queued behind them: a repaint is deferred to a microtask, so
    // counting without settling first would miss every one of them.
    await k.timeline.settled();
    return { immediately, settled: kf.since(before) };
  })()`);
  console.log(`  6 evaluated renders at one position scheduled ${delta.settled.seeks} seeks `
    + `and ${delta.settled.drafts} drafts, and rendered ${delta.settled.renders} frames in total`);
  check(delta.immediately.seeks === 0 && delta.immediately.drafts === 0,
    'evaluating a frame asks for no repaint of its own',
    `${delta.immediately.seeks} seeks, ${delta.immediately.drafts} drafts`);
  check(delta.settled.renders === 6,
    'and nothing more is left queued behind them once the transport settles',
    `${delta.settled.renders} renders for 6 asked for, ${delta.settled.seeks} seeks`);
}

// =============================== 3. a keyframed look seeks the way it plays

console.log('\n== 3. a keyframed look: the same program position, reached two ways ==');

// Blackwall selected the way a user selects it, so no look value is invented here.
// It is the one preset that switches both accumulators on at once, which is what
// makes a pre-roll cost anything at all.
await applyLook(BLACKWALL_LOOK);

// Tracks that move the two things a pre-roll is sized by, plus the camera. `wake`
// keyed means the pre-roll length itself changes with the playhead, which is the
// interesting case - a seek has to compute it at the target rather than once.
const LOOK_TRACKS = {
  wake: [
    { t: 0, value: 0, easeOut: [0.6, 0], easeIn: LIN_IN },
    { t: 8, value: 900, easeOut: LIN_OUT, easeIn: [0.4, 1] },
    { t: 16, value: 200, easeOut: LIN_OUT, easeIn: LIN_IN },
  ],
  bloom: [
    { t: 2, value: 0.2, easeOut: LIN_OUT, easeIn: LIN_IN },
    { t: 12, value: 3.5, easeOut: LIN_OUT, easeIn: LIN_IN },
  ],
  additive: [{ t: 0, value: true }, { t: 9, value: false }],
  camera: PATH,
};

// One arm: pin the camera, reach a program position one of the two ways, read the
// image back. Everything the verdict rests on comes back with it - the counters the
// arm actually moved, the camera it ended on, and what the transport says about the
// seek it ran. The arguments go in as source rather than through `JSON.stringify`,
// for the reason `src` exists.
const arm = (label, kind, targetSec, frames = null) => page.evaluate(`(async () => {
  const k = globalThis.__kinect;
  const kf = globalThis.__kf;
  const t = k.timeline.transport();
  const [label, kind, targetSec, frames] =
    [${src(label)}, ${src(kind)}, ${src(targetSec)}, ${src(frames)}];
  kf.pinCamera();
  await k.timeline.settled();
  kf.pinCamera();
  const before = kf.counters();
  let seek = null;
  if (kind === 'playback') {
    await t.seek(0);
    await t.runTo(t.frameAt(targetSec));
  } else {
    seek = await t.seek(targetSec, frames === null ? {} : { frames });
  }
  const pixels = kf.grab(label);
  return {
    hash: await kf.sha(pixels), delta: kf.since(before), camera: kf.camera(), seek,
    state: k.timeline.read(),
  };
})()`);

{
  await setRetime(FLAT);
  await setTracks(LOOK_TRACKS);
  await settle();

  const TARGET = 11.0;
  const played = await arm('played', 'playback', TARGET);
  const seeked = await arm('seeked', 'seek', TARGET);
  const control = await arm('control', 'seek', TARGET, 0);

  const plan = seeked.seek.plan;
  console.log(`  Blackwall with wake, bloom, additive and the camera all keyed; target ${TARGET}s = `
    + `output frame ${seeked.seek.target}. Pre-roll computed at ${plan.frames} frames `
    + `(surface ${plan.surface}, trails ${plan.trails}) against a wake of `
    + `${scalarAt(LOOK_TRACKS.wake, TARGET).toFixed(0)}ms at the target.`);
  console.log(`  playback rendered ${played.delta.renders} output frames and advanced the surface memory `
    + `${played.delta.stateAdvances} times; the seek rendered ${seeked.delta.renders} and advanced it `
    + `${seeked.delta.stateAdvances}; the control rendered ${control.delta.renders}.`);

  check(played.delta.renders === seeked.seek.target + 1,
    'playback rendered every output frame from the start of the edit',
    `${played.delta.renders} of ${seeked.seek.target + 1}`);
  check(seeked.delta.renders === plan.frames + 1,
    'the seek rendered the pre-roll and the target and nothing else',
    `${seeked.delta.renders} of ${plan.frames + 1}`);
  check(played.delta.renders > seeked.delta.renders * 3,
    'the two arms did substantially different amounts of work');
  check(played.camera === seeked.camera, 'the camera is identical across the arms');

  const same = await diff('played', 'seeked');
  const apart = await diff('played', 'control');
  console.log(`\n  playback vs seek        ${show(same)}${same.max === 0 ? '  (byte-identical)' : ''}`);
  console.log(`  playback vs no pre-roll ${show(apart)}`);
  check(same.max <= SAME_MAX, `a keyframed look seeks within ${SAME_MAX}/255 of the way it plays`, show(same));
  check(apart.max >= CONTROL_MIN && apart.pct >= CONTROL_MIN_PCT,
    'the control lands somewhere else, so the equality above is about something', show(apart));

  // And a pre-roll is genuinely required, and the computed length covers what is
  // required. Not "the computed length is exactly what is needed": a ghost is drawn
  // while `age < fade + wake * strength` and strength is under 1 for most rays, so
  // the computed length is the worst case and the needed one is shorter. Measured
  // by walking down until the equality breaks, rather than asserted either way.
  let needed = plan.frames;
  for (let n = plan.frames; n >= 0; n--) {
    await arm('trial', 'seek', TARGET, n);
    const d = await diff('played', 'trial');
    if (d.max > SAME_MAX) break;
    needed = n;
  }
  console.log(`  the shortest pre-roll that still reproduces it is ${needed} frames, `
    + `against ${plan.frames} computed`);
  check(needed > 0, 'a pre-roll is required at all here', `${needed} frames needed`);
  check(plan.frames >= needed, 'and the computed length covers what is needed',
    `${plan.frames} computed against ${needed} needed`);
}

// ---------------- 3b. a seek from a cheap position to an expensive one

// Every arm above reaches its target warm: the seek follows a playback or a prior
// seek at the same position, so the uniforms already hold the target's look before
// the pre-roll is even sized. That is the shape of an easy check, and it hid a real
// bug for a whole round - `preroll` read fade, wake and damp straight off the
// uniforms, which is the look at wherever the playhead was *parked*, so a scrub
// release that jumped from a cheap position to an expensive one sized its warm-up
// for the cheap one and landed short of its own playback.
//
// So this arm is deliberately cold. Park at a position where the keyed parameters
// are at their cheapest, seek in one jump to where they are dearest, and compare
// against the playback that walked there. The plan the cold seek computes has to be
// the plan the warm one computes, because the look at the target does not depend on
// how the playhead got there.
console.log('\n== 3b. a seek that jumps from a cheap look to an expensive one ==');
{
  // Keyed so that the cheap end really is cheap: no persistence and no trails at
  // the head, both substantial at the target. Anything less and the two plans
  // differ by too little for the difference to be visible in pixels.
  const COLD = {
    trails: [{ t: 0, value: 0 }, { t: 8, value: 0.9 }],
    wake: [{ t: 0, value: 0 }, { t: 8, value: 1500 }],
  };
  await setRetime(FLAT);
  await setTracks(COLD);
  await applyLook(BLACKWALL_LOOK);
  await settle();

  const TARGET = 11.0;
  const cold = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const kf = globalThis.__kf;
    const t = k.timeline.transport();
    kf.pinCamera();
    // Parked at the cheap end first, so the uniforms hold the cheap look when the
    // expensive seek sizes itself. This is the state a scrub release starts from.
    await t.seek(0);
    await k.timeline.settled();
    const parked = {
      fade: k.uniforms.fadeTime.value, wake: k.uniforms.wakeTime.value,
      damp: k.afterimage.uniforms.damp.value,
    };
    const plan = t.preroll(${src(TARGET)});
    const seek = await t.seek(${src(TARGET)});
    kf.grab('cold');
    return { parked, plan, seek, warm: t.preroll(${src(TARGET)}) };
  })()`);
  const played = await arm('cold-played', 'playback', TARGET);

  const same = await diff('cold-played', 'cold');
  console.log(`  parked at 0s the uniforms hold fade ${cold.parked.fade}s, wake ${cold.parked.wake}s, `
    + `damp ${cold.parked.damp}; the track says wake `
    + `${scalarAt(COLD.wake, TARGET).toFixed(0)}ms and trails `
    + `${scalarAt(COLD.trails, TARGET).toFixed(2)} at ${TARGET}s`);
  console.log(`  the cold plan is ${cold.plan.frames} frames (surface ${cold.plan.surface}, `
    + `trails ${cold.plan.trails}); the same plan computed warm is ${cold.warm.frames}`);
  console.log(`  cold seek vs playback   ${show(same)}`);
  check(cold.plan.frames === cold.warm.frames,
    'a pre-roll is sized from the tracks at the target, not from the uniforms at the playhead',
    `${cold.plan.frames} cold against ${cold.warm.frames} warm`);
  check(cold.seek.frames === cold.plan.frames,
    'and the seek ran the length it computed', `${cold.seek.frames} of ${cold.plan.frames}`);
  check(same.max <= SAME_MAX,
    'so a seek that jumps from a cheap look to an expensive one still reproduces its playback',
    show(same));
  // The control: the cheap end really is cheap, or "cold equals warm" would be a
  // statement about two identical configurations.
  check(cold.parked.wake === 0 && cold.parked.damp === 0,
    'and the playhead really was parked somewhere cheap, so the two plans could have differed',
    JSON.stringify(cold.parked));
  await setTracks({});
}

// ---------------- 3c. and one whose pre-roll window crosses a dearer region

// Target-sampling fixed §3b, and then the question is whether sampling at the
// target is *correct* or merely better than sampling at the playhead. For the
// surface half it is correct: the state texture's contents do not depend on fade or
// wake, and the draw decision reads the uniforms at the frame being drawn, so
// covering fade plus wake ending at the target is exactly sufficient.
//
// For the trails half it is not, and this is the case that shows why. Three's pass
// is `max(new, damp * old)` applied per output frame with that frame's damp, so
// what survives from before a pre-roll is the product of damp across the window -
// which `damp_at_target ^ n` is only while damp is constant. Keyed high right up to
// the target and low at it, the closed form asks for a fraction of what is needed.
console.log('\n== 3c. a pre-roll whose window is dearer than its target ==');
{
  await setRetime(FLAT);
  await applyLook(BLACKWALL_LOOK);
  // Fade and wake at zero and unkeyed, so the surface half computes 0 and cannot
  // mask the trails half by being the larger of the two.
  await page.evaluate(`globalThis.__kinect.params.apply(${src({ fade: 0, wake: 0 })})`);
  await setTracks({ trails: [{ t: 0, value: 0.95 }, { t: 7.8, value: 0.95 }, { t: 8.0, value: 0.5 }] });
  await settle();

  const TARGET = 8.0;
  const seen = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const fps = t.outputFps;
    return {
      plan: t.preroll(${src(TARGET)}),
      atTarget: k.keyframes.valueAt('trails', ${src(TARGET)}),
      across: [0, 10, 20, 30, 40].map((n) => k.keyframes.valueAt('trails', ${src(TARGET)} - n / fps)),
      fps,
    };
  })()`);
  // What the closed form would say, and what the product actually needs - both
  // computed here rather than read off the page.
  const closed = Math.ceil(Math.log(0.01) / Math.log(seen.atTarget));
  let product = 1;
  let needed = 0;
  for (let n = 1; n <= 400; n += 1) {
    product *= scalarAt(
      [{ t: 0, value: 0.95 }, { t: 7.8, value: 0.95 }, { t: 8.0, value: 0.5 }],
      TARGET - (n - 1) / seen.fps,
    );
    needed = n;
    if (product <= 0.01) break;
  }
  const played = await arm('win-played', 'playback', TARGET);
  const full = await arm('win-full', 'seek', TARGET);
  const short = await arm('win-short', 'seek', TARGET, closed);
  const same = await diff('win-played', 'win-full');
  const apart = await diff('win-played', 'win-short');

  console.log(`  damp runs ${seen.across.map((v) => v.toFixed(2)).reverse().join(' -> ')} into the target`);
  console.log(`  the closed form asks for ${closed} frames; the product over the window needs `
    + `${needed}; the page plans ${seen.plan.trails}`);
  console.log(`  at the planned length vs playback   ${show(same)}`);
  console.log(`  at the closed form's length vs it   ${show(apart)}`);
  check(seen.plan.trails === needed,
    'the trails half counts the frames the product over the window needs',
    `${seen.plan.trails} against ${needed}`);
  check(same.max <= SAME_MAX,
    'so a seek whose window is dearer than its target still reproduces its playback', show(same));
  // The control, and the whole reason this section exists: the closed form is a
  // different number here, and the image it produces is visibly wrong.
  check(closed < needed, 'and the closed form really would have asked for less',
    `${closed} against ${needed}`);
  check(apart.max >= CONTROL_MIN,
    'and landed somewhere else, which is what makes the equality above about something',
    show(apart));
  await setTracks({});
  await applyLook(RGB_LOOK);
  await settle();
}

// ============================== 4. the retime curve, a ramp and a hold

console.log('\n== 4. program time maps to source time through the curve ==');
{
  for (const [label, curve] of [['ramp', RAMP], ['hold', HOLD]]) {
    await setRetime(curve);
    await setTracks({});
    await settle();

    const probes = [];
    for (let i = 0; i <= 24; i++) probes.push((i / 24) * 11);
    const read = await page.evaluate(`(() => {
      const r = globalThis.__kinect.timeline.retime;
      const t = globalThis.__kinect.timeline.transport();
      return {
        source: ${src(probes)}.map((p) => r.sourceSecAt(p)),
        // Which capture frame the transport would bracket, so the mapping is
        // checked all the way down to the index rather than only as arithmetic.
        bracket: ${src(probes)}.map((p) => t.sourceFrameAt(p)),
        duration: t.duration,
      };
    })()`);

    const wantSource = probes.map((p) => retimeAt(curve, p));
    const sourceErr = worst(read.source.map((v, i) => Math.abs(v - wantSource[i])));
    const wantBracket = wantSource.map((s) => bracketOf(s));
    const bracketBad = read.bracket.filter((b, i) => b !== wantBracket[i]).length;
    // The program length is the point at which the curve first reaches the end of
    // the take, computed here from the tool's own curve by bisection.
    let lo = 0;
    let hi = 200;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (retimeAt(curve, mid) < SOURCE_DURATION) lo = mid;
      else hi = mid;
    }
    console.log(`  ${label}: worst source error ${sourceErr.toExponential(1)}s over 25 positions; `
      + `duration ${read.duration.toFixed(4)}s against ${hi.toFixed(4)}s computed here`);
    check(sourceErr < 1e-6, `${label}: the curve maps program time to the source times it should`,
      `worst ${sourceErr.toExponential(2)}s`);
    check(bracketBad === 0, `${label}: and the transport brackets the capture frames the index names`,
      `${bracketBad} of ${probes.length} wrong`);
    check(Math.abs(read.duration - hi) < 1e-3,
      `${label}: and the program runs until the curve reaches the end of the take`,
      `${read.duration.toFixed(4)}s against ${hi.toFixed(4)}s`);
  }

  // The control: the flat curve has to give different answers, or the three above
  // would pass on a page that ignored its keys entirely.
  await setRetime(FLAT);
  const flat = await page.evaluate('[5, 8, 10].map((p) => globalThis.__kinect.timeline.retime.sourceSecAt(p))');
  const ramped = [5, 8, 10].map((p) => retimeAt(RAMP, p));
  const gap = worst(flat.map((v, i) => Math.abs(v - ramped[i])));
  console.log(`  a curve-free retime at the same positions is ${gap.toFixed(2)}s away from the ramp`);
  check(gap > 1, 'and a page ignoring its keys would land somewhere else entirely', `${gap.toFixed(2)}s apart`);
}

// ---------------- 4b. a hold really holds

console.log('\n== 4b. a hold freezes source time, and the image with it ==');
{
  await setRetime(HOLD);
  await setTracks({});
  // Blackwall, but with every term that reads program time turned off - the scan
  // sweep, the grain, the scanlines, the RGB split and the glitch all take
  // `uniforms.time`, which is program time and keeps running under a freeze. The
  // persistence stays on, so the surface memory is still in the picture and this
  // is not a claim about a renderer that had stopped working. The other side of
  // that - that the program-time terms *do* keep moving - is the second half below.
  await applyLook(BLACKWALL_LOOK);
  const TIME_FREE = { scan: 0, grain: 0, scanlines: 0, rgbSplit: 0, glitch: 0, noise: 0, trails: 0 };
  await page.evaluate(`globalThis.__kinect.params.apply(${src(TIME_FREE)})`);
  await settle();

  const inside = [4.6, 5.4, 6.2, 6.9];
  const read = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const kf = globalThis.__kf;
    const t = k.timeline.transport();
    const out = [];
    for (const [i, p] of ${src(inside)}.entries()) {
      const before = kf.counters();
      await t.seek(p);
      const pixels = kf.grab('hold-' + i);
      out.push({
        p,
        source: k.timeline.retime.sourceSecAt(p),
        frame: t.sourceFrameAt(p),
        advances: kf.since(before).stateAdvances,
        hash: await kf.sha(pixels),
      });
    }
    return out;
  })()`);

  const sourceSpread = worst(read.map((r) => Math.abs(r.source - read[0].source)));
  console.log(`  four positions across the freeze (${inside.join('s, ')}s) all map to source `
    + `${read[0].source.toFixed(4)}s, capture frame ${read[0].frame}; spread ${sourceSpread.toExponential(1)}s`);
  check(sourceSpread < 1e-9, 'source time does not advance through a hold', `${sourceSpread.toExponential(2)}s`);
  check(new Set(read.map((r) => r.frame)).size === 1,
    'so the same capture frame is under the playhead throughout', `${new Set(read.map((r) => r.frame)).size} frames`);

  const advances = read.map((r) => r.advances);
  console.log(`  the surface memory advanced ${advances.join(', ')} times across the four seeks`);
  const holdDiffs = [];
  for (let i = 1; i < inside.length; i++) holdDiffs.push(await diff('hold-0', `hold-${i}`));
  console.log(`  and the image at each: ${holdDiffs.map(show).join(' | ')}`);
  check(holdDiffs.every((d) => d.max <= SAME_MAX),
    'and a seek to any of them lands on the same image', holdDiffs.map((d) => d.max).join(', '));

  // The control: a position outside the hold has to differ, or "the same image"
  // above would be a statement about a renderer that had stopped working.
  await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    await k.timeline.transport().seek(9.5);
    globalThis.__kf.grab('after-hold');
    return true;
  })()`);
  const past = await diff('hold-0', 'after-hold');
  console.log(`  a position past the freeze, at 9.5s: ${show(past)}`);
  check(past.max >= CONTROL_MIN && past.pct >= CONTROL_MIN_PCT,
    'while a position past it is a different image, so this can tell them apart', show(past));

  // The other side of it, and it is a property rather than a caveat. Program time
  // is the coordinate; a hold freezes the *footage* by holding source time still,
  // and everything the look drives off program time carries on. Turning the scan
  // sweep and the grain back on has to make the same four positions differ.
  await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const kf = globalThis.__kf;
    const t = k.timeline.transport();
    k.params.apply({ scan: 0.35, grain: 0.22, scanlines: 0.35 });
    await k.timeline.settled();
    for (const [i, p] of ${src(inside)}.entries()) {
      await t.seek(p);
      kf.grab('lively-' + i);
    }
    return true;
  })()`);
  const lively = await diff('lively-0', 'lively-3');
  console.log(`  with the scan sweep and grain back on, the same two positions: ${show(lively)}`);
  check(lively.max >= CONTROL_MIN,
    'and program time keeps running under the freeze, which is what makes it the coordinate',
    show(lively));
}

// ---------------- 4c. the pre-roll is a window on the curve, not a tangent

console.log('\n== 4c. the pre-roll asks how far back the curve covers a source span ==');
{
  // Three shapes, and the probes are placed where the answer is interesting rather
  // than evenly. Inside one straight segment the tangent is the curve, so the two
  // arithmetics agree and prove nothing - the discriminating positions are the ones
  // whose pre-roll window reaches back *across* a change of slope, and the S-curve,
  // where the slope is changing everywhere.
  const CASES = [
    { label: 'ramp, slow side', curve: RAMP, at: 4.0 },
    { label: 'ramp, fast side', curve: RAMP, at: 9.0 },
    { label: 'ramp, just past a knee', curve: RAMP, at: 6.1 },
    { label: 'S-curve, early', curve: EASED_RAMP, at: 2.0 },
    { label: 'S-curve, late', curve: EASED_RAMP, at: 8.5 },
    { label: 'hold, before it', curve: HOLD, at: 3.0 },
    { label: 'hold, inside it', curve: HOLD, at: 6.0 },
    { label: 'hold, just past it', curve: HOLD, at: 7.5 },
  ];
  console.log('  method: Blackwall at fade 120 + wake 550 = 0.670s of source persistence, 30 fps out.');
  console.log('  configuration            window  tangent   source span the window covers');
  const rows = [];
  for (const c of CASES) {
    await setRetime(c.curve);
    await applyLook(BLACKWALL_LOOK);
    await settle();
    const got = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const t = k.timeline.transport();
      return {
        plan: t.preroll(${src(c.at)}),
        span: k.uniforms.fadeTime.value + k.uniforms.wakeTime.value,
        fps: t.outputFps,
        lastFrame: t.lastFrame,
      };
    })()`);
    const want = framesBack(c.curve, c.at, got.span, got.fps, got.lastFrame);
    const tangent = framesBackByTangent(c.curve, c.at, got.span, got.fps);
    const covers = retimeAt(c.curve, c.at) - retimeAt(c.curve, c.at - got.plan.surface / got.fps);
    rows.push({ ...c, got, want, tangent, covers });
    console.log(`  ${c.label.padEnd(22)} ${String(got.plan.surface).padStart(6)} `
      + `${String(tangent).padStart(8)}   ${covers.toFixed(4)}s of ${got.span.toFixed(3)}s`);
  }
  for (const r of rows) {
    check(r.got.plan.surface === r.want,
      `${r.label}: the window query counts the frames this tool counts`,
      `${r.got.plan.surface} against ${r.want}`);
  }
  for (const r of rows) {
    check(r.covers >= r.got.span - 1e-6,
      `${r.label}: and the frames it counted really do cover fade plus wake`,
      `${r.covers.toFixed(4)}s of ${r.got.span.toFixed(3)}s`);
  }
  // The control, and the whole reason the seam grew a window. On a constant slope
  // the two agree; on a curve they must not, and inside a hold the tangent answers
  // "no frames needed" for the case that needs the most.
  const differing = rows.filter((r) => r.tangent !== r.want).length;
  const holdRow = rows.find((r) => r.label === 'hold, inside it');
  console.log(`  ${differing} of ${rows.length} configurations disagree with the tangent arithmetic; `
    + `inside the hold it asks for ${holdRow.tangent} frames against ${holdRow.want}`);
  check(differing >= 3, 'and the tangent arithmetic would have given different answers',
    `${differing} of ${rows.length} differ`);
  check(holdRow.tangent === 0 && holdRow.want > 0,
    'including a hold, where a slope of zero covers no source span at all whatever it is multiplied by',
    `tangent ${holdRow.tangent}, window ${holdRow.want}`);
}

// ---------------- 4d. and the seek it sizes lands where the playback does

console.log('\n== 4d. a seek across a ramp and across a hold reproduces its playback ==');
{
  // The ramp target sits just past the knee, so its pre-roll window reaches back
  // across a change of slope - the case a tangent at the target gets wrong.
  for (const [label, curve, target] of [['ramp', RAMP, 6.1], ['hold', HOLD, 6.0]]) {
    await setRetime(curve);
    await setTracks(LOOK_TRACKS);
    await applyLook(BLACKWALL_LOOK);
    await settle();

    const played = await arm(`${label}-played`, 'playback', target);
    const seeked = await arm(`${label}-seeked`, 'seek', target);
    // The control is the pre-roll the tangent arithmetic would have asked for -
    // not zero. That makes this the direct test of the carried finding: the old
    // number has to produce a visibly different image, or replacing it changed
    // nothing that matters.
    const span = await page.evaluate(
      'globalThis.__kinect.uniforms.fadeTime.value + globalThis.__kinect.uniforms.wakeTime.value',
    );
    const tangent = framesBackByTangent(curve, target, span, seeked.state.outputFps);
    const old = await arm(`${label}-tangent`, 'seek', target, tangent);

    const same = await diff(`${label}-played`, `${label}-seeked`);
    const apart = await diff(`${label}-played`, `${label}-tangent`);
    console.log(`  ${label} at ${target}s: pre-roll ${seeked.seek.plan.frames} frames `
      + `(surface ${seeked.seek.plan.surface}, trails ${seeked.seek.plan.trails}), playback rendered `
      + `${played.delta.renders}`);
    console.log(`    seek vs playback        ${show(same)}`);
    console.log(`    tangent-sized (${String(tangent).padStart(3)}) vs it  ${show(apart)}`);
    check(same.max <= SAME_MAX, `${label}: the computed pre-roll reproduces the playback`, show(same));
    if (label === 'hold') {
      check(apart.max >= CONTROL_MIN,
        `${label}: and the tangent-sized pre-roll does not, which is the finding this replaces`,
        show(apart));
    }
  }
}

// ================= 4e. a curve that moves while a seek is fetching

// A seek plans which source frames it needs, awaits them, and renders. The curve
// can move inside that await - and when it does, the plan describes a program the
// page no longer has, so the render walks the source backwards and the pair source
// refuses. Found by dragging a retime key in the real editor, where every pointer
// move rewrites the curve mid-fetch.
//
// **The hazard is older than the curve, and this is the half worth being explicit
// about.** The speed slider writes `retime.rate` from an `input` handler, outside
// the transport's exclusive queue, so a committed step 4 could reach the same
// state - a rate change landing while a seek was awaiting its frames. It is far
// harder to hit there because one slider move is one mutation rather than sixty,
// which is why it was never seen. So the first arm here moves `rate` and nothing
// else: it is step 4's path, exercised deliberately rather than waited for.
//
// The window is entered on purpose rather than raced for. `ensure` is wrapped so
// the curve changes exactly as the fetch resolves, which is the one instant that
// matters and the one a timing test would hit by luck.
console.log('\n== 4e. the retime curve moving while a seek is fetching ==');
{
  await setTracks({});
  await applyLook(BLACKWALL_LOOK);
  // Drained before the curve is touched. Selecting a mode schedules an accurate
  // seek, and rewriting the curve while *that* one is fetching is the same
  // contention this section is about - manufactured by the check rather than by
  // the claim, so what would fail is an operation nobody is testing.
  await settle();

  // The second arm goes from one keyed curve to another rather than from no keys to
  // keys, so the retime lane exists on both sides of it. A lane appearing mid-seek
  // resizes the stage, and two images of different sizes cannot be compared at all -
  // which would make this a check about layout wearing a re-planning claim's name.
  for (const [label, before, after] of [
    ['rate, the step 4 path', { rate: 1, keys: [] }, { rate: 0.25, keys: [] }],
    ['keys, the step 5 path', RAMP, HOLD],
  ]) {
    await setRetime(before);
    await settle();
    const got = await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const kf = globalThis.__kf;
      const t = k.timeline.transport();
      const source = t.source;
      // Emptied first, or there is nothing to await and the window this is about
      // never opens. The first run of this check counted zero interruptions and
      // reported two failures against a seek that never fetched anything at all.
      source.cache.clear();
      const real = source.ensure.bind(source);
      let hits = 0;
      // Armed only around the seek under test. Without the flag the rewrite lands
      // in whatever operation happens to be fetching - a repaint queued behind a
      // mode click, in the run that found this - and what fails is that operation
      // rather than the claim, which is a check measuring its own interference.
      let armed = false;
      source.ensure = (a, b) => real(a, b).then((r) => {
        // Once, as the first fetch resolves. Rewriting it on every fetch would
        // never converge, and this is testing a curve that moved rather than a
        // curve that will not stop moving - the bound covers that separately.
        if (armed && hits++ === 0) k.keyframes.setRetime(${src(after)});
        return r;
      });
      await k.timeline.settled();
      let threw = null;
      let landed = null;
      try {
        armed = true;
        landed = await t.seek(12.0);
      } catch (err) {
        threw = String(err.message ?? err);
      } finally {
        armed = false;
      }
      // Read here, before anything is allowed to settle. A stand-down asks for a
      // repaint, and a repaint that lands resets this counter - so reading it after
      // a settle reports zero for a seek that never landed at all. That is what the
      // first version of this section did, and it passed.
      const overtaken = t.overtaken;
      const at = t.programSec;
      const sourceAt = k.timeline.retime.sourceSecAt(at);
      source.ensure = real;
      // Settled before reading, because an overtaken seek stands down quietly and
      // leaves the landing to the repaint it queued. The claim is that the playhead
      // ends up where the winning curve puts it, not that one particular call did
      // the rendering.
      await k.timeline.settled();
      return {
        threw, hits, overtaken, at, sourceAt, landed: landed !== null,
        rate: k.timeline.retime.rate,
        keys: k.timeline.retime.keys.length,
      };
    })()`);
    // Checked as a position rather than as pixels. An earlier version of this
    // section compared the interrupted seek's image against a clean one and the
    // verdict moved between runs - the two operations reach the same place through
    // different amounts of queued work, and the harness could not hold them still
    // enough for a pixel equality to mean anything. Sections 3 and 4d carry the
    // pixel claim for ordinary seeks; what this section is for is that an
    // interrupted one lands rather than refusing, and where it lands is a number.
    const wantSource = retimeAt(after, got.at);
    const drift = Math.abs(got.sourceAt - wantSource);
    console.log(`  ${label}: the curve was rewritten on fetch ${got.hits > 0 ? 'yes' : 'NO'}, `
      + `seek ${got.threw ? `threw: ${got.threw}` : (got.landed ? 'landed' : 'STOOD DOWN')} `
      + `with ${got.overtaken} stand-downs; playhead at program ${got.at.toFixed(3)}s -> source `
      + `${got.sourceAt.toFixed(4)}s against ${wantSource.toFixed(4)}s computed here`);
    check(got.hits > 0, `${label}: the fetch really was interrupted, so this tested something`,
      `${got.hits} interruptions`);
    check(got.threw === null, `${label}: the seek re-planned around it instead of refusing`,
      got.threw ?? '');
    // The load-bearing one, and the one an easier check gets wrong. A stand-down
    // asks for a repaint that arrives at the same place a moment later, so every
    // downstream reading looks right while the operation under test did nothing.
    check(got.landed === true && got.overtaken === 0,
      `${label}: and the seek itself landed rather than standing down for a repaint`,
      `landed ${got.landed}, ${got.overtaken} stand-downs`);
    check(Math.abs(got.at - 12.0) < 1e-6,
      `${label}: at the program position it was asked for`, `${got.at.toFixed(4)}s of 12s`);
    check(drift < 1e-6,
      `${label}: reading the source time the winning curve maps it to`,
      `${drift.toExponential(2)}s adrift`);
  }
  await setRetime(FLAT);
}

// ============ 4f. a downhill curve cannot be authored, and one cannot kill the page

// Source time running backwards is unrenderable here, and not by omission: both
// accumulators advance one source frame at a time and neither can be walked back,
// so a descending segment asks the pair source to go backwards and it refuses. The
// refusal used to arrive from inside the animation loop, which three then stops
// driving - no playback, no scrubbing, no repaint, permanently, and with nothing
// persisted that is the editing session. Two claims, and both are needed: the
// editing doors must not be able to author one, and the loop must survive one that
// arrives anyway.
console.log('\n== 4f. a retime curve that runs downhill ==');
{
  await setTracks({});
  await setRetime({ rate: 1, keys: [{ t: 0, value: 0 }, { t: 8, value: 12 }, { t: 14, value: 20 }] });
  await settle();

  // (a) the programmatic door - a project file is a door too.
  const refused = await page.evaluate(`(() => {
    try {
      globalThis.__kinect.keyframes.setRetime({ rate: 1, keys: [
        { t: 0, value: 0 }, { t: 5, value: 12 }, { t: 9, value: 4 } ] });
      return null;
    } catch (err) { return String(err.message ?? err); }
  })()`);
  console.log(`  a falling curve through setRetime: ${refused ? 'refused' : 'ACCEPTED'}`);
  check(refused !== null, 'a curve that falls is refused rather than stored', refused ?? 'accepted');
  // The control: a hold is equal values, which is legal and must not be refused.
  const holdOk = await page.evaluate(`(() => {
    try {
      globalThis.__kinect.keyframes.setRetime(${src(HOLD)});
      return true;
    } catch { return false; }
  })()`);
  check(holdOk === true, 'while a hold, which is equal values, still is not');

  // The other way to author a descent, and the one a values-only check cannot see:
  // keys that ascend, with an outgoing handle that overshoots past the later value
  // and comes back down inside the segment. On this fixture a shallow one hides
  // inside single capture brackets, so `mixT` walks backwards within a pair and the
  // reverse renders with nothing refusing it at all.
  const HANDLE_DESCENT = { rate: 1, keys: [
    { t: 0, value: 0, easeOut: [0.3, 1.6], easeIn: [2 / 3, 2 / 3] },
    { t: 8, value: 6, easeOut: [1 / 3, 1 / 3], easeIn: [2 / 3, 2 / 3] },
  ] };
  const handleRefused = await page.evaluate(`(() => {
    try {
      globalThis.__kinect.keyframes.setRetime(${src(HANDLE_DESCENT)});
      return null;
    } catch (err) { return String(err.message ?? err); }
  })()`);
  // What that curve would have done, sampled by this tool from its own evaluator, so
  // the refusal is shown to be refusing something real rather than being cautious.
  //
  // Measured as the largest drawdown - how far the curve falls below a level it has
  // already reached - rather than as a peak followed by a minimum. The descent here
  // is a dip in the middle of the segment and the curve still ends at its highest
  // value, so "the maximum, then the minimum after it" finds nothing at all and
  // reports a working refusal as refusing nothing. Sampled finely, because a narrow
  // dip falls between coarse samples.
  const sampled = [];
  for (let i = 0; i <= 320; i++) sampled.push(scalarAt(HANDLE_DESCENT.keys, (i / 320) * 8, true));
  let high = -Infinity;
  let drawdown = 0;
  let from = 0;
  let to = 0;
  for (const v of sampled) {
    if (v > high) high = v;
    if (high - v > drawdown) { drawdown = high - v; from = high; to = v; }
  }
  console.log(`  keys 0 -> 6 with an easeOut y of 1.6: ${handleRefused ? 'refused' : 'ACCEPTED'}; `
    + `that curve reaches ${from.toFixed(3)}s and falls back to ${to.toFixed(3)}s, `
    + `a drawdown of ${drawdown.toFixed(3)}s`);
  check(drawdown > 0.02,
    'the handle really does bend the curve back on itself, so there is something to refuse',
    `${drawdown.toFixed(4)}s of drawdown`);
  check(handleRefused !== null,
    'and a handle outside the unit box is refused, not only falling key values',
    handleRefused ?? 'accepted');
  // The control: the same keys with an in-box handle are still accepted, so this is
  // a bound on the handle rather than a ban on easing the retime at all.
  const easedOk = await page.evaluate(`(() => {
    try {
      globalThis.__kinect.keyframes.setRetime({ rate: 1, keys: [
        { t: 0, value: 0, easeOut: [0.3, 0.95], easeIn: [2 / 3, 2 / 3] },
        { t: 8, value: 6, easeOut: [1 / 3, 1 / 3], easeIn: [2 / 3, 2 / 3] } ] });
      return true;
    } catch { return false; }
  })()`);
  check(easedOk === true, 'while an eased retime with both handles inside it still is not');

  // (b) the editing door - dragged with a real pointer, well past the neighbour.
  await setRetime({ rate: 1, keys: [{ t: 0, value: 6 }, { t: 8, value: 12 }, { t: 14, value: 20 }] });
  await settle();
  await settle();
  const lane = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('#tBeds .tlane')].find((l) => l.dataset.owner === 'retime');
    const key = el.querySelectorAll('.tkey')[1];
    const r = key.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, bottom: box.bottom };
  })()`);
  await page.mouse.move(lane.x, lane.y);
  await page.mouse.down();
  // All the way to the floor of the lane and past it, which without a clamp asks
  // for a value under the key before it.
  await page.mouse.move(lane.x, lane.bottom + 40, { steps: 6 });
  await page.mouse.up();
  await settle();
  const dragged = await page.evaluate(
    'globalThis.__kinect.timeline.retime.keys.map((k) => ({ t: k.t, value: k.value }))',
  );
  const falls = dragged.some((k, i) => i > 0 && k.value < dragged[i - 1].value - 1e-9);
  console.log(`  dragged the middle key to the floor of its lane: `
    + `${dragged.map((k) => k.value.toFixed(2)).join(' -> ')}`);
  check(!falls, 'and a key dragged below the one before it stops there instead of going under',
    JSON.stringify(dragged));
  check(Math.abs(dragged[1].value - dragged[0].value) < 1e-6,
    'landing exactly on it, so the clamp is what stopped it rather than the drag being short',
    `${dragged[1].value.toFixed(4)} against ${dragged[0].value.toFixed(4)}`);

  // (c) the backstop - one that arrives anyway must not take the page with it.
  const survived = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    k.keyframes.setRetime({ rate: 1, keys: [{ t: 0, value: 0 }, { t: 12, value: 18 }] });
    await k.timeline.settled();
    await t.seek(4.0);
    // Past every guard, straight onto the object, which is the only way to produce
    // one now and is exactly the "arrives anyway" this backstop is for.
    //
    // The descent starts from where the walk already stands rather than from
    // somewhere else on the take: 6.0s of source at 4.0s of program, which is
    // exactly what the seek above just consumed. A curve that also *jumped* would
    // ask for frames nobody has fetched, and playback would sit waiting for them
    // instead of trying to walk backwards - which is a stall, not this claim.
    k.timeline.retime.keys = [
      { t: 0, value: 8, easeOut: [1 / 3, 1 / 3], easeIn: [2 / 3, 2 / 3] },
      { t: 12, value: 2, easeOut: [1 / 3, 1 / 3], easeIn: [2 / 3, 2 / 3] },
    ];
    const before = k.timeline.counters.renders;
    await t.play();
    const startedPlaying = t.playing;
    // Long enough for the walk to catch up with itself. The seek that preceded the
    // swap left the source walk well behind where the new curve points, so the
    // first few steps move *forward* through that backlog and only start going
    // backwards once they reach it - the refusal is a second or so in, not
    // immediate, and a short wait reports a page that simply had not got there yet.
    for (let i = 0; i < 90 && t.playing; i++) await frames();
    const afterCrash = {
      playing: t.playing,
      note: document.getElementById('tNote').textContent,
      rendered: k.timeline.counters.renders - before,
    };
    // Put a sane curve back and ask the loop to work. If the callback stopped being
    // driven this is where it shows - nothing renders, whatever the transport says.
    k.keyframes.setRetime({ rate: 1, keys: [{ t: 0, value: 0 }, { t: 12, value: 18 }] });
    await k.timeline.settled();
    await t.seek(1.0);
    const settledRenders = k.timeline.counters.renders;
    await t.play();
    for (let i = 0; i < 20; i++) await frames();
    t.pause();
    return { startedPlaying, afterCrash, alive: k.timeline.counters.renders - settledRenders };
  })()`);
  console.log(`  a curve written straight onto the object, then play: transport `
    + `${survived.afterCrash.playing ? 'still playing' : 'paused'}, note `
    + `"${survived.afterCrash.note.slice(0, 60)}"`);
  console.log(`  with a sane curve back, the animation loop rendered ${survived.alive} frames`);
  // The control on the control: the transport really was playing when it met the
  // curve, so "it paused" is a thing that happened rather than a thing that never
  // started. Renders are the wrong measure of that - it refuses on the first step,
  // which is the point.
  check(survived.startedPlaying === true,
    'playback really was running when it met the curve',
    `rendered ${survived.afterCrash.rendered} frames before refusing`);
  check(survived.afterCrash.playing === false,
    'a curve that cannot be walked pauses the transport rather than running into it');
  check(survived.afterCrash.note.length > 0, 'and says why on the strip rather than only in the console',
    survived.afterCrash.note);
  // This section provokes exactly one error and it is the one under test, so the
  // run-wide no-errors assertion is told to expect it - and told to fail if it
  // does not arrive.
  expectError('the retime curve runs backwards here',
    'the refusal a downhill curve produces, caught by the loop rather than by the page dying');
  // The load-bearing one. Everything above can be true of a page whose animation
  // loop has already stopped being driven, because a paused transport renders
  // nothing either way.
  check(survived.alive > 0,
    'and the animation loop is still being driven afterwards, which is the whole of the claim',
    `${survived.alive} frames rendered after`);
  await setRetime(FLAT);
  await settle();
}

// ============================================ 5. undo is document state only

console.log('\n== 5. undo restores the document and never the view ==');
{
  await setRetime(FLAT);
  await setTracks({});
  await applyLook(RGB_LOOK);
  await settle();
  await page.evaluate('globalThis.__kinect.keyframes.undo.begin()');

  const drag = async (id, values) => page.evaluate(`(() => {
    const el = document.getElementById(${src(id)});
    for (const v of ${src(values)}) {
      el.value = String(v);
      el.dispatchEvent(new Event('input'));
    }
    el.dispatchEvent(new Event('change'));
  })()`);
  const depth = () => page.evaluate('globalThis.__kinect.keyframes.undo.depth()');
  const project = () => page.evaluate('globalThis.__kinect.keyframes.project()');

  // (a) one drag is one level, not one per pointer move.
  const before5 = await depth();
  await drag('bloom', [0.5, 1.0, 1.5, 2.0, 2.5]);
  await settle();
  const afterDrag = await depth();
  console.log(`  a five-step drag of the bloom slider took the stack from ${before5} to ${afterDrag}`);
  check(afterDrag === before5 + 1, 'a slider drag pushes one snapshot, at the end of the interaction',
    `${afterDrag - before5} levels for five input events`);

  // (b) input without a release pushes nothing.
  const midDrag = await page.evaluate(`(() => {
    const el = document.getElementById('bloom');
    const start = globalThis.__kinect.keyframes.undo.depth();
    for (const v of [3.0, 3.5, 4.0]) {
      el.value = String(v);
      el.dispatchEvent(new Event('input'));
    }
    return { start, during: globalThis.__kinect.keyframes.undo.depth() };
  })()`);
  await settle();
  check(midDrag.during === midDrag.start, 'and nothing at all while the drag is still running',
    `${midDrag.during - midDrag.start} levels`);
  await page.evaluate("document.getElementById('bloom').dispatchEvent(new Event('change'))");
  await settle();

  // (c) the view leaves no trace: orbiting, scrubbing and render scale.
  const beforeView = await depth();
  const viewProbe = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    // Orbiting: the controls moved and fired their own events, the way a drag does.
    k.controls.dispatchEvent({ type: 'start' });
    k.freeCamera.position.set(0.6, 0.4, 1.9);
    k.controls.dispatchEvent({ type: 'change' });
    k.controls.dispatchEvent({ type: 'end' });
    await k.timeline.settled();
    const afterOrbit = k.keyframes.undo.depth();
    // Scrubbing.
    await t.seek(6.0);
    const afterScrub = k.keyframes.undo.depth();
    return { afterOrbit, afterScrub, frame: t.frame };
  })()`);
  const scaleEl = 'renderScale';
  const scaleBefore = await page.evaluate(`globalThis.__kinect.params.get(${src(scaleEl)})`);
  await drag(scaleEl, [90, 80, 70]);
  await settle();
  const afterScale = await depth();
  console.log(`  orbit ${viewProbe.afterOrbit}, scrub ${viewProbe.afterScrub}, `
    + `render scale ${scaleBefore} -> 70 gives ${afterScale}, all against ${beforeView}`);
  check(viewProbe.afterOrbit === beforeView, 'orbiting to inspect the cloud leaves the stack untouched');
  check(viewProbe.afterScrub === beforeView, 'and so does moving the playhead');
  check(afterScale === beforeView,
    'and so does dropping render scale, even though its control fires the same change event',
    `${afterScale - beforeView} levels`);

  // (d) and none of it is in the snapshot, so an undo cannot put it back.
  const snapshot = await project();
  // A v3 document is `{ look: { mode, params, tracks }, composition: { retime, camera } }`.
  // Read flat, `snapshot.params` is undefined and the `in` below throws rather than
  // failing, which is how this arrived: as "the page stopped answering" three sections
  // after the shape actually changed.
  check(!('renderScale' in snapshot.look.params) && !('spin' in snapshot.look.params),
    'the snapshot holds no view state at all', Object.keys(snapshot.look.params).join(' '));

  // (e) an undo restores the document and moves neither the playhead nor the view.
  const keyed = { wake: [{ t: 0, value: 100 }, { t: 5, value: 1200 }] };
  await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.keyframes.setTracks(${src(keyed)});
    k.keyframes.setRetime(${src(RAMP)});
    k.keyframes.undo.commit();
  })()`);
  await settle();
  const withKeys = await project();
  const depthWithKeys = await depth();
  const undone = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const frameBefore = t.frame;
    const scaleBefore = k.params.get('renderScale');
    const camBefore = k.freeCamera.position.toArray();
    const popped = k.keyframes.undo.pop();
    return {
      popped,
      project: k.keyframes.project(),
      frameBefore,
      frameAfter: t.frame,
      scaleBefore,
      scaleAfter: k.params.get('renderScale'),
      camBefore,
      camAfter: k.freeCamera.position.toArray(),
      depth: k.keyframes.undo.depth(),
    };
  })()`);
  await settle();
  // Look tracks and the retime curve sit on opposite sides of the v3 split - tracks are
  // look, the curve is composition - so the two readings below come from two places.
  const undoneTracks = undone.project.look.tracks;
  const undoneRetime = undone.project.composition.retime;
  console.log(`  a track and a retime curve pushed one level (${depthWithKeys}), then undone: `
    + `tracks ${Object.keys(withKeys.look.tracks).join(',') || 'none'} -> `
    + `${Object.keys(undoneTracks).join(',') || 'none'}, `
    + `retime keys ${withKeys.composition.retime.keys.length} -> ${undoneRetime.keys.length}`);
  check(undone.popped === true, 'the stack had something to pop');
  check(Object.keys(undoneTracks).length === 0 && undoneRetime.keys.length === 0,
    'and undo took the keys and the curve back off', JSON.stringify(undoneTracks));
  check(undone.frameAfter === undone.frameBefore, 'and left the playhead exactly where it was',
    `frame ${undone.frameBefore} -> ${undone.frameAfter}`);
  check(undone.scaleAfter === undone.scaleBefore, 'and did not touch render scale',
    `${undone.scaleBefore} -> ${undone.scaleAfter}`);
  check(String(undone.camBefore) === String(undone.camAfter), 'and did not walk the orbit backwards',
    `${undone.camBefore} -> ${undone.camAfter}`);

  // (f) the look really comes back, not just the key list.
  //
  // **Half of what this row used to assert has lost its subject rather than its
  // anchor, and it is deleted rather than re-pointed.** It read the clip's mode either
  // side of a click on the Blackwall button and asserted that selecting a mode was one
  // undo level "not twelve" - because `setMode(4)` wrote the mode plus twelve look
  // values, and the whole danger was that thirteen writes in one gesture might not come
  // back together. There is no mode and no bundled write: picking a reading writes one
  // registry parameter, which undoes exactly like the slider beside it. Re-anchoring
  // this onto whatever is nearest would have kept a green row that tested nothing.
  //
  // What survives is the property that outlived the mode - a bulk write is one level,
  // and undo restores every value in it - and its subject is a preset now.
  //
  // Driven through `applyStoredPreset`, which is the door the apply button uses, and
  // **not** through the `applyPreset` underneath it. That distinction cost a red row
  // to find and is worth the sentence: `applyPreset` writes the values and commits
  // nothing, so a first draft of this measured 13 values moved in **0** undo levels
  // and read exactly like a program that had lost its undo. The commit belongs to the
  // gesture rather than to the write - which is right, because a track writing values
  // every frame must not push a level - so a check that reaches past the gesture is
  // asserting against a path no user takes.
  const bulkUndo = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const LOOK = ${JSON.stringify(BLACKWALL_LOOK)};
    const watched = Object.keys(LOOK);
    const read = () => Object.fromEntries(watched.map((n) => [n, k.params.get(n)]));
    k.keyframes.undo.begin();
    const before = read();
    k.library.applyStoredPreset({ name: 'keyframe-check', rev: 'sha256:0', body: { version: k.library.PROJECT_VERSION, values: LOOK } });
    await k.timeline.settled();
    const after = read();
    const pushed = k.keyframes.undo.depth();
    k.keyframes.undo.pop();
    await k.timeline.settled();
    return { before, after, back: read(), pushed, watched: watched.length };
  })()`);
  const moved = Object.keys(bulkUndo.before).filter((n) => bulkUndo.before[n] !== bulkUndo.after[n]);
  console.log(`  applying the Blackwall look moved ${moved.length} of ${bulkUndo.watched} values `
    + `in ${bulkUndo.pushed} level: ${moved.map((n) => `${n} ${bulkUndo.before[n]}->${bulkUndo.after[n]}`).join(' ')}`);
  // The control for the two rows below, and it is why `moved` is counted rather than
  // assumed: a preset that wrote nothing would undo perfectly and pass both of them.
  check(moved.length > 0, 'applying a look actually moves values', `${moved.length} moved`);
  check(bulkUndo.pushed === 1, `and it is one undo level, not ${bulkUndo.watched}`, `${bulkUndo.pushed}`);
  check(JSON.stringify(bulkUndo.back) === JSON.stringify(bulkUndo.before),
    'and undo restores every value it wrote, together',
    `${JSON.stringify(bulkUndo.back)} against ${JSON.stringify(bulkUndo.before)}`);
}

// ================================= 6. the two surfaces, and where the furniture is

console.log('\n== 6. look in lanes, composition in the world ==');
{
  await setRetime(FLAT);
  await setTracks({ bloom: EASED, additive: STEPS, camera: PATH });
  await settle();
  const lanes = await page.evaluate('globalThis.__kinect.keyframes.lanes()');
  const named = await page.evaluate('globalThis.__kinect.keyframes.names()');
  const dom = await page.evaluate(
    "[...document.querySelectorAll('#tBeds .tlane')].map((el) => el.dataset.owner)",
  );
  console.log(`  three keyed parameters give lanes ${dom.join(', ')}; `
    + `the registry declares ${lanes.map((l) => `${l.owner}:${l.kind}`).join(' ')}`);
  check(lanes.length === 3 && dom.length === 3, 'only parameters carrying keys get a lane',
    `${lanes.length} lanes for ${named.length} tracks, ${dom.length} in the document`);
  check(String(dom) === String(lanes.map((l) => l.owner)), 'and the lanes drawn are the lanes computed');
  check(lanes.every((l) => l.kind === (l.owner === 'camera' ? 'pose' : (l.owner === 'additive' ? 'step' : 'scalar'))),
    'and each lane takes its kind off the registry rather than off a table of its own',
    lanes.map((l) => `${l.owner}=${l.kind}`).join(' '));

  const empty = await page.evaluate(`(() => {
    globalThis.__kinect.keyframes.setTracks({});
    return [...document.querySelectorAll('#tBeds .tlane')].length;
  })()`);
  check(empty === 0, 'and a clip with no keys has none at all, which is the nine-into-five deletion',
    `${empty} lanes`);
}

// ---------------- 6b. a camera node is a thing in space you can drag

console.log('\n== 6b. dragging a path node in the top-down moves it across the floor ==');
{
  await setTracks({ camera: PATH });
  await settle();
  const NODE = 1;
  // Driven with the real pointer rather than with synthesised events. A dispatched
  // PointerEvent carries no active pointer id, so the capture the drag takes out
  // throws and the gesture never starts - which would have this check measuring
  // the absence of its own input rather than the absence of the feature.
  // **Canvas-local, and `page.mouse` is viewport-relative.** These were the same
  // number while the stage filled the window from its corner; the editor letterboxes
  // itself to the export aspect now, so the canvas is centred in whatever the stage
  // area leaves over and the two differ by that offset. Without it the drag lands on
  // empty background and the node does not move, which reads as the feature being
  // gone rather than as the pointer having missed - four rows here failed exactly
  // that way. The other drag in this file takes its point from a DOM rect and is
  // already in viewport coordinates.
  const canvasAt = await page.evaluate(`(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { x: r.left, y: r.top };
  })()`);
  const raw = await page.evaluate(`globalThis.__kinect.keyframes.camera.project(${src(NODE)}, true)`);
  const at = { x: raw.x + canvasAt.x, y: raw.y + canvasAt.y };
  const before = await page.evaluate(`globalThis.__kinect.keyframes.camera.keys()[${src(NODE)}].value.position`);
  const depthBefore = await page.evaluate('globalThis.__kinect.keyframes.undo.depth()');

  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const during = await page.evaluate('globalThis.__kinect.controls.enabled');
  await page.mouse.move(at.x + 18, at.y - 12, { steps: 4 });
  await page.mouse.up();
  await settle();

  const after = await page.evaluate(`globalThis.__kinect.keyframes.camera.keys()[${src(NODE)}].value.position`);
  const orbitAfter = await page.evaluate('globalThis.__kinect.controls.enabled');
  const depthAfter = await page.evaluate('globalThis.__kinect.keyframes.undo.depth()');
  const lane = await page.evaluate("globalThis.__kinect.keyframes.lanes().find((l) => l.owner === 'camera')");

  const d = [0, 1, 2].map((i) => after[i] - before[i]);
  // The plan is drawn to a known scale, so how far the node should have gone is
  // arithmetic rather than a guess: 18 pixels right and 12 up, over the pixels per
  // metre the inset uses.
  const inset = await page.evaluate('globalThis.__kinect.keyframes.chrome.inset()');
  const perMetre = inset.h / 7;
  console.log(`  node ${NODE} moved from ${before.map((x) => x.toFixed(3)).join(', ')} to `
    + `${after.map((x) => x.toFixed(3)).join(', ')}   `
    + `(dx ${d[0].toFixed(3)}, dy ${d[1].toFixed(3)}, dz ${d[2].toFixed(3)})`);
  console.log(`  the plan runs at ${perMetre.toFixed(1)} px/m, so 18 px right and 12 px up is `
    + `${(18 / perMetre).toFixed(3)} m in x and ${(-12 / perMetre).toFixed(3)} m in z`);
  check(Math.abs(d[0] - 18 / perMetre) < 0.05 && Math.abs(d[2] - (-12 / perMetre)) < 0.05,
    'a drag in the plan moves the node the distance the plan\'s own scale says',
    `dx ${d[0].toFixed(3)} against ${(18 / perMetre).toFixed(3)}, dz ${d[2].toFixed(3)} against ${(-12 / perMetre).toFixed(3)}`);
  check(d[1] === 0, 'and leaves its height alone, because a top-down drag says nothing about height',
    `dy ${d[1].toFixed(6)}`);
  check(during === false && orbitAfter === true,
    'and navigation is suspended for the length of the drag and handed back after it',
    `during ${during}, after ${orbitAfter}`);
  check(depthAfter === depthBefore + 1, 'and one drag is one undo level',
    `${depthAfter - depthBefore} levels`);
  check(lane.keys === PATH.length, 'and the path still has all its keys', `${lane.keys}`);
}

// ---------------- 6d. a retime key dragged vertically stays where it is in time

// The retime curve is the one track whose value changes how long the program is,
// so its lane is the one place where editing a key rescales the ruler the key is
// drawn on. Left alone that is a feedback loop rather than a rescale: drag a key
// down, the clip slows, the program lengthens, the ruler rescales, the key moves
// under a pointer that never moved sideways, and the new position reads back as a
// later program time - which slows it further. Measured before the ruler was
// frozen for the length of a drag: twelve pixels of vertical drag walked one key
// from 15.0s to 48.3s in four moves.
console.log('\n== 6d. a retime key dragged down changes the speed, not when it is ==');
{
  await setTracks({});
  await setRetime({ rate: 1, keys: [{ t: 0, value: 0 }, { t: 15, value: 15 }] });
  await settle();
  // Drained again after the curve is set, not only before. The first version of
  // this section dragged a key while a repaint left over from an earlier section
  // was still fetching, and that repaint was overtaken three times and stood down -
  // correct behaviour, reported correctly, and nothing to do with the claim here.
  // A user with a fast hand can reproduce it; a check should not manufacture it.
  await settle();
  const lane = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('#tBeds .tlane')].find((l) => l.dataset.owner === 'retime');
    const key = el.querySelectorAll('.tkey')[1];
    const r = key.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      top: box.top, height: box.height,
      value: globalThis.__kinect.timeline.retime.keys[1].value,
    };
  })()`);
  // **The walk is in seconds converted to pixels, not in pixels.** The retime lane draws
  // zero to the capture's own length across its forty pixels, so what a pixel is worth
  // depends on the fixture: on the 49.79s sample this tree holds, the old fixed walk of
  // 3, 6, 9 and 12 pixels was worth 15 seconds, which took a key sitting at 15 exactly
  // to zero. That is the floor - a curve flat at zero never advances the source, so the
  // program length stops being "longer" and falls back to the last key's own time - and
  // the row below read the collapse as the clip failing to slow down. So the drop is
  // three quarters of wherever the key is, in four equal steps, and the pixels for it
  // come from where the page actually drew the key: `value / (1 - frac)` is the top of
  // the lane's range read back off the drawing rather than assumed.
  const frac = (lane.y - lane.top) / lane.height;
  const perPx = (lane.value / Math.max(1e-6, 1 - frac)) / lane.height;
  const dropPx = (lane.value * 0.75) / Math.max(1e-9, perPx);
  const steps = [1, 2, 3, 4].map((i) => Math.round((dropPx * i) / 4));
  const walk = [];
  await page.mouse.move(lane.x, lane.y);
  await page.mouse.down();
  for (const dy of steps) {
    await page.mouse.move(lane.x, lane.y + dy);
    walk.push(await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      return { t: k.timeline.retime.keys[1].t, value: k.timeline.retime.keys[1].value,
        duration: k.timeline.transport().duration };
    })()`));
  }
  await page.mouse.up();
  await settle();
  console.log(`  four vertical moves of ${steps.join(', ')}px, at ${perPx.toFixed(3)}s per pixel: `
    + `t ${walk.map((w) => w.t.toFixed(3)).join(' ')}`);
  console.log(`  against value ${walk.map((w) => w.value.toFixed(2)).join(' ')} `
    + `and program length ${walk.map((w) => w.duration.toFixed(1)).join(' ')}s`);
  const slid = worst(walk.map((w) => Math.abs(w.t - 15)));
  check(slid < 0.01, 'the key holds its program time through a vertical drag',
    `worst ${slid.toFixed(4)}s of slide`);
  // The control: the drag has to have done something, or holding still would be
  // the answer to everything above.
  check(Math.abs(walk[3].value - walk[0].value) > 1,
    'while its value moved, so the drag was doing something',
    `${walk[0].value.toFixed(2)} to ${walk[3].value.toFixed(2)}`);
  check(walk[3].duration > walk[0].duration * 1.5,
    'and the program got longer, which is what slowing a clip means',
    `${walk[0].duration.toFixed(1)}s to ${walk[3].duration.toFixed(1)}s`);
  await setRetime(FLAT);
}

// ---------------- 6e. the panel writes keys, through the controls a hand uses

// Two things that had no coverage at all, and both are gesture wiring - the class
// that has produced five of this build's bugs, every one of them found by driving
// the page rather than by reasoning about it. So the keyframe button is clicked and
// the ease handle is dragged with a real pointer, not with dispatched events.
console.log('\n== 6e. keying from the panel, and dragging a handle ==');
{
  await setRetime(FLAT);
  await setTracks({});
  await applyLook(BLACKWALL_LOOK);
  await settle();
  // Bloom now lives on the Look inspector. The look above opens Optical through the
  // document-derived group rule; this selects the parent surface a hand must cross
  // before the diamond is visible.
  await page.click('#panelTabLook');

  // (a) the keyframe button, clicked.
  const seekTo = (sec) => page.evaluate(
    `(async () => { await globalThis.__kinect.timeline.transport().seek(${src(sec)}); })()`,
  );
  await seekTo(2.0);
  await page.click('.kf[aria-label="bloom keyframe"]');
  await settle();
  const afterClick = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      keys: k.keyframes.project().look.tracks.bloom ?? null,
      state: document.querySelector('.kf[aria-label="bloom keyframe"]').dataset.kf,
      value: k.params.get('bloom'),
    };
  })()`);
  console.log(`  clicking the bloom diamond at 2.0s: ${afterClick.keys?.length ?? 0} key, `
    + `the control reads "${afterClick.state}", the parameter is ${afterClick.value}`);
  check(afterClick.keys?.length === 1, 'clicking a keyframe control plants a key at the playhead',
    `${afterClick.keys?.length ?? 0} keys`);
  check(afterClick.state === 'here', 'and the control says there is one here', afterClick.state);
  check(Math.abs(afterClick.keys[0].value - afterClick.value) < 1e-9,
    'holding the value the parameter already had, so keying changes no image',
    `${afterClick.keys[0].value} against ${afterClick.value}`);

  // (b) the Final Cut rule: with keys on the track, moving the slider writes the
  // key at the playhead rather than shifting the whole curve. Untested until now,
  // and the failure it guards against is specific - the evaluator rewrites every
  // keyed parameter on the next render, so a bare `params.set` would be overwritten
  // and the slider would appear to spring back on its own.
  await seekTo(8.0);
  await page.click('.kf[aria-label="bloom keyframe"]');
  await settle();
  await page.evaluate(`(() => {
    const el = document.getElementById('bloom');
    el.value = '3';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  })()`);
  await settle();
  await seekTo(5.0);
  const before5 = await page.evaluate('globalThis.__kinect.params.get("bloom")');
  await page.evaluate(`(() => {
    const el = document.getElementById('bloom');
    el.value = '1.25';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  })()`);
  await settle();
  const fc = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      keys: k.keyframes.project().look.tracks.bloom.map((key) => ({ t: +key.t.toFixed(3), value: key.value })),
      value: k.params.get('bloom'),
      slider: Number(document.getElementById('bloom').value),
    };
  })()`);
  const planted = fc.keys.find((key) => Math.abs(key.t - 5.0) < 0.05);
  console.log(`  at 5.0s the curve read ${before5}; dragging the slider to 1.25 gives keys `
    + `${fc.keys.map((key) => `${key.t}s=${key.value}`).join(' ')}`);
  console.log(`  and after the render that follows it, the parameter reads ${fc.value} `
    + `with the slider at ${fc.slider}`);
  check(fc.keys.length === 3 && planted !== undefined,
    'moving a slider on a keyed track writes a key at the playhead',
    `${fc.keys.length} keys`);
  check(planted !== undefined && Math.abs(planted.value - 1.25) < 0.03,
    'holding the value that was dragged to', `${planted?.value}`);
  // The one that matters. A bare `params.set` passes everything above and then the
  // evaluator puts the old curve back on the very next frame.
  check(Math.abs(fc.value - 1.25) < 0.03 && Math.abs(fc.slider - 1.25) < 0.03,
    'and it stays there through the render that follows, rather than springing back',
    `parameter ${fc.value}, slider ${fc.slider}`);
  // The control: with no keys, the same drag must write no key at all, or "it
  // writes a key" would be true of a track that keys everything you touch.
  await page.evaluate('globalThis.__kinect.keyframes.setTracks({})');
  await settle();
  await page.evaluate(`(() => {
    const el = document.getElementById('bloom');
    el.value = '2';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  })()`);
  await settle();
  const unkeyed = await page.evaluate('globalThis.__kinect.keyframes.names().length');
  check(unkeyed === 0, 'while the same drag on an unkeyed track writes no key at all',
    `${unkeyed} tracks`);

  // (c) an ease handle, dragged with the pointer.
  await setTracks({ bloom: EASED });
  await settle();
  const handle = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('#tBeds .tlane')].find((l) => l.dataset.owner === 'bloom');
    const key = el.querySelectorAll('.tkey')[1];
    const r = key.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.mouse.click(handle.x, handle.y);
  await settle();
  const at = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('#tBeds .tlane')].find((l) => l.dataset.owner === 'bloom');
    const h = el.querySelector('.thandle');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check(at !== null, 'selecting a key shows its ease handles', at ? '' : 'no handle drawn');
  const curveBefore = await page.evaluate(
    '[5.0, 6.5].map((t) => globalThis.__kinect.keyframes.valueAt("bloom", t))',
  );
  const handleBefore = await page.evaluate(
    'JSON.stringify(globalThis.__kinect.keyframes.project().look.tracks.bloom[1])',
  );
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x - 30, at.y + 8, { steps: 5 });
  await page.mouse.up();
  await settle();
  const handleAfter = await page.evaluate(
    'JSON.stringify(globalThis.__kinect.keyframes.project().look.tracks.bloom[1])',
  );
  const curveAfter = await page.evaluate(
    '[5.0, 6.5].map((t) => globalThis.__kinect.keyframes.valueAt("bloom", t))',
  );
  const moved = worst(curveAfter.map((v, i) => Math.abs(v - curveBefore[i])));
  console.log(`  handle dragged 30px left and 8px down: `
    + `${JSON.parse(handleBefore).easeOut.map((v) => v.toFixed(3))} -> `
    + `${JSON.parse(handleAfter).easeOut.map((v) => v.toFixed(3))}`);
  // Sampled inside the segment the dragged handle actually shapes. The first handle
  // drawn belongs to the selected key's *outgoing* side, so it bends the segment
  // after it and not the one before - sampling the wrong side reads zero change and
  // reports a working handle as broken.
  console.log(`  and the curve it shapes, between 4s and 9s, moved ${moved.toFixed(3)}`);
  check(handleBefore !== handleAfter, 'dragging an ease handle rewrites it');
  check(moved > 0.01, 'and the curve between the keys follows it, which is what a handle is for',
    `${moved.toFixed(4)} of change`);
  const keysHeld = await page.evaluate(
    'globalThis.__kinect.keyframes.project().look.tracks.bloom.map((k) => k.value)',
  );
  check(String(keysHeld) === String(EASED.map((k) => k.value)),
    'while every key value stays exactly where it was, because an ease bends timing and not values',
    String(keysHeld));
  await setTracks({});
}

// ---------------- 6c. and none of it is in the rendered frame

console.log('\n== 6c. the furniture draws outside the frame ==');
{
  await setTracks({ camera: PATH });
  await applyLook(BLACKWALL_LOOK);
  await settle();
  const shots = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const kf = globalThis.__kf;
    const t = k.timeline.transport();
    await t.seek(5.0);
    kf.grab('chrome-on');
    const on = k.keyframes.chrome.on();
    k.keyframes.chrome.set(false);
    await t.seek(5.0);
    kf.grab('chrome-off');
    k.keyframes.chrome.set(true);
    return { on, inset: k.keyframes.chrome.inset() };
  })()`);
  const chromeDiff = await diff('chrome-on', 'chrome-off');
  const insetPct = (shots.inset.w * shots.inset.h) / (STAGE.width * STAGE.height) * 100;
  console.log(`  the top-down covers ${shots.inset.w}x${shots.inset.h} of the stage, `
    + `${insetPct.toFixed(1)}% of it; with the furniture on and off: ${show(chromeDiff)}`);
  check(shots.on === true, 'the furniture was on for the first of the two');
  check(chromeDiff.max === 0,
    'and the rendered frame is byte-identical either way, so none of it is in the image',
    show(chromeDiff));
  // The control: something covering 8% of the stage would be unmissable if it were
  // in there, which is what makes the equality above worth having.
  check(insetPct > 5, 'and it is large enough that it could not have been missed',
    `${insetPct.toFixed(1)}% of the stage`);
}

{
  const unexpected = errors.filter((text) => {
    const match = expected.find((e) => text.includes(e.fragment));
    if (match) match.seen = true;
    return !match;
  });
  check(unexpected.length === 0, 'the page logged no errors it was not asked for',
    unexpected.slice(0, 3).join(' | '));
  for (const e of expected) {
    check(e.seen, `and the one it was asked for arrived: ${e.why}`, e.seen ? '' : 'never logged');
  }
}

if (SHOTS) {
  await page.locator('#stage').screenshot({ path: join(SHOTS, 'keyframe-stage.png') });
  await page.screenshot({ path: join(SHOTS, 'keyframe-page.png') });
}

console.log(`\n[keyframe] ${failures ? `FAIL (${failures})` : 'PASS'}`);
await browser.close();
process.exit(failures ? 1 : 0);
