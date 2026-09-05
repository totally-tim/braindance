// The scalar curve maths, called directly. It supplements the proof tools rather than
// replacing any of them: what it catches that a rendered frame cannot is the edge case a
// frame never visits - a single key, coincident keys, a query outside the track.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EASE_OUT_LINEAR, EASE_IN_LINEAR, SEGMENT_POINT_CEILING, easeAt, easeParam, elevate,
  keyBefore, HOLD_ENDS, scalarAt, stepAt, hermite, tangentAt, foldRefusal, foldFreeX,
} from '../web/curve.js';

/** A key as the tracks build one: a time, a value, and the two handles around it. */
const key = (t, value) => ({ t, value, easeOut: EASE_OUT_LINEAR, easeIn: EASE_IN_LINEAR });
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('keyBefore answers -1 before the first key rather than 0', () => {
  const keys = [key(1, 10), key(2, 20)];
  assert.equal(keyBefore(keys, 0.5), -1);
  assert.equal(keyBefore(keys, 1), 0);
  assert.equal(keyBefore(keys, 1.5), 0);
  assert.equal(keyBefore(keys, 9), 1);
});

test('a linear ease is the identity, which is what makes it the default handle', () => {
  for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    assert.ok(near(easeAt(EASE_OUT_LINEAR, EASE_IN_LINEAR, x), x, 1e-6),
      `eased ${x} to ${easeAt(EASE_OUT_LINEAR, EASE_IN_LINEAR, x)}`);
  }
});

test('easeParam pins both ends exactly, so a segment starts and finishes on its keys', () => {
  assert.ok(near(easeParam(EASE_OUT_LINEAR, EASE_IN_LINEAR, 0), 0, 1e-6));
  assert.ok(near(easeParam(EASE_OUT_LINEAR, EASE_IN_LINEAR, 1), 1, 1e-6));
});

test('linear is the identity at every degree, so `lin` still means unshaped', () => {
  const diagonals = [
    [[[1 / 3, 1 / 3]], [[2 / 3, 2 / 3]]],
    [[[0.2, 0.2], [0.4, 0.4]], [[0.6, 0.6], [0.8, 0.8]]],
    [[[0.1, 0.1]], [[0.5, 0.5], [0.7, 0.7], [0.9, 0.9]]],
  ];
  for (const [out, inn] of diagonals) {
    let worst = 0;
    for (let i = 0; i <= 1000; i++) worst = Math.max(worst, Math.abs(easeAt(out, inn, i / 1000) - i / 1000));
    assert.ok(worst < 1e-9, `out ${JSON.stringify(out)} in ${JSON.stringify(inn)} drifted ${worst}`);
  }
});

test('the quintic glide IS 6u^5-15u^4+10u^3, which is what makes it C2 rather than nearly', () => {
  const out = [[0.2, 0], [0.4, 0]];
  const inn = [[0.6, 1], [0.8, 1]];
  let worst = 0;
  for (let i = 0; i <= 10000; i++) {
    const u = i / 10000;
    worst = Math.max(worst, Math.abs(easeAt(out, inn, u) - u * u * u * (10 - 15 * u + 6 * u * u)));
  }
  assert.ok(worst < 1e-12, `glide departs the quintic smoothstep by ${worst}`);
});

test('the glide brings acceleration to zero at both ends and the cubic smooth does not', () => {
  // Acceleration measured the way a camera feels it: the second difference of the eased
  // fraction just inside each end.
  const accel = (out, inn, x) => {
    const h = 1e-3;
    return (easeAt(out, inn, x + h) - 2 * easeAt(out, inn, x) + easeAt(out, inn, x - h)) / (h * h);
  };
  const smoothStart = Math.abs(accel([[0.42, 0]], [[0.58, 1]], 2e-3));
  const glideStart = Math.abs(accel([[0.2, 0], [0.4, 0]], [[0.6, 1], [0.8, 1]], 2e-3));
  assert.ok(smoothStart > 1, `the cubic smooth should still step in acceleration, got ${smoothStart}`);
  assert.ok(glideStart < smoothStart / 10,
    `the glide should arrive far flatter: cubic ${smoothStart}, quintic ${glideStart}`);
});

test('elevate adds a control point without moving the curve, which is why +pt is safe', () => {
  const shapes = [
    [EASE_OUT_LINEAR, EASE_IN_LINEAR],
    [[[0.42, 0]], [[0.58, 1]]],
    [[[0.2, 0], [0.4, 0]], [[0.6, 1], [0.8, 1]]],
    [[[0.9, 0.15]], [[0.1, 0.85]]],
  ];
  for (const [out, inn] of shapes) {
    for (const side of ['easeOut', 'easeIn']) {
      const up = elevate(out, inn, side);
      assert.equal(up.easeOut.length + up.easeIn.length, out.length + inn.length + 1);
      assert.equal(up[side].length, (side === 'easeOut' ? out : inn).length + 1,
        'the side that was pressed is the side that grew');
      let worst = 0;
      for (let i = 0; i <= 2000; i++) {
        const x = i / 2000;
        worst = Math.max(worst, Math.abs(easeAt(up.easeOut, up.easeIn, x) - easeAt(out, inn, x)));
      }
      assert.ok(worst < 1e-9,
        `elevating ${side} of ${JSON.stringify([out, inn])} moved the curve by ${worst}`);
    }
  }
});

