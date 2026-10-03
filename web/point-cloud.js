// What a point in the cloud is made of, and how it is addressed. One depth pixel is two
// vertices, one uniform table and one material: the table is the only channel there is for
// telling the shaders anything, and the geometry decides which texel each vertex reads. The
// crop predicate at the foot is here because it reads the table's own faces.
//
// Nothing is allocated and no GL is touched while this module evaluates - the four source cells
// come back from `createTextures` and `stateTex` reads a target `createSurfaceMemory` has not
// made yet, so a table built up here would hold nulls for both.

import * as THREE from 'three';
import { DEPTH_H, DEPTH_W, POINTS } from './format.js';
import { scene, PROGRAM_FOV } from './scene.js';
import { projectionScaleForVerticalFov } from './lens.js';
import {
  CLIP_FAR_DEFAULT, CLIP_NEAR_DEFAULT, CROP_LIMIT, outsideCropBox,
} from './crop-box.js';

// The selected cloud as seven live bindings, read from `web/main.js` for the rest of the
// program's life and repointed by the select below. Two have an entry in
// `tools/module-check.mjs` - the uniform table and the levelling pair, both of them written
// into from outside - and the other five are reached through their own methods.
export let geometry = null;
export let uniforms = null;
export let material = null;
export let cloud = null;
// The group the levelling rotation rides, which is the selected clip's rather than the program's.
export let level = null;
// The two angles that rotation is composed from, in degrees, and this clip's own pair. Held
// rather than read back off the group: a quaternion does not say which of the two angles made
// it, and each of the two sliders writes one of them and then recomposes both.
export let levelAngles = null;
// The group the clip's placement rides, above levelling. Where the clip sits in the room.
export let transform = null;

// The pixel coordinates every cloud draws, built at most once. The two attributes are a function
// of the depth grid alone, so a second cloud reading a second copy of the same 434,176 vertices
// would be seven megabytes saying what this one already says. Built on demand rather than up
// here, so this module still allocates nothing while it evaluates.
let sharedGeometry = null;

function pixelGeometry() {
  if (sharedGeometry) return sharedGeometry;
  // Two vertices per depth pixel: one for the live point, one for the ghost it leaves behind.
  // The ghost half is left out of the draw range entirely when nothing can be shed.
  sharedGeometry = new THREE.BufferGeometry();
  const pixelCoords = new Float32Array(POINTS * 2 * 3);
  const slotAttr = new Float32Array(POINTS * 2);
  for (let slot = 0; slot < 2; slot++) {
    for (let row = 0, i = 0; row < DEPTH_H; row++) {
      for (let col = 0; col < DEPTH_W; col++, i++) {
        const k = slot * POINTS + i;
        pixelCoords[k * 3] = col;
        pixelCoords[k * 3 + 1] = row;
        pixelCoords[k * 3 + 2] = 0;
        slotAttr[k] = slot;
      }
    }
  }
  sharedGeometry.setAttribute('position', new THREE.BufferAttribute(pixelCoords, 3));
  sharedGeometry.setAttribute('aSlot', new THREE.BufferAttribute(slotAttr, 1));
  sharedGeometry.setDrawRange(0, POINTS);
  sharedGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -3), 12);
  return sharedGeometry;
}

/**
 * Builds one cloud's uniform table, material and points, and puts it in the scene.
 *
 * `sourceCells`, `stateTexture` and `program` are passed in rather than imported, so the one
 * place they are wired together is `web/cloud-instance.js` - which is what lets this module
 * compile a shader without ever knowing there is a server. Called after the surface memory as
 * well as after the textures, because `stateTex` is seeded with the ghost target and the first
 * frame samples that seed.
 */
