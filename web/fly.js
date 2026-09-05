// Camera displacement from held keys and pivot rotation from a look drag.

import * as THREE from 'three';

export const FLY_SPEED_MPS = 1;
export const FLY_STALL_S = 0.1;

// How near the pole the view direction may come, which is OrbitControls' own `_EPS`.
export const LOOK_POLE_EPS = 1e-6;

// Which way each key pushes. The first four are camera-space and turn with the view; the last
// two take the pole the caller passes, so they climb the room rather than the picture.
const FLY_KEYS = new Map([
  ['KeyW', { local: [0, 0, -1] }],
  ['KeyS', { local: [0, 0, 1] }],
  ['KeyA', { local: [-1, 0, 0] }],
  ['KeyD', { local: [1, 0, 0] }],
  ['KeyE', { pole: 1 }],
  ['KeyQ', { pole: -1 }],
]);

const flyAxis = new THREE.Vector3();
const lookPole = new THREE.Vector3();
const lookRight = new THREE.Vector3();

/** Whether a key code is one of the six fly keys. */
function isFlyKey(code) {
  return FLY_KEYS.has(code);
}

/**
 * Where the held key codes point: a unit vector in world space, or zero. Written into `out`
 * and returned, so the caller decides what object carries it.
 */
function flyDirection(held, quaternion, up, out) {
  out.set(0, 0, 0);
  for (const [code, push] of FLY_KEYS) {
    if (!held.has(code)) continue;
    if (push.pole) out.addScaledVector(flyAxis.copy(up).normalize(), push.pole);
    else out.add(flyAxis.fromArray(push.local).applyQuaternion(quaternion));
  }
  // Normalised, so a diagonal is no faster than one key and W against S is nothing at all.
  return out.lengthSq() < 1e-12 ? out.set(0, 0, 0) : out.normalize();
}

/**
 * One frame's displacement into `out`: direction x speed x the elapsed seconds. The cap is why
 * a stalled tab does not teleport the camera on the frame it comes back.
 */
function flyStep(held, dtSec, quaternion, up, out) {
  flyDirection(held, quaternion, up, out);
  return out.multiplyScalar(FLY_SPEED_MPS * Math.min(Math.max(dtSec, 0), FLY_STALL_S));
}

/** Rotate `target - position` in place, at one field of view per viewport height. */
function lookOffset(offset, up, dxPx, dyPx, fovDeg, heightPx, out) {
  out.copy(offset);
  const perPixel = THREE.MathUtils.degToRad(fovDeg) / Math.max(1, heightPx);
  lookPole.copy(up).normalize();
  out.applyAxisAngle(lookPole, -dxPx * perPixel);
  // Off the yawed offset, so a diagonal drag pitches about where the yaw left the view.
  lookRight.crossVectors(out, lookPole);
  // An offset already along the pole has no right axis. The clamp below never leaves one there.
  if (lookRight.lengthSq() < 1e-12) return out;
  lookRight.normalize();
  const polar = Math.acos(Math.min(1, Math.max(-1, out.dot(lookPole) / out.length())));
  // Dragging down looks down, which is the polar angle growing. Clamped as an angle rather than
  // by rotating and correcting, so a drag past the pole stops at it instead of flipping over it.
  const wanted = Math.min(
    Math.PI - LOOK_POLE_EPS, Math.max(LOOK_POLE_EPS, polar + dyPx * perPixel),
  );
  return out.applyAxisAngle(lookRight, polar - wanted);
}

export {
  isFlyKey, flyDirection, flyStep, lookOffset,
};
