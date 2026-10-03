// What this context can render into: which pixel types a render target can hold, and how large
// one can be. Asked once, of the live context, and read by every target the viewer allocates.
//
// A type is proved by building a framebuffer on it rather than by reading extension names,
// because the two disagree: a context with `EXT_color_buffer_float` renders half-float without
// ever listing `EXT_color_buffer_half_float`, which is Firefox's own list. The size is the
// smaller of the texture and renderbuffer limits, because a post-chain target is both - a
// colour texture and a depth renderbuffer - and a privacy mode such as Firefox's
// `privacy.resistFingerprinting` holds both at 2048 while leaving the canvas itself alone.
//
// Nothing is allocated and no GL is touched while this module evaluates; the probe runs on the
// first question.

import * as THREE from 'three';
import { renderer } from './scene.js';

// Best first. A target asks for the best type up to the precision it was designed for, so
// nothing is promoted past what it was measured at.
const LADDER = [THREE.FloatType, THREE.HalfFloatType, THREE.UnsignedByteType];
const NAMES = new Map([
  [THREE.FloatType, 'float'],
  [THREE.HalfFloatType, 'half'],
  [THREE.UnsignedByteType, 'byte'],
]);

let decided = null;

/** Whether a 1x1 target of this type completes a framebuffer on this context. */
function completes(type) {
  const gl = renderer.getContext();
  const probe = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false });
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(probe);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } finally {
    renderer.setRenderTarget(previous);
    probe.dispose();
  }
}

/** The decision: the renderable types, best first, and the largest target edge in pixels. */
export function renderTargetCaps() {
  if (decided === null) {
    const gl = renderer.getContext();
    decided = Object.freeze({
      types: Object.freeze(LADDER.filter(completes)),
      maxSize: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
    });
  }
  return decided;
}

/** The best type from `best` down to `worst` that this context renders into, or null if none does. */
export function targetType(best, worst = THREE.UnsignedByteType) {
  const { types } = renderTargetCaps();
  return LADDER.slice(LADDER.indexOf(best), LADDER.indexOf(worst) + 1)
    .find((type) => types.includes(type)) ?? null;
}

/** A type as the word the page reports it by: float, half, byte, or null. */
export const typeName = (type) => NAMES.get(type) ?? null;