export function createPointCloud(sourceCells, stateTexture, program) {
  const uniforms = {
    // The four source textures, referenced rather than restated, so what the shader samples and
    // what the door last bound cannot come apart. A fresh `{ value: … }` would hold frame one.
    depthPrev: sourceCells.depthPrev,
    depthCurr: sourceCells.depthCurr,
    colorPrev: sourceCells.colorPrev,
    colorCurr: sourceCells.colorCurr,
    mixT: { value: 1 },
    // How far apart the two bound frames are, in seconds, which is what turns a depth difference
    // into a speed. Neither `mixT` nor `sinceFrameSec` is the gap and reconstructing it is
    // degenerate at the head of a pair, so the transport hands it over as its own number. The 1
    // is a placeholder: nothing divides by it before the transport writes it.
    spanSec: { value: 1 },
    snapDelta: { value: 250 },
    interpolate: { value: 1 },
    focal: { value: new THREE.Vector2(366, 366) },
    center: { value: new THREE.Vector2(256, 212) },
    resolution: { value: new THREE.Vector2(DEPTH_W, DEPTH_H) },
    // The drawing buffer's height, which is what makes every screen-space term in
    // `web/cloud-shader.js` a fraction of the frame. Written by `resize` and by nothing else.
    bufferHeight: { value: 1080 },
    // What this hardware will rasterise a point sprite at - a bound on the machine rather than a
    // value anybody chose, so not a registry parameter. The 64 is the literal it stands in for.
    pointCeiling: { value: 64 },
    // The lens every look is graded through; the shader reads any other lens as magnification.
    lensReference: { value: projectionScaleForVerticalFov(PROGRAM_FOV) },
    pointSize: { value: 9 },
    opacity: { value: 1 },
    exposure: { value: 1.15 },
    nearClip: { value: CLIP_NEAR_DEFAULT },
    farClip: { value: CLIP_FAR_DEFAULT },
    // The four lateral faces of the box `nearClip`/`farClip` already closes in depth. Absolute
    // plane positions in sensor metres rather than insets from an edge, because the frame widens
    // with depth and an inset would have to name a depth to mean anything. Seven clears
    // everything any slider can ask for, so a project saved before these existed still loads.
    cropL: { value: -7 },
    cropR: { value: 7 },
    cropB: { value: -7 },
    cropT: { value: 7 },
    // Whether those six faces actually cut, and what a point on the wrong side of them looks
    // like while somebody is editing them. `cropOn` gates the discard rather than moving the
    // planes, which is what lets one switch cover all six faces. `cropOutside` is viewer-only
    // and zero in every path that produces a deliverable.
    cropOn: { value: 1 },
    cropOutside: { value: 0 },
    // The turbulence field: metres, cycles per metre, and drift per program second - all world
    // units, so none of them owes the 1080p reference every screen-space term here does.
    noise: { value: 0 },
    noiseScale: { value: 3 },
    noiseSpeed: { value: 0.7 },
    lattice: { value: 0 },
    latticeCell: { value: 0.05 },
    // The glyph field, which draws a character where the lattice put a point and rides that
    // lattice rather than carrying a grid of its own. The three keys sum into one index and
    // wrap, so each means how far it moves the character and a weight at zero contributes
    // nothing. `glyphHash` defaults to 1 because that is the identity the probe shipped.
    glyph: { value: 0 },
    glyphTone: { value: 0 },
    glyphHash: { value: 1 },
    glyphRain: { value: 0 },
    // The falling wave: one scalar per point out of world height and program time, driving
    // brightness in the fragment stage, and the glyph field's rain key reads the same scalar.
    // Each length defaults to what the probe's clips were shot at rather than to zero, because
    // a span of zero is a degenerate divisor protected only by the master.
    rain: { value: 0 },
    rainSpeed: { value: 0.55 },
    rainSpan: { value: 1.3 },
    rainTrail: { value: 0.45 },
    // One region, three uses. Centre, half-extents, corner radius and falloff are sensor metres.
    regionCentre: { value: new THREE.Vector3(0, 0, -2) },
    regionHalf: { value: new THREE.Vector3(0, 0, 0) },
    regionRound: { value: 0.5 },
    regionSoft: { value: 0.2 },
    regionPush: { value: 0 },
    regionNoise: { value: 0 },
    regionMask: { value: 0 },
    ripple: { value: 0 },
    rippleFreq: { value: 4 },
    rippleSpeed: { value: 1 },
    // Datastream corruption, and the five numbers one slider used to hide. `glitch` is the
    // master and the only one meant to be keyframed in anger; the rest are ceilings, and every
    // default below is exactly the literal it replaced. Density against shove is the pair that
    // earns its keep - fused into the master they could only travel the diagonal.
    glitch: { value: 0 },
    glitchDensity: { value: 0.45 },
    glitchShove: { value: 0.45 },
    glitchTint: { value: 1.8 },
    glitchBands: { value: 12 },
    glitchAxis: { value: 0 },
    // Hertz, and zero is a state rather than an off switch: `floor(time * 0.0)` is a constant,
    // so the tear pattern freezes where it stands instead of stopping.
    glitchRate: { value: 7 },
    time: { value: 0 },
    // Program time again, in a cell of its own, so `timeline-check --mutate rain-accumulates`
    // can integrate exactly one line. Pointed at `time` it would redden the ripple, the glitch
    // and the raster too, and a control that fails everything cannot say which claim carries.
    rainPhase: { value: 0 },
    // The five readings of the take, as weights rather than as a mode, so colour and range
    // compose instead of excluding one another and a reading can move under the playhead. RGB
    // alone is the boot state.
    readRgb: { value: 1 },
    readDepth: { value: 0 },
    // Ghost, Contour, and Blackwall declare these uniforms in their packages. The cells stay
    // here because this table is the only channel into the assembled cloud shader.
    ghost: { value: 0 },
    ghostRim: { value: 0.7 },
    ghostFill: { value: 0.35 },
    contour: { value: 0 },
    contourBands: { value: 12 },
    // These are the floats obtained by subtracting the default width from a JavaScript double.
    // They are intentionally not the result of subtracting two floats in the shader.
    contourEdges: { value: new THREE.Vector2(0.42, 0.58) },
    blackwall: { value: 0 },
    blackwallSweep: { value: 0.28 },
    blackwallScan: { value: 0 },
    // What the two core readings are made of.
    rgbSaturation: { value: 1 },
    depthGamma: { value: 1 },
    denoise: { value: 1 },
    edgeTol: { value: 120 },
    // Whether there is a colour camera at all, and the same cell the colour door raises when a
    // JPEG binds, so the stream switching colour off and a frame arriving write one answer.
    hasColor: sourceCells.hasColor,
    softEdge: { value: 1 },
    rimAmount: { value: 0.55 },
    // Both apply on top of whichever reading is selected rather than inside one of its
    // branches, so they compose with every reading instead of being a sixth and seventh one.
    thermal: { value: 0 },
    edges: { value: 0 },
    // The duotone, which is a tonal transform rather than a palette: the two poles hold
    // luminance as well as hue, so the near-black figure against a burning core comes out of
    // the same term that decides what colour the room is. The pair is baked, following
    // `heatRamp` and `depthRamp`, and `duotoneHue` turns both poles together. Radians here.
    duotoneDepth: { value: 0 },
    duotoneHue: { value: 0 },
    duotoneSplit: { value: 0.5 },
    // How many metres the ramp between the two poles takes. Metres because without it the ramp's
    // width *was* the clip range, so the grade was a function of how tightly the crop box
    // happened to be shut. The default is that range's own width, so a document naming nothing
    // renders what it rendered before the span existed.
    duotoneSpan: { value: CLIP_FAR_DEFAULT - CLIP_NEAR_DEFAULT },
    duotoneMotion: { value: 0 },
    stateTex: { value: stateTexture },
    fadeTime: { value: 0.12 },
    wakeTime: { value: 0 },
    sinceFrameSec: { value: 0 },
  };

  // The two programs those uniforms feed, assembled at the boot in `web/main.js` rather than
  // imported whole. Every uniform the assembled pair declares needs a key in the table above,
  // nothing checks it in either direction, and a uniform with no key reads a silent zero -
  // `test/cloud-shader.test.mjs` asks it of the assembled program rather than of any file.
  const { vertexShader, fragmentShader } = program;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: true,
  });

  const geometry = pixelGeometry();
  const cloud = new THREE.Points(geometry, material);
  // The geometry is shared; set its range immediately before this cloud draws from its own look.
  cloud.onBeforeRender = () => {
    const shedding = uniforms.fadeTime.value > 0 || uniforms.wakeTime.value > 0;
    geometry.setDrawRange(0, shedding ? POINTS * 2 : POINTS);
  };
  // Two groups above the points, because the two rotations answer to different owners: the outer
  // one is where the clip is placed in the room, the inner one is levelling, and a single node
  // carrying both would make a clip's placement a function of how the mount was bolted.
  const level = new THREE.Group();
  const transform = new THREE.Group();
  level.add(cloud);
  transform.add(level);
  scene.add(transform);
  return { geometry, uniforms, material, cloud, level, levelAngles: { tilt: 0, roll: 0 }, transform };
}

