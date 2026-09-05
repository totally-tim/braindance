// The glyph field's point-size ceiling, held as arithmetic. This proves the ceiling is *expressed*
// in reference pixels; it says nothing about whether a sprite stops growing there on a GPU.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPORT_SIZES } from '../web/export-sizes.js';

/** The look's own ceiling, in pixels at 1080p. */
const GLYPH_CEILING_REF = 255;

/** This rig's `ALIASED_POINT_SIZE_RANGE` top; a parameter because it is per-machine. */
const MEASURED_POINT_CEILING = 511;

const EXPORT_HEIGHTS = [...new Set(EXPORT_SIZES.flatMap(({ sizes }) => sizes.map(([, h]) => h)))];

/** The shipped clamp, read back in the look's own unit. */
const shipped = (bufferHeight, pointCeiling) => {
  const k = bufferHeight / 1080;
  return Math.min(GLYPH_CEILING_REF * k, pointCeiling) / k;
};

/** The same reading for the form this replaced: the hardware bound alone. */
const hardwareAlone = (bufferHeight, pointCeiling) => {
  const k = bufferHeight / 1080;
  return pointCeiling / k;
};

test('the ceiling is the same reference-pixel distance at every size an export offers', () => {
  const read = EXPORT_HEIGHTS.map((h) => [h, shipped(h, MEASURED_POINT_CEILING)]);
  for (const [h, ref] of read) {
    assert.equal(ref, GLYPH_CEILING_REF, `a ${h}-tall buffer put the ceiling at ${ref}`);
  }
  assert.ok(EXPORT_HEIGHTS.length >= 4, `only ${EXPORT_HEIGHTS.length} distinct export heights`);
});

test('while the hardware bound alone is a different distance at every size, which is the defect', () => {
  // The falsification row: the pre-fix form has to give a different distance per height.
  const distances = EXPORT_HEIGHTS.map((h) => hardwareAlone(h, MEASURED_POINT_CEILING));
  assert.ok(new Set(distances).size > 1,
    `the hardware bound gave one distance at every height: ${distances.join(', ')}`);
  assert.equal(hardwareAlone(1080, MEASURED_POINT_CEILING), 511);
  assert.equal(hardwareAlone(2160, MEASURED_POINT_CEILING), 255.5);
});

test('255 is the largest ceiling the tallest offered output can actually rasterise', () => {
  const tallest = Math.max(...EXPORT_HEIGHTS);
  const largestScale = tallest / 1080;
  assert.equal(largestScale, 2, `the tallest export is ${tallest}, a scale of ${largestScale}`);
  assert.ok(GLYPH_CEILING_REF * largestScale <= MEASURED_POINT_CEILING,
    `${GLYPH_CEILING_REF} * ${largestScale} is past the ${MEASURED_POINT_CEILING} this rig draws`);
  assert.ok((GLYPH_CEILING_REF + 1) * largestScale > MEASURED_POINT_CEILING,
    `${GLYPH_CEILING_REF + 1} would also have fitted, so this is not the largest`);
});

test('and on a GPU that cannot draw it the hardware wins, which is the bound doing its job', () => {
  const small = 128;
  assert.equal(shipped(2160, small), small / 2);
  assert.equal(shipped(1080, small), small);
  assert.notEqual(shipped(2160, small), shipped(1080, small));
  assert.equal(shipped(2160, 8192), GLYPH_CEILING_REF);
  assert.equal(shipped(1080, 8192), GLYPH_CEILING_REF);
});

test('the shader carries this exact ceiling, so the number above is not a second copy', () => {
  // The 255 is written out here rather than read out of the shader, so retuning one
  // without the other fails instead of agreeing by construction.
  const src = readFileSync(new URL('../effects-builtin/glyph/size.vert.glsl', import.meta.url), 'utf8');
  const clamp = `min(${GLYPH_CEILING_REF}.0 * k, pointCeiling)`;
  assert.ok(src.includes(clamp), `the glyph branch does not clamp to ${clamp}`);
  assert.ok(src.includes(`gl_PointSize = clamp(mix(base, cellPx * k * zoom, glyph), 1.0, ${clamp});`),
    'the reference ceiling is not on the glyph branch');
  assert.ok(src.includes('gl_PointSize = clamp(pointSize * zoom * k / max(0.15, -mv.z), 1.0, 64.0);'),
    'the fallback branch no longer carries the statement export-check anchors on');
});
