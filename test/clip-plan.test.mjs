import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_MAX, RATE_MIN, clipAffordedSec, clipProgramSecAt, clipSourceSecAt, frameLoadByTake,
  framesBackFor, headFramesFor, headTrim, integerMidpoint, rescaleClipKeys, snapshotClipKeys,
  usableClipRate,
} from '../web/clip-plan.js';

test('bisection midpoints stay inside safe-integer intervals above the signed 32-bit range', () => {
  assert.equal(integerMidpoint(2_900_000_000, 3_000_000_000), 2_950_000_000);
  assert.equal(integerMidpoint(2_900_000_000, 3_000_000_000, true), 2_950_000_000);
  assert.equal(integerMidpoint(3_000_000_000, 3_000_000_001), 3_000_000_000);
  assert.equal(integerMidpoint(3_000_000_000, 3_000_000_001, true), 3_000_000_001);
});

test('a large-frame cache bisection converges on its first fitting frame', () => {
  const firstFit = 3_000_001_461;
  let lo = 2_999_999_100;
  let hi = 3_000_002_100;
  let turns = 0;
  while (lo < hi && turns < 64) {
    const mid = integerMidpoint(lo, hi);
    if (mid >= firstFit) hi = mid;
    else lo = mid + 1;
    turns++;
  }
  assert.equal(lo, firstFit);
  assert.ok(turns < 64, `${turns} turns did not converge`);
});

test('shared-take cache demand counts each requested frame once', () => {
  const take = {};
  const other = {};
  const load = frameLoadByTake([
    { take, from: 10, to: 20 },
    { take, from: 15, to: 25 },
    { take, from: 40, to: 42 },
    { take: other, from: 0, to: 1 },
  ]);
  assert.equal(load.get(take), 19);
  assert.equal(load.get(other), 2);
});

test('a clip speed change rescales only that clip local keys', () => {
  const clipTracks = [{ keys: [{ t: 2 }, { t: 6 }] }];
  const camera = { keys: [{ t: 12 }] };
  const snapshot = snapshotClipKeys(clipTracks);
  rescaleClipKeys(snapshot, 0.5);
  rescaleClipKeys(snapshot, 0.25);
  assert.deepEqual(clipTracks[0].keys.map((key) => key.t), [0.5, 1.5]);
  assert.equal(camera.keys[0].t, 12);
});

test('stored rates stay inside the same finite range the editor offers', () => {
  assert.equal(usableClipRate(RATE_MIN), true);
  assert.equal(usableClipRate(RATE_MAX), true);
  for (const rate of [0, -1, Number.MIN_VALUE, RATE_MIN - 0.001, RATE_MAX + 0.001, Infinity, NaN]) {
    assert.equal(usableClipRate(rate), false, `${String(rate)} was accepted`);
  }
});

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('a clip maps its own program seconds onto source seconds from its in-point', () => {
  assert.equal(clipSourceSecAt({ speed: 1, sourceStart: 0 }, 3), 3);
  assert.equal(clipSourceSecAt({ speed: 2, sourceStart: 0 }, 3), 6);
  assert.equal(clipSourceSecAt({ speed: 0.5, sourceStart: 4 }, 6), 7);
});

test('clipProgramSecAt inverts clipSourceSecAt at every speed and in-point', () => {
  for (const timing of [
    { speed: 1, sourceStart: 0 }, { speed: 2, sourceStart: 4 }, { speed: 0.25, sourceStart: 9.5 },
  ]) {
    for (const localSec of [0, 0.7, 3, 12.25]) {
      const source = clipSourceSecAt(timing, localSec);
      assert.ok(near(clipProgramSecAt(timing, source), localSec),
        `${localSec}s of ${JSON.stringify(timing)} came back as ${clipProgramSecAt(timing, source)}s`);
    }
  }
});

test('what a clip affords is the footage past its in-point, never a negative length', () => {
  assert.equal(clipAffordedSec({ speed: 2, sourceStart: 0 }, 12), 6);
  assert.equal(clipAffordedSec({ speed: 0.5, sourceStart: 0 }, 12), 24);
  assert.equal(clipAffordedSec({ speed: 1, sourceStart: 4 }, 12), 8);
  // An in-point past the end of the footage affords nothing rather than running backwards.
  assert.equal(clipAffordedSec({ speed: 1, sourceStart: 20 }, 12), 0);
});

test('a head trim moves the in-point later and leaves the footage under the body where it was', () => {
  const clip = { start: 0, sourceStart: 0, speed: 1 };
  const at = 20;
  const before = clipSourceSecAt(clip, at - clip.start);
  const trimmed = { ...clip, ...headTrim(clip, 5, 30, 0.2) };
  assert.ok(near(trimmed.start, 5));
  assert.ok(near(trimmed.sourceStart, 5));
  assert.ok(near(clipSourceSecAt(trimmed, at - trimmed.start), before),
    'the source second under a fixed program position moved');
  assert.ok(near(trimmed.trim, 25), 'the out-point held');
});

