// Which passes the picture goes through after the cloud is drawn, and in what order.
//
// The order is the whole of this file's opinion: trails accumulate the raw cloud, the mosh drags
// what it holds of that along Y, bloom blows out the hot edges of what is left, and the grade
// tears the finished image. Reordering any two is a different look - a grade before the bloom
// would have the glow blooming the tearing rather than the picture, and a mosh after the grade
// would smear the grain and the scanlines down the frame instead of drawing them over the
// damage.
// The mosh sits feed-side for the reason the glitch package's own tear does: a compression
// artifact happened to the picture on its way here, before anything displayed it. No opinion
// about the passes themselves lives here.
//
// Nothing is allocated and no GL is touched while this module evaluates: `buildPostChain` does
// both, at the point in the boot order `web/main.js` writes out. Every target in the chain holds
// the type `targetType` answers, because three's own default is half-float asked of nobody.

import * as THREE from 'three';
import { renderer, scene, viewCamera } from './scene.js';
import { targetType } from './render-targets.js';
import { BloomPass } from './bloom-pass.js';
import { MoshPass } from './mosh-pass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// The chain and the four passes in it, as live bindings assigned once by the build below and
// read all over `web/main.js`. Each is a three.js object whose published interface is exactly
// those property writes, which is what the entries in `tools/module-check.mjs` say.
export let composer = null;
export let renderPass = null;
export let afterimage = null;
export let mosh = null;
export let bloom = null;
export let grade = null;
// The pixel type every target in the chain holds: half-float where the context renders it, 8-bit
// where it does not, and null where it renders neither - a chain that cannot be drawn, which the
// viewer answers by drawing straight to the canvas and saying so.
export let chainType = null;

// Every cell the mosh's shader reads before a look lands. `tNew` and `tOld` are written by the
// pass itself once a frame; `moshIFrame` is the render loop's, and it is 1 rather than 0 at rest
// so that a pass switched on before anything has decided otherwise draws the frame it was handed
// rather than reading history nobody has written.
const MOSH_UNIFORMS = {
  tNew: { value: null },
  tOld: { value: null },
  time: { value: 0 },
  moshIFrame: { value: 1 },
  resolution: { value: new THREE.Vector2(1, 1) },
  // The datamosh package's ten, defaulting to what its manifest declares, so a page whose
  // registry has not landed yet holds the same look the first slider read will.
  mosh: { value: 0 },
  moshReach: { value: 14 },
  moshDecay: { value: 0.88 },
  moshSplay: { value: 1 },
  moshLine: { value: 0.55 },
  moshGrain: { value: 3 },
  moshDrift: { value: 0 },
  moshSpeed: { value: 1 },
  moshCycleRefresh: { value: 0 },
  moshRefresh: { value: 1.2 },
};

// Every cell the grade's shader reads, with the value it holds before a look lands. The text
// that reads them is assembled elsewhere, so this is the whole of what stayed: a default a
// package cannot carry, because two of them are constructed objects.
const GRADE_UNIFORMS = {
  tDiffuse: { value: null },
  rgbSplit: { value: 0 },
  scanlines: { value: 0 },
  // The three that turn one scanline term into a raster, and they are settings of `scanlines`
  // rather than terms beside it. The angle arrives as its own axis rather than as an angle,
  // because GLSL ES permits thousandths of error on a trigonometric function and a whisker of x
  // leaking into a raster meant to run along y moved all six frames of the comparison. Done
  // here, `Math.sin(0)` is exactly 0 and survives the cast. Degrees on the slider.
  scanAxis: { value: new THREE.Vector2(0, 1) },
  scanPitch: { value: 1.3 },
  scanHard: { value: 0 },
  grain: { value: 0 },
  // The corner falloff, which was the literal 0.55 applied whenever this pass ran at all - so it
  // was a hidden function of the three terms above. It defaults to 0 rather than to 0.55 because
  // what it replaces is a conditional and no single default reproduces both branches; zero is
  // the branch that keeps the parameter defaults drawing what they drew. `blackwall.json` names
  // 0.55, so the one shipped look that had a vignette keeps it.
  vignette: { value: 0 },
  // Light bleeding back along the axis below, gathered within the frame rather than accumulated
  // across frames.
  streak: { value: 0 },
  // Which way the light runs, as its own axis rather than as an angle, for the reason `scanAxis`
  // above carries: `sin(0.0)` is not promised to be exactly zero in GLSL ES, and a whisker of
  // the wrong axis is a defect no picture shows the shape of. Degrees on the slider, and here
  // an angle means what an angle means, because the grade runs against a square reference pixel.
  streakAxis: { value: new THREE.Vector2(0, 1) },
  // The halation's four. Light that reached the emulsion scatters off the base and exposes it
  // again, so a highlight rings whatever surrounds it - warm whatever colour the highlight was,
  // which is the one thing the bloom above cannot say. The radius is reference pixels at 1080p.
  halation: { value: 0 },
  halationRadius: { value: 22 },
  halationThreshold: { value: 0.55 },
  halationTint: { value: 0.35 },
  // The stock's four, which are the emulsion's colour rather than a thing that happened to the
  // light. The balance is an axis between two stocks and its halves are different shapes. Keyed
  // to luminance and deliberately not to depth: the depth-keyed term is the duotone, which
  // replaces the colour a point at a time where this biases the assembled frame, halos and all.
  stock: { value: 0 },
  stockBalance: { value: 0 },
  stockSplit: { value: 0.45 },
  stockLatitude: { value: 0.3 },
  // The toe under the Reinhard curve, promoted from the literal 0.018 and keeping its value,
  // because what it replaces is a constant rather than a conditional. It is not the silhouette
  // crush: it darkens near and far alike, and the term that separates a subject from the space
  // behind it is the duotone in `web/cloud-shader.js`.
  crush: { value: 0.018 },
  time: { value: 0 },
  resolution: { value: new THREE.Vector2(1, 1) },
};

