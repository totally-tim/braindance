// How the halo is built and how big it is built at. The pass and the chain size at the foot of
// the file are one reason to change rather than two: the size is frozen because the pass bakes
// its reach into its shaders. Nothing here runs at import time beyond declaring a class and
// three strings, so both halves can be constructed under bare node with no renderer at all.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * The glow, as a progressive down-and-up sample chain rather than a Gaussian per mip.
 *
 * `UnrealBloomPass` costs what it costs because of how many render targets it visits and not
 * how big they are - shrinking its chain sixty-fold moved the frame by 0.026ms - so the only
 * lever is visiting fewer targets: five downsamples, four upsamples and one blend against its
 * thirteen full-screen draws. The threshold rides in the first downsample, which is the one
 * place fusing costs nothing, and `bloomChainSize` at the foot of this file decides the size.
 *
 * Three terms of the pass this replaces were dropped when this was first written and are back:
 * `renderer.autoClear` left on, so the accumulating up chain did not accumulate; the
 * composite's `3.0`; and the per-mip `bloomFactors` with `radius` as their mirror. Together
 * they are 9.0 of gain on a five-octave sum against the 1.0 this applied to one octave.
 */
export const BLOOM_LEVELS = 5;

// The old composite's per-mip weights, finest mip first, and the gain over them. Kept as the
// two literals rather than the 1.8 they multiply out to, because the product is only 1.8 while
// every octave has the same mean. The array stays module-local and the function crosses, since
// an exported array is a channel a caller could push a sixth factor onto.
const BLOOM_FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2];
export const BLOOM_COMPAT_GAIN = 3.0;
export const bloomWeights = (radius) => BLOOM_FACTORS.map((f) => f + radius * (1.2 - 2.0 * f));

// How far apart the tent's taps sit, in texels of the level being read. A constant rather than
// a parameter: it was `radius` until the weight set came back, and `radius` is the weight
// mirror rather than a tap spacing.
const TENT_SPACING = 0.7;

// Thirteen taps in the pattern Jimenez's filter uses. Written as one pass because every tap is
// bilinear: this reads thirty-six texels' worth of neighbourhood for thirteen fetches, which is
// what lets a single pass replace a separable pair.
const bloomDownShader = /* glsl */ `
  precision highp float;
  uniform sampler2D tSource;
  uniform vec2 texel;
  uniform float threshold, knee, firstLevel;
  varying vec2 vUv;

  void main() {
    vec2 t = texel;
    vec3 a = texture2D(tSource, vUv + vec2(-2.0 * t.x,  2.0 * t.y)).rgb;
    vec3 b = texture2D(tSource, vUv + vec2( 0.0,        2.0 * t.y)).rgb;
    vec3 c = texture2D(tSource, vUv + vec2( 2.0 * t.x,  2.0 * t.y)).rgb;
    vec3 d = texture2D(tSource, vUv + vec2(-2.0 * t.x,  0.0)).rgb;
    vec3 e = texture2D(tSource, vUv).rgb;
    vec3 f = texture2D(tSource, vUv + vec2( 2.0 * t.x,  0.0)).rgb;
    vec3 g = texture2D(tSource, vUv + vec2(-2.0 * t.x, -2.0 * t.y)).rgb;
    vec3 h = texture2D(tSource, vUv + vec2( 0.0,       -2.0 * t.y)).rgb;
    vec3 i = texture2D(tSource, vUv + vec2( 2.0 * t.x, -2.0 * t.y)).rgb;
    vec3 j = texture2D(tSource, vUv + vec2(-t.x,  t.y)).rgb;
    vec3 k = texture2D(tSource, vUv + vec2( t.x,  t.y)).rgb;
    vec3 l = texture2D(tSource, vUv + vec2(-t.x, -t.y)).rgb;
    vec3 m = texture2D(tSource, vUv + vec2( t.x, -t.y)).rgb;

    vec3 sum = e * 0.125;
    sum += (a + c + g + i) * 0.03125;
    sum += (b + d + f + h) * 0.0625;
    sum += (j + k + l + m) * 0.125;

    // Only the level that reads the frame itself cuts the darks out. Applying it further down
    // would eat the glow it had already spread, since a halo is dimmer than its highlight.
    if (firstLevel > 0.5) {
      float lum = dot(sum, vec3(0.299, 0.587, 0.114));
      sum *= smoothstep(threshold, threshold + knee, lum);
    }
    gl_FragColor = vec4(sum, 1.0);
  }
`;