/**
 * Points the seven bindings above, and everything below that reads them, at one cloud.
 *
 * The levelling rotation is in that list, and so are the two angles it is composed from: they
 * ride a group and a pair of their own per clip, so the readers that ask what "up" is are asking
 * about the selected clip rather than about the program. One shared pair is what let a clip's
 * tilt compose with another clip's roll. The placement above it is there for the same reason -
 * the registry's `transform` writes it, and a write reaches whichever clip the selection or a
 * `withClip` walk has the core pointed at.
 */
export function selectPointCloud(points) {
  geometry = points.geometry;
  uniforms = points.uniforms;
  material = points.material;
  cloud = points.cloud;
  level = points.level;
  levelAngles = points.levelAngles;
  transform = points.transform;
}

/**
 * Releases one cloud: its node out of the scene, then the material's compiled programs.
 *
 * The geometry is left alone on purpose - it is shared, so disposing it here would take the
 * vertices out from under every other cloud.
 */
export function disposePointCloud(points) {
  points.transform.removeFromParent();
  points.level.remove(points.cloud);
  points.transform.remove(points.level);
  points.material.dispose();
}

/**
 * The two shader programs this material draws with, replaced. The material is mutated rather
 * than rebuilt, because `cloud` is already in the scene holding it and `web/main.js` reaches
 * it by no other route.
 *
 * `material.dispose()` is what actually releases the old program. `needsUpdate` compiles a new
 * one and leaves the old one linked in the same material's `programs` set, so every install
 * that changed a byte of GLSL used to leave a whole compiled program behind.
 */
