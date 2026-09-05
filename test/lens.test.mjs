// The 35mm-equivalent lens arithmetic, called directly. The aspect is the whole content: a
// focal length is an angle only once the shape of the frame is fixed, so every row here names
// the shape it is asking about and no row asks at one aspect alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { verticalFovForFocalLength, focalLengthForVerticalFov, projectionScaleForVerticalFov } from '../web/lens.js';

const ASPECTS = [['16:9', 16 / 9], ['2.39:1', 2.39], ['4:3', 4 / 3], ['1:1', 1], ['65:24', 65 / 24]];
const LENSES = [8, 14, 18.3, 22.745, 24, 35, 50, 85, 135, 200, 300];

/** The horizontal angle a vertical one covers at an aspect, written out rather than imported. */
const horizontalFov = (fovDeg, aspect) => (2 * Math.atan(Math.tan((fovDeg * Math.PI) / 360) * aspect) * 180) / Math.PI;

/** The corner-to-corner angle, which is the one a focal length is really a name for. */
const diagonalFov = (fovDeg, aspect) => (2 * Math.atan(Math.tan((fovDeg * Math.PI) / 360) * Math.sqrt(aspect * aspect + 1)) * 180) / Math.PI;

const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol,
  `${what}: ${got} is not within ${tol} of ${want}`);

// Recovered through the two functions rather than read off an exported constant, so it asks
// what the shipped arithmetic carries rather than what a number beside it says.
const halfDiagonalBehind = (aspect, mm) => mm * Math.tan((verticalFovForFocalLength(mm, aspect) * Math.PI) / 360) * Math.sqrt(aspect * aspect + 1);

test('the basis is the full-frame gate\'s half-diagonal, derived rather than a rounded literal', () => {
  const gate = Math.hypot(36, 24) / 2;
  for (const [name, aspect] of ASPECTS) {
    for (const mm of [12, 35, 180]) near(halfDiagonalBehind(aspect, mm), gate, 1e-12, `${mm}mm at ${name}`);
  }
  // 21.6333 is what the gate works out to, and the point of deriving it is the digits past that.
  near(gate, 21.6333, 0.0001, 'the gate');
  assert.notEqual(halfDiagonalBehind(16 / 9, 35), 21.6335);
});

test('mm to fov and back is the same lens, at every aspect and every length', () => {
  for (const [name, aspect] of ASPECTS) {
    for (const mm of LENSES) {
      const back = focalLengthForVerticalFov(verticalFovForFocalLength(mm, aspect), aspect);
      near(back, mm, 1e-9, `${mm}mm at ${name}`);
    }
  }
});

test('fov to mm and back is the same angle, so neither direction is the derived one', () => {
  for (const [name, aspect] of ASPECTS) {
    for (const fov of [4.05, 12, 26.84, 33.72, 50, 60.158, 90, 105.95]) {
      const back = verticalFovForFocalLength(focalLengthForVerticalFov(fov, aspect), aspect);
      near(back, fov, 1e-9, `${fov} degrees at ${name}`);
    }
  }
});

// A lens is a diagonal angle on the full-frame gate, and every aspect is a crop of that gate,
// so this number may not move. It is the one row that would survive an implementation reading
// the wrong axis, which is why the vertical spot values below are stated separately.
test('the diagonal angle a lens covers is the same at every aspect', () => {
  for (const mm of LENSES) {
    const angles = ASPECTS.map(([name, aspect]) => [name, diagonalFov(verticalFovForFocalLength(mm, aspect), aspect)]);
    for (const [name, angle] of angles) near(angle, angles[0][1], 1e-9, `${mm}mm at ${name}`);
  }
  for (const [name, aspect] of ASPECTS) {
    near(diagonalFov(verticalFovForFocalLength(35, aspect), aspect), 63.44, 0.005, `35mm at ${name}`);
  }
});