test('a head trim at double speed advances the in-point by twice what the head moved', () => {
  const clip = { start: 0, sourceStart: 0, speed: 2 };
  const at = 20;
  const before = clipSourceSecAt(clip, at - clip.start);
  const trimmed = { ...clip, ...headTrim(clip, 5, 30, 0.2) };
  assert.ok(near(trimmed.sourceStart, 10));
  assert.ok(near(clipSourceSecAt(trimmed, at - trimmed.start), before));
});

test('a head trim stops at program zero and at the head of the take', () => {
  // Program zero: a clip at the head of the edit cannot be dragged before it.
  const atZero = headTrim({ start: 0, sourceStart: 0, speed: 1 }, -9, 30, 0.2);
  assert.equal(atZero.start, 0);
  assert.equal(atZero.sourceStart, 0);
  // The head of the take: a clip placed later can come back only as far as its footage reaches.
  const takeFloor = headTrim({ start: 10, sourceStart: 4, speed: 2 }, 0, 30, 0.2);
  assert.ok(near(takeFloor.start, 8), `stopped at ${takeFloor.start}s rather than 8s`);
  assert.equal(takeFloor.sourceStart, 0, 'the in-point landed near zero rather than on it');
});

test('a head trim cannot cross its own out-point, and leaves a clip still wide enough to grab', () => {
  const trimmed = headTrim({ start: 0, sourceStart: 0, speed: 1 }, 99, 30, 0.2);
  assert.ok(near(trimmed.start, 29.8));
  assert.ok(near(trimmed.trim, 0.2));
});

test('a head trim cannot move an extended clip past the end of its footage', () => {
  const trimmed = headTrim(
    { start: 0, sourceStart: 0, speed: 1 },
    15,
    20,
    0.2,
    10,
  );
  assert.ok(near(trimmed.start, 9.8));
  assert.ok(near(trimmed.sourceStart, 9.8));
  assert.ok(near(trimmed.trim, 10.2));
});

test('a trim and a trim back to the head of the take return the in-point to exactly zero', () => {
  const clip = { start: 0, sourceStart: 0, speed: 1.5 };
  const trimmed = { ...clip, ...headTrim(clip, 6, 40, 0.2) };
  assert.ok(trimmed.sourceStart > 0);
  const back = headTrim(trimmed, -3, 40, 0.2);
  assert.equal(back.sourceStart, 0, 'the in-point kept a rounding residue');
  assert.equal(back.start, 0);
});

test('a trim back to the head of the take lands on zero at every speed, not near it', () => {
  // The in-point a clip carries need not have been written at the speed it now runs at: the
  // slider moves a trimmed clip, and a document arrives holding both fields. So the subtraction
  // that walks the head back to the take does not cancel exactly, and either sign is a defect -
  // a positive residue is a clip the surface calls trimmed, and a negative one is refused at the
  // document door.
  for (const speed of [0.1, 0.15, 0.3, 0.35, 0.7, 0.9, 1.1, 1.3, 1.7, 2.3, 3.3, 0.33, 1.23]) {
    for (const sourceStart of [0.1, 0.3, 0.7, 1.3, 2.9, 5.7, 7.796909871244635, 9.1, 12.7]) {
      for (const pad of [0, 3]) {
        // Placed so the head of the take is reachable: a clip whose take floor sits before
        // program zero stops at zero with footage still in front of its in-point, and the
        // in-point it keeps there is a reading rather than a residue.
        const start = sourceStart / speed + pad;
        const back = headTrim({ start, sourceStart, speed }, -99, start + 40, 0.2);
        assert.equal(back.sourceStart, 0,
          `speed ${speed}, in-point ${sourceStart}s, start ${start}s left ${back.sourceStart}`);
      }
    }
  }
});

test('the frames a surface span reaches back over count the span, not the ceiling', () => {
  assert.deepEqual(framesBackFor(2, 0.5, 30, 600), { frames: 8, covered: true });
  assert.deepEqual(framesBackFor(0.5, 0.5, 30, 600), { frames: 30, covered: true });
  assert.deepEqual(framesBackFor(1, 2, 30, 600), { frames: 60, covered: true });
  // The tolerance the walk it replaces carried: 0.1 + 0.2 is 0.30000000000000004 in binary.
  assert.deepEqual(framesBackFor(1, 0.1 + 0.2, 30, 600), { frames: 9, covered: true });
  // A span the ceiling cannot cover answers the ceiling and says so.
  assert.deepEqual(framesBackFor(0.1, 2.1, 30, 618), { frames: 618, covered: false });
  assert.deepEqual(framesBackFor(1, 0, 30, 600), { frames: 0, covered: true });
  assert.deepEqual(framesBackFor(1, -1, 30, 600), { frames: 0, covered: true });
});

test('the frames before its in-point a clip still reaches footage over stop at the take head', () => {
  assert.equal(headFramesFor(1, 2, 30, 600), 60);
  assert.equal(headFramesFor(2, 2, 30, 600), 30);
  assert.equal(headFramesFor(0.5, 2, 30, 600), 120);
  // An untrimmed clip reaches back over nothing: there is no footage before its in-point.
  assert.equal(headFramesFor(1, 0, 30, 600), 0);
  // Bounded by the window it is asked for rather than by the footage alone.
  assert.equal(headFramesFor(1, 100, 30, 12), 12);
});
