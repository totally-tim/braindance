// The crop box, asked of the one module the cloud shader, the plan inset and the webcam page all
// frame from. Every expected value is written out longhand rather than computed by a second call,
// so nothing here can agree with the module by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIP_FAR_DEFAULT, CLIP_NEAR_DEFAULT, CROP_BOX_GLSL, CROP_FACE_NAMES, CROP_LIMIT,
  FRAMING_DEFAULTS, FRAMING_NAMES, outsideCropBox, unprojectPixel,
} from '../web/crop-box.js';

// Asymmetric on all three axes, so a swapped pair or a dropped sign shows rather than cancelling.
const FACES = Object.freeze({
  crop: true, near: 0.5, far: 4, left: -1, right: 2, bottom: -0.25, top: 3,
});

// A point in the convention the module speaks, which is the shader's: the camera looks down -z,
// so a sample `metresOut` in front of the sensor has `z` of minus that. Rows below name metres.
const at = (x, y, metresOut) => ({ x, y, z: -metresOut });
// Clear of every face, so one moved coordinate is the only reason a row below can read outside.
const INSIDE = at(0.5, 1, 2);

// The principal point and the focal length the sample takes were shot with, to 2 decimal places.
const LENS = Object.freeze({ fx: 1081.37, fy: 1081.37, cx: 959.5, cy: 539.5 });

const near = (a, b, tol = 1e-15) => Math.abs(a - b) <= tol;

test('the control: a point clear of all six faces is inside, so a row below cannot pass on a predicate that always cuts', () => {
  assert.equal(outsideCropBox(FACES, INSIDE), false, 'the point every row moves one axis of read as outside');
});

test('each of the six faces cuts on its own side and lets the other side through', () => {
  // face, a point just past it, the same point just inside it. One axis moves per row.
  const rows = [
    ['near', at(0.5, 1, 0.49), at(0.5, 1, 0.51)],
    ['far', at(0.5, 1, 4.01), at(0.5, 1, 3.99)],
    ['left', at(-1.01, 1, 2), at(-0.99, 1, 2)],
    ['right', at(2.01, 1, 2), at(1.99, 1, 2)],
    ['bottom', at(0.5, -0.26, 2), at(0.5, -0.24, 2)],
    ['top', at(0.5, 3.01, 2), at(0.5, 2.99, 2)],
  ];
  for (const [face, beyond, within] of rows) {
    assert.equal(outsideCropBox(FACES, beyond), true,
      `${face} let ${JSON.stringify(beyond)} through, which is past it`);
    assert.equal(outsideCropBox(FACES, within), false,
      `${face} cut ${JSON.stringify(within)}, which is inside it`);
  }
  // The class rather than the six instances: a seventh face reddens this until a row drives it.
  assert.deepEqual(rows.map((row) => row[0]), CROP_FACE_NAMES,
    'a face is named that no row above drives from both sides');
});

test('a point exactly on a face is inside, which is what the strict comparisons mean', () => {
  const onEach = [
    at(0.5, 1, 0.5), at(0.5, 1, 4), at(-1, 1, 2), at(2, 1, 2), at(0.5, -0.25, 2), at(0.5, 3, 2),
  ];
  assert.equal(onEach.length, CROP_FACE_NAMES.length, 'a face has no point sitting exactly on it');
  for (const point of onEach) {
    assert.equal(outsideCropBox(FACES, point), false,
      `${JSON.stringify(point)} sits exactly on a face and read as outside`);
  }
});

test('the switch off cuts nothing, however far outside the point is', () => {
  const off = { ...FACES, crop: false };
  // Behind the sensor, past every lateral face, and at the far plane's wrong side.
  const wayOut = [at(0, 0, -50), at(1000, 1000, 1000), at(-1000, -1000, 0.1)];
  for (const point of wayOut) {
    assert.equal(outsideCropBox(off, point), false,
      `the switch was off and ${JSON.stringify(point)} was cut anyway`);
    // The falsification control: with the switch on, every one of them is outside, so the row
    // above cannot pass on a predicate that never cuts.
    assert.equal(outsideCropBox(FACES, point), true,
      `${JSON.stringify(point)} is not outside with the switch on, so the row above proves nothing`);
  }
});

