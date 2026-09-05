export const RATE_MIN = 0.1;
export const RATE_MAX = 4;

export function usableClipRate(value) {
  return Number.isFinite(value) && value >= RATE_MIN && value <= RATE_MAX;
}

/** The lower or upper integer midpoint of an inclusive safe-integer interval. */
export function integerMidpoint(lo, hi, upper = false) {
  return lo + Math.floor((hi - lo + (upper ? 1 : 0)) / 2);
}

/** Counts the union of inclusive frame ranges requested from each take. */
export function frameLoadByTake(spans) {
  const ranges = new Map();
  for (const span of spans) {
    const list = ranges.get(span.take) ?? [];
    list.push([span.from, span.to]);
    ranges.set(span.take, list);
  }

  const loads = new Map();
  for (const [take, list] of ranges) {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let frames = 0;
    let from = null;
    let to = null;
    for (const [nextFrom, nextTo] of list) {
      if (from === null) {
        from = nextFrom;
        to = nextTo;
      } else if (nextFrom <= to + 1) {
        to = Math.max(to, nextTo);
      } else {
        frames += to - from + 1;
        from = nextFrom;
        to = nextTo;
      }
    }
    if (from !== null) frames += to - from + 1;
    loads.set(take, frames);
  }
  return loads;
}

export const snapshotClipKeys = (tracks) => [...tracks]
  .flatMap((track) => track.keys.map((key) => [key, key.t]));

/** Rescales clip-local key times around a pivot when the clip's speed changes. */
export function rescaleClipKeys(snapshot, factor, pivot = 0) {
  for (const [key, time] of snapshot) key.t = pivot + (time - pivot) * factor;
}

/** The source second a clip's own program second lands on, from its in-point at its speed. */
export function clipSourceSecAt({ speed, sourceStart }, localSec) {
  return sourceStart + localSec * speed;
}

/** Where a source second sits in the clip's own program time, which runs the map backwards. */
export function clipProgramSecAt({ speed, sourceStart }, sourceSec) {
  return (sourceSec - sourceStart) / speed;
}

/** How much program time the footage past a clip's in-point makes at its speed. */
export function clipAffordedSec(timing, sourceDurationSec) {
  return Math.max(0, clipProgramSecAt(timing, sourceDurationSec));
}

/**
 * Moves a clip's head to `wantStart`, answering its new placement, in-point and trim.
 *
 * Two floors - the head of the edit and the head of the take - and a ceiling that leaves a clip
 * still wide enough to grab. The footage under what is left holds still by construction: the
 * in-point moves by exactly the program time the head crossed, read at the clip's speed.
 */
export function headTrim(
  { start, sourceStart, speed },
  wantStart,
  holdEnd,
  minLengthSec,
  sourceDurationSec = Infinity,
) {
  const takeFloor = start - sourceStart / speed;
  // A tail can extend beyond the take and hold its last frame. Keep a head drag out of that held
  // region, or it can serialise an in-point that the document door must refuse on reload.
  const takeCeiling = Number.isFinite(sourceDurationSec)
    ? start + Math.max(0, (sourceDurationSec - sourceStart) / speed - minLengthSec)
    : Infinity;
  const newStart = Math.max(0,
    Math.max(takeFloor, Math.min(holdEnd - minLengthSec, takeCeiling, wantStart)));
  const moved = sourceStart + (newStart - start) * speed;
  // Landed on the head of the take rather than near it: the residue of the subtraction above
  // would otherwise be refused as a negative in-point by the document door.
  return {
    start: newStart,
    sourceStart: Math.max(0, Math.abs(moved) < 1e-9 ? 0 : moved),
    trim: Math.max(minLengthSec, holdEnd - newStart),
  };
}

/**
 * How many output frames back a clip reaches to cover `sourceSpanSec` of footage, and whether
 * `ceiling` frames were enough to cover it.
 */
export function framesBackFor(speed, sourceSpanSec, fps, ceiling) {
  if (!(sourceSpanSec > 0)) return { frames: 0, covered: true };
  const limit = Math.max(0, Math.floor(ceiling));
  const n = Math.max(1, Math.ceil(((sourceSpanSec - 1e-9) * fps) / speed));
  return { frames: Math.min(n, limit), covered: n <= limit };
}

/** How many output frames before its in-point a clip still reaches footage over. */
export function headFramesFor(speed, sourceStart, fps, limit) {
  return Math.max(0, Math.min(limit, Math.floor((sourceStart * fps) / speed)));
}
