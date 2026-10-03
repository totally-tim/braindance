const EASE_OUT_LINEAR = [[1 / 3, 1 / 3]];
const EASE_IN_LINEAR = [[2 / 3, 2 / 3]];

// Deep copy so edits do not reach into undo snapshots.
const copyHandle = (h) => h.map((p) => [p[0], p[1]]);

const SEGMENT_POINT_CEILING = 4;

/** One control ordinate of a segment's timing curve, by index over the whole list. */
const ctrl = (a, b, k, axis) => {
  if (k === 0) return 0;
  if (k > a.length + b.length) return 1;
  return k <= a.length ? a[k - 1][axis] : b[k - 1 - a.length][axis];
};

const work = new Float64Array(2 * SEGMENT_POINT_CEILING + 2);
const dwork = new Float64Array(2 * SEGMENT_POINT_CEILING + 2);

/** One coordinate of the segment's timing curve at Bezier parameter `u`. */
function bezAxis(a, b, axis, u) {
  const n = 2 + a.length + b.length;
  for (let i = 0; i < n; i++) work[i] = ctrl(a, b, i, axis);
  for (let m = n - 1; m > 0; m--) {
    for (let i = 0; i < m; i++) work[i] += (work[i + 1] - work[i]) * u;
  }
  return work[0];
}

/** The same coordinate's derivative with respect to `u`. */
function bezSlopeAxis(a, b, axis, u) {
  const n = 1 + a.length + b.length;
  for (let i = 0; i < n; i++) {
    dwork[i] = n * (ctrl(a, b, i + 1, axis) - ctrl(a, b, i, axis));
  }
  for (let m = n - 1; m > 0; m--) {
    for (let i = 0; i < m; i++) dwork[i] += (dwork[i + 1] - dwork[i]) * u;
  }
  return dwork[0];
}

/** The Bezier parameter at which the curve's x reaches `x`. */
function easeParam(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const err = bezAxis(a, b, 0, u) - x;
    if (Math.abs(err) < 1e-9) return u;
    const d = bezSlopeAxis(a, b, 0, u);
    if (d < 1e-6) break;
    const next = u - err / d;
    if (!(next > 0 && next < 1)) break;
    u = next;
  }
  let lo = 0;
  let hi = 1;
  u = x;
  for (let i = 0; i < 60; i++) {
    const err = bezAxis(a, b, 0, u) - x;
    if (Math.abs(err) < 1e-12) break;
    if (err > 0) hi = u; else lo = u;
    u = (lo + hi) / 2;
  }
  return u;
}

/** Where in a segment's value range a fraction of the way through it lands. */
function easeAt(a, b, x) {
  return bezAxis(a, b, 1, easeParam(a, b, x));
}

/** The same segment with one more control point on `side`, and the identical curve. */
function elevate(a, b, side) {
  const n = 1 + a.length + b.length;
  const raised = [];
  for (let i = 1; i <= n; i++) {
    const w = i / (n + 1);
    raised.push([0, 1].map((axis) => w * ctrl(a, b, i - 1, axis) + (1 - w) * ctrl(a, b, i, axis)));
  }
  const cut = side === 'easeOut' ? a.length + 1 : a.length;
  return { easeOut: raised.slice(0, cut), easeIn: raised.slice(cut) };
}