test('the principal point unprojects to the origin, at any depth', () => {
  // cx 959.5 against the half-pixel offset puts the principal point at the centre of column 959.
  for (const metres of [1, 3.5]) {
    const point = unprojectPixel(959, 539, metres, LENS);
    assert.ok(near(point.x, 0) && near(point.y, 0),
      `the principal point at ${metres} m landed at x ${point.x}, y ${point.y} rather than the origin`);
    assert.ok(near(point.z, -metres),
      `the camera looks down -z, so ${metres} m out is z ${-metres}, got ${point.z}`);
  }
});

test('image-left is positive x and image-top is positive y, which is the mirror every take was shot through', () => {
  const corner = unprojectPixel(0, 0, 1, LENS);
  // 959 / 1081.37 and 539 / 1081.37: the pixels from the top-left sample's centre to the
  // principal point, over the focal length, at one metre.
  assert.ok(near(corner.x, 0.8868379925464921),
    `column 0 is image-left and must come back positive x, got ${corner.x}`);
  assert.ok(near(corner.y, 0.49844179143124007),
    `row 0 is image-top and must come back positive y, got ${corner.y}`);
});

test('a pixel near the frame edge lands outside the registered depth frustum, so the crop faces have to reach past it', () => {
  const point = unprojectPixel(115, 539, 1, LENS);
  // 844 / 1081.37: column 115's centre is 844 pixels left of the principal point.
  assert.ok(near(point.x, 0.78049141366969688),
    `column 115 at one metre landed at x ${point.x}`);
  // tan(35.3 degrees), the depth camera's own horizontal half-angle. The colour camera sees
  // wider, so a sample the registration carries into the colour frame reaches past it.
  assert.ok(Math.abs(point.x) > 0.70803946712802268,
    'x 0.78049141366969688 at one metre is not past the depth frustum\'s 0.70803946712802268 half-extent');
});

test('the nine framing parameters and their defaults, written out rather than read off the registry', () => {
  assert.deepEqual(FRAMING_NAMES,
    ['tilt', 'roll', 'near', 'far', 'crop', 'left', 'right', 'bottom', 'top']);
  assert.deepEqual(FRAMING_DEFAULTS, {
    tilt: 0, roll: 0, near: 0.05, far: 6, crop: true, left: -7, right: 7, bottom: -7, top: 7,
  });
  // The three the rest of the program imports by name, against the same numbers.
  assert.equal(CLIP_NEAR_DEFAULT, 0.05);
  assert.equal(CLIP_FAR_DEFAULT, 6);
  assert.equal(CROP_LIMIT, 7);
  // Every face is a framing parameter, and the switch is not one of the faces.
  for (const face of CROP_FACE_NAMES) assert.ok(FRAMING_NAMES.includes(face), `${face} is not a framing name`);
  assert.ok(!CROP_FACE_NAMES.includes('crop'), 'the switch is listed as a face of the box');
});

test('the shared GLSL declares no uniform of its own, so a rename in the spine is a compile error rather than a silent zero', () => {
  assert.equal(/^\s*uniform\b/m.test(CROP_BOX_GLSL), false,
    'the spliced GLSL declares a uniform, which would shadow or duplicate the spine\'s own');
  for (const signature of ['bool outsideDepthPair(float z)', 'bool outsideLateral(vec2 xy)']) {
    assert.equal(CROP_BOX_GLSL.split(signature).length - 1, 1,
      `web/cloud-shader.js calls ${signature} and the spliced text defines it other than once`);
  }
});

