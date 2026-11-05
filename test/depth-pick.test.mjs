// The pivot's pick, driven against grids written by hand. What the page cannot answer offline is
// whether a press reaches this at all; what only this can answer is whether the arithmetic in it
// is right, on a scene whose distances are known exactly rather than measured off a capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEPTH_H, DEPTH_W } from '../web/format.js';
import { projectThrough } from '../web/plan-geometry.js';
import {
  pickDepth, sensorPoint, PICK_RADIUS_PX, PICK_STRIDE, PICK_TOLERANCE_M,
} from '../web/depth-pick.js';

// A Kinect v2's own numbers, near enough: the pick reads whatever the uniforms hold, so what
// matters here is that the test and the module agree about one set of them.
const focal = { x: 365, y: 365 };
const center = { x: DEPTH_W / 2, y: DEPTH_H / 2 };
const stage = { x: 0, y: 0, w: 1920, h: 1080 };
const noTilt = new THREE.Quaternion();

/** The forward map, spelled a second time on purpose - this file is what would catch it drifting. */
function pointAt(col, row, metres) {
  return [
    (-(col + 0.5 - center.x) / focal.x) * metres,
    -((row + 0.5 - center.y) / focal.y) * metres,
    -metres,
  ];
}

/** A camera at the sensor, looking the way the sensor looks. Distances are then plain ranges. */
function sensorCamera() {
  const camera = new THREE.PerspectiveCamera(50, stage.w / stage.h, 0.05, 60);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  return camera;
}

const camera = sensorCamera();

/** Where a texel of a given range lands on the stage, so a press can be aimed at one. */
function stageOf(col, row, metres) {
  const p = projectThrough(pointAt(col, row, metres), camera, stage);
  assert.ok(p, `texel ${col},${row} at ${metres}m projected to nothing`);
  return p;
}

// What the pick owes for a texel, which is its range from the camera and not its range down the
// optical axis. Off-centre the two differ by centimetres, and writing 2.0 where the answer is
// 2.06 is a test asserting a model the renderer does not use.
function rangeOf(col, row, metres, from = camera) {
  return new THREE.Vector3().fromArray(pointAt(col, row, metres)).distanceTo(from.position);
}

// A wall filling the frame at 2.0m, a box over the middle of it at 1.0m, and a rectangle with
// no returns at all off to one side.
const BOX = { col0: 226, col1: 286, row0: 182, row1: 242 };
const HOLE = { col0: 330, col1: 390, row0: 182, row1: 242 };
const inside = (r, col, row) => col >= r.col0 && col <= r.col1 && row >= r.row0 && row <= r.row1;

function scene({ spikeAt = null } = {}) {
  const depth = new Uint16Array(DEPTH_W * DEPTH_H);
  for (let row = 0; row < DEPTH_H; row++) {
    for (let col = 0; col < DEPTH_W; col++) {
      const i = row * DEPTH_W + col;
      if (inside(HOLE, col, row)) depth[i] = 0;
      else if (inside(BOX, col, row)) depth[i] = 1000;
      else depth[i] = 2000;
    }
  }
  if (spikeAt) depth[spikeAt.row * DEPTH_W + spikeAt.col] = 300;
  return depth;
}

const pick = (depth, at, extra = {}) => pickDepth({
  depth, focal, center, tilt: noTilt, camera, stage, x: at.x, y: at.y, ...extra,
});

test('the forward map is libfreenect2 pinhole, and an empty sample is not a point', () => {
  const out = new THREE.Vector3();
  assert.equal(sensorPoint(out, 0, 100, 100, focal.x, focal.y, center.x, center.y), 0);
  const z = sensorPoint(out, 2500, 100, 140, focal.x, focal.y, center.x, center.y);
  assert.equal(z, 2.5);
  assert.deepEqual(out.toArray(), pointAt(100, 140, 2.5));
});

