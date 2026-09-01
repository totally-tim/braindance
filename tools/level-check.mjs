#!/usr/bin/env node
// Levelling: the room is rotated into its own frame, and everything downstream of the rotation
// comes level with it. Nothing measures the angle a sensor was bolted at, so `tilt` and `roll` are
// a human saying which way is up, and they turn the cloud rather than the camera - which levels the
// turntable, the top-down, auto-orbit's axis and the exported frame at once, and every one of those
// is a separate way for the feature to be half-built.
//
// Two of the five claims are invariants: the crop and the region are tested on the undisplaced
// position in the vertex shader, so rotating the world and the camera by the same quaternion is a
// no-op and the two pictures have to be bit-identical, and the sensor view is posed in the sensor's
// frame, so its picture at any cant is the picture it gives at none. Section 3 is measured
// two-sided, because a one-sided "it changed" row passes on any change at all. The frames are
// planted - `z = c / (u . n)` along each pixel's own ray - so this needs no sensor and no capture,
// and `levelPair` can state the cant a surface should be level at instead of asking the page for
// it. It spawns its own server, and a missing GPU browser exits 2, because untested is not passed.
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

// Each names source text and must match exactly once. A replacement matching nothing would run an
// unmutated build and be recorded as this check having missed a bug it was never shown.
const MUTATIONS = {
  // The parameters are accepted, stored and drawn on their sliders, and never reach the cloud. The
  // control for section 1 rather than for any comparison, because every comparison below is
  // satisfied by a build that draws the same picture twice.
  'tilt-ignored': { file: 'web/main.js', edits: [[
    '  tiltQuaternion(levelAngles.tilt, levelAngles.roll, level.quaternion);',
    '  level.quaternion.identity();',
  ]] },
  // The crop moves to the far side of the levelling, so the six faces stop being a place in the
  // room. Section 2's identity sees it: the surviving set changes, and no camera move can put a
  // discarded point back.
  'crop-follows-tilt': { file: 'web/cloud-shader.js', edits: [[
    '  if (outsideLateral(pos.xy)) {',
    '  if (outsideLateral((modelMatrix * vec4(pos, 1.0)).xy)) {',
  ]] },
  // The crop box is drawn straight off the uniforms, in the sensor's axes, over a cloud in the
  // room's - what the top-down's old rectangle did for as long as levelling existed, with
  // no control at all.
  'plan-box-ignores-tilt': { file: 'web/main.js', edits: [[
    '    ).applyMatrix4(level.matrixWorld);',
    '    );',
  ]] },
  // The switch reaches the shader and stops there, so the top-down goes on culling the cloud the
  // picture is showing in full. Two readers, one of them told; the plan is now the only one left
  // that can catch it.
  'crop-switch-reaches-only-the-shader': { file: 'web/point-cloud.js', edits: [[
    '    crop: uniforms.cropOn.value === 1,',
    '    crop: true,',
  ]] },
  // The picture levels and the box in the corner does not, which is the state this feature was
  // built to end. Nothing outside section 3 can see it.
  'plan-ignores-tilt': { file: 'web/main.js', edits: [[
    '      planVec.applyQuaternion(scratchQuat).add(scratchPosition);',
    '      planVec.add(scratchPosition);',
  ]] },
  // The plan culls on x alone, which is what it did while a top-down had no y to care about;
  // levelling turns sensor y into the plan's own x and z, so discarded points reappear inside the
  // footprint. Spelled out at the call site rather than by editing `croppedOut`, so two mutations
  // do not redden the same rows.
  'plan-skips-vertical-crop': { file: 'web/main.js', edits: [[
    '      if (croppedOut(planVec.x, planVec.y, z)) continue;',
    '      if (uniforms.cropOn.value === 1\n'
    + '        && (z < uniforms.nearClip.value || z > uniforms.farClip.value\n'
    + '          || planVec.x < uniforms.cropL.value || planVec.x > uniforms.cropR.value)) continue;',
  ]] },
  // The sensor view keeps navigation's own pole and axis, so on a levelled take the one button
  // meaning "exactly what the sensor shot" shows a rolled picture. `sensor-view-check`'s fov rows
  // cannot see this.
  'sensor-view-ignores-tilt': { file: 'web/main.js', edits: [[
    '  setNavigationUp(new THREE.Vector3(0, 1, 0).applyQuaternion(scratchQuat));\n'
    + '  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE).applyQuaternion(scratchQuat).add(scratchPosition);',
    '  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE).add(scratchPosition);',
  ]] },
  // The button takes tilt back to neutral and leaves roll behind. Reading both parameters and both
  // sliders through the real control catches the half-reset.
  'reset-keeps-roll': { file: 'web/main.js', edits: [[
    '  return writeWorldRotation(0, 0);',
    '  return writeWorldRotation(0, params.get(\'roll\'));',
  ]] },
  // The region is read after the model rotation instead of on the undisplaced sensor-space
  // position. Section 2 is the only thing that can see it, and only because that section switches a
  // region effect on - at the default zeroes the shader never evaluates the region
  // coordinate at all.
  'region-follows-tilt': { file: 'web/cloud-shader.js', edits: [[
    '  vec3 p0 = pos;',
    '  vec3 p0 = (modelMatrix * vec4(pos, 1.0)).xyz;',
  ]] },
  // The pair is composed the other way round, `Rz(roll) * Rx(tilt)`. Every surface leaning along
  // one axis alone is carried onto the vertical by both orders, which is why section 3 plants
  // surface B at 27 degrees of roll, and it is the two-sided reading that catches it - a canted
  // plane fills a box too. `registry-check` catches it independently by writing `Rx *
  // Rz` out longhand.
  'level-order-swapped': { file: 'web/world-tilt.js', edits: [[
    "const tiltEuler = new THREE.Euler(0, 0, 0, 'XYZ');",
    "const tiltEuler = new THREE.Euler(0, 0, 0, 'ZYX');",
  ]] },
  // The shader goes back to being a faithful port of `Registration::getPointXYZ`: the frames arrive
  // mirrored and nothing undoes it, so the cloud is a reflection of the room. This had no catcher
  // for two years, and section 8 is its only one.
  'x-not-mirrored': { file: 'web/cloud-shader.js', edits: [[
    '    -(pixel.x + 0.5 - center.x) / focal.x * z,',
    '     (pixel.x + 0.5 - center.x) / focal.x * z,',
  ]] },
  // The sign is fixed in the shader and the top-down keeps the old one, so the picture shows the
  // room the right way round and the plan beside it is a reflection. One says the sign matters, the
  // other says which readers were told.
  // Aimed at `web/crop-box.js`, where the JavaScript unprojection now lives: it was in the plan's
  // own loop, moved to `web/depth-pick.js` when the pivot's pick came to need it, and moved again
  // when the webcam page came to need it under bare node. Each move widened the mutation and that
  // is the point - one spelling means one control, so this now turns over the pick, the plan and
  // the page together rather than leaving a copy this file would have gone on testing alone. The
  // shader keeps its own spelling in GLSL, which is what `x-not-mirrored` above is for.
  'plan-x-not-mirrored': { file: 'web/crop-box.js', edits: [[
    '  point.x = (-(col + 0.5 - cx) / fx) * zMetres;',
    '  point.x = ((col + 0.5 - cx) / fx) * zMetres;',
  ]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// A mutation applied in place and restored afterwards leaves a mutated working tree behind any
// crash. `web/` is copied rather than linked for the same reason: through a symlink every mutation
// here would rewrite the repo's own source.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
// `effects-builtin` is in this list because the effect store declines to boot without its shipped
// root, so from the moment the packages arrived the staged tree here was a server that could not
// start, and this tool reported `DID NOT RUN` on every run.
for (const dir of ['server', 'tools', 'web', 'effects-builtin']) cpSync(join(REPO, dir), join(WORK, dir), { recursive: true });
// `native/` is deliberately not among these. A live socket wipes a plant in well under a second -
// measured, a sentinel written into all 217k samples was gone within 500ms, because an arriving
// frame swaps the two depth textures. Section 1 checks the plant is still there rather than
// trusting this list, so adding `native` here fails that row instead of quietly changing what
// this tool proves.
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

let checked = 0;
let failed = 0;
// A claim that could not be tested here at all, which is a third answer and not a quiet pass.
let untested = null;
// A run that threw rather than a claim that failed. Kept apart from `failed` so the verdict cannot
// count its own timeout as a mutation being caught.
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

// Each is a unit normal in sensor metres and the depth at which its centre ray crosses. A is
// deliberately blind to the order the pair composes in - it leans along one axis only - while B and
// C lean both ways, which is why section 3 plants B.
const SURFACES = [
  { name: 'A, tipped away from the sensor and not rolled', n: [0, 0.3, -1], z: 2.0 },
  { name: 'B, rolled in its bracket as well', n: [0.45, 0.89, -0.35], z: 2.2 },
  { name: 'C, leaning hard along both axes at once', n: [0.6, 0.6, -0.53], z: 2.0 },
];

/**
 * The pair that carries a planted normal onto the room's vertical, under the `Rx(tilt) * Rz(roll)`
 * order the cloud is turned by. An oracle and not a convenience: the cant that levels a surface is
 * a fact about the normal this file planted, so it is computed here and never read back out of the
 * page - a check that asked the build under test which angles level its own plant would agree with
 * any build by construction. `roll` is whatever takes the normal into the YZ plane, and `tilt` is
 * whatever then swings that onto the axis.
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

  // The panel overlaps the picture's left edge and its own hover state is a change a comparison
  // would read. Taken out of the document rather than hit-tested around, because nothing here
  // presses anything on it.
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });

  /**
   * Plants one analytic plane over the depth image. The look is flattened first: fade, wake and
   * noise are temporal, so a picture compared against another picture would be comparing two
   * moments of an accumulator rather than two geometries.
   */
  const plant = (surface) => page.evaluate(({ n: n0, z: zc }) => {
    const k = globalThis.__kinect;
    for (const [name, value] of Object.entries({
      fade: 0, wake: 0, 'noise.amount': 0, additive: false, spin: false, denoise: false,
    })) k.params.set(name, value);
    const DW = 512;
    const DH = 424;
    const fx = k.uniforms.focal.value.x;
    const fy = k.uniforms.focal.value.y;
    const cx = k.uniforms.center.value.x;
    const cy = k.uniforms.center.value.y;
    const len = Math.hypot(n0[0], n0[1], n0[2]);
    const n = n0.map((v) => v / len);
    const c = zc * -n[2];
    const data = k.uniforms.depthCurr.value.image.data;
    data.fill(0);
    for (let row = 0; row < DH; row++) {
      for (let col = 0; col < DW; col++) {
        // The page's unprojection inverted rather than upstream's - x carries the mirror correction
        // `web/cloud-shader.js` explains. Planting through an un-negated ray would grade the plane
        // fit against a normal nobody planted.
        const ux = -(col + 0.5 - cx) / fx;
        const uy = -(row + 0.5 - cy) / fy;
        const den = ux * n[0] + uy * n[1] - n[2];
        if (Math.abs(den) < 1e-6) continue;
        const z = c / den;
        if (!(z >= k.uniforms.nearClip.value && z <= k.uniforms.farClip.value)) continue;
        data[row * DW + col] = Math.round(z * 1000);
      }
    }
    k.uniforms.depthCurr.value.needsUpdate = true;
    k.resetAccumulators();
    return n;
  }, surface);

  /**
   * Whether the planted frame is still the one the page is drawing. A sparse fingerprint taken at
   * plant time, plus the texture identity: an arriving frame swaps the two depth textures, so
   * `depthCurr` stops being the object the plant was written into. Both are asserted, because a
   * build writing arrivals in place would keep the identity and lose the samples.
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
   * The rendered frame, and only the rendered frame. Two shots with a gap, which have to agree
   * before either is used: a picture still moving makes every comparison below meaningless in the
   * direction that reads as a pass.
   */
  const picture = async () => {
    await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));
    await wait(260);
    const first = await page.locator('#stage').screenshot();
    await wait(160);
    const second = await page.locator('#stage').screenshot();
    return { hash: hash(second), stable: Buffer.compare(first, second) === 0 };
  };

  console.log('1. the parameters reach the cloud');
  await plant(SURFACES[2]);
  await plantFingerprint();
  await setTilt(0, 0);
  const flat = await picture();
  ok('a picture of a planted surface is stable enough to compare', flat.stable);
  // Everything below this row is graded against a surface this tool chose, so this row says the
  // surface on screen is still that one. Taken after a full `picture()`, because the window that
  // matters is the one a comparison spans.
  const held = await plantHeld();
  ok('and it is still the planted surface after a settle, not a frame off the wire',
    held.sameTexture && held.sum === held.expected,
    held.sameTexture ? `checksum ${held.sum} vs ${held.expected}` : 'the depth texture was swapped under it');
  await setTilt(18, -24);
  const canted = await picture();
  ok('and cants when the two parameters move', flat.hash !== canted.hash,
    `${flat.hash} then ${canted.hash}`);

  console.log('\n2. the crop and the region stay in sensor metres');
  // A box that actually bites. Left open, every point survives either way round and the identity
  // below is true for a build with no crop at all.
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('left', -0.4);
    k.params.set('right', 0.5);
    k.params.set('bottom', -0.35);
    k.params.set('top', 0.45);
  });
  /**
   * A region that actually bites, which this section claimed in its heading and did not do. The
   * shader gates the whole region evaluation behind `push.amount`, `noise.region` and `mask.amount`
   * being non-zero, so at their defaults a build evaluating it after the model rotation drew a
   * pixel-identical picture and passed. A mask rather than a push, because a push moves points and
   * a mask removes them, and the surviving set is what the identity below compares.
   */
  const armRegion = () => page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.set('regionZ', -2);
    k.params.set('regionW', 0.25);
    k.params.set('regionH', 0.25);
    k.params.set('regionD', 0.25);
    k.params.set('regionRound', 0.05);
    k.params.set('regionSoft', 0.05);
    k.params.set('mask.amount', 1);
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
  // The row that stops the region rows below being vacuous: a region whose box missed the planted
  // plane, or whose mask was left at zero, would satisfy every identity in this section by
  // changing nothing.
  ok('switching the region on takes points out of the picture, so it is in the proof at all',
    bare.hash !== still.hash, `${bare.hash} then ${still.hash}`);
  ok('and the picture with the region on is stable enough to compare', still.stable);
  await setTilt(22, 31);
  await poseProgram(true);
  const carried = await picture();
  ok('turning the world and the camera by the same rotation changes nothing at all',
    still.hash === carried.hash, `${still.hash} then ${carried.hash}`);
  // Without this row the identity above is satisfied by a build where the camera is not carried
  // either - two pictures that are the same because nothing moved.
  await poseProgram(false);
  const notCarried = await picture();
  ok('and leaving the camera behind does change it, so the identity is not vacuous',
    still.hash !== notCarried.hash, `${still.hash} then ${notCarried.hash}`);
  await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.setViewCamera(k.freeCamera);
    k.params.reset([
      'left', 'right', 'bottom', 'top',
      'regionZ', 'regionW', 'regionH', 'regionD', 'regionRound', 'regionSoft', 'mask.amount',
    ]);
  });

  console.log('\n3. the top-down draws the levelled frame');
  /**
   * The plan cloud's own bounding box in the inset, in pixels. Filtered by colour rather than by
   * area: the path and the frustum are drawn in the same box in teal and orange, and the cloud is
   * the only near-neutral thing in there. Read off the overlay's own backing store rather than out
   * of a screenshot.
   */
  const planExtent = async () => {
    await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(true));
    await wait(220);
    return page.evaluate(() => {
      const canvas = document.getElementById('chrome');
      const r = globalThis.__kinect.keyframes.chrome.inset();
      // The overlay is drawn through a device-pixel-ratio transform, so the inset's CSS rectangle
      // has to be taken back into the buffer's own scale.
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
          if (red < 90 || Math.abs(red - green) > 26 || Math.abs(green - blue) > 26) continue;
          n++;
          sumX += x;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      // `sumX` and `insetW` are raw on purpose, and section 8 is what needs them: an extent is
      // invariant under a reflection and a position is not, so every row measuring `w` and `h`
      // would pass a plan drawn mirrored.
      return n === 0
        ? { n: 0, sumX: 0, insetW: w }
        : { n, w: maxX - minX + 1, h: maxY - minY + 1, scale, sumX, insetW: w };
    });
  };

  // Surface B leans along both axes, so the pair that levels it is a different pair under each
  // composition order and this section is `level-order-swapped`'s catcher. The cant comes from
  // `levelPair` rather than from the page.
  await setTilt(0, 0);
  await plant(SURFACES[1]);
  const level = levelPair(SURFACES[1].n);
  const flatPose = await setTilt(level.tilt, level.roll);
  {
    const flatPlan = await planExtent();
    ok('a surface levelled flat covers the top-down in two directions',
      flatPlan.n > 200 && Math.min(flatPlan.w, flatPlan.h) > 8,
      `${flatPlan.n} plan points, ${flatPlan.w}x${flatPlan.h}px at tilt ${flatPose.tilt} roll ${flatPose.roll}`);
    // The vertical crop, which this plan ignored on purpose until levelling existed: sensor y ran
    // straight up the axis a top-down projects away, so culling on x alone was free. Measured with
    // the room levelled flat, where a strip taken out of the surface is visible to this extent.
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
    // A further quarter turn about x stands the same surface on its edge, so its top-down collapses
    // to a line. Two-sided on purpose: the fat reading alone passes on a plan that ignores the
    // levelling entirely.
    await setTilt(flatPose.tilt - 90, flatPose.roll);
    const edgePlan = await planExtent();
    const flatMinor = Math.min(flatPlan.w, flatPlan.h);
    const edgeMinor = Math.min(edgePlan.w ?? 0, edgePlan.h ?? 0);
    ok('and standing it on its edge collapses that box to a line',
      edgePlan.n > 0 && edgeMinor * 3 < flatMinor,
      `${flatMinor}px across flat, ${edgeMinor}px on edge`);
  }
  await page.evaluate(() => globalThis.__kinect.keyframes.chrome.set(false));

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

  console.log('\n5. reset rotation puts both axes and both sliders back');
  // Through the control and not through the hook, which is why these rows drive a button rather
  // than calling `resetWorldRotation`. `editor-check` names this tool as `camLevelReset`'s driver.
  await page.evaluate(() => { document.getElementById('panel').style.display = ''; });
  // And the inspector holding it is selected, because the panel is four tabs now: every group
  // outside the selected one is `display: none`. The tab is read off the group that contains the
  // button rather than named.
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
  // Both axes and both sliders. The sliders are read beside the parameters rather than instead of
  // them, because a reset that moved the value and not the view looks like a reset that worked to
  // anything asking only one of the two.
  ok('reset rotation takes both axes and both sliders back to neutral',
    reset.tilt === 0 && reset.roll === 0 && reset.sliders.every((value) => Number(value) === 0),
    `rotation ${reset.tilt}/${reset.roll}, sliders ${reset.sliders.join('/')}`);
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });

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
  // Every orientation a mount can end up at has to be reachable on the sliders, and `levelPair`'s
  // two `atan2`s say what that span is. A range short of these would refuse a bracket somebody
  // actually built, by clamping rather than by saying so.
  ok('and the sliders reach every cant a surface can be levelled from',
    boundary.ranges[0][0] <= -90 && boundary.ranges[0][1] >= 90
    && boundary.ranges[1][0] <= -180 && boundary.ranges[1][1] >= 180,
    JSON.stringify(boundary.ranges));
  console.log('\n7. the crop box is drawn in the room and its switch reaches every reader');

  // Section 2 asserts the crop is tested in sensor metres; this is the drawing's half of the same
  // fact and it points the other way, because the box is drawn in the room. The old top-down
  // rectangle got this half wrong for as long as levelling existed.
  await setTilt(14, -9);
  const box = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const q = k.worldTilt();
    const u = k.uniforms;
    const lo = [u.cropL.value, u.cropB.value, -u.farClip.value];
    const hi = [u.cropR.value, u.cropT.value, -u.nearClip.value];
    // Turned by the quaternion read off the cloud rather than by one composed from the two sliders:
    // that is the difference between holding the drawing to what the renderer is doing and to a
    // second calculation that agrees by construction.
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
    // The control: a box already sitting in the room's frame would satisfy the comparison above
    // without carrying anything, so the corners must also be somewhere the unrotated box is not.
    const bare = Math.max(...got.map((c, i) => Math.max(...c.map((n, j) => Math.abs(n
      - [(i & 1) ? hi[0] : lo[0], (i & 2) ? hi[1] : lo[1], (i & 4) ? hi[2] : lo[2]][j])))));
    return { worst, bare };
  });
  ok('the box the chrome draws is the sensor box turned by the rotation the cloud carries',
    box.worst < 1e-6, `worst corner off by ${box.worst.toExponential(2)} m`);
  ok('and it is not simply the sensor box, which a levelled room would draw beside its cloud',
    box.bare > 0.05, `${box.bare.toFixed(3)} m from the unrotated box`);

  // The switch, asked of a reader that is not the shader: the top-down walks the depth texture
  // through the same six faces, so a `crop` wired to the shader alone leaves it culling a cloud the
  // picture is showing in full.
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
  // Back to the open count exactly rather than merely upward: the same plant through the same
  // camera is the same set of pixels twice, and a row asking only for more points would pass a
  // build that widened the faces.
  ok('and releasing the switch hands them back, so the switch reaches more than the shader',
    releasedPlan.n === openPlan.n,
    `${bitingPlan.n} biting, ${releasedPlan.n} released, ${openPlan.n} open`);

  console.log('\n8. the unprojection is mirrored, on both readers that state it');
  /**
   * A slab of constant depth in one column band, and nothing anywhere else. Asymmetric on purpose,
   * and that is the only reason this section can exist: every other fixture here is a plane,
   * symmetric about the optical axis, so no row that plants a `SURFACES` entry can see a sign on x
   * - which is how a mirrored cloud sat in this program from its first commit through every proof
   * tool in the suite. The flip was established on the rig, off a colour frame carrying branded
   * text that reads only after one horizontal flip, and what this section does is pin the sign that
   * measurement settled.
   */
  const plantBar = (offsetFrom, offsetTo, metres) => page.evaluate(({ a, b, z }) => {
    const k = globalThis.__kinect;
    for (const [name, value] of Object.entries({
      fade: 0, wake: 0, 'noise.amount': 0, additive: false, spin: false, denoise: false,
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
   * The crop, used as a fixed frame of reference rather than as the thing under test. The six faces
   * are world-space constants and the cloud's x is not, so half-opening the box turns "which side
   * of the axis did this band land on" into "is the stage empty".
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
  // The reference, and it is an empty grid rather than an empty crop: every row below reads "equal
  // to this" as "the band was entirely on the other side of the axis".
  await plantBar(0, 0, 0);
  const emptyStage = await picture();
  ok('an empty depth grid draws a stable empty stage to compare against', emptyStage.stable,
    `hash ${emptyStage.hash}`);

  const RIGHT_BAND = [80, 140];
  const LEFT_BAND = [-140, -80];
  // Five metres rather than two, and the depth is what buys the top-down its margin: the band's
  // world x is `offset / fx * z`. Measured at five, the two bands come out 0.288 apart and
  // symmetric about the centre to within 0.004.
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
  // The load-bearing pair. A band on the image's right is at negative world x once the mirror is
  // undone, so un-negating the unprojection inverts both rows together.
  ok('a band on the image right survives a crop keeping only negative x',
    rightOnNeg.stable && rightOnNeg.hash !== emptyStage.hash,
    `${rightOnNeg.hash} against an empty ${emptyStage.hash}`);
  ok('and nothing of it survives a crop keeping only positive x',
    rightOnPos.stable && rightOnPos.hash === emptyStage.hash,
    `${rightOnPos.hash} against an empty ${emptyStage.hash}`);

  // Two-sided, because one side cannot tell a mirror from a build that culls: a row asking only
  // that the right-hand band lands on negative x is satisfied by a shader that put every point
  // there, or drew nothing.
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

  // The top-down, asked the same question, because it states the unprojection for itself and a sign
  // fixed in the shader alone leaves the plan drawing the room's left on the plan's right. Position
  // rather than extent, since an extent is invariant under a reflection. The TOP-DOWN caption
  // clears the brightness floor and both neutrality bounds, so it is measured and subtracted rather
  // than filtered around.
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
if (MUTATIONS[MUTATE]?.fails) console.log(`[level] it should redden: ${MUTATIONS[MUTATE].fails}`);
  // Exit code alone cannot tell a caught mutation from a tool that crashed before asserting
  // anything, and this repo has been bitten by exactly that twice.
  if (failed === 0) { console.log('[level] NOT CAUGHT - the check passed a build it should have rejected'); process.exit(1); }
  console.log(`[level] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[level] FAIL'); process.exit(1); }
console.log('[level] PASS');
process.exit(0);
