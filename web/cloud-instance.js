// One cloud's own state, and which one the render core is pointed at.
//
// An instance is the four source textures the doors bind into, the surface memory that ages
// them, and the uniform table, material and `THREE.Points` that draw them - everything a second
// cloud would need a second of. The geometry is not on that list: 434,176 pixel coordinates are
// the same for every cloud, so `web/point-cloud.js` builds one and every instance draws it.
//
// The three modules below each keep their exported bindings pointed at the selected instance,
// which is what lets `web/main.js` go on reading `uniforms`, `depthCurr` and `statePrev` as
// names rather than reaching through an instance at a hundred call sites. One instance per clip,
// and `web/main.js` repoints them around every clip it draws.

import { createTextures, selectTextures } from './gpu-textures.js';
import {
  createSurfaceMemory, selectSurfaceMemory, disposeSurfaceMemory, memoryTexture,
} from './surface-memory.js';
import { createPointCloud, selectPointCloud, disposePointCloud } from './point-cloud.js';

/**
 * Builds one cloud: its textures, then its surface memory, then its material and points.
 *
 * The order is the dependency and the reason this sequence is written out in one place rather
 * than left to an import list: the memory ages the depth pair, and the cloud's `stateTex` is
 * seeded with the target that memory has just made.
 */
export function createCloudInstance(program) {
  const textures = createTextures();
  const memory = createSurfaceMemory(textures);
  const points = createPointCloud(textures.cells, memoryTexture(memory), program);
  return { textures, memory, points };
}

/** Points the render core at one instance, in the three modules that hold a view of it. */
export function selectCloud(instance) {
  selectTextures(instance.textures);
  selectSurfaceMemory(instance.memory);
  selectPointCloud(instance.points);
}

/**
 * Releases one cloud: its node out of the scene, then the GPU objects behind it.
 *
 * The geometry is deliberately not released, because it is the one every other cloud is still
 * drawing. Not calling this leaks two float render targets and four textures per clip a document
 * drops, which a session that opens several edits reaches quickly.
 */
export function disposeCloudInstance(instance) {
  disposePointCloud(instance.points);
  disposeSurfaceMemory(instance.memory);
  for (const key of ['depthPrev', 'depthCurr', 'colorPrev', 'colorCurr']) {
    instance.textures[key].dispose();
  }
}