test('elevating repeatedly to the ceiling still does not move the curve', () => {
  let out = [[0.42, 0]];
  let inn = [[0.58, 1]];
  const sample = (o, i2) => Array.from({ length: 501 }, (_, i) => easeAt(o, i2, i / 500));
  const before = sample(out, inn);
  while (out.length < SEGMENT_POINT_CEILING) {
    ({ easeOut: out, easeIn: inn } = elevate(out, inn, 'easeOut'));
  }
  const after = sample(out, inn);
  const worst = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
  assert.equal(out.length, SEGMENT_POINT_CEILING);
  assert.ok(worst < 1e-9, `walking to the ceiling moved the curve by ${worst}`);
});

test('scalarAt returns a key\'s own value at that key\'s time', () => {
  const keys = [key(0, 5), key(1, 9), key(2, -3)];
  assert.ok(near(scalarAt(keys, 0, HOLD_ENDS), 5));
  assert.ok(near(scalarAt(keys, 1, HOLD_ENDS), 9));
  assert.ok(near(scalarAt(keys, 2, HOLD_ENDS), -3));
});

test('scalarAt interpolates monotonically between two rising keys', () => {
  const keys = [key(0, 0), key(1, 10)];
  let last = -Infinity;
  for (let t = 0; t <= 1.00001; t += 0.05) {
    const v = scalarAt(keys, t, HOLD_ENDS);
    assert.ok(v >= last - 1e-9, `value fell at t=${t}: ${v} after ${last}`);
    assert.ok(v >= -1e-9 && v <= 10 + 1e-9, `value left the span at t=${t}: ${v}`);
    last = v;
  }
});

test('a query outside the track holds the outer values rather than extending the slope', () => {
  const keys = [key(1, 10), key(2, 20)];
  assert.ok(near(scalarAt(keys, -5, HOLD_ENDS), 10));
  assert.ok(near(scalarAt(keys, 99, HOLD_ENDS), 20));
});

test('a single key answers with its value everywhere, and no keys answers 0', () => {
  assert.equal(scalarAt([key(4, 7)], 0, HOLD_ENDS), 7);
  assert.equal(scalarAt([key(4, 7)], 99, HOLD_ENDS), 7);
  assert.equal(scalarAt([], 0, HOLD_ENDS), 0);
});

test('coincident keys give the later value rather than dividing by zero', () => {
  const keys = [key(1, 10), key(1, 20)];
  const v = scalarAt(keys, 1, HOLD_ENDS);
  assert.ok(Number.isFinite(v), `expected a number, got ${v}`);
  assert.equal(v, 20);
});

test('stepAt holds the earlier value across a segment and never interpolates', () => {
  const keys = [key(0, 0), key(1, 1)];
  assert.equal(stepAt(keys, 0), 0);
  assert.equal(stepAt(keys, 0.99), 0);
  assert.equal(stepAt(keys, 1), 1);
  assert.equal(stepAt(keys, -1), 0, 'before the first key it holds the first value');
});

test('hermite lands on its endpoints, so a segment meets the keys it spans', () => {
  assert.ok(near(hermite(0, 10, 0, 0, 1, 0), 0, 1e-9));
  assert.ok(near(hermite(0, 10, 0, 0, 1, 1), 10, 1e-9));
});

const pose = (t, x) => ({ t, value: { position: [x, 0, 0] } });

test('tangentAt mirrors the missing neighbour a segment outside, not on top of the end key', () => {
  const keys = [pose(0, 0), pose(1, 3), pose(2, 4)];
  assert.ok(near(tangentAt(keys, 0, 0), 3 / 2, 1e-9), 'half the first segment\'s average velocity');
  assert.ok(near(tangentAt(keys, 2, 0), 1 / 2, 1e-9), 'and half the last segment\'s');
  assert.ok(near(tangentAt(keys, 1, 0), 4 / 2, 1e-9));
});

test('tangentAt divides by neighbour time, so uneven spacing is not read as an index', () => {
  const tight = [pose(0, 0), pose(0.2, 3), pose(3.2, 4)];
  const even = [pose(0, 0), pose(1.6, 3), pose(3.2, 4)];
  assert.ok(near(tangentAt(tight, 1, 0), 4 / 3.2, 1e-9));
  assert.ok(near(tangentAt(even, 1, 0), 4 / 3.2, 1e-9));
  assert.ok(near(tangentAt(tight, 0, 0), 3 / 0.4, 1e-9));
  assert.ok(near(tangentAt(even, 0, 0), 3 / 3.2, 1e-9));
});

