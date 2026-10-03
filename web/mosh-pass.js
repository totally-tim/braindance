// The feedback pass, and the arithmetic that says how far back a seek has to start to reproduce
// it. Both halves are here for one reason to change: the pass is what holds a frame of memory,
// and the walk below is the ceiling on how long that memory can last. Nothing runs at import
// time beyond declaring a class and a function, so the walk can be tested under bare node with
// no renderer at all - the same split `web/bloom-pass.js` makes with `bloomChainSize`.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

/**
 * A pass that can read the frame it drew last time.
 *
 * Two targets and a swap, the shape three's own `AfterimagePass` uses: the program draws into
 * `comp` reading `old`, the result is copied on to whatever the chain asked for, and the two
 * swap so `old` holds what was just drawn. Half float where the context renders it, because a
 * pixel that has been through the feedback a dozen times has been quantised a dozen times, and
 * eight bits of it band visibly on the smear.
 *
 * The program and the pixel type are handed in rather than decided here, for the reason
 * `buildPostChain` is handed the grade's: this module never learns there is an effect store or
 * a context, which is what lets the gate assemble the same text under bare node.
 */
export class MoshPass extends Pass {
  constructor({ uniforms, vertexShader, fragmentShader, type }) {
    super();
    if (type === undefined) throw new Error('the mosh pass needs the pixel type its history holds');
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    const target = () => new THREE.WebGLRenderTarget(1, 1, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      type,
    });
    this.comp = target();
    this.old = target();
    this.quad = new FullScreenQuad(this.material);
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
  }

  /** The two targets the history lives in, so a reset can clear them by name rather than by index. */
  get history() {
    return [this.comp, this.old];
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tNew.value = readBuffer.texture;
    this.uniforms.tOld.value = this.old.texture;

    renderer.setRenderTarget(this.comp);
    this.quad.render(renderer);

    this.copyMaterial.uniforms.tDiffuse.value = this.comp.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.copyQuad.render(renderer);

    const held = this.old;
    this.old = this.comp;
    this.comp = held;
  }

  setSize(width, height) {
    this.comp.setSize(width, height);
    this.old.setSize(width, height);
  }

  dispose() {
    this.comp.dispose();
    this.old.dispose();
    this.material.dispose();
    this.copyMaterial.dispose();
    this.quad.dispose();
    this.copyQuad.dispose();
  }
}

/**
 * Whether the refresh falls between two consecutive rendered frames.
 *
 * The period is a look term like any other, so it keyframes, and `floor(t / period)` against a
 * moving period is not a boundary anybody could seek to. What is well defined is the comparison
 * the render loop actually makes: each frame divides its own program time by the period that was
 * in force when it was drawn, and the refresh fires where the two answers differ. Both periods
 * are handed in rather than looked up, because the loop remembers the previous frame's and the
 * walk below evaluates it - one question, asked from two directions, and they may not drift.
 *
 * A period of zero or less is not a period: it refreshes every frame rather than dividing by
 * nothing.
 */
export const moshRefreshes = (prevSec, prevPeriod, sec, period) => {
  if (!(prevPeriod > 0) || !(period > 0)) return true;
  return Math.floor(prevSec / prevPeriod) !== Math.floor(sec / period);
};

/**
 * How many output frames back a seek has to start for the mosh pass to land where playback did.
 *
 * A frame the pass refreshes on is one it draws exactly what it was handed, so it is where a
 * decode can start - a keyframe, which is the same thing an I-frame is in the format this look is
 * about. The walk goes back a frame at a time looking for the nearest one, and there are three
 * kinds: the refresh itself, the pass's first live frame (whose history is black, so it refreshes
 * whatever the period says), and the head of the take. Zero is a legitimate answer: a target that
 * is itself a refresh needs no pre-roll at all.
 *
 * **In frames rather than in seconds**, because that is what the loop renders: `seekNow` and
 * playback both step `k / outputFps`, and a walk subtracting `1 / outputFps` off a float lands a
 * whisker under a boundary and reports a refresh one frame early.
 *
 * `covered` is false when the ceiling ran out before any of the three, which is the honest answer
 * rather than a number: something has made the memory outlast the bound its own parameter states.
 */
export function moshFramesBack(programSec, outputFps, liveAt, periodAt, ceilingFrames) {
  if (!liveAt(programSec)) return { frames: 0, covered: true };
  const target = Math.round(programSec * outputFps);
  for (let n = 0; n <= ceilingFrames; n++) {
    const frame = target - n;
    if (frame <= 0) return { frames: n, covered: true };
    const at = frame / outputFps;
    const prev = (frame - 1) / outputFps;
    if (!liveAt(prev)) return { frames: n, covered: true };
    if (moshRefreshes(prev, periodAt(prev), at, periodAt(at))) return { frames: n, covered: true };
  }
  return { frames: ceilingFrames, covered: false };
}
