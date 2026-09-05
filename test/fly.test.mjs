// The fly keys' directions, one frame's displacement, and where a look drag puts the pivot,
// called directly. The rows that matter are the ones a browser cannot separate: Q and E climb
// the pole they are handed rather than the camera's own vertical, a frame that arrives after a
// stall moves the cap and not the gap, and the look turns the view the way the drag went rather
// than the way an orbit of the same pixels would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FLY_SPEED_MPS, FLY_STALL_S, LOOK_POLE_EPS,
  isFlyKey, flyDirection, flyStep, lookOffset,
} from '../web/fly.js';

const UP = new THREE.Vector3(0, 1, 0);
const held = (...codes) => new Set(codes);
const dir = (codes, quaternion = new THREE.Quaternion()) => (
  flyDirection(codes, quaternion, UP, new THREE.Vector3()).toArray()
);
const step = (codes, dt, quaternion = new THREE.Quaternion(), up = UP) => (
  flyStep(codes, dt, quaternion, up, new THREE.Vector3())
);

const near = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;
const nearAll = (got, want, tol = 1e-12) => got.every((v, i) => near(v, want[i], tol));

/** Pitched down by `deg`, which is a rotation about the camera's local X. */
const pitched = (deg) => new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-deg),
);

// A camera at the origin looking two metres down -Z, which is the offset the look drag turns.
const LOOK_HEIGHT = 1000;
// The lens the rows below drag at, unless they are the ones about the lens mattering.
const LOOK_FOV = 90;
const offsetOf = (...xyz) => new THREE.Vector3(...xyz);
const look = (offset, dx, dy, up = UP, fov = LOOK_FOV, height = LOOK_HEIGHT) => (
  lookOffset(offset, up, dx, dy, fov, height, new THREE.Vector3())
);
/** The camera's right axis for an offset and a pole, which is the axis the pitch turns about. */
const rightOf = (offset, up) => new THREE.Vector3().crossVectors(offset, up).normalize();

test('the six keys are fly keys and nothing else is', () => {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) {
    assert.equal(isFlyKey(code), true, code);
  }
  for (const code of ['KeyZ', 'KeyF', 'KeyR', 'ArrowUp', 'Space', 'ShiftLeft', 'w', '']) {
    assert.equal(isFlyKey(code), false, code);
  }
});

test('W is the view direction, S is its opposite, and D is the camera\'s local +X', () => {
  assert.ok(nearAll(dir(held('KeyW')), [0, 0, -1]), `${dir(held('KeyW'))}`);
  assert.ok(nearAll(dir(held('KeyS')), [0, 0, 1]), `${dir(held('KeyS'))}`);
  assert.ok(nearAll(dir(held('KeyD')), [1, 0, 0]), `${dir(held('KeyD'))}`);
  assert.ok(nearAll(dir(held('KeyA')), [-1, 0, 0]), `${dir(held('KeyA'))}`);
  // Turned a quarter turn about the pole, so a camera-space direction is a different world one.
  const yawed = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2);
  assert.ok(nearAll(dir(held('KeyW'), yawed), [-1, 0, 0], 1e-9), `${dir(held('KeyW'), yawed)}`);
  assert.ok(nearAll(dir(held('KeyD'), yawed), [0, 0, -1], 1e-9), `${dir(held('KeyD'), yawed)}`);
});

test('E is the pole it was handed and not the camera\'s own vertical, however the camera is aimed', () => {
  const down = pitched(40);
  // The control: at this pitch the camera's local Y is 40 degrees off the pole, so a build
  // reading the camera's vertical answers somewhere else entirely.
  const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(down);
  assert.ok(localY.dot(UP) < 0.8, `the camera is not pitched: local Y dots the pole at ${localY.dot(UP)}`);
  assert.ok(nearAll(dir(held('KeyE'), down), [0, 1, 0], 1e-12), `${dir(held('KeyE'), down)}`);
  assert.ok(nearAll(dir(held('KeyQ'), down), [0, -1, 0], 1e-12), `${dir(held('KeyQ'), down)}`);
  // And a pole that is not the world's +Y is followed just as exactly, which is what levelling
  // and the sensor view hand in.
  const canted = new THREE.Vector3(0.3, 0.9, -0.2);
  const want = canted.clone().normalize().toArray();
  const got = flyDirection(held('KeyE'), down, canted, new THREE.Vector3()).toArray();
  assert.ok(nearAll(got, want, 1e-12), `${got} against ${want}`);
});

test('opposite keys cancel and a diagonal stays one unit long', () => {
  assert.deepEqual(dir(held('KeyW', 'KeyS')), [0, 0, 0]);
  assert.deepEqual(dir(held('KeyA', 'KeyD')), [0, 0, 0]);
  assert.deepEqual(dir(held('KeyQ', 'KeyE')), [0, 0, 0]);
  assert.deepEqual(dir(held()), [0, 0, 0]);
  const diagonal = dir(held('KeyW', 'KeyD'));
  assert.ok(near(Math.hypot(...diagonal), 1), `${diagonal} is ${Math.hypot(...diagonal)} long`);
  assert.ok(nearAll(diagonal, [Math.SQRT1_2, 0, -Math.SQRT1_2]), `${diagonal}`);
  const corner = dir(held('KeyW', 'KeyD', 'KeyE'));
  assert.ok(near(Math.hypot(...corner), 1), `${corner} is ${Math.hypot(...corner)} long`);
});