/** The last key at or before `t`, or -1 when `t` sits before every key. */
function keyBefore(keys, t) {
  let lo = 0;
  let hi = keys.length - 1;
  if (hi < 0 || t < keys[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const HOLD_ENDS = 'hold';

function scalarAt(keys, t, ends) {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1) return keys[0].value;
  const i = keyBefore(keys, t);
  if (i < 0) return keys[0].value;
  if (i >= n - 1) return keys[n - 1].value;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.value;
  return a.value + (b.value - a.value) * easeAt(a.easeOut, b.easeIn, (t - a.t) / span);
}

function stepAt(keys, t) {
  const i = keyBefore(keys, t);
  return keys[i < 0 ? 0 : i].value;
}

function hermite(p0, p1, m0, m1, span, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * p0 + h10 * span * m0 + h01 * p1 + h11 * span * m1;
}

/** The tangent at key `i`, in metres per program second. */
function tangentAt(keys, i, axis) {
  const n = keys.length;
  const at = (k) => (k < 0
    ? { t: 2 * keys[0].t - keys[1].t, value: keys[0].value }
    : (k > n - 1
      ? { t: 2 * keys[n - 1].t - keys[n - 2].t, value: keys[n - 1].value }
      : keys[k]));
  const lo = at(i - 1);
  const hi = at(i + 1);
  const span = hi.t - lo.t;
  if (span <= 0) return 0;
  return (hi.value.position[axis] - lo.value.position[axis]) / span;
}


/** Whether a handle is one this evaluator can be asked to render, and why not if not. */
function handleRefusal(points, loY, hiY) {
  for (const [x, y] of points) {
    if (!(x >= 0 && x <= 1)) {
      return `a control point at x=${x}, outside the segment it shapes - the timing curve `
        + 'is a function of time within the segment, so a point past either end makes it '
        + 'fold back and run the value backwards through part of the move';
    }
    if (!(y >= loY && y <= hiY)) {
      return `a control point at y=${y}, outside the [${loY}, ${hiY}] this kind of track allows`;
    }
  }
  return null;
}

/** Whether a segment's timing curve folds, and a sentence naming where when it does. */
function foldRefusal(a, b) {
  const n = 1 + a.length + b.length;
  const d = [];
  for (let i = 0; i < n; i++) d.push(n * (ctrl(a, b, i + 1, 0) - ctrl(a, b, i, 0)));
  const witness = (coef, lo, hi, depth) => {
    if (coef.every((c) => c >= -1e-9)) return null;
    if (coef[0] < -1e-9) return lo;
    if (coef[coef.length - 1] < -1e-9) return hi;
    if (depth === 0) return null;
    const mid = (lo + hi) / 2;
    const left = [];
    const right = [];
    const level = [...coef];
    for (let m = level.length; m > 0; m--) {
      left.push(level[0]);
      right.push(level[m - 1]);
      for (let i = 0; i + 1 < m; i++) level[i] = (level[i] + level[i + 1]) / 2;
    }
    return witness(left, lo, mid, depth - 1) ?? witness(right.reverse(), mid, hi, depth - 1);
  };
  const u = witness(d, 0, 1, 40);
  if (u === null) return null;
  const slope = bezSlopeAxis(a, b, 0, u);
  return `a timing curve that folds - its x runs backwards near ${Math.round(u * 100)}% of the way `
    + `through the segment (dx/du ${slope.toFixed(2)}) - so the bisection that samples it still `
    + 'terminates and the move renders at the wrong times rather than failing';
}

/** How far a control point's x may move toward `to` before the segment folds. */
function foldFreeX(a, b, side, index, from, to) {
  const probe = (x) => {
    const list = (side === 'easeOut' ? a : b).map((p) => [p[0], p[1]]);
    list[index] = [x, list[index][1]];
    return foldRefusal(side === 'easeOut' ? list : a, side === 'easeOut' ? b : list) === null;
  };
  if (probe(to)) return to;
  if (!probe(from)) return to;
  let good = from;
  let bad = to;
  for (let i = 0; i < 30; i++) {
    const mid = (good + bad) / 2;
    if (probe(mid)) good = mid; else bad = mid;
  }
  return good;
}

export {
  handleRefusal,
  foldRefusal,
  foldFreeX,
  EASE_OUT_LINEAR,
  EASE_IN_LINEAR,
  SEGMENT_POINT_CEILING,
  copyHandle,
  easeParam,
  easeAt,
  elevate,
  keyBefore,
  HOLD_ENDS,
  scalarAt,
  stepAt,
  hermite,
  tangentAt,
};
