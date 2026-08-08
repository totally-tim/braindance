#!/usr/bin/env node
// Levelling: the room is rotated into its own frame, and everything downstream of the
// rotation comes level with it.
//
// A sensor is a thing somebody bolted to something and nothing measures the angle it
// ended up at - libfreenect2's device API offers two sets of camera intrinsics and no
// accelerometer - so a cloud from a dashboard mount arrives canted with no gravity
// vector anywhere to straighten it by. `tilt` and `roll` are a human saying which way
// is up, and they turn the cloud rather than the camera. That choice is what this tool
// is mostly about, because it is the choice with consequences: rotating the world
// levels the turntable, the top-down, auto-orbit's axis and the exported frame at
// once, and every one of those is a separate way for the feature to be half-built.
//
// **Five claims, and two of them are invariants rather than behaviours.**
//
//  1. The world actually turns. A picture at a non-zero cant differs from the picture
//     at none. Dull, and it is here because every other section is a comparison that
//     a build ignoring the parameters entirely would satisfy by drawing the same
//     thing twice. `tilt-ignored` is its control and it exists to catch this file
//     passing itself.
//  2. **The crop and the region stay in sensor metres.** They are tested on the
//     undisplaced position in the vertex shader, before the model matrix, so a box
//     shrunk onto a subject stays on that subject when the room is levelled under it.
//     Asserted as an identity rather than by reading the shader: rotating the world
//     and the camera by the same quaternion is a no-op, so the two pictures have to
//     be **bit-identical**. Move the crop test to the far side of the rotation and
//     the surviving set changes, which no camera move can undo - `crop-follows-tilt`.
//  3. The top-down is a top-down of the room and not a slanted section of it. This
//     was the second visible symptom of the same bug and it had no check at all: the
//     inset drew the sensor's own axes, so the box in the corner of a canted take was
//     labelled TOP-DOWN and was not one. Measured two-sided - a plane levelled flat
//     has a fat plan and the same plane stood on its edge has a thin one - because a
//     one-sided "it changed" row passes on any change at all.
//  4. **The sensor view stays literal.** It means exactly what the sensor shot, so it
//     has to be posed in the sensor's frame rather than the levelled one: its picture
//     at any cant is the same picture it gives at none. That is what forces the free
//     camera's up onto the sensor's, which is why navigation's controls are rebuilt
//     rather than written to - see `setNavigationUp` in `web/main.js`.
//  5. **There is a neutral way back, and it goes through the control.** The pair is
//     document state and easy to leave somewhere unusable, so `reset rotation` puts
//     both axes and both sliders back in one press - and it has to be pressed rather
//     than called, because the panel being a view on the registry is the thing that
//     could silently stop being true. `reset-keeps-roll` is its control: a button that
//     took `tilt` home and left `roll` behind passes any row that reads one axis.
//
// **The frames are planted, so this needs no sensor and no capture.** The depth
// texture is written directly with an analytic plane - `z = c / (u . n)` along each
// pixel's own ray - so the normal every section works from is one this file chose. That
// is what lets `levelPair` below state the cant a planted surface should be level at
// instead of asking the page for it, and a fixture take would have given a surface
// nobody knows the normal of.
//
//   node tools/level-check.mjs
//   node tools/level-check.mjs --mutate tilt-ignored             # must FAIL
//   node tools/level-check.mjs --mutate crop-follows-tilt        # must FAIL
//   node tools/level-check.mjs --mutate plan-box-ignores-tilt    # must FAIL
//   node tools/level-check.mjs --mutate crop-switch-reaches-only-the-shader # must FAIL
//   node tools/level-check.mjs --mutate plan-ignores-tilt        # must FAIL
//   node tools/level-check.mjs --mutate plan-skips-vertical-crop # must FAIL
//   node tools/level-check.mjs --mutate region-follows-tilt      # must FAIL
//   node tools/level-check.mjs --mutate sensor-view-ignores-tilt # must FAIL
//   node tools/level-check.mjs --mutate level-order-swapped      # must FAIL
//   node tools/level-check.mjs --mutate reset-keeps-roll         # must FAIL
//   node tools/level-check.mjs --mutate x-not-mirrored           # must FAIL
//   node tools/level-check.mjs --mutate plan-x-not-mirrored      # must FAIL
//
// It spawns its own server and needs none running. `--port` takes one nothing else
// holds; the default is not in any other tool's range, but two worktrees running this
// at once still collide and get each other's server, which is `library-check`'s
// lesson written down again. A GPU browser is required outright rather than optional:
// every claim here is about a picture, so there is no useful subset to run without
// one, and a missing playwright exits **2** - untested is not passed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8377'));
const MUTATE = flag('--mutate');
const WORK = join(REPO, '.level-check');
const RECORDER_URL = `http://127.0.0.1:${PORT}/record`;

