// The trim a deliverable covers: what a bound may be, and what the pair is held to once it is
// written. The pair is module state, so every row resets it - one clip range is what the
// transport, the export and the two markers all read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as clip from '../web/clip-range.js';

const { clipBoundOrThrow, writeClipRange } = clip;
const { pastOutPoint, rangeFrames } = clip;

const reset = () => writeClipRange({ in: 0, out: null }, null);

test('a bound is a finite number of program seconds, and null only at the out point', () => {
  reset();
  assert.equal(clipBoundOrThrow(0, 'in'), 0);
  assert.equal(clipBoundOrThrow(12.5, 'out'), 12.5);
  assert.equal(clipBoundOrThrow(-3, 'in'), -3, 'the predicate answers what a time is, and the clamp answers where it may be');
  assert.equal(clipBoundOrThrow(null, 'out'), null);
  assert.throws(() => clipBoundOrThrow(null, 'in'), /in point is null/);
  for (const bad of [NaN, Infinity, -Infinity, '4', 'start', undefined, {}, [], true]) {
    assert.throws(() => clipBoundOrThrow(bad, 'out'), /not a program time/s,
      `${JSON.stringify(bad) ?? String(bad)} was accepted as an out point`);
  }
});

test('a bound that is not a time is refused before either end is written', () => {
  reset();
  writeClipRange({ in: 2, out: 8 }, 20);
  assert.throws(() => writeClipRange({ in: 'start', out: 9 }, 20), /not a program time/s);
  assert.equal(clip.clipIn, 2);
  assert.equal(clip.clipOut, 8);
  assert.throws(() => writeClipRange({ in: 5, out: 'end' }, 20), /not a program time/s);
  assert.equal(clip.clipIn, 2, 'the in point was written by a call that was going to be refused');
  assert.equal(clip.clipOut, 8);
});

test('a field left out keeps whatever it held, which is how a marker drag writes one end', () => {
  reset();
  writeClipRange({ in: 3, out: 9 }, 20);
  writeClipRange({ in: 4 }, 20);
  assert.equal(clip.clipIn, 4);
  assert.equal(clip.clipOut, 9);
  writeClipRange({ out: 7 }, 20);
  assert.equal(clip.clipIn, 4);
  assert.equal(clip.clipOut, 7);
});

test('the pair is held inside the program that is open', () => {
  reset();
  writeClipRange({ in: 60, out: 120 }, 30);
  assert.ok(clip.clipIn <= clip.clipOut, `in ${clip.clipIn} against out ${clip.clipOut}`);
  assert.equal(clip.clipIn, 30);
  assert.equal(clip.clipOut, 30);

  reset();
  writeClipRange({ in: -5, out: 10 }, 30);
  assert.equal(clip.clipIn, 0);
  assert.equal(clip.clipOut, 10);

  reset();
  writeClipRange({ in: 4, out: 9 }, 30);
  writeClipRange({ in: 20 }, 30);
  assert.equal(clip.clipIn, 20);
  assert.equal(clip.clipOut, 20);
});

test('null stays null, because "to the end" is a statement rather than a time', () => {
  reset();
  writeClipRange({ in: 2, out: null }, 30);
  assert.equal(clip.clipOut, null,
    'a duration written in here would freeze "the whole clip" at the length it had today');
  writeClipRange({ in: 2 }, 300);
  assert.equal(clip.clipOut, null);
});

test('with no take open the pair is written and not clamped', () => {
  reset();
  writeClipRange({ in: 90, out: 200 }, null);
  assert.equal(clip.clipIn, 90);
  assert.equal(clip.clipOut, 200);
  writeClipRange({}, 30);
  assert.equal(clip.clipIn, 30);
  assert.equal(clip.clipOut, 30);
});

test('the invariant holds over every document a caller can hand it', () => {
  const durations = [1, 30, 75.6, 480];
  const bounds = [-10, 0, 0.5, 12, 29.999, 30, 75.6, 1e6];
  for (const dur of durations) {
    for (const inn of bounds) {
      for (const out of [...bounds, null]) {
        reset();
        writeClipRange({ in: inn, out }, dur);
        const held = `in ${inn} out ${out} over ${dur}s -> ${clip.clipIn}/${clip.clipOut}`;
        assert.ok(clip.clipIn >= 0 && clip.clipIn <= dur, held);
        if (clip.clipOut !== null) {
          assert.ok(clip.clipOut >= clip.clipIn && clip.clipOut <= dur, held);
        } else {
          assert.equal(out, null, `${held} - only a null asked for may stay null`);
        }
      }
    }
  }
});

test('a marker drag previews what its own release will commit', () => {
  // The two expressions the ruler's markers use, copied out of the drag and the release and
  // run through the same door - the drag used to assign the bindings directly and skip it.
  const dur = 30;
  reset();
  writeClipRange({ in: 5, out: null }, dur);
  const t = 2;
  writeClipRange({ out: clip.clipOut === null ? t : Math.max(clip.clipIn, Math.min(t, dur)) }, dur);
  assert.equal(clip.clipOut, 5, 'the preview lands where the release lands');
  writeClipRange({ out: Math.max(clip.clipIn, Math.min(t, dur)) }, dur);
  assert.equal(clip.clipOut, 5);

  reset();
  writeClipRange({ in: 5, out: 20 }, dur);
  writeClipRange({ in: Math.max(0, Math.min(9, clip.clipOut ?? dur)) }, dur);
  assert.equal(clip.clipIn, 9);
  assert.equal(clip.clipOut, 20);
});

test('a range ends on the last frame the transport steps to', () => {
  assert.deepEqual(rangeFrames({ in: 0, out: 0.99 }, 10, 30), { from: 0, to: 29 }, '0.99 s at 30 fps stops before 1.0 s');
  assert.deepEqual(rangeFrames({ in: 0, out: 1 }, 10, 30), { from: 0, to: 30 }, 'an out point on the grid is its own frame');
  assert.deepEqual(rangeFrames({ in: 0.98, out: null }, 9.43, 30), { from: 29, to: 282 }, 'the in point rounds to where a seek lands');
  for (const fps of [24, 30, 60, 120]) {
    const last = Math.floor(100 * fps);
    for (let i = 0; i <= 2000; i++) {
      const out = i * 0.0499;
      const { from, to } = rangeFrames({ in: 0, out }, 100, fps);
      assert.ok(from <= to && to <= last);
      assert.ok(!pastOutPoint(to / fps, out), `${fps} fps, out ${out}: frame ${to} is past the out point`);
      assert.ok(to === last || pastOutPoint((to + 1) / fps, out), `${fps} fps, out ${out}: frame ${to + 1} is not past it either`);
    }
  }
});