test('a linear ease composed into a segment is the identity, which is why the default renders as it did', () => {
  let worst = 0;
  for (let i = 0; i <= 1000; i++) {
    const u = i / 1000;
    worst = Math.max(worst, Math.abs(easeAt(EASE_OUT_LINEAR, EASE_IN_LINEAR, u) - u));
  }
  assert.ok(worst <= 4e-16, `worst departure from the identity was ${worst}`);
  assert.equal(easeAt(EASE_OUT_LINEAR, EASE_IN_LINEAR, 0), 0);
  assert.equal(easeAt(EASE_OUT_LINEAR, EASE_IN_LINEAR, 1), 1);
});

test('an eased u traverses the same points, so shaping the timing cannot move the path', () => {
  const keys = [pose(0, 0), pose(1, 3), pose(2, 4)];
  const raw = (u) => hermite(0, 3, tangentAt(keys, 0, 0), tangentAt(keys, 1, 0), 1, u);
  const eased = (u) => raw(easeAt([[0.42, 0]], [[0.58, 1]], u));
  for (let i = 0; i <= 100; i++) {
    const u = i / 100;
    const v = eased(u);
    assert.ok(v >= Math.min(raw(0), raw(1)) - 1e-9 && v <= Math.max(raw(0), raw(1)) + 1e-9,
      `eased sample ${v} left the raw curve's span at u=${u}`);
  }
  assert.ok(near(eased(0), raw(0), 1e-9));
  assert.ok(near(eased(1), raw(1), 1e-9));
  assert.ok(!near(eased(0.25), raw(0.25), 1e-6),
    `a smooth ease left the quarter point where linear put it: ${eased(0.25)}`);
  assert.ok(near(eased(0.5), raw(0.5), 1e-9),
    'and the midpoint of a symmetric ease is where it started, which is why it is not the probe');
});

test('foldRefusal accepts the legal crossed polygon elevate produces, and its source', () => {
  assert.equal(foldRefusal([[0.9, 0.1]], [[0.1, 0.9]]), null);
  const el = elevate([[0.9, 0.1]], [[0.1, 0.9]], 'easeOut');
  assert.equal(foldRefusal(el.easeOut, el.easeIn), null);
});

test('foldRefusal refuses a fold that ascends within each side, which per-side ordering cannot see', () => {
  const why = foldRefusal([[0.9, 0]], [[0.05, 0.5], [0.1, 1]]);
  assert.ok(why !== null && /folds/.test(why), `expected a fold refusal, got ${why}`);
});

test('foldRefusal accepts a plateau, because a stall is a hold rather than a fold', () => {
  assert.equal(foldRefusal([[0.5, 0.2], [0.5, 0.8]], EASE_IN_LINEAR), null);
  assert.equal(foldRefusal(EASE_OUT_LINEAR, EASE_IN_LINEAR), null);
});

test('elevation never turns an accepted segment into a refused one', () => {
  let a = [[0.9, 0.1]];
  let b = [[0.1, 0.9]];
  while (a.length < SEGMENT_POINT_CEILING && b.length < SEGMENT_POINT_CEILING) {
    const side = a.length <= b.length ? 'easeOut' : 'easeIn';
    ({ easeOut: a, easeIn: b } = elevate(a, b, side));
    assert.equal(foldRefusal(a, b), null,
      `elevation to ${a.length}+${b.length} control points turned a legal segment into a refused one`);
  }
});

test('foldFreeX holds the line a drag cannot: no sequence of clamped moves folds a segment', () => {
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const clone = (h) => h.map((p) => [p[0], p[1]]);
  let el = elevate([[0.9, 0.1]], [[0.1, 0.9]], 'easeOut');
  el = elevate(el.easeOut, el.easeIn, 'easeIn');
  const starts = [
    { out: [EASE_OUT_LINEAR[0]], inn: [EASE_IN_LINEAR[0]] },
    { out: [[0.9, 0.1]], inn: [[0.1, 0.9]] },
    { out: clone(el.easeOut), inn: clone(el.easeIn) },
  ];
  let unguarded = 0;
  for (let trial = 0; trial < 200 && !unguarded; trial++) {
    const out = clone(starts[2].out);
    const inn = clone(starts[2].inn);
    for (let step = 0; step < 40; step++) {
      const onOut = rnd() < 0.5;
      const list = onOut ? out : inn;
      const index = Math.floor(rnd() * list.length);
      list[index][0] = rnd();
      if (foldRefusal(out, inn)) { unguarded++; break; }
    }
  }
  assert.ok(unguarded > 0, 'the unguarded adversary never folded, so the guarded run below asks nothing');
  for (const start of starts) {
    for (let trial = 0; trial < 300; trial++) {
      const out = clone(start.out);
      const inn = clone(start.inn);
      for (let step = 0; step < 40; step++) {
        const onOut = rnd() < 0.5;
        const side = onOut ? 'easeOut' : 'easeIn';
        const list = onOut ? out : inn;
        const index = Math.floor(rnd() * list.length);
        list[index][0] = foldFreeX(out, inn, side, index, list[index][0], rnd());
        assert.equal(foldRefusal(out, inn), null,
          `a clamped move folded the segment: ${JSON.stringify({ out, inn })}`);
      }
    }
  }
});
