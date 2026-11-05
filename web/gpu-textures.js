import * as THREE from 'three';
import { DEPTH_H, DEPTH_W } from './format.js';

/**
 * Which two sensor frames a cloud is holding, and the one door a new one replaces them
 * through.
 *
 * There are two of each kind rather than one because the vertex stage interpolates
 * between the last two arrivals - that is what makes an 8-15fps stream look fluid on
 * a 120Hz display - so "the current frame" is really a pair with a direction, and the
 * only operation that keeps the pair honest is a swap. Every acquisition path in the
 * program goes through the same swap here rather than writing a texture of its own,
 * because a socket arrival, a pinned run and an indexed pull that each did their own
 * would leave the renderer producing a different image depending on where the bytes
 * came from.
 *
 * **Nothing is allocated while this module evaluates.** The four textures are built by
 * `createTextures`, which `web/cloud-instance.js` calls in the order it writes out, because an
 * ES module runs its whole body before its importer's first statement - so anything built
 * up here would make the boot order a property of how the imports happen to be sorted,
 * which an import-sorting reflex or a merge can change without anybody reading a line
 * of it.
 *
 * `createTextures` hands back the five uniform cells the cloud's shader reads its source
 * frames through, and `web/point-cloud.js` composes those same cells into its material by
 * reference rather than copying their values. That is what lets the door below reach the
 * shader without importing the material it feeds: a uniform is a cell the GPU reads, and
 * a second copy of one is a second answer to which texture is current. The cells go by way
 * of `web/cloud-instance.js`, which holds what this returns and hands it to `createPointCloud`
 * - so the wiring is one line of the boot rather than an import each way.
 */

// Depth arrives as raw millimetres. An integer texture keeps it exact, and two
// of them let the vertex shader interpolate between the last two sensor frames -
// which is what makes an 8-15fps stream look fluid on a 120Hz display.
const makeDepthTexture = () => {
  const tex = new THREE.DataTexture(
    new Uint16Array(DEPTH_W * DEPTH_H), DEPTH_W, DEPTH_H, THREE.RedIntegerFormat, THREE.UnsignedShortType,
  );
  tex.internalFormat = 'R16UI';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
};

const makeColorTexture = () => {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
};

// The selected cloud's three current textures, as views rather than as state of their own.
// The older half of the depth pair has no view because nothing outside this file has a question
// it answers: the shader is told about it through the cell below, and the one reader of the
// CPU-side array - the top-down view, which draws the cloud from the texture rather than reading
// the GPU back - wants the frame that just arrived.
export let depthCurr = null;
export let colorPrev = null;
export let colorCurr = null;

// The selected cloud's four textures, and the shader's view of the pair. The cells are kept
// beside the swap rather than in the point cloud's own uniform table because these five are the
// ones the doors below write, and a cell written from the module that does not own the swap is
// the drift the single door exists to stop.
let selected = null;

// Repoints the views above at the selected cloud - after a select, and after either swap, since
// a swap is exactly a change in which texture is current.
const pointViews = () => {
  depthCurr = selected.depthCurr;
  colorPrev = selected.colorPrev;
  colorCurr = selected.colorCurr;
};

/**
 * Builds one cloud's four textures and the five cells its material composes.
 *
 * Both depth textures start zero-filled, and that is load-bearing rather than incidental:
 * a zero sample reads as "no return" everywhere downstream, so every point leaves at the
 * empty-sample test until the first real frame binds, and nothing renders a room made of
 * whatever memory happened to hold.
 */
export function createTextures() {
  const textures = {
    depthPrev: makeDepthTexture(),
    depthCurr: makeDepthTexture(),
    colorPrev: makeColorTexture(),
    colorCurr: makeColorTexture(),
    colorPairReady: false,
    cells: {
      depthPrev: { value: null },
      depthCurr: { value: null },
      colorPrev: { value: null },
      colorCurr: { value: null },
      hasColor: { value: 0 },
    },
  };
  textures.cells.depthPrev.value = textures.depthPrev;
  textures.cells.depthCurr.value = textures.depthCurr;
  textures.cells.colorPrev.value = textures.colorPrev;
  textures.cells.colorCurr.value = textures.colorCurr;
  return textures;
}

/**
 * The two colour bitmaps one cloud has bound, which nothing may close while they are.
 *
 * Asked of a named cloud rather than of the selected one, because the caller is a cache shared
 * by every clip cut on one take: a trim reading only the bindings in front of it would close a
 * bitmap another clip is still drawing.
 */
export const boundColorImages = (textures) => [textures.colorPrev.image, textures.colorCurr.image];

/** Points the doors below, and the three views above, at one cloud's textures. */
export function selectTextures(textures) {
  selected = textures;
  pointViews();
}

// Every grid a depth block can arrive on, keyed by its own sample count. The
// divisor is negotiated out of band on the socket, but a frame already in flight
// when the setting changes arrives under the previous one - so the length is what a
// frame actually is, where the last grant is only what the next frame will be. Every
// divisor the socket and the frame API accept lands on a distinct count, so nothing
// here has to be told which one it is looking at.
const DEPTH_GRIDS = new Map();
for (let k = 1; k <= 16; k++) {
  const w = Math.ceil(DEPTH_W / k);
  const h = Math.ceil(DEPTH_H / k);
  DEPTH_GRIDS.set(w * h, { k, w, h });
}