export function setCloudProgram(program) {
  if (material.vertexShader === program.vertexShader
    && material.fragmentShader === program.fragmentShader) return;
  material.dispose();
  material.vertexShader = program.vertexShader;
  material.fragmentShader = program.fragmentShader;
  material.needsUpdate = true;
}

/**
 * The additive-glow switch, which is four writes because a blend mode is not one on its own:
 * additive points have to stop writing depth, and the soft edge goes with them. `needsUpdate`
 * is what makes the pair take, since three.js compiles a program per material state.
 */
export function setAdditive(on) {
  material.blending = on ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.depthWrite = !on;
  uniforms.softEdge.value = on ? 1 : 0;
  material.needsUpdate = true;
}

/**
 * How far out the four lateral crop planes have to reach for this lens, in metres. The widest
 * sample is the frame corner furthest from the principal point, so the half-extent at depth z is
 * `max(c, N - c) / f * z` - an off-centre principal point reaches further on one side.
 */
export const cropReach = (maxDepth = 9.5) => {
  const { x: fx, y: fy } = uniforms.focal.value;
  const { x: cx, y: cy } = uniforms.center.value;
  return {
    x: (Math.max(cx, DEPTH_W - cx) / fx) * maxDepth,
    y: (Math.max(cy, DEPTH_H - cy) / fy) * maxDepth,
    limit: CROP_LIMIT,
  };
};

/**
 * Whether a sensor-space sample is on the wrong side of the crop box, reading the faces the
 * shader is drawing with. The plan inset in `web/main.js` asks this rather than spelling the six
 * comparisons out again; `outsideCropBox` is where they are spelled. Sensor metres and before the
 * levelling rotation, matching the shader; `depth` is positive metres from the sensor.
 */
export function croppedOut(x, y, depth) {
  return outsideCropBox({
    crop: uniforms.cropOn.value === 1,
    near: uniforms.nearClip.value,
    far: uniforms.farClip.value,
    left: uniforms.cropL.value,
    right: uniforms.cropR.value,
    bottom: uniforms.cropB.value,
    top: uniforms.cropT.value,
    // The predicate reads the shader's convention, where the camera looks down -z.
  }, { x, y, z: -depth });
}