test('the target is the caller\'s object, written in place and handed back', () => {
  const out = new THREE.Vector3(9, 9, 9);
  assert.equal(flyDirection(held('KeyW'), new THREE.Quaternion(), UP, out), out);
  assert.ok(nearAll(out.toArray(), [0, 0, -1]), `${out.toArray()}`);
  const moved = new THREE.Vector3();
  assert.equal(flyStep(held('KeyW'), 0.05, new THREE.Quaternion(), UP, moved), moved);
  const turned = new THREE.Vector3();
  assert.equal(lookOffset(offsetOf(0, 0, -2), UP, 10, 10, LOOK_FOV, LOOK_HEIGHT, turned), turned);
  assert.ok(turned.length() > 0, `${turned.toArray()}`);
});

test('a frame moves direction x speed x dt, and the first frame of a hold moves nothing', () => {
  // `nearAll` and not a deep equal: a direction of -1 scaled by zero is -0, which is the same
  // displacement and a different value.
  assert.ok(nearAll(step(held('KeyW'), 0).toArray(), [0, 0, 0]), 'dt 0 moved something');
  assert.ok(nearAll(step(held(), 0.05).toArray(), [0, 0, 0]), 'nothing held moved something');
  const tenth = step(held('KeyW'), 0.05);
  assert.ok(near(tenth.length(), 0.05 * FLY_SPEED_MPS), `${tenth.length()} m over 50 ms`);
  assert.ok(nearAll(tenth.toArray(), [0, 0, -0.05 * FLY_SPEED_MPS]), `${tenth.toArray()}`);
  // A negative delta is a clock that went backwards, which moves nothing rather than backwards.
  assert.ok(nearAll(step(held('KeyW'), -1).toArray(), [0, 0, 0]),
    `a negative delta moved ${step(held('KeyW'), -1).toArray()}`);
});

test('a frame after a stall moves the cap and not the gap', () => {
  const stalled = step(held('KeyW'), 5);
  assert.ok(near(stalled.length(), FLY_STALL_S * FLY_SPEED_MPS),
    `${stalled.length()} m over a 5 s gap, where the cap allows ${FLY_STALL_S * FLY_SPEED_MPS}`);
  assert.ok(stalled.length() < 0.2, `${stalled.length()} m is a teleport`);
  // The cap is a cap and not a floor: a frame inside it keeps its own length.
  const inside = step(held('KeyW'), FLY_STALL_S / 2);
  assert.ok(near(inside.length(), (FLY_STALL_S / 2) * FLY_SPEED_MPS), `${inside.length()}`);
});

test('dragging right turns the view right, which is the opposite of orbiting the same pixels', () => {
  const from = offsetOf(0, 0, -2);
  const right = rightOf(from, UP);
  assert.ok(nearAll(right.toArray(), [1, 0, 0]), `the right axis is ${right.toArray()}`);
  const turned = look(from, 100, 0);
  // The whole point of the change: the pivot swings towards the camera's right, which puts the
  // scene to the left of where it was. An orbit of the same 100 pixels swings the camera the
  // other way and sweeps the scene right.
  assert.ok(turned.dot(right) > 0,
    `dragging right put the pivot at ${turned.toArray()}, which dots the right axis at ${turned.dot(right)}`);
  assert.ok(look(from, -100, 0).dot(right) < 0, `dragging left went ${look(from, -100, 0).toArray()}`);
});

test('a drag the height of the viewport turns exactly one field of view, at any lens', () => {
  const from = offsetOf(0, 0, -2);
  // Both a wide view and a long lens must scale the angle by the same fraction of stage height.
  for (const fov of [90, 4]) {
    const whole = look(from, LOOK_HEIGHT, 0, UP, fov);
    assert.ok(near(whole.angleTo(from), THREE.MathUtils.degToRad(fov), 1e-12),
      `a full-height drag at ${fov} degrees turned ${THREE.MathUtils.radToDeg(whole.angleTo(from))}`);
    // And a quarter of the screen is a quarter of the angle, so the rate holds across the drag.
    const quarter = look(from, LOOK_HEIGHT / 4, 0, UP, fov);
    assert.ok(near(quarter.angleTo(from), THREE.MathUtils.degToRad(fov) / 4, 1e-12),
      `a quarter-height drag at ${fov} degrees turned ${THREE.MathUtils.radToDeg(quarter.angleTo(from))}`);
  }
  // The control: the same pixels at the two lenses turn the view by different amounts, so a
  // build with a rate of its own would satisfy the shape of the rows above and fail here.
  const wide = look(from, 200, 0, UP, 90).angleTo(from);
  const long = look(from, 200, 0, UP, 4).angleTo(from);
  assert.ok(near(wide / long, 90 / 4, 1e-9), `200 pixels turned ${wide} wide and ${long} long`);
});