test('a face holding NaN cuts nothing on its own axis, which is what the GLSL does with one', () => {
  for (const face of CROP_FACE_NAMES) {
    // Both comparisons against NaN are false, so the box loses that face and keeps the other five.
    assert.equal(outsideCropBox({ ...FACES, [face]: NaN }, INSIDE), false,
      `${face} held NaN and cut a point that is inside every other face`);
  }
  // Five faces still cut, so the row above is not passing on a box that stopped cutting at all.
  assert.equal(outsideCropBox({ ...FACES, near: NaN }, at(0.5, 1, 4.01)), true,
    'near held NaN and far stopped cutting with it');
  // A NaN switch is off, the same way a `cropOn` of NaN fails `cropOn == 1.0` in the shader.
  assert.equal(outsideCropBox({ ...FACES, crop: NaN }, at(0.5, 1, 4.01)), false,
    'a NaN switch was read as on');
});

test('a sample at or behind the sensor is outside, because the near plane is in front of it', () => {
  for (const metres of [0, -0.5, -50]) {
    assert.equal(outsideCropBox(FACES, at(0.5, 1, metres)), true,
      `z ${metres} is not in front of the near plane at ${FACES.near} and was kept`);
  }
  // The default near plane is 0.05 m, so this holds for an untouched box too.
  assert.equal(outsideCropBox({ ...FRAMING_DEFAULTS }, at(0, 0, 0)), true,
    'a zero-depth sample survives the box in its default position');
});

test('an unprojected pixel goes straight into the box with no sign flip, which is why both speak one convention', () => {
  const box = { crop: true, near: 0.5, far: 4, left: -1, right: 2, bottom: -0.25, top: 3 };
  // Column 959, row 539 is the principal point, so the ray runs straight out and only depth
  // decides. 2 m is inside the pair, 0.25 m is nearer than near, 5 m is past far.
  assert.equal(outsideCropBox(box, unprojectPixel(959, 539, 2, LENS)), false, '2 m down the axis was cut');
  assert.equal(outsideCropBox(box, unprojectPixel(959, 539, 0.25, LENS)), true, '0.25 m survived a near plane of 0.5');
  assert.equal(outsideCropBox(box, unprojectPixel(959, 539, 5, LENS)), true, '5 m survived a far plane of 4');
  // And a lateral face, driven by the column rather than by the depth: at 2 m, column 115 is
  // 844 / 1081.37 * 2 = 1.5609828273393938 m to image-left, which is inside right at 2 and
  // outside a right face pulled in to 1.5.
  assert.equal(outsideCropBox(box, unprojectPixel(115, 539, 2, LENS)), false, 'column 115 at 2 m was cut by a face at 2 m');
  assert.equal(outsideCropBox({ ...box, right: 1.5 }, unprojectPixel(115, 539, 2, LENS)), true,
    'column 115 at 2 m reaches 1.5609828273393938 m and survived a right face at 1.5');
});

test('the target form writes in place and agrees with the fresh form', () => {
  const target = { x: 0, y: 0, z: 0 };
  const returned = unprojectPixel(115, 200, 2.5, LENS, target);
  assert.equal(returned, target, 'the return is not the object that was passed in');
  const fresh = unprojectPixel(115, 200, 2.5, LENS);
  assert.notEqual(fresh, target, 'the fresh form handed back the target rather than a new object');
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(near(target[axis], fresh[axis]),
      `${axis} is ${target[axis]} written in place and ${fresh[axis]} fresh`);
  }
  // A three.js Vector3 qualifies because the three fields are its own, which is what
  // `sensorPoint` in web/depth-pick.js relies on. Stood in for here by an object carrying the
  // same fields plus the methods a Vector3 has, so a write through a setter would be caught.
  const vectorLike = { x: 0, y: 0, z: 0, set() { throw new Error('unprojectPixel called set() rather than writing the fields'); } };
  unprojectPixel(115, 200, 2.5, LENS, vectorLike);
  assert.ok(near(vectorLike.x, fresh.x) && near(vectorLike.y, fresh.y) && near(vectorLike.z, fresh.z),
    'the fields of a vector-like target were not written');
});