test('a 35mm lens is these angles, which is what the aspect is doing in the signature', () => {
  const spots = [
    ['16:9', 16 / 9, 33.72, 56.62],
    ['2.39:1', 2.39, 26.84, 59.38],
    ['4:3', 4 / 3, 40.70, 52.62],
  ];
  for (const [name, aspect, fovV, fovH] of spots) {
    const got = verticalFovForFocalLength(35, aspect);
    near(got, fovV, 0.05, `35mm at ${name} vertically`);
    near(horizontalFov(got, aspect), fovH, 0.05, `35mm at ${name} horizontally`);
  }
  // Three different vertical angles, so an implementation ignoring the aspect fails here.
  assert.ok(spots[0][2] !== spots[1][2] && spots[1][2] !== spots[2][2]);
});

test('the two fovs the program already writes are these lenses', () => {
  // `PROGRAM_FOV` in web/scene.js, which is what both cameras boot at.
  near(focalLengthForVerticalFov(50, 16 / 9), 22.745, 0.05, 'the default camera');
  // What `sensorView` in web/main.js writes from the Kinect's fy of 366.031494 over 424 rows.
  const sensorFov = (2 * Math.atan((424 / 2) / 366.031494) * 180) / Math.PI;
  near(sensorFov, 60.158, 0.001, 'the sensor view angle');
  near(focalLengthForVerticalFov(sensorFov, 16 / 9), 18.312, 0.05, 'the sensor view lens');
});

test('the band the display offers is inside what a projection matrix will take', () => {
  near(verticalFovForFocalLength(8, 16 / 9), 105.95, 0.05, 'the wide end');
  near(verticalFovForFocalLength(300, 16 / 9), 4.049, 0.05, 'the long end');
});

// The ends are limits rather than errors: there is no clamp in the module, because the band of
// usable lenses belongs to the display and `sensorView` writes whatever the intrinsics imply.
test('at the degenerate ends the answers are the limits, and the round trip does not survive them', () => {
  for (const [name, aspect] of ASPECTS) {
    assert.equal(verticalFovForFocalLength(0, aspect), 180, `zero millimetres at ${name}`);
    assert.equal(verticalFovForFocalLength(Infinity, aspect), 0, `an infinite lens at ${name}`);
    assert.equal(focalLengthForVerticalFov(0, aspect), Infinity, `a zero angle at ${name}`);

    // Not zero: `tan` of a right angle is 1.633e16 in doubles rather than infinite, so a
    // 180-degree field comes back as a positive length too small to be any lens.
    const flat = focalLengthForVerticalFov(180, aspect);
    assert.ok(flat > 0 && flat < 1e-12, `a 180-degree field at ${name} came back as ${flat}`);
    assert.notEqual(flat, 0);
  }
});

test('nothing outside the band is coerced into a number that looks like a lens', () => {
  for (const bad of [NaN, undefined]) {
    assert.ok(Number.isNaN(verticalFovForFocalLength(bad, 16 / 9)), `${String(bad)} millimetres`);
    assert.ok(Number.isNaN(verticalFovForFocalLength(35, bad)), `an aspect of ${String(bad)}`);
    assert.ok(Number.isNaN(focalLengthForVerticalFov(bad, 16 / 9)), `${String(bad)} degrees`);
  }
  // A negative length is a negative angle rather than its positive twin, so a sign error shows.
  assert.ok(verticalFovForFocalLength(-35, 16 / 9) < 0);
});

test('the projection scale is what a perspective camera writes at projectionMatrix[1][1]', () => {
  for (const fov of [4.049, 26.26, 50, 60.3, 105.95]) {
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 60);
    near(projectionScaleForVerticalFov(fov), camera.projectionMatrix.elements[5], 1e-12, `${fov} degrees`);
  }
  // Twice the scale is half the tangent: the lens rows in export-check lean on this being exact.
  const twice = (2 * Math.atan(Math.tan((50 * Math.PI) / 360) / 2) * 180) / Math.PI;
  near(projectionScaleForVerticalFov(twice) / projectionScaleForVerticalFov(50), 2, 1e-12, 'a 2x lens');
});