// --- mutations -------------------------------------------------------------
// Each names source text and must match exactly once. A replacement matching nothing
// would run an unmutated build and be recorded as this check having missed a bug it
// was never shown.
const MUTATIONS = {
  // The parameters are accepted, stored, drawn on their sliders - and never reach the
  // cloud. This is the whole feature absent behind a working panel, and it is the
  // control for section 1 rather than for any of the comparisons, because every
  // comparison below is satisfied by a build that draws the same picture twice.
  'tilt-ignored': { file: 'web/main.js', edits: [[
    '  cloud.quaternion.copy(worldTilt);',
    '  cloud.quaternion.identity();',
  ]] },
  // The crop moves to the far side of the levelling: the six faces stop being a place
  // in the room and become a place relative to however the room is currently turned.
  // Section 2's identity is what sees it - the surviving set changes, and no camera
  // move can put a discarded point back.
  'crop-follows-tilt': { file: 'web/main.js', edits: [[
    '  if (cropOn == 1.0 && (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT)) {',
    '  vec3 cropAt = (modelMatrix * vec4(pos, 1.0)).xyz;\n'
    + '  if (cropOn == 1.0 && (cropAt.x < cropL || cropAt.x > cropR || cropAt.y < cropB || cropAt.y > cropT)) {',
  ]] },
  // The crop box is drawn straight off the uniforms, in the sensor's axes, over a cloud
  // in the room's. This is what the top-down's old rectangle did for as long as levelling
  // existed, and it had no control at all - the rectangle was two of the six faces and
  // nothing compared it to anything.
  'plan-box-ignores-tilt': { file: 'web/main.js', edits: [[
    '    ).applyQuaternion(worldTilt);',
    '    );',
  ]] },
  // The switch reaches the shader and stops there. The picture releases and the top-down
  // goes on culling the cloud it draws underneath the box - which is the "close the
  // class" failure written as one line: two readers, one of them told. There were three
  // readers while a floor could be selected in the picture, and that reader is gone, so
  // the plan is now the only thing standing between this mutation and a green run.
  'crop-switch-reaches-only-the-shader': { file: 'web/main.js', edits: [[
    '  if (uniforms.cropOn.value !== 1) return false;\n',
    '',
  ]] },
  // The picture levels and the box in the corner does not, which is exactly the state
  // this feature was built to end. Nothing outside section 3 can see it.
  'plan-ignores-tilt': { file: 'web/main.js', edits: [[
    '      planVec.set(wx, wy, -z).applyQuaternion(worldTilt);',
    '      planVec.set(wx, wy, -z);',
  ]] },
  // The plan culls on x alone, which is what it did while a top-down had no y to
  // care about. Levelling turns sensor y into the plan's own x and z, so points the
  // renderer discarded reappear inside the footprint - and only section 3's extent,
  // measured with a crop that bites vertically, can see it.
  //
  // Spelled out at the call site rather than by editing `croppedOut`, and the
  // distinction is what keeps this mutation and the one above apart: reaching into the
  // predicate is `crop-switch-reaches-only-the-shader`'s job and reddens the switch
  // rows, where this one leaves the predicate alone and changes only what the plan
  // thinks to ask it. Two mutations that edited the same function would redden the same
  // rows and neither would say which property was load-bearing.
  'plan-skips-vertical-crop': { file: 'web/main.js', edits: [[
    '      if (croppedOut(wx, wy, z)) continue;',
    '      if (uniforms.cropOn.value === 1\n'
    + '        && (z < uniforms.nearClip.value || z > uniforms.farClip.value\n'
    + '          || wx < uniforms.cropL.value || wx > uniforms.cropR.value)) continue;',
  ]] },
  // The sensor view keeps navigation's own pole and its own axis, so on a levelled
  // take the one button that means "exactly what the sensor shot" shows a rolled
  // picture through a frustum fitted to an unrolled one. The fov rows in
  // `sensor-view-check` cannot see this: the angles it reports are unchanged.
  'sensor-view-ignores-tilt': { file: 'web/main.js', edits: [[
    '  setNavigationUp(new THREE.Vector3(0, 1, 0).applyQuaternion(worldTilt));\n'
    + '  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE).applyQuaternion(worldTilt);',
    '  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE);',
  ]] },
  // The button takes tilt back to neutral and leaves roll behind. Reading both
  // parameters and both sliders through the real control catches the half-reset.
  'reset-keeps-roll': { file: 'web/main.js', edits: [[
    '  return writeWorldRotation(0, 0);',
    '  return writeWorldRotation(0, params.get(\'roll\'));',
  ]] },
  // The region is read after the model rotation instead of on the undisplaced
  // sensor-space position, so a region placed on a subject slides off it the moment
  // the room is levelled underneath. Section 2 is the only thing that can see it, and
  // only because that section now switches a region effect on: with `regionPush`,
  // `regionNoise` and `regionMask` all at zero the shader never evaluates the region
  // coordinate at all, and this mutation and the fix draw the same picture.
  'region-follows-tilt': { file: 'web/main.js', edits: [[
    '  vec3 p0 = pos;',
    '  vec3 p0 = (modelMatrix * vec4(pos, 1.0)).xyz;',
  ]] },
  // The pair is composed the other way round, `Rz(roll) * Rx(tilt)`. Every surface that
  // leans along one axis alone is carried onto the vertical by both orders, so a plant
  // that only tipped away from the sensor could not see this at all - which is why
  // section 3 plants surface B, whose roll is 27 degrees.
  //
  // **It is the two-sided reading that catches this, not the flat one.** Measured: under
  // the swap the surface is left canted, and the flat row still passes, because a canted
  // plane fills a box too and that row asks only for a fat one. What fires is the quarter
  // turn - 118px across flat and 58px on edge where a levelled surface collapses to 28 -
  // since a pose that was never level does not stand on its edge when it is turned as if
  // it were. This is the same reason the section was built two-sided, arriving from a
  // second direction.
  //
  // `registry-check` catches it independently, by writing `Rx * Rz` out longhand and
  // comparing against the landing site. Two tools rather than one is deliberate: this
  // one says the order has a visible consequence, and that one says which order.
  //
  // It shares that row with `plan-ignores-tilt`, which reddens it at 116px flat and 116px
  // on edge. Distinguishable by value and not by name, so the row is load-bearing twice
  // over: weaken it and two controls go quiet together.
  'level-order-swapped': { file: 'web/main.js', edits: [[
    "const tiltEuler = new THREE.Euler(0, 0, 0, 'XYZ');",
    "const tiltEuler = new THREE.Euler(0, 0, 0, 'ZYX');",
  ]] },
  // The shader goes back to being a faithful port of `Registration::getPointXYZ`, which
  // is the state this program shipped in from its first commit: the frames arrive
  // mirrored and nothing undoes it, so the cloud is a reflection of the room. This is the
  // mutation that had no catcher for two years - section 8 is its only one, and only
  // because that section plants something asymmetric. Every other fixture in this file,
  // and the fov and intrinsics arms of `sensor-view-check`, draw the same picture either
  // way round.
  'x-not-mirrored': { file: 'web/main.js', edits: [[
    '    -(pixel.x + 0.5 - center.x) / focal.x * z,',
    '     (pixel.x + 0.5 - center.x) / focal.x * z,',
  ]] },
  // The sign is fixed in the shader and the top-down keeps the old one, so the picture
  // shows the room the right way round and the plan beside it is a reflection. This is
  // "close the class, not the instance" written as one line, and it is a separate control
  // from `x-not-mirrored` for the reason `plan-ignores-tilt` is separate from
  // `tilt-ignored`: one says the sign matters and the other says which readers were told.
  'plan-x-not-mirrored': { file: 'web/main.js', edits: [[
    '      const wx = (-(col + 0.5 - cx) / fx) * z;',
    '      const wx = ((col + 0.5 - cx) / fx) * z;',
  ]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// --- the staged tree -------------------------------------------------------
// A mutation applied in place and restored afterwards leaves a mutated working tree
// behind any crash, which is the one state a proof tool must never produce. `web/` is
// copied rather than linked for the same reason: through a symlink every mutation
// here would rewrite the repo's own source.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const dir of ['server', 'tools', 'web']) cpSync(join(REPO, dir), join(WORK, dir), { recursive: true });
// **`native/` is deliberately not among these, and that is load-bearing rather than an
// omission.** Every frame this tool grades is one it planted, and a live socket wipes a
// plant in well under a second - measured on a page with the sensor attached, a sentinel
// written into all 217k samples was gone within 500ms, because an arriving frame swaps
// the two depth textures and the plant is left in the one nothing reads. The staged tree
// having no grabber binary is what makes the server it spawns quiet, so the plane the
// fit is graded against is still the plane on screen.
//
// It held by accident until a Kinect was first attached to this machine, and nothing in
// this file would have noticed the difference. So the assertion in section 1 checks the
// plant is still there rather than trusting this list, and adding `native` to the line
// below fails that row instead of quietly changing what this tool proves.
//
// Verified rather than reasoned about, by doing exactly that. With `native` staged the
// checksum row fires - 1726596637 against an expected 95354338 - and nine rows fail
// behind it, the fits reading tilt -3.5 roll -32 off surface A where the planted answer
// is 73.5 and 0. Which is the point of the row rather than a bonus: without it those
// nine are a check that has gone mysteriously wrong, and on a stiller scene some of them
// would have passed.
for (const name of ['node_modules', 'vendor', 'captures']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(WORK, name));
}
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const path = join(WORK, spec.file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated build`);
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

// --- harness ---------------------------------------------------------------
let checked = 0;
let failed = 0;
// A claim that could not be tested here at all, which is a third answer and not a
// quiet pass.
let untested = null;
// A run that threw rather than a claim that failed. Kept apart from `failed` so the
// verdict cannot count its own timeout as a mutation being caught.
let crashed = null;
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
const start = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(WORK, 'server/index.js'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  const log = [];
  const onData = (c) => {
    log.push(c.toString());
    if (log.join('').includes('viewer on')) setTimeout(resolve, 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = async () => {
  for (const c of servers) c.kill('SIGKILL');
  servers.length = 0;
  await wait(150);
};

// The three surfaces the sections plant. Each is a unit normal in sensor metres and the
// depth at which its centre ray crosses. **A is deliberately blind to the order the pair
// composes in**: it leans along one axis only, so its roll comes out at zero and
// `Rx * Rz` and `Rz * Rx` are the same rotation. B and C lean both ways, which is why
// section 3 - the section whose control is `level-order-swapped` - plants B rather than
// the simplest of the three. The blind arm is kept rather than replaced, because a set
// of arms that all see a mutation says nothing about which property is load-bearing, and
// the file says which is which here rather than leaving it to a confusing sweep.
const SURFACES = [
  { name: 'A, tipped away from the sensor and not rolled', n: [0, 0.3, -1], z: 2.0 },
  { name: 'B, rolled in its bracket as well', n: [0.45, 0.89, -0.35], z: 2.2 },
  { name: 'C, leaning hard along both axes at once', n: [0.6, 0.6, -0.53], z: 2.0 },
];

/**
 * The pair that carries a planted normal onto the room's vertical, under the
 * `Rx(tilt) * Rz(roll)` order the cloud is turned by.
 *
 * **This is an oracle and not a convenience.** The sections below need a surface that is
 * genuinely level to measure a top-down against, and the cant that makes it so is a fact
 * about the normal this file planted - so it is computed here, from that normal, and
 * never read back out of the page. A check that asked the build under test which angles
 * level its own plant would agree with any build by construction, including one that
 * composes the pair the other way round.
 *
 * `roll` is whatever takes the normal into the YZ plane, which leaves a non-negative
 * horizontal component behind, and `tilt` is whatever then swings that onto the axis.
 * Two angles for two degrees of freedom, with yaw left where it belongs.
 */
const levelPair = ([x, y, z]) => {
  const len = Math.hypot(x, y, z);
  const [nx, ny, nz] = [x / len, y / len, z / len];
  const deg = (rad) => (rad * 180) / Math.PI;
  return {
    tilt: deg(Math.atan2(-nz, Math.hypot(nx, ny))),
    roll: deg(Math.atan2(nx, ny)),
  };
};

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

console.log(`[level] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}\n`);

try {
  let chromium;
  try {
    ({ chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs')));
  } catch {
    untested = 'playwright is not installed, and every claim here is about a picture';
    throw new Error(untested);
  }

  await start();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(RECORDER_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 });

  // The panel overlaps the picture's left edge and its own hover state is a change in
  // the region a comparison would read - `sensor-view-check` records a run that passed
  // a repaint row on a button highlight. Taken out of the document rather than
  // hit-tested around, because nothing here needs to press anything on it.
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });

  /**
   * Plants one analytic plane over the depth image.
   *
   * The look is flattened first and that is not tidiness. Fade, wake and noise are
   * temporal, so a picture compared against another picture would be comparing two
   * moments of an accumulator rather than two geometries, and the identity in section
   * 2 would be false for a reason that has nothing to do with levelling.
   */
  const plant = (surface) => page.evaluate(({ n: n0, z: zc }) => {
    const k = globalThis.__kinect;
    for (const [name, value] of Object.entries({
      fade: 0, wake: 0, noise: 0, additive: false, spin: false, denoise: false,
    })) k.params.set(name, value);
    const DW = 512;
    const DH = 424;
    const fx = k.uniforms.focal.value.x;
    const fy = k.uniforms.focal.value.y;
    const cx = k.uniforms.center.value.x;
    const cy = k.uniforms.center.value.y;
    const len = Math.hypot(n0[0], n0[1], n0[2]);
    const n = n0.map((v) => v / len);
    // `c` is fixed by where the centre ray is wanted, so every surface lands at a
    // sane depth whatever way it leans.
    const c = zc * -n[2];
    const data = k.uniforms.depthCurr.value.image.data;
    data.fill(0);
    for (let row = 0; row < DH; row++) {
      for (let col = 0; col < DW; col++) {
        // The ray this sample lies on, and it is the *page's* unprojection inverted
        // rather than upstream's - x carries the mirror correction `unproject` in
        // `web/main.js` explains. Planting through an un-negated ray would put every
        // surface in the texture at the mirror image of the normal asked for, and the
        // plane fit would then be graded against a normal nobody planted.
        const ux = -(col + 0.5 - cx) / fx;
        const uy = -(row + 0.5 - cy) / fy;
        const den = ux * n[0] + uy * n[1] - n[2];
        if (Math.abs(den) < 1e-6) continue;
        const z = c / den;
        // The renderer's own depth gate, so a planted sample that would be discarded
        // is never written in the first place.
        if (!(z >= k.uniforms.nearClip.value && z <= k.uniforms.farClip.value)) continue;
        data[row * DW + col] = Math.round(z * 1000);
      }
    }
    k.uniforms.depthCurr.value.needsUpdate = true;
    k.resetAccumulators();
    return n;
  }, surface);

  /**
   * Whether the planted frame is still the one the page is drawing.
   *
   * A sparse fingerprint taken at plant time and compared later, rather than the whole
   * grid shipped in and out of the page twice. The texture identity goes with it and is
   * the cheaper half of the answer: an arriving frame *swaps* the two depth textures, so
   * `depthCurr` stops being the object the plant was written into. Both are asserted,
   * because a build that wrote arrivals in place rather than swapping would keep the
   * identity and lose the samples.
   */
  const plantFingerprint = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    const texture = k.uniforms.depthCurr.value;
    const data = texture.image.data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 97) { sum = (sum + data[i] * (i + 1)) % 2147483647; n++; }
    globalThis.__levelPlant = { sum, n, texture };
    return { sum, n };
  });

  const plantHeld = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    const texture = k.uniforms.depthCurr.value;
    const data = texture.image.data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 97) sum = (sum + data[i] * (i + 1)) % 2147483647;
    const was = globalThis.__levelPlant;
    return { sameTexture: texture === was.texture, sum, expected: was.sum };
  });

  const setTilt = (tilt, roll) => page.evaluate(([t, r]) => {
    const k = globalThis.__kinect;
    k.params.set('tilt', t);
    k.params.set('roll', r);
    return { tilt: k.params.get('tilt'), roll: k.params.get('roll'), q: k.worldTilt() };
  }, [tilt, roll]);

  /**
   * The rendered frame, and only the rendered frame.
   *
   * Two shots with a gap, and they have to agree before either is used. A picture that
   * is still moving makes every comparison below meaningless in the direction that
   * reads as a pass - two arms that differ get called a difference, when what happened
   * is that the accumulators had not settled.
   */
  const picture = async () => {
    await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));
    await wait(260);
    const first = await page.locator('#stage').screenshot();
    await wait(160);
    const second = await page.locator('#stage').screenshot();
    return { hash: hash(second), stable: Buffer.compare(first, second) === 0 };
  };

  // --- 1. the world turns ---------------------------------------------------
  console.log('1. the parameters reach the cloud');
  await plant(SURFACES[2]);
  await plantFingerprint();
  await setTilt(0, 0);
  const flat = await picture();
  ok('a picture of a planted surface is stable enough to compare', flat.stable);
  // **Everything below this row is graded against a surface this tool chose, so this
  // row is what says the surface on screen is still that one.** With a sensor attached
  // and a grabber in the staged tree, a live socket wipes a plant in under half a second
  // and every later section would go on passing while measuring the room. Taken after a
  // full `picture()` rather than immediately, because the window that matters is the one
  // a comparison spans.
  const held = await plantHeld();
  ok('and it is still the planted surface after a settle, not a frame off the wire',
    held.sameTexture && held.sum === held.expected,
    held.sameTexture ? `checksum ${held.sum} vs ${held.expected}` : 'the depth texture was swapped under it');
  await setTilt(18, -24);
  const canted = await picture();
  ok('and cants when the two parameters move', flat.hash !== canted.hash,
    `${flat.hash} then ${canted.hash}`);

  // --- 2. the crop is a place in the room -----------------------------------
  console.log('\n2. the crop and the region stay in sensor metres');
  // A box that actually bites. Left open, every point survives either way round and
  // the identity below is true for a build with no crop at all.
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('left', -0.4);
    k.params.set('right', 0.5);
    k.params.set('bottom', -0.35);
    k.params.set('top', 0.45);
  });
  /**
   * A region that actually bites, which this section claimed in its heading and did
   * not do.
   *
   * The crop faces alone cannot prove the region is in sensor space: the shader gates
   * the whole region evaluation behind `regionPush`, `regionNoise` and `regionMask`
   * being non-zero, so with all three at their defaults the region coordinate is never
   * read, and a build that evaluated it after the model rotation drew a pixel-identical
   * picture and passed this section. `region-follows-tilt` is the control for that, and
   * it fails only because this is here.
   *
   * A mask rather than a push, because a push moves points and a mask removes them: the
   * surviving set is what the identity below compares, and a point shoved a little way
   * along its own radius can still land on the pixel it left. The box is centred on the
   * planted surface's own centre ray at two metres, so it takes a bite out of the
   * middle of the plane rather than clipping a corner nothing would miss.
   */
  const armRegion = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('regionZ', -2);
    k.params.set('regionW', 0.25);
    k.params.set('regionH', 0.25);
    k.params.set('regionD', 0.25);
    k.params.set('regionRound', 0.05);
    k.params.set('regionSoft', 0.05);
    k.params.set('regionMask', 1);
  });
  /** Poses the program camera, optionally carried by the world's own rotation. */
  const poseProgram = (carry) => page.evaluate((withTilt) => {
    const k = globalThis.__kinect;
    const cam = k.programCamera;
    cam.up.set(0, 1, 0);
    cam.position.set(0.35, 0.45, 1.5);
    cam.lookAt(0, 0, -2);
    const position = cam.position.clone();
    const quaternion = cam.quaternion.clone();
    if (withTilt) {
      const q = cam.quaternion.clone().fromArray(k.worldTilt());
      position.applyQuaternion(q);
      quaternion.premultiply(q);
    }
    k.params.set('camera', { position: position.toArray(), quaternion: quaternion.toArray(), fov: 50 });
    k.setViewCamera(k.programCamera);
  }, carry);

  await setTilt(0, 0);
  await poseProgram(false);
  const bare = await picture();
  ok('the same surface through a fixed pose is stable', bare.stable);
  await armRegion();
  const still = await picture();
  // The row that stops the region rows below being vacuous. A region whose box missed
  // the planted plane, or whose mask was left at zero, would satisfy every identity in
  // this section by changing nothing - which is exactly the state this section was in.
  ok('switching the region on takes points out of the picture, so it is in the proof at all',
    bare.hash !== still.hash, `${bare.hash} then ${still.hash}`);
  ok('and the picture with the region on is stable enough to compare', still.stable);
  await setTilt(22, 31);
  await poseProgram(true);
  const carried = await picture();
  ok('turning the world and the camera by the same rotation changes nothing at all',
    still.hash === carried.hash, `${still.hash} then ${carried.hash}`);
  // Without this row the identity above is satisfied by a build where the camera is
  // not carried either - two pictures that are the same because nothing moved.
  await poseProgram(false);
  const notCarried = await picture();
  ok('and leaving the camera behind does change it, so the identity is not vacuous',
    still.hash !== notCarried.hash, `${still.hash} then ${notCarried.hash}`);
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.setViewCamera(k.freeCamera);
    // The region goes back with the crop. Section 3 measures the plan cloud's extent
    // and section 5 fits a plane through the planted samples, and a mask still eating
    // the middle of that surface would be measuring a hole in both.
    k.params.reset([
      'left', 'right', 'bottom', 'top',
      'regionZ', 'regionW', 'regionH', 'regionD', 'regionRound', 'regionSoft', 'regionMask',
    ]);
  });

  // --- 3. the top-down is a top-down of the room ----------------------------
  console.log('\n3. the top-down draws the levelled frame');
  /**
   * The plan cloud's own bounding box in the inset, in pixels.
   *
   * Filtered by colour rather than by area: the path and the frustum are drawn in the
   * same box in teal and orange, and a bounding box that swallowed either would be
   * measuring the furniture. The cloud is the only near-neutral thing in there.
   */
  // Read off the overlay's own backing store rather than out of a screenshot: it is a
  // 2D canvas, so the pixels are there for the asking, and going through a PNG would
  // have added a decoder this repo does not otherwise depend on.
  const planExtent = async () => {
    await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(true));
    await wait(220);
    return page.evaluate(() => {
      const canvas = document.getElementById('chrome');
      const r = globalThis.__kinect.keyframes.chrome.inset();
      // The overlay is drawn through a device-pixel-ratio transform, so the inset's
      // CSS rectangle has to be taken back into the buffer's own scale.
      const scale = canvas.width / r.stage.w;
      const x0 = Math.round(r.x * scale);
      const y0 = Math.round(r.y * scale);
      const w = Math.round(r.w * scale);
      const h = Math.round(r.h * scale);
      const px = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let n = 0;
      let sumX = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const red = px[i]; const green = px[i + 1]; const blue = px[i + 2];
          if (px[i + 3] < 40) continue;
          // Bright and near-neutral. The plan cloud is drawn at (232, 236, 241), the
          // path in teal and the frustum in orange, and a box that swallowed either of
          // those would be measuring the furniture.
          if (red < 90 || Math.abs(red - green) > 26 || Math.abs(green - blue) > 26) continue;
          n++;
          sumX += x;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      // `sumX` and `insetW` are raw on purpose, and section 8 is what needs them: an
      // extent is invariant under a reflection and a position is not, so every row that
      // measures `w` and `h` would pass a plan drawn mirrored. They come out unreduced
      // because the filter above does not catch quite everything - see section 8 - and a
      // centroid computed here would bake that in where a caller cannot subtract it.
      return n === 0
        ? { n: 0, sumX: 0, insetW: w }
        : { n, w: maxX - minX + 1, h: maxY - minY + 1, scale, sumX, insetW: w };
    });
  };

  // Surface B, which leans along both axes: its roll is 27 degrees, so the pair that
  // levels it is a different pair under each composition order and this whole section
  // is `level-order-swapped`'s catcher. A surface that only tipped away from the sensor
  // would be levelled correctly by either order and every row below would stay green.
  //
  // The cant comes from `levelPair` rather than from the page, and is written through
  // `setTilt` so the angles the rest of the section reasons with are the ones the
  // sliders actually hold after snapping to their half-degree step.
  await setTilt(0, 0);
  await plant(SURFACES[1]);
  const level = levelPair(SURFACES[1].n);
  const flatPose = await setTilt(level.tilt, level.roll);
  {
    const flatPlan = await planExtent();
    ok('a surface levelled flat covers the top-down in two directions',
      flatPlan.n > 200 && Math.min(flatPlan.w, flatPlan.h) > 8,
      `${flatPlan.n} plan points, ${flatPlan.w}x${flatPlan.h}px at tilt ${flatPose.tilt} roll ${flatPose.roll}`);
    // **The vertical crop, which this plan ignored on purpose until levelling existed.**
    // While the top-down was drawn about the sensor's own axes, sensor y ran straight up
    // the axis a top-down projects away, so a point cropped by `bottom`/`top` could not
    // have landed on a pixel this view has and culling on x alone was free. Levelling
    // mixes y into the plan's own x and z, and a point the renderer threw away now lands
    // inside the footprint looking like geometry. Measured with the room still levelled
    // flat, because that is the pose where the whole surface is in the box and a strip
    // taken out of it is a change this extent can actually see.
    await page.evaluate(() => {
      const k = globalThis.__kinect;
      k.params.set('bottom', -0.25);
      k.params.set('top', 0.25);
    });
    const croppedPlan = await planExtent();
    ok('and closing the crop in sensor y takes points out of it, which a plan culling on x alone cannot do',
      croppedPlan.n > 0 && croppedPlan.n * 1.2 < flatPlan.n,
      `${flatPlan.n} plan points with the crop open, ${croppedPlan.n} with bottom/top closed`);
    await page.evaluate(() => globalThis.__kinect.params.reset(['bottom', 'top']));
    // A further quarter turn about x stands the same surface on its edge: whatever was
    // carried onto +Y goes to -Z, which is horizontal, so its top-down collapses to a
    // line. Two-sided on purpose - the fat reading alone passes on a plan that ignores
    // the levelling entirely, because a canted plane fills a box too.
    await setTilt(flatPose.tilt - 90, flatPose.roll);
    const edgePlan = await planExtent();
    const flatMinor = Math.min(flatPlan.w, flatPlan.h);
    const edgeMinor = Math.min(edgePlan.w ?? 0, edgePlan.h ?? 0);
    ok('and standing it on its edge collapses that box to a line',
      edgePlan.n > 0 && edgeMinor * 3 < flatMinor,
      `${flatMinor}px across flat, ${edgeMinor}px on edge`);
  }
  await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));

  // --- 4. the sensor view stays literal -------------------------------------
  console.log('\n4. the sensor view is posed in the sensor frame');
  await plant(SURFACES[2]);
  await setTilt(0, 0);
  await page.evaluate(() => globalThis.__kinect.sensorView());
  const sensorFlat = await picture();
  ok('the sensor view of a planted surface is stable', sensorFlat.stable);
  await setTilt(26, -37);
  await page.evaluate(() => globalThis.__kinect.sensorView());
  const sensorCanted = await picture();
  ok('and is the same picture at any cant, because it means what the sensor shot',
    sensorFlat.hash === sensorCanted.hash, `${sensorFlat.hash} then ${sensorCanted.hash}`);
  const restored = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const sensorUp = k.freeCamera.up.toArray();
    k.params.set('tilt', 4);
    return { sensorUp, afterLevelling: k.freeCamera.up.toArray() };
  });
  ok('the sensor view takes navigation onto the sensor pole',
    Math.abs(restored.sensorUp[1] - 1) > 1e-3, restored.sensorUp.map((v) => v.toFixed(3)).join(', '));
  ok('and touching either levelling parameter puts the pole back on the room',
    Math.abs(restored.afterLevelling[1] - 1) < 1e-9,
    restored.afterLevelling.map((v) => v.toFixed(3)).join(', '));

  // --- 5. the neutral way back ----------------------------------------------
  console.log('\n5. reset rotation puts both axes and both sliders back');
  // **Through the control and not through the hook**, and that is why these rows drive a
  // button at all rather than calling `resetWorldRotation`. `editor-check` names this
  // tool as `camLevelReset`'s driver, and a driver that reached past the control into the
  // function behind it would be the exact failure that file was written about: the suite
  // testing the model while the control it is named after was never pressed, which is how
  // the in and out markers spent their whole life detached from the document with every
  // proof tool green.
  await page.evaluate(() => { document.getElementById('panel').style.display = ''; });
  // **And the inspector holding it is selected, because the panel is four tabs now.**
  // Showing `#panel` was enough while it was one column; with tabs, every group outside
  // the selected one is `display: none`, so this click waited thirty seconds on a
  // button plainly in the document and the run ended at "did not finish" with
  // twenty-four rows passed and one failed. The tab is read off the group that contains
  // the button rather than named, so the next reorganisation moves it without moving
  // this.
  await page.evaluate(() => {
    const tab = document.getElementById('camLevelReset')?.closest('[data-panel-tab]')?.dataset.panelTab;
    if (tab) document.querySelector(`.paneltab[data-panel-tab="${tab}"]`)?.click();
  });
  await setTilt(12.5, -6);
  await page.locator('#camLevelReset').click();
  const reset = await page.evaluate(() => ({
    tilt: globalThis.__kinect.params.get('tilt'),
    roll: globalThis.__kinect.params.get('roll'),
    sliders: [document.getElementById('tilt').value, document.getElementById('roll').value],
  }));
  // Both axes and both sliders. A button that took `tilt` home and left `roll` behind
  // satisfies any row reading one of them, which is `reset-keeps-roll`; and the sliders
  // are read beside the parameters rather than instead of them, because the panel being
  // a view on the registry is the thing that could quietly stop being true - a reset
  // that moved the value and not the view looks like a reset that worked to anything
  // asking only one of the two.
  ok('reset rotation takes both axes and both sliders back to neutral',
    reset.tilt === 0 && reset.roll === 0 && reset.sliders.every((value) => Number(value) === 0),
    `rotation ${reset.tilt}/${reset.roll}, sliders ${reset.sliders.join('/')}`);
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });

  // --- 6. which side of the document boundary it falls on --------------------
  console.log('\n6. the cant is the take\'s and the pole is the viewer\'s');
  const boundary = await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('tilt', 12.5);
    k.params.set('roll', -6);
    const document = k.params.values();
    const view = k.params.values(k.params.names('view'));
    return {
      inDocument: 'tilt' in document && 'roll' in document,
      values: [document.tilt, document.roll],
      leakedToView: 'tilt' in view || 'roll' in view,
      tags: [k.params.spec('tilt').tag, k.params.spec('roll').tag],
      ranges: [k.params.spec('tilt'), k.params.spec('roll')].map((s) => [s.min, s.max]),
    };
  });
  ok('both are document state, so a project carries the cant it was levelled at',
    boundary.inDocument && !boundary.leakedToView, `${boundary.values.join(', ')} tagged ${boundary.tags.join('/')}`);
  // Every orientation a mount can end up at has to be reachable on the sliders, and
  // `levelPair`'s two `atan2`s say what that span is: `roll` over the full turn, `tilt`
  // against a non-negative horizontal component and so inside the quarter turn either
  // side. A range short of these would refuse a bracket somebody actually built, and
  // would do it by clamping rather than by saying so.
  ok('and the sliders reach every cant a surface can be levelled from',
    boundary.ranges[0][0] <= -90 && boundary.ranges[0][1] >= 90
    && boundary.ranges[1][0] <= -180 && boundary.ranges[1][1] >= 180,
    JSON.stringify(boundary.ranges));
  console.log('\n7. the crop box is drawn in the room and its switch reaches every reader');

  // Section 2 asserts the crop is *tested* in sensor metres, before the model matrix, so
  // a box shrunk onto a subject stays on that subject when the room is levelled. This is
  // the drawing's half of the same fact and it points the other way: the box is drawn in
  // the room, so the picture of it has to carry the rotation the test deliberately does
  // not. Both halves are needed - the shader ignoring the tilt and the chrome applying
  // it are two statements about one box, and the old top-down rectangle got the second
  // one wrong for as long as levelling existed.
  await setTilt(14, -9);
  const box = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const q = k.worldTilt();
    const u = k.uniforms;
    const lo = [u.cropL.value, u.cropB.value, -u.farClip.value];
    const hi = [u.cropR.value, u.cropT.value, -u.nearClip.value];
    // Turned by the quaternion read off the cloud rather than by one composed from the
    // two sliders. That is the difference between holding the drawing to what the
    // renderer is actually doing and holding it to a second calculation that agrees with
    // it by construction.
    const v = new (k.freeCamera.position.constructor)();
    const rot = k.freeCamera.quaternion.clone().fromArray(q);
    const want = [];
    for (let i = 0; i < 8; i++) {
      want.push(v.set(
        (i & 1) ? hi[0] : lo[0],
        (i & 2) ? hi[1] : lo[1],
        (i & 4) ? hi[2] : lo[2],
      ).applyQuaternion(rot).toArray());
    }
    const got = k.cropBoxCorners();
    const worst = Math.max(...got.map((c, i) => Math.max(...c.map((n, j) => Math.abs(n - want[i][j])))));
    // The control for the row: a box already sitting in the room's frame would satisfy
    // the comparison above without carrying anything, so the corners must also be
    // somewhere the unrotated box is not.
    const bare = Math.max(...got.map((c, i) => Math.max(...c.map((n, j) => Math.abs(n
      - [(i & 1) ? hi[0] : lo[0], (i & 2) ? hi[1] : lo[1], (i & 4) ? hi[2] : lo[2]][j])))));
    return { worst, bare };
  });
  ok('the box the chrome draws is the sensor box turned by the rotation the cloud carries',
    box.worst < 1e-6, `worst corner off by ${box.worst.toExponential(2)} m`);
  ok('and it is not simply the sensor box, which a levelled room would draw beside its cloud',
    box.bare > 0.05, `${box.bare.toFixed(3)} m from the unrotated box`);

  // The switch, asked of a reader that is not the shader. The top-down walks the depth
  // texture through the same six faces, so a crop that bites takes points out of the
  // plan - and has to hand them back the moment the switch says the box does not bite.
  // A `crop` wired to the shader alone leaves the top-down culling a cloud the picture
  // is showing in full, which is section 3's disagreement arriving from the other side.
  //
  // **This used to ask floor selection, which walked the same texture and applied the
  // same faces.** That gesture is gone and the plan is the only non-shader reader left,
  // so `crop-switch-reaches-only-the-shader` has exactly one catcher and it is here.
  //
  // Measured with the surface levelled flat, for section 3's reason: that is the pose
  // where the whole plane is inside the box, so a strip taken out of it is a change this
  // extent can actually see.
  await plant(SURFACES[1]);
  const switchFlat = levelPair(SURFACES[1].n);
  await setTilt(switchFlat.tilt, switchFlat.roll);
  const openPlan = await planExtent();
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('bottom', -0.25);
    k.params.set('top', 0.25);
  });
  const bitingPlan = await planExtent();
  await page.evaluate(() => globalThis.__kinect.params.set('crop', false));
  const releasedPlan = await planExtent();
  await page.evaluate(() => {
    globalThis.__kinect.params.reset(['bottom', 'top', 'crop']);
    globalThis.__kinect.keyframes.chrome.set(false);
  });
  ok('a crop that bites takes points out of the top-down',
    bitingPlan.n > 0 && bitingPlan.n * 1.2 < openPlan.n,
    `${openPlan.n} plan points with the box open, ${bitingPlan.n} with bottom/top closed`);
  // Back to the open count exactly, rather than merely upward. The same plant drawn
  // through the same camera is the same set of pixels twice, so anything short of the
  // open count is a switch that released *something else* - and a row asking only for
  // more points would pass a build that widened the faces instead of standing them down.
  ok('and releasing the switch hands them back, so the switch reaches more than the shader',
    releasedPlan.n === openPlan.n,
    `${bitingPlan.n} biting, ${releasedPlan.n} released, ${openPlan.n} open`);

  // --- 8. the cloud is not a reflection of the room -------------------------
  console.log('\n8. the unprojection is mirrored, on both readers that state it');
  /**
   * A slab of constant depth in one column band, and nothing anywhere else.
   *
   * **Asymmetric on purpose, and that is the only reason this section can exist.** Every
   * other fixture in this file is a plane, and a plane is symmetric about the optical
   * axis - reflect it and it is the same plane. So no row that plants a `SURFACES` entry
   * can see a sign on x, which is how a mirrored cloud sat in this program from its first
   * commit through every proof tool in the suite: `level-check` plants symmetric planes,
   * the intrinsics and fov arms of `sensor-view-check` measure half-angles, and
   * `registration-check` grades `Registration::apply` rather than the unprojection. A
   * mirror was invariant under the entire rig. The band is deliberately off-centre and
   * deliberately not added to `SURFACES`, because a fixture list of planes is the thing
   * that was missing an object rather than a list that wanted one more entry.
   *
   * **What this section can and cannot say.** It cannot see the room - no offline fixture
   * can, and the flip was established by measurement on the rig instead: the colour
   * camera's own 1920x1080 frame off `/camera.mjpg` carries branded text that reads only
   * after one horizontal flip, on a JPEG with a JFIF APP0 marker and no EXIF segment for
   * anything downstream to have been applying. What this section does is pin the sign that
   * measurement settled, so the next edit through here cannot quietly undo it, and hold
   * the shader and the top-down to the same one.
   */
  const plantBar = (offsetFrom, offsetTo, metres) => page.evaluate(({ a, b, z }) => {
    const k = globalThis.__kinect;
    for (const [name, value] of Object.entries({
      fade: 0, wake: 0, noise: 0, additive: false, spin: false, denoise: false,
    })) k.params.set(name, value);
    const DW = 512;
    const DH = 424;
    const cx = k.uniforms.center.value.x;
    const from = Math.max(0, Math.round(cx + a));
    const to = Math.min(DW, Math.round(cx + b));
    const data = k.uniforms.depthCurr.value.image.data;
    data.fill(0);
    let n = 0;
    if (z > 0) {
      const mm = Math.round(z * 1000);
      for (let row = 0; row < DH; row++) {
        for (let col = from; col < to; col++) { data[row * DW + col] = mm; n++; }
      }
    }
    k.uniforms.depthCurr.value.needsUpdate = true;
    k.resetAccumulators();
    return { n, from, to, cx };
  }, { a: offsetFrom, b: offsetTo, z: metres });

  /**
   * The crop, used as a fixed frame of reference rather than as the thing under test.
   *
   * The six faces are world-space constants and the cloud's x is not, so half-opening the
   * box turns "which side of the axis did this band land on" into "is the stage empty" -
   * a question `picture()` already answers, with no pixel read and no second render path
   * to keep honest. It is also a genuinely different reader: `croppedOut` compares against
   * the same `pos.x` the geometry is built from, so a sign that moves moves the cloud
   * relative to a box that does not.
   */
  const keepSideOfAxis = (side) => page.evaluate((s) => {
    const k = globalThis.__kinect;
    k.params.set('crop', true);
    k.params.set('left', s === 'negative' ? -7 : 0.05);
    k.params.set('right', s === 'negative' ? -0.05 : 7);
  }, side);

  await setTilt(0, 0);
  await page.evaluate(() => globalThis.__kinect.sensorView());
  await wait(260);
  // The reference, and it is an empty *grid* rather than an empty crop: every row below
  // reads "equal to this" as "the band was entirely on the other side of the axis", so
  // the reference has to be a stage with nothing in it for a reason the crop cannot also
  // produce by accident.
  await plantBar(0, 0, 0);
  const emptyStage = await picture();
  ok('an empty depth grid draws a stable empty stage to compare against', emptyStage.stable,
    `hash ${emptyStage.hash}`);

  const RIGHT_BAND = [80, 140];
  const LEFT_BAND = [-140, -80];
  // Five metres rather than two, and the depth is what buys the top-down its margin. The
  // band's world x is `offset / fx * z`, so the column offset sets the angle and the
  // distance sets how far across the inset that angle lands. Measured at five: the two
  // bands come out at 0.358 and 0.646 of the inset's width, 0.288 apart and symmetric
  // about its centre to within 0.004, against thresholds at 0.44 and 0.56. Still inside
  // `farClip` and inside the plan's 7m span. The crop rows above are indifferent to the
  // depth - culling on x is scale-free - so one fixture serves both readers.
  const BAND_DEPTH = 5;
  const bandRight = await plantBar(RIGHT_BAND[0], RIGHT_BAND[1], BAND_DEPTH);
  await plantFingerprint();
  ok('a band planted right of the principal point has samples in it',
    bandRight.n > 20000, `${bandRight.n} samples in columns ${bandRight.from}..${bandRight.to}`);
  await keepSideOfAxis('negative');
  const rightOnNeg = await picture();
  await keepSideOfAxis('positive');
  const rightOnPos = await picture();
  const heldRight = await plantHeld();
  ok('and the band is still the planted one, not a frame off the wire',
    heldRight.sameTexture && heldRight.sum === heldRight.expected,
    heldRight.sameTexture ? `checksum ${heldRight.sum} vs ${heldRight.expected}` : 'the depth texture was swapped under it');
  // The load-bearing pair. A band on the image's *right* is at negative world x once the
  // mirror is undone, so it survives a box that keeps only the negative side and vanishes
  // from one that keeps only the positive side. Un-negate the unprojection and both rows
  // invert together.
  ok('a band on the image right survives a crop keeping only negative x',
    rightOnNeg.stable && rightOnNeg.hash !== emptyStage.hash,
    `${rightOnNeg.hash} against an empty ${emptyStage.hash}`);
  ok('and nothing of it survives a crop keeping only positive x',
    rightOnPos.stable && rightOnPos.hash === emptyStage.hash,
    `${rightOnPos.hash} against an empty ${emptyStage.hash}`);

  // **Two-sided, because one side cannot tell a mirror from a build that culls.** A row
  // asking only that the right-hand band lands on negative x is satisfied by a shader
  // that put every point at negative x, or drew nothing at all, and either would read as
  // a pass. The complement is what makes the pair a measurement of the sign.
  await plantBar(LEFT_BAND[0], LEFT_BAND[1], BAND_DEPTH);
  await plantFingerprint();
  await keepSideOfAxis('positive');
  const leftOnPos = await picture();
  await keepSideOfAxis('negative');
  const leftOnNeg = await picture();
  ok('the mirrored band answers the other way round: it survives on positive x',
    leftOnPos.stable && leftOnPos.hash !== emptyStage.hash,
    `${leftOnPos.hash} against an empty ${emptyStage.hash}`);
  ok('and vanishes on negative x, so the two bands are on opposite sides of the axis',
    leftOnNeg.stable && leftOnNeg.hash === emptyStage.hash,
    `${leftOnNeg.hash} against an empty ${emptyStage.hash}`);

  // The top-down, asked the same question, because it states the unprojection for itself
  // in another language's worth of code and a sign fixed in the shader alone leaves the
  // plan drawing the room's left on the plan's right. Position rather than extent: an
  // extent is invariant under a reflection, which is why every existing row in section 3
  // would pass a mirrored plan.
  //
  // **The inset's own furniture is measured and subtracted rather than filtered around.**
  // `planExtent`'s comment claims the cloud is the only near-neutral thing in the box, and
  // that is not quite true: the TOP-DOWN caption is `#6d7683`, which clears the brightness
  // floor and both neutrality bounds, and it sits in the bottom-left corner. Left in, it
  // drags a centroid a fixed distance toward the left edge - measured at about 0.17 of the
  // inset's width, which is larger than the displacement these two bands produce, so the
  // uncorrected reading put both of them left of centre and 0.017 apart. An empty depth
  // grid is what the box looks like with no cloud in it, so the difference between the two
  // readings is the cloud on its own and the caption cancels exactly rather than
  // approximately. Section 3's extents have the same passenger and are wide enough not to
  // care; the claim in that comment is the thing that is wrong, and it is noted here
  // rather than quietly patched there.
  await page.evaluate(() => globalThis.__kinect.params.reset(['left', 'right', 'crop']));
  await plantBar(0, 0, 0);
  const planBare = await planExtent();
  await plantBar(LEFT_BAND[0], LEFT_BAND[1], BAND_DEPTH);
  const planLeftBand = await planExtent();
  await plantBar(RIGHT_BAND[0], RIGHT_BAND[1], BAND_DEPTH);
  const planRightBand = await planExtent();
  await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));
  const bandAcross = (shot) => (shot.sumX - planBare.sumX) / (shot.n - planBare.n) / shot.insetW;
  const rightAcross = bandAcross(planRightBand);
  const leftAcross = bandAcross(planLeftBand);
  ok('the top-down puts the image-right band left of its own centre, as the picture does',
    planRightBand.n > planBare.n && rightAcross < 0.44,
    `${planRightBand.n - planBare.n} cloud pixels at ${rightAcross.toFixed(3)} across`);
  ok('and the image-left band right of it, so the plan and the shader share one sign',
    planLeftBand.n > planBare.n && leftAcross > 0.56,
    `${planLeftBand.n - planBare.n} cloud pixels at ${leftAcross.toFixed(3)} across`);

  ok('the page reported no error through any of it', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  await browser.close();
} catch (err) {
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
} finally {
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[level] ${checked} assertions, ${failed} failed`);
if (crashed && !untested) {
  console.log(`[level] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested) {
  console.log(`[level] UNTESTED - ${untested}.`);
  process.exit(2);
}
if (MUTATE) {
  // Exit code alone cannot tell a caught mutation from a tool that crashed before
  // asserting anything, and this repo has been bitten by exactly that twice.
  if (failed === 0) { console.log('[level] NOT CAUGHT - the check passed a build it should have rejected'); process.exit(1); }
  console.log(`[level] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[level] FAIL'); process.exit(1); }
console.log('[level] PASS');
process.exit(0);