test('dragging down looks down, at the same radians per pixel as across', () => {
  const from = offsetOf(0, 0, -2);
  assert.ok(look(from, 0, 100).dot(UP) < from.dot(UP),
    `dragging down put the pivot at ${look(from, 0, 100).toArray()}`);
  assert.ok(look(from, 0, -100).dot(UP) > from.dot(UP),
    `dragging up put the pivot at ${look(from, 0, -100).toArray()}`);
  // The same rate on both axes, stated as the angle rather than as a vector: the same pixels
  // down and across turn the view by the same amount, and that amount is the field of view over
  // the viewport height.
  const down = look(from, 0, 137);
  const across = look(from, 137, 0);
  assert.ok(near(down.angleTo(from), across.angleTo(from), 1e-12),
    `${down.angleTo(from)} down against ${across.angleTo(from)} across`);
  assert.ok(near(down.angleTo(from), (THREE.MathUtils.degToRad(LOOK_FOV) * 137) / LOOK_HEIGHT, 1e-12),
    `137 pixels down turned ${THREE.MathUtils.radToDeg(down.angleTo(from))} degrees`);
});

test('the look is a rotation, so the orbit radius survives it and a zero drag changes nothing', () => {
  const from = offsetOf(0.7, -1.3, -2.4);
  for (const [dx, dy] of [[0, 0], [37, 0], [0, -91], [220, 140], [-4000, 3000]]) {
    const turned = look(from, dx, dy);
    assert.ok(near(turned.length(), from.length(), 1e-12),
      `${dx},${dy} took the radius from ${from.length()} to ${turned.length()}`);
  }
  // Exactly nothing, not nearly nothing: a zero drag is a zero angle on both axes.
  assert.deepEqual(look(from, 0, 0).toArray(), from.toArray());
});

test('a drag past the pole stops at it rather than flipping the view over it', () => {
  const from = offsetOf(0, 0, -2);
  const forward = from.clone().normalize();
  for (const [dy, pole, name] of [[40 * LOOK_HEIGHT, -1, 'down'], [-40 * LOOK_HEIGHT, 1, 'up']]) {
    const turned = look(from, 0, dy);
    const polar = Math.acos(turned.dot(UP) / turned.length());
    const wanted = pole < 0 ? Math.PI - LOOK_POLE_EPS : LOOK_POLE_EPS;
    assert.ok(near(polar, wanted, 1e-9),
      `dragging ${name} forty screens landed a polar angle of ${polar}, wanted ${wanted}`);
    // Not flipped: a build that let the pitch run past the pole comes back facing the other way,
    // so the horizontal part of the offset would have changed sign.
    assert.ok(turned.dot(forward) > 0,
      `dragging ${name} forty screens turned the view around: ${turned.toArray()}`);
    assert.ok(near(turned.length(), from.length(), 1e-12), `${turned.length()}`);
  }
});

test('the look follows the pole it was handed, which is a levelled room and not the world\'s +Y', () => {
  const canted = new THREE.Vector3(0.3, 0.9, -0.2);
  const pole = canted.clone().normalize();
  // An offset square to that pole, so the drag starts on the room's own horizon.
  const from = new THREE.Vector3(0, 0, -2).projectOnPlane(pole).setLength(2);
  assert.ok(near(from.dot(pole), 0, 1e-12), `the offset is not square to the pole: ${from.dot(pole)}`);

  // Across: a yaw about the pole leaves the height above the room's floor exactly alone.
  const yawed = look(from, 130, 0, canted);
  assert.ok(near(yawed.dot(pole), from.dot(pole), 1e-12),
    `the yaw moved the pivot off the room's horizon by ${yawed.dot(pole) - from.dot(pole)}`);
  // The control: the same yaw does move the height above the *world's* floor, so a build that
  // ignored the pole and used +Y would pass the row above and answer somewhere else here.
  assert.ok(Math.abs(yawed.y - from.y) > 0.1,
    `the canted pole is indistinguishable from +Y here: ${yawed.y} against ${from.y}`);

  // Down: the pitch stays in the plane the pole and the offset span, so it leaves that plane's
  // normal alone. That normal is the right axis, which is the axis the pitch turns about.
  const right = rightOf(from, canted);
  const pitchedDown = look(from, 0, 90, canted);
  assert.ok(near(pitchedDown.dot(right), 0, 1e-12),
    `the pitch left the pole's plane by ${pitchedDown.dot(right)}`);
  assert.ok(pitchedDown.dot(pole) < from.dot(pole),
    `dragging down did not look down the room: ${pitchedDown.dot(pole)} against ${from.dot(pole)}`);
  // And the clamp is against that pole too, so forty screens down stops at the room's floor.
  const far = look(from, 0, 40 * LOOK_HEIGHT, canted);
  assert.ok(near(Math.acos(far.dot(pole) / far.length()), Math.PI - LOOK_POLE_EPS, 1e-9),
    `${Math.acos(far.dot(pole) / far.length())}`);
});
