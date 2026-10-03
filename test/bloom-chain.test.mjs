// The size bloom's mip chain is built at, and the weights the pass applies, called directly.
//
// The chain is frozen at the 600-tall buffer the look was graded on because `BloomPass` bakes
// its reach into its shaders when it is constructed; every other screen-space term is
// expressed against 1080p, and reconciling the two is the mistake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BloomPass, BLOOM_LEVELS, bloomChainSize, bloomWeights, BLOOM_COMPAT_GAIN,
} from '../web/bloom-pass.js';

/** The chain CLAUDE.md names: half a 600-tall reference at the buffer's aspect. */
const graded = (bufferWidth, bufferHeight) => ({
  width: Math.max(1, (bufferWidth / bufferHeight) * 300),
  height: 300,
});

const BUFFERS = [
  [960, 600], [1920, 1200], [640, 400], [800, 480], [1920, 1080], [3840, 2160], [1280, 720],
];

test('the chain is half a 600-tall reference at the buffer aspect, at every size', () => {
  for (const [w, h] of BUFFERS) {
    assert.deepEqual(bloomChainSize(w, h), graded(w, h), `${w}x${h}`);
  }
});

test('two buffers of one aspect get one chain, which is the whole of what frozen means', () => {
  assert.deepEqual(bloomChainSize(960, 600), bloomChainSize(1920, 1200));
  assert.deepEqual(bloomChainSize(1920, 1080), bloomChainSize(3840, 2160));
});

test('a chain that followed the buffer would be a different answer - above 600, and only above it', () => {
  const followsBuffer = (w, h) => ({ width: Math.max(1, w / 2), height: Math.max(1, h / 2) });
  assert.notDeepEqual(bloomChainSize(1920, 1200), followsBuffer(1920, 1200));
  assert.notDeepEqual(bloomChainSize(3840, 2160), followsBuffer(3840, 2160));

  assert.deepEqual(bloomChainSize(960, 600), followsBuffer(960, 600));
});

test('and a chain frozen at 1080 would be a different answer too', () => {
  const frozenAt1080 = (w, h) => ({ width: Math.max(1, (w / h) * 540), height: 540 });
  for (const [w, h] of BUFFERS) {
    assert.notDeepEqual(bloomChainSize(w, h), frozenAt1080(w, h), `${w}x${h}`);
  }
});

test('a buffer too narrow to halve stops at one texel rather than asking for none', () => {
  assert.deepEqual(bloomChainSize(1, 1000), { width: 1, height: 300 });
});

test('the pass halves that chain five times and floors every level at one', () => {
  const pass = new BloomPass(1.0, 0.6, 0.85, THREE.HalfFloatType);
  assert.equal(pass.targets.length, BLOOM_LEVELS);

  pass.setSize(533, 300);
  assert.deepEqual(pass.targets.map((t) => [t.width, t.height]),
    [[267, 150], [134, 75], [67, 38], [34, 19], [17, 10]]);

  pass.setSize(1, 1);
  assert.deepEqual(pass.targets.map((t) => [t.width, t.height]),
    [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]);

  pass.dispose();
});

test('the weight set sums to three at every radius, which is what makes radius a shape', () => {
  for (const radius of [0, 0.25, 0.5, 0.7, 1]) {
    const sum = bloomWeights(radius).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 3) < 1e-12, `radius ${radius} summed to ${sum}`);
  }
  const graded07 = bloomWeights(0.7).map((w) => Number(w.toFixed(2)));
  assert.deepEqual(graded07, [0.44, 0.52, 0.60, 0.68, 0.76]);
  assert.ok(graded07[4] > graded07[0], 'at 0.7 the coarsest octave outweighs the finest');

  assert.notDeepEqual(bloomWeights(0.7), [1, 1, 1, 1, 1]);
  assert.deepEqual(bloomWeights(0), [1.0, 0.8, 0.6, 0.4, 0.2]);
  assert.equal(bloomWeights(0).length, BLOOM_LEVELS);
});