/**
 * A decimated grid back onto the sensor's own, nearest-neighbour, which is exactly
 * the sampling `decimatePayload` did on the node run backwards.
 *
 * A texel only means anything at the pixel it was measured at: the shader unprojects
 * `-(col + 0.5 - cx) / fx * z` against intrinsics the sensor reported for a 512x424
 * grid, so where a sample sits in the texture *is* the ray it is claimed to lie on.
 * Writing a smaller grid straight into the larger one is therefore not a coarser
 * picture, it is a different scene. At ÷4 the 13,568 samples land in the first 27 of
 * 424 rows and the live cloud collapses into a band about a metre above the optical
 * axis, while the 203,520 texels the frame cannot reach - 93.8% of the grid - keep
 * the last full-rate frame and stand there frozen where the room used to be. That
 * reads as the depth returns having lost their scale, which is what it was reported
 * as, and it is a monitor silently changing its own geometry: the one thing the
 * design says an instrument must never do.
 *
 * Paying it back in compute rather than on the wire is the right side to pay on. The
 * divisor exists because a radio link cannot carry 14.6 MB/s and never because a
 * machine could not keep up, so expanding here costs the client the GPU it already
 * had spare and leaves the saving where it was asked for.
 *
 * Private to this file, because the only way to reach it is through the depth door
 * below - an acquisition path that expanded a block itself and then handed over the
 * result would be the second expansion site this arrangement exists to prevent.
 */
function expandDepth(src, dst) {
  const grid = DEPTH_GRIDS.get(src.length);
  if (!grid) {
    throw new Error(
      `a depth block of ${src.length} samples is not the ${DEPTH_W}x${DEPTH_H} grid at any divisor this `
      + 'build serves: refusing rather than filling the head of the texture with it and '
      + 'unprojecting whatever was already in the rest as though it were the scene',
    );
  }
  if (grid.k === 1) {
    dst.set(src);
    return;
  }
  for (let row = 0; row < DEPTH_H; row++) {
    const from = ((row / grid.k) | 0) * grid.w;
    const to = row * DEPTH_W;
    for (let col = 0; col < DEPTH_W; col++) dst[to + col] = src[from + ((col / grid.k) | 0)];
  }
}

// The two doors every acquisition path goes through to put a capture frame in
// front of the shader. They write the selected cloud, and there is one of each
// rather than one per source, because the swap is the part that has to be
// identical: a socket arrival, a pinned run and an indexed pull all have to
// leave the textures in the same relationship or the renderer would produce a
// different image depending on where the bytes came from - which is the drift
// this whole design is arranged to prevent. A second cloud gets a second set of
// textures and the same two doors, so the swap stays identical by being one
// implementation run against another instance rather than a second one.
//
// The expansion is inside the door for the same reason. A monitor was the only
// caller handing over a decimated grid, so fixing it where the socket unpacks its
// bytes would have left the next caller that decimates - the editor over a slow
// link, which the design already asks for - to find the same hole again.
export function bindDepth(data) {
  const swap = selected.depthPrev;
  selected.depthPrev = selected.depthCurr;
  selected.depthCurr = swap;
  expandDepth(data, selected.depthCurr.image.data);
  selected.depthCurr.needsUpdate = true;
  selected.cells.depthPrev.value = selected.depthPrev;
  selected.cells.depthCurr.value = selected.depthCurr;
  pointViews();
}

// Ownership of the bitmap stays with the caller. Live closes its own two swaps
// later, once it is certainly unbound; the indexed cache holds its own until the
// frame is evicted. Closing one here would free a bitmap the other still needs.
export function bindColor(bitmap) {
  if (selected.colorPrev === selected.colorCurr) {
    selected.colorPrev.dispose();
    selected.colorPrev = makeColorTexture();
    selected.colorCurr = makeColorTexture();
    selected.colorPairReady = false;
  }
  if (!selected.colorPairReady) {
    selected.colorPrev.image = bitmap;
    selected.colorPrev.needsUpdate = true;
    selected.colorCurr.image = bitmap;
    selected.colorCurr.needsUpdate = true;
    selected.cells.colorPrev.value = selected.colorPrev;
    selected.cells.colorCurr.value = selected.colorCurr;
    selected.cells.hasColor.value = 1;
    selected.colorPairReady = true;
    pointViews();
    return;
  }
  const swap = selected.colorPrev;
  selected.colorPrev = selected.colorCurr;
  selected.colorCurr = swap;
  selected.colorCurr.image = bitmap;
  selected.colorCurr.needsUpdate = true;
  selected.cells.colorPrev.value = selected.colorPrev;
  selected.cells.colorCurr.value = selected.colorCurr;
  selected.cells.hasColor.value = 1;
  pointViews();
}

/** Makes the next colour arrival seed both samplers, without taking bitmap ownership. */
export function resetColorSource() {
  selected.colorPairReady = false;
  selected.cells.hasColor.value = 0;
}

/**
 * A colour image from bytes rather than from a decode, planted on both halves of the
 * pair at once.
 *
 * The third writer of the colour pair and the only one that is not an acquisition
 * path, so it deliberately does not swap: both samplers end up pointed at the same
 * texture, which makes what the cloud is wearing independent of decode timing and of
 * which side of the pair `mixT` happens to favour. A run that plants its own colour is
 * one that wants an exact picture, and a picture that depends on where the playhead sits
 * inside a pair is not one.
 */
export function plantColor(rgba, width, height) {
  const prev = selected.colorPrev;
  const curr = selected.colorCurr;
  prev.dispose();
  if (curr !== prev) curr.dispose();
  const tex = new THREE.DataTexture(
    new Uint8Array(rgba), width, height, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  selected.colorPrev = tex;
  selected.colorCurr = tex;
  selected.cells.colorPrev.value = tex;
  selected.cells.colorCurr.value = tex;
  selected.cells.hasColor.value = 1;
  selected.colorPairReady = true;
  pointViews();
}