// The nine-tap tent that walks back up, additive onto the level below, so the falloff is the
// sum of the chain rather than a set of weights chosen at the end.
const bloomUpShader = /* glsl */ `
  precision highp float;
  uniform sampler2D tSource;
  uniform vec2 texel;
  uniform float spacing, weight;
  varying vec2 vUv;

  void main() {
    // The composite's weights, applied here because in this chain there is no composite to
    // apply them in. The uniform is the RATIO between two adjacent weights: the target already
    // holds everything coarser, so scaling what arrives scales every octave above this one.
    vec2 t = texel * spacing;
    vec3 sum = texture2D(tSource, vUv + vec2(-t.x,  t.y)).rgb * 0.0625;
    sum += texture2D(tSource, vUv + vec2( 0.0,   t.y)).rgb * 0.125;
    sum += texture2D(tSource, vUv + vec2( t.x,   t.y)).rgb * 0.0625;
    sum += texture2D(tSource, vUv + vec2(-t.x,   0.0)).rgb * 0.125;
    sum += texture2D(tSource, vUv).rgb * 0.25;
    sum += texture2D(tSource, vUv + vec2( t.x,   0.0)).rgb * 0.125;
    sum += texture2D(tSource, vUv + vec2(-t.x,  -t.y)).rgb * 0.0625;
    sum += texture2D(tSource, vUv + vec2( 0.0,  -t.y)).rgb * 0.125;
    sum += texture2D(tSource, vUv + vec2( t.x,  -t.y)).rgb * 0.0625;
    gl_FragColor = vec4(sum * weight, 1.0);
  }
`;

const bloomVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export class BloomPass extends Pass {
  constructor(strength, radius, threshold, type) {
    super();
    if (type === undefined) throw new Error('the bloom pass needs the pixel type its chain holds');
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    // The last step writes the picture and the glow summed into the other buffer, so the
    // composer swaps onto it. Blending onto the buffer it was handed aliased a texture with
    // its own render target.
    this.needsSwap = true;

    this.targets = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const target = new THREE.WebGLRenderTarget(1, 1, { type });
      target.texture.name = `bloom.${i}`;
      target.texture.generateMipmaps = false;
      this.targets.push(target);
    }

    this.downMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSource: { value: null },
        texel: { value: new THREE.Vector2() },
        threshold: { value: threshold },
        knee: { value: 0.01 },
        firstLevel: { value: 0 },
      },
      vertexShader: bloomVertexShader,
      fragmentShader: bloomDownShader,
    });

    this.upMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSource: { value: null },
        texel: { value: new THREE.Vector2() },
        spacing: { value: TENT_SPACING },
        weight: { value: 1 },
      },
      vertexShader: bloomVertexShader,
      fragmentShader: bloomUpShader,
      // Additive, because an upsample lays its octave over the wider one already in the target.
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    // The picture and the glow are added in one shader rather than by blending the glow onto
    // the picture. The additive version binds the buffer it reads as its own render target,
    // which WebGL leaves undefined - here it lost the picture entirely.
    this.blendMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPicture: { value: null },
        tBloom: { value: null },
        strength: { value: strength },
      },
      vertexShader: bloomVertexShader,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tPicture, tBloom;
        uniform float strength;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tPicture, vUv);
          gl_FragColor = vec4(base.rgb + texture2D(tBloom, vUv).rgb * strength, base.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(null);
  }

  setSize(width, height) {
    let w = Math.max(1, Math.round(width));
    let h = Math.max(1, Math.round(height));
    for (const target of this.targets) {
      // Halved per level and floored at one, so a chain asked for on a very small preview
      // stops shrinking instead of asking for a zero-sized target.
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      target.setSize(w, h);
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const previousTarget = renderer.getRenderTarget();
    // Held down for the whole pass, and this is the line whose absence cost the halo four of
    // its five octaves: `WebGLRenderer.render` clears the bound target when `autoClear` is set,
    // so every additive upsample landed on a target that had just been wiped. The explicit
    // `clear()` calls below are what clears from here on.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // The old composite's weight set at this radius, and the ratios that reproduce it in an
    // accumulating chain. Setting `r(i) = w(i) / w(i-1)` telescopes the up loop's products to
    // `w(i) / w(0)`, and the blend's `w(0)` puts the missing factor back.
    const weights = bloomWeights(this.radius);

    // Down. The first level reads the frame and cuts the darks; the rest read the level above.
    this.quad.material = this.downMaterial;
    for (let i = 0; i < this.targets.length; i++) {
      const source = i === 0 ? readBuffer : this.targets[i - 1];
      this.downMaterial.uniforms.tSource.value = source.texture;
      this.downMaterial.uniforms.threshold.value = this.threshold;
      this.downMaterial.uniforms.firstLevel.value = i === 0 ? 1 : 0;
      this.downMaterial.uniforms.texel.value.set(1 / source.width, 1 / source.height);
      renderer.setRenderTarget(this.targets[i]);
      renderer.clear();
      this.quad.render(renderer);
    }

    // Up, accumulating. Nothing is cleared on the way back: each pass adds its octave to the
    // level below, which already holds that level's own downsample.
    this.quad.material = this.upMaterial;
    for (let i = this.targets.length - 1; i > 0; i--) {
      const source = this.targets[i];
      this.upMaterial.uniforms.tSource.value = source.texture;
      this.upMaterial.uniforms.weight.value = weights[i] / weights[i - 1];
      this.upMaterial.uniforms.texel.value.set(1 / source.width, 1 / source.height);
      renderer.setRenderTarget(this.targets[i - 1]);
      this.quad.render(renderer);
    }

    // And the two are summed into the buffer the composer will swap to. `strength` is applied
    // here and only here, so the look control stays outside the resampling.
    this.quad.material = this.blendMaterial;
    this.blendMaterial.uniforms.tPicture.value = readBuffer.texture;
    this.blendMaterial.uniforms.tBloom.value = this.targets[0].texture;
    this.blendMaterial.uniforms.strength.value = this.strength * BLOOM_COMPAT_GAIN * weights[0];
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    renderer.clear();
    this.quad.render(renderer);

    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    for (const target of this.targets) target.dispose();
    this.downMaterial.dispose();
    this.upMaterial.dispose();
    this.blendMaterial.dispose();
    this.quad.dispose();
  }
}

// What `setSize` should be handed for a given drawing buffer. Bloom runs at half resolution,
// and the resolution it is half of is a fixed 600-tall reference rather than the drawing
// buffer, which is what makes its halo a fixed fraction of the frame.
//
// The reference is **not** the 1080p every other screen-space term is expressed against, and
// the two do not reconcile: `UnrealBloomPass` bakes its tap count into its shaders when it is
// constructed, so the chain has no value to state and is frozen at the buffer the look was
// graded on. Freezing it at 1080 makes the halo 1.8x tighter - measured at 7.16/255 on the
// worst of forty tile means against 1.10 for this one.
export function bloomChainSize(bufferWidth, bufferHeight) {
  const refWidth = (bufferWidth / bufferHeight) * 600;
  return { width: Math.max(1, refWidth / 2), height: 300 };
}