/**
 * Builds the composer and hangs the four passes off it, in the order the header names.
 *
 * Called after the cloud exists, because `RenderPass` is handed the scene it will draw and the
 * boot order is written out in `web/main.js` rather than inferred. Every pass but the render
 * and the output starts switched off, so a surface that grades nothing pays nothing.
 *
 * `gradeProgram` is handed in for the same reason `buildPointCloud` is handed its own: this
 * module builds a pass without ever knowing there is a server, which is what lets the gate run
 * the same assembler under bare node.
 */
export function buildPostChain(gradeProgram, moshProgram) {
  chainType = targetType(THREE.HalfFloatType);
  // Built on 8-bit when nothing renders, so the passes exist for the registry to write into; the
  // viewer never draws through a chain whose `chainType` is null.
  const type = chainType ?? THREE.UnsignedByteType;
  const target = new THREE.WebGLRenderTarget(1, 1, { type });
  target.texture.name = 'EffectComposer.rt1';
  composer = new EffectComposer(renderer, target);
  renderPass = new RenderPass(scene, viewCamera);
  composer.addPass(renderPass);

  afterimage = new AfterimagePass(0.0);
  afterimage.enabled = false;
  // Three builds both history targets as half-float in the constructor and takes no type, so they
  // are replaced before anything has drawn into them.
  for (const key of ['_textureComp', '_textureOld']) {
    if (!afterimage[key]?.isWebGLRenderTarget) {
      throw new Error('afterimage internals moved: its history targets can no longer be typed');
    }
    afterimage[key].dispose();
    afterimage[key] = new THREE.WebGLRenderTarget(1, 1, { magFilter: THREE.NearestFilter, type });
  }
  composer.addPass(afterimage);

  mosh = new MoshPass({
    uniforms: MOSH_UNIFORMS,
    vertexShader: moshProgram.vertexShader,
    fragmentShader: moshProgram.fragmentShader,
    type,
  });
  mosh.enabled = false;
  composer.addPass(mosh);

  bloom = new BloomPass(0.0, 0.7, 0.2, type);
  bloom.enabled = false;
  composer.addPass(bloom);

  // One combined pass: chaining separate RGBShift/Film/Vignette passes would cost
  // a full-screen read and write each.
  grade = new ShaderPass({
    uniforms: GRADE_UNIFORMS,
    vertexShader: gradeProgram.vertexShader,
    fragmentShader: gradeProgram.fragmentShader,
  });
  grade.enabled = false;
  composer.addPass(grade);

  composer.addPass(new OutputPass());
}

/**
 * The grade's program, replaced without replacing the pass.
 *
 * The pass's identity is what the chain is built out of: `composer` holds it at the position
 * this file's whole argument is about, and every uniform the look writes is a cell in
 * `GRADE_UNIFORMS` its material composed by reference. Building a new `ShaderPass` would leave
 * the drawn image on the old one with nothing saying which program drew it.
 *
 * `grade.material.dispose()` is what releases the old program rather than `needsUpdate` - see
 * `setCloudProgram`, which is the other half of the same swap and had the same leak.
 */
export function setGradeProgram(gradeProgram) {
  if (grade.material.vertexShader === gradeProgram.vertexShader
    && grade.material.fragmentShader === gradeProgram.fragmentShader) return;
  grade.material.dispose();
  grade.material.vertexShader = gradeProgram.vertexShader;
  grade.material.fragmentShader = gradeProgram.fragmentShader;
  grade.material.needsUpdate = true;
}

/** The mosh's program, replaced without replacing the pass. `setGradeProgram` carries the why. */
export function setMoshProgram(moshProgram) {
  if (mosh.material.vertexShader === moshProgram.vertexShader
    && mosh.material.fragmentShader === moshProgram.fragmentShader) return;
  mosh.material.dispose();
  mosh.material.vertexShader = moshProgram.vertexShader;
  mosh.material.fragmentShader = moshProgram.fragmentShader;
  mosh.material.needsUpdate = true;
}
