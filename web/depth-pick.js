// Unprojects depth texels and finds the visible surface under a stage point.

import * as THREE from 'three';
import { DEPTH_H, DEPTH_W } from './format.js';
import { unprojectPixel } from './crop-box.js';

// Keep mutable scratch private so no writable state crosses a module boundary.
const scratch = new THREE.Vector3();
const scratchWorld = new THREE.Vector3();
const viewProjection = new THREE.Matrix4();
const tiltMatrix = new THREE.Matrix4();

/**
 * Writes one libfreenect2 depth sample into `out`, or returns 0 for no return. The unprojection
 * itself is `web/crop-box.js`'s, so the plan, the pick and the webcam page share one spelling of
 * it; `out` is written in place because a sweep calls this once per texel.
 */
export function sensorPoint(out, mm, col, row, fx, fy, cx, cy) {
  if (mm === 0) return 0;
  const z = mm * 0.001;
  unprojectPixel(col, row, z, { fx, fy, cx, cy }, out);
  return z;
}

// At stride 2, a 12px radius is the smallest measured sweep that finds multiple surface samples.
export const PICK_RADIUS_PX = 12;
export const PICK_STRIDE = 2;

// The nearest cluster with at least two samples wins, which rejects isolated depth spikes.
export const PICK_TOLERANCE_M = 0.15;

/** Returns the camera distance to undisplaced depth under a stage point, or null. */
export function pickDepth({
  depth, focal, center, tilt, camera, stage, x, y,
  croppedOut = () => false,
  radiusPx = PICK_RADIUS_PX,
  stride = PICK_STRIDE,
  tolerance = PICK_TOLERANCE_M,
}) {
  const hit = sweep({ depth, focal, center, tilt, camera, stage, x, y, croppedOut, radiusPx, stride, tolerance });
  if (hit || stride === 1) return hit;
  // Retry every texel because the projected stage point has no cheap texel-space inverse.
  return sweep({ depth, focal, center, tilt, camera, stage, x, y, croppedOut, radiusPx, stride: 1, tolerance });
}

function sweep({ depth, focal, center, tilt, camera, stage, x, y, croppedOut, radiusPx, stride, tolerance }) {
  const { x: fx, y: fy } = focal;
  const { x: cx, y: cy } = center;
  // Fold tilt, view and projection together before the inner loop.
  camera.updateMatrixWorld();
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(tiltMatrix.makeRotationFromQuaternion(tilt));
  const radius2 = radiusPx * radiusPx;
  const eye = camera.position;
  const candidates = [];
  let samples = 0;
  for (let row = 0; row < DEPTH_H; row += stride) {
    for (let col = 0; col < DEPTH_W; col += stride) {
      const z = sensorPoint(scratch, depth[row * DEPTH_W + col], col, row, fx, fy, cx, cy);
      if (z === 0) continue;
      // A press must not pivot on geometry the renderer discarded.
      if (croppedOut(scratch.x, scratch.y, z)) continue;
      scratchWorld.copy(scratch).applyQuaternion(tilt);
      scratch.applyMatrix4(viewProjection);
      // The unit-cube z test also rejects points behind the camera after division by w.
      if (scratch.z < -1 || scratch.z > 1) continue;
      samples++;
      const px = stage.x + ((scratch.x + 1) / 2) * stage.w - x;
      const py = stage.y + ((1 - scratch.y) / 2) * stage.h - y;
      if (px * px + py * py > radius2) continue;
      candidates.push({ distance: eye.distanceTo(scratchWorld), world: scratchWorld.toArray() });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  let cluster = null;
  for (let start = 0; start < candidates.length; start++) {
    let end = start;
    while (end + 1 < candidates.length
      && candidates[end + 1].distance - candidates[start].distance <= tolerance) end++;
    if (end > start) { cluster = [start, end]; break; }
    start = end;
  }
  if (cluster === null) return null;
  // The middle of whichever cluster won, so the distance is a value the surface actually holds
  // rather than its front edge.
  const chosen = candidates[cluster[0] + ((cluster[1] - cluster[0]) >> 1)];
  return {
    distance: chosen.distance,
    world: chosen.world,
    samples,
    candidates: candidates.length,
    cluster: cluster[1] - cluster[0] + 1,
  };
}