test('a press over the near box reads the box, not the wall behind it', () => {
  const at = stageOf((BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0);
  const hit = pick(scene(), at);
  assert.ok(hit, 'nothing was under a press aimed at the middle of the box');
  assert.ok(Math.abs(hit.distance - 1.0) < 0.02, `${hit.distance} where the box is at 1.0m`);
});

test('a press beside the box reads the wall', () => {
  // A texel well clear of the box on the wall's own plane, so the answer is the wall and not a
  // silhouette edge.
  const col = BOX.col0 - 60;
  const row = (BOX.row0 + BOX.row1) / 2;
  const hit = pick(scene(), stageOf(col, row, 2.0));
  assert.ok(hit, 'nothing was under a press aimed at the wall');
  const owed = rangeOf(col, row, 2.0);
  assert.ok(Math.abs(hit.distance - owed) < 0.03, `${hit.distance} where the wall texel is at ${owed}`);
});

// The nearest-sample rule is what makes a press land on the thing in front rather than on
// whatever the ray happens to leave through, so it is asserted as an ordering and not only as
// two separate numbers.
test('the box is nearer than the wall, which is the whole point of taking the nearest', () => {
  const depth = scene();
  const onBox = pick(depth, stageOf((BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0));
  const onWall = pick(depth, stageOf(BOX.col0 - 60, (BOX.row0 + BOX.row1) / 2, 2.0));
  assert.ok(onBox.distance < onWall.distance - 0.5, `${onBox.distance} against ${onWall.distance}`);
});

// The one press where taking the nearest and taking the farthest are different answers. Every
// other row here sits well inside a surface of one range, where a sort in either direction gives
// the same number - so on a build that took the farthest they all stay green.
test('a press on the box edge takes the box, not the wall the radius also reaches', () => {
  const at = stageOf(BOX.col1, (BOX.row0 + BOX.row1) / 2, 1.0);
  const hit = pick(scene(), at);
  assert.ok(hit, 'nothing was under a press aimed at the edge of the box');
  assert.ok(hit.candidates > hit.cluster,
    `${hit.candidates} candidates in one cluster of ${hit.cluster} - the radius reached only one `
    + 'surface, so this row cannot tell the near one from the far one');
  assert.ok(Math.abs(hit.distance - 1.0) < 0.03,
    `${hit.distance} where the box is at 1.0m and the wall it borders is at 2.0m`);
});

test('a press over a hole in the returns finds nothing and says so', () => {
  const at = stageOf((HOLE.col0 + HOLE.col1) / 2, (HOLE.row0 + HOLE.row1) / 2, 2.0);
  assert.equal(pick(scene(), at), null);
});

test('a lone sample over a hole is not enough to pick a surface', () => {
  const depth = new Uint16Array(DEPTH_W * DEPTH_H);
  const col = 256;
  const row = 212;
  depth[row * DEPTH_W + col] = 300;
  assert.equal(pick(depth, stageOf(col, row, 0.3)), null);
});

test('a press over geometry the crop predicate rejects finds nothing', () => {
  const at = stageOf((BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0);
  const depth = scene();
  // Everything, so a miss here cannot be a press that landed a few pixels off the box.
  assert.equal(pick(depth, at, { croppedOut: () => true }), null);
  // A near clip that takes the box and nothing else. There is no wall behind it to fall through
  // to - a depth grid holds one range per texel, not a column of them - so the honest answer is
  // still nothing, and a build that returned the wall here would be reading a neighbouring texel.
  assert.equal(pick(depth, at, { croppedOut: (x, y, z) => z < 1.5 }), null);
  // The far clip instead, which removes the wall and leaves the box: the crop shapes the answer
  // rather than only ever suppressing it.
  const hit = pick(depth, at, { croppedOut: (x, y, z) => z > 1.5 });
  assert.ok(hit && Math.abs(hit.distance - 1.0) < 0.02,
    `${hit ? hit.distance : 'null'} where the box the far clip kept is at 1.0m`);
});

test('a lone spike does not drag the answer off the surface it sits on', () => {
  const col = BOX.col0 - 60;
  const row = (BOX.row0 + BOX.row1) / 2;
  const at = stageOf(col, row, 2.0);
  const clean = pick(scene(), at);
  const spiked = pick(scene({ spikeAt: { col, row } }), at);
  assert.ok(spiked, 'the spiked grid returned nothing at all');
  assert.ok(spiked.distance > clean.distance - PICK_TOLERANCE_M,
    `${spiked.distance} - a 0.3m spike pulled the pick off a 2.0m wall`);
  assert.ok(Math.abs(spiked.distance - clean.distance) < 0.03,
    `${spiked.distance} against ${clean.distance} with no spike`);
});

test('the pick honours the levelling rotation rather than answering in the sensor frame', () => {
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.35);
  const tilted = new THREE.Vector3().fromArray(
    pointAt((BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0),
  ).applyQuaternion(tilt);
  const p = projectThrough(tilted.toArray(), camera, stage);
  assert.ok(p, 'the tilted box projected to nothing');
  const hit = pick(scene(), p, { tilt });
  assert.ok(hit, 'nothing was under a press aimed at where the tilt puts the box');
  assert.ok(Math.abs(hit.distance - 1.0) < 0.02, `${hit.distance} where the box is at 1.0m`);
});

// Distance is from the camera and not down the optical axis, which only agree when the camera
// is at the sensor looking the sensor's way. A pivot built from an axial depth would sit short.
test('the distance is measured from the camera, wherever the camera is', () => {
  const moved = new THREE.PerspectiveCamera(50, stage.w / stage.h, 0.05, 60);
  moved.position.set(0, 0, 1.0);
  moved.lookAt(0, 0, -1);
  moved.updateMatrixWorld(true);
  const centreOfBox = pointAt((BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0);
  const p = projectThrough(centreOfBox, moved, stage);
  const hit = pickDepth({
    depth: scene(), focal, center, tilt: noTilt, camera: moved, stage, x: p.x, y: p.y,
  });
  assert.ok(hit, 'nothing was under a press from the moved camera');
  const expected = new THREE.Vector3().fromArray(centreOfBox).distanceTo(moved.position);
  assert.ok(Math.abs(hit.distance - expected) < 0.02, `${hit.distance} against ${expected}`);
});

// Stride 2 is the sweep a press pays for. It has to give the answer stride 1 gives, or the cost
// saving is being taken out of the result.
test('the coarse sweep and the exhaustive one agree', () => {
  const depth = scene();
  for (const [col, row, metres] of [
    [(BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0],
    [BOX.col0 - 60, (BOX.row0 + BOX.row1) / 2, 2.0],
    [120, 300, 2.0],
  ]) {
    const at = stageOf(col, row, metres);
    const coarse = pick(depth, at);
    const exact = pick(depth, at, { stride: 1 });
    assert.ok(coarse && exact, `${col},${row}: nothing under the press at stride 2 or stride 1`);
    assert.ok(Math.abs(coarse.distance - exact.distance) < 0.02,
      `${col},${row}: stride 2 gave ${coarse.distance}, stride 1 gave ${exact.distance}`);
  }
});

// The radius and the stride are not independent, and this is the row that says so. A stride-2
// sweep of a wall two metres out lands its samples about 6.3 stage pixels apart at 1080p, so at
// the six-pixel radius this started with a press had exactly one candidate - and every rule about
// outvoting a stray texel is a rule about a population of one. The spike row above passes on a
// build with no company in it, because the spike is then the only thing there is.
test('a press has company under it, which is what every rule about outvoting a spike needs', () => {
  const col = BOX.col0 - 60;
  const row = (BOX.row0 + BOX.row1) / 2;
  const hit = pick(scene(), stageOf(col, row, 2.0));
  assert.ok(hit.cluster > 1,
    `${hit.cluster} samples in the winning cluster from ${hit.candidates} candidates, at a `
    + `${PICK_RADIUS_PX}px radius and stride ${PICK_STRIDE} - a lone candidate cannot be outvoted`);
});

test('the pick honours a clip placed and rotated in the room through worldMatrix', () => {
  const placement = new THREE.Group();
  placement.position.set(1.4, -0.3, -2.5);
  placement.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.25);
  const levelGroup = new THREE.Group();
  levelGroup.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.15);
  placement.add(levelGroup);
  levelGroup.updateWorldMatrix(true, false);

  const worldBox = new THREE.Vector3().fromArray(
    pointAt((BOX.col0 + BOX.col1) / 2, (BOX.row0 + BOX.row1) / 2, 1.0),
  ).applyMatrix4(levelGroup.matrixWorld);
  const p = projectThrough(worldBox.toArray(), camera, stage);
  assert.ok(p, 'the placed box projected to nothing');
  const hit = pick(scene(), p, { worldMatrix: levelGroup.matrixWorld });
  assert.ok(hit, 'nothing was under a press aimed at where worldMatrix puts the box');
  const expected = worldBox.distanceTo(camera.position);
  assert.ok(Math.abs(hit.distance - expected) < 0.02, `${hit.distance} against ${expected}`);
});