test('the ratios the up chain carries telescope back into the weighted composite', () => {
  const w = bloomWeights(0.7);
  const strength = 0.5;
  let carried = 1;
  const delivered = [strength * BLOOM_COMPAT_GAIN * w[0] * carried];
  for (let i = 1; i < BLOOM_LEVELS; i++) {
    carried *= w[i] / w[i - 1];
    delivered.push(strength * BLOOM_COMPAT_GAIN * w[0] * carried);
  }
  for (let i = 0; i < BLOOM_LEVELS; i++) {
    assert.ok(Math.abs(delivered[i] - strength * BLOOM_COMPAT_GAIN * w[i]) < 1e-12,
      `octave ${i} arrives at ${delivered[i]}`);
  }
  const total = delivered.reduce((a, b) => a + b, 0) / strength;
  assert.ok(Math.abs(total - 9) < 1e-12, `the chain delivers ${total} per unit of strength`);
});

// A renderer clears the bound target when `autoClear` is up, so an additive upsample onto a
// target it has just wiped replaces the octave below instead of laying over it - the halo
// still looks like a halo at a fifth the brightness, which is why this is held here.
test('the pass holds autoClear down while it draws, and hands it back', () => {
  const seen = [];
  const target = { texture: {}, width: 960, height: 600 };
  const pass = new BloomPass(0.5, 0.7, 0.2, THREE.HalfFloatType);
  pass.setSize(480, 300);
  const renderer = {
    autoClear: true,
    _target: null,
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; },
    clear() { seen.push(['clear', this.autoClear]); },
    render() {
      const u = pass.quad.material.uniforms;
      seen.push(['render', this.autoClear, u.weight?.value, u.strength?.value]);
    },
  };
  pass.render(renderer, { texture: {} }, target);

  assert.equal(seen.filter(([what]) => what === 'render').length, 10,
    'five downsamples, four upsamples and one blend');
  assert.equal(seen.filter(([what]) => what === 'clear').length, 6,
    'the five down levels and the composite clear themselves');
  assert.ok(seen.every(([, auto]) => auto === false),
    'every draw the pass makes runs with autoClear down');
  assert.equal(renderer.autoClear, true, 'and the renderer gets its own setting back');

  const w = bloomWeights(0.7);
  const draws = seen.filter(([what]) => what === 'render');
  const ups = draws.slice(BLOOM_LEVELS, BLOOM_LEVELS + BLOOM_LEVELS - 1).map(([, , weight]) => weight);
  const want = [4, 3, 2, 1].map((i) => w[i] / w[i - 1]);
  ups.forEach((got, n) => assert.ok(Math.abs(got - want[n]) < 1e-12,
    `upsample ${n} carried ${got}, wants ${want[n]}`));
  const blend = draws[draws.length - 1][3];
  assert.ok(Math.abs(blend - 0.5 * BLOOM_COMPAT_GAIN * w[0]) < 1e-12,
    `the blend carried ${blend}, wants strength * ${BLOOM_COMPAT_GAIN} * ${w[0]}`);
  assert.ok(ups.some((got) => Math.abs(got - 1) > 1e-9), 'an unweighted up chain is a different answer');
  assert.ok(Math.abs(blend - 0.5) > 1e-9, 'and a blend carrying strength alone is another');

  const refuses = [];
  const stubborn = {
    _target: null,
    get autoClear() { return true; },
    set autoClear(_v) { /* the write the pass makes, declined */ },
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; },
    clear() {},
    render() { refuses.push(this.autoClear); },
  };
  const second = new BloomPass(0.5, 0.7, 0.2, THREE.HalfFloatType);
  second.setSize(480, 300);
  second.render(stubborn, { texture: {} }, target);
  assert.ok(refuses.length === 10 && refuses.every((auto) => auto === true),
    'the control has to be able to see draws that run with autoClear up');

  pass.dispose();
  second.dispose();
});

test('every level holds the pixel type it was handed, and a pass handed none refuses to build', () => {
  for (const type of [THREE.HalfFloatType, THREE.UnsignedByteType]) {
    const pass = new BloomPass(0.5, 0.7, 0.2, type);
    assert.deepEqual(pass.targets.map((t) => t.texture.type), Array(BLOOM_LEVELS).fill(type));
  }
  assert.throws(() => new BloomPass(0.5, 0.7, 0.2), /pixel type/);
});
