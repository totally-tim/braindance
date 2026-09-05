// How a span of program time maps onto positions across the strip, and how far a gesture
// may zoom it.
//
// **It replaced `rulerDuration()` rather than joining it.** Eleven places used to work out
// a position by dividing by the clip's length, and a twelfth that kept doing so under a
// zoomed window would not look broken - it would draw its marker *unzoomed*, at a
// plausible place, silently disagreeing with the eleven around it. Deleting the old name
// is what makes a missed caller a throw on the first paint instead of a wrong picture
// nobody can see is wrong, and putting the object in a file of its own is the same rule
// one step further out: there is one mapping from a program second to a position on the
// strip, and it is imported rather than found.
//
// **The window is held as fractions of the program duration.** This keeps the same footage
// visible when one clip fills the program and a speed change scales that clip uniformly.
// A clip inside a larger edit changes the duration non-uniformly; `main.js` then rebases these
// fractions from the program-second bounds captured at the start of the speed gesture.
//
// **Two readings arrive at construction rather than being reached for, and that is what
// makes the arithmetic testable without a browser.** How long the program currently is,
// and where the ruler's bed sits on screen. Both are suppliers rather than values because
// both move underneath a window that does not: the length is frozen for the duration of a
// lane drag by a rule that belongs to the drag, and the bed's box changes with every
// resize and every splitter move. `main.js` writes both at the one place it builds this,
// and the reason each is what it is lives there, beside the thing it is about.
//
// **What deliberately stayed in `main.js`, against the plan this split was written to.**
// `clipFractionAt` was to come here and did not: it chooses between the overview and the
// ruler by comparing two elements, measures whichever it chose, and its whole comment is
// about why those two surfaces answer the same question differently. `buildRuler` asks this
// file for a width-sized tick set and then builds the elements. Both read this object through the
// same public fields every other caller does - `a`, `b`, `spanSec` - so moving them would
// be moving a DOM function into an arithmetic module on the grounds that it also reads two
// numbers, and it would tear each comment off the elements it is about.

// How little program time the strip will show. A window is bounded below so a wheel
// cannot zoom into a point, where every position on screen is the same instant and the
// gesture that got there has no inverse.
export const MIN_VIEW_SEC = 0.25;

// How much one wheel notch zooms, and one press of the two zoom keys with it. Chosen so a
// notch is a visible step and a flick is not a jump to the bottom of the range: about
// eight notches per factor of ten.
export const ZOOM_PER_NOTCH = 1.33;

// The ladder a ruler picks its spacing from, in seconds. Every rung divides the one
// above it or is half of it, so zooming walks the labels through the ladder instead of
// re-labelling everything on each notch, and the sub-second rungs are the frame-ish
// intervals somebody placing a key actually wants.
export const TICK_STEPS = [
  1 / 30, 1 / 10, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

const RULER_TICK_LIMIT = 500;

/** A width-sized set of ruler ticks, including spans beyond the fixed sub-hour ladder. */
export function rulerTickSeconds(startSec, endSec, wantedSec) {
  const top = TICK_STEPS[TICK_STEPS.length - 1];
  let step = TICK_STEPS.find((candidate) => candidate >= wantedSec);
  if (step === undefined) {
    const ratio = wantedSec / top;
    const magnitude = 10 ** Math.floor(Math.log10(ratio));
    const multiple = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= ratio) ?? 10;
    const scaled = top * multiple * magnitude;
    step = Number.isFinite(scaled) ? scaled : wantedSec;
  }
  const first = Math.ceil(startSec / step - 1e-9) * step;
  const available = Math.max(0, Math.floor((endSec - first) / step + 1e-9) + 1);
  const count = Math.min(RULER_TICK_LIMIT, available);
  return {
    step,
    seconds: Array.from({ length: count }, (_, index) => first + index * step),
  };
}

/** A tick's label. Bare seconds under a minute, `m:ss` over it, so it reads as a clock. */
export function tickLabel(sec, step) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  if (sec < 60) return `${sec.toFixed(decimals)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}`;
}

/**
 * The window of program time the strip is drawn against, and the only thing that turns
 * a program second into a position on it.
 *
 * A factory rather than an exported object, and the reason is the boundary rather than
 * taste: the two readings above have to be bound to the surface that owns them, and an
 * object exported from here with them already inside would have had to reach back into
 * `main.js` for a transport and a DOM node, which is the ring this tree has no way to
 * evaluate.
 */
export function makeViewWindow({ durationSec, bedRect }) {
  return {
    // The visible window, as fractions of `duration`. `0..1` is the whole clip.
    a: 0,
    b: 1,
    // And the window that was *asked* for, which is what the limits are re-derived from -
    // see `set`. These two are equal except while a clamp is binding.
    wantA: 0,
    wantB: 1,

    /**
     * The program length the ruler is drawn against, floored so every division below it
     * stays finite - including the one a caller makes before a take is open.
     *
     * Handed in rather than read, because what counts as the length is a question this
     * file cannot answer: it is the transport's, except while a lane drag is holding it
     * still. The reason it is held still is written on the supplier, beside the drag it
     * is about.
     */
    get duration() { return Math.max(1e-6, durationSec()); },

    get startSec() { return this.a * this.duration; },
    get endSec() { return this.b * this.duration; },
    get spanSec() { return (this.b - this.a) * this.duration; },
    /** True when the whole clip is on screen, which is what the fit control returns to. */
    get whole() { return this.a === 0 && this.b === 1; },

    /** Where a program second sits across the bed, in percent. Off-window is out of 0..100. */
    pct(t) {
      return ((t / this.duration) - this.a) / Math.max(1e-9, this.b - this.a) * 100;
    },

    /** Program seconds at a percentage across the bed. The inverse of `pct`. */
    secAtPct(p) {
      return (this.a + (p / 100) * (this.b - this.a)) * this.duration;
    },

    /** Where the pointer is, in program seconds, clamped to the window it is over. */
    timeAt(clientX) {
      const r = bedRect();
      const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
      return Math.max(0, Math.min(this.duration, (this.a + f * (this.b - this.a)) * this.duration));
    },

    /**
     * Whether a marker at `t` is worth drawing. The margin is a whole window because a
     * curve is sampled across the visible span and a key's node is 11px wide - a marker
     * just outside still has a corner inside, and hiding it would pop at the edge.
     */
    holds(t) {
      const f = t / this.duration;
      const margin = (this.b - this.a) * 0.02;
      return f >= this.a - margin && f <= this.b + margin;
    },

    /**
     * The narrowest window allowed here, as a fraction of the clip.
     *
     * Named rather than recomputed by each caller, because the edge drag needs the same
     * number `set` clamps with and a second copy of it would be a second answer.
     */
    minSpan() { return Math.min(1, MIN_VIEW_SEC / this.duration); },

    /**
     * The window, clamped: inside the clip, no narrower than `MIN_VIEW_SEC`, at most all.
     *
     * **What was asked for is kept beside what the clamp allowed, and the clamp is
     * re-derived rather than accumulated.** `minSpan` is a number of seconds expressed as
     * a fraction, so it moves whenever the clip's length does - and a clamp applied to its
     * own previous output only ever ratchets outward. Measured: at 0.1x the whole clip is
     * 480s and the minimum window is a fraction of 0.00052; going to 4x makes that 0.00625s
     * of a 12s clip, the clamp widens it to 0.0208, and coming back to 0.1x that fraction
     * is 10s. The document returns exactly, no undo step is committed, and the ruler is
     * forty times wider than it started - which is the one thing the speed control claims
     * not to do.
     *
     * `userLaneHeight` in `main.js` already had the answer, and its comment says why in
     * the same words: store the request, apply the limits on the way out, so a window
     * narrowed by a clip that got shorter opens back up when the clip gets longer again.
     */
    set(a, b) {
      this.wantA = a;
      this.wantB = b;
      return this.reclamp();
    },

    /**
     * Re-applies the limits to the window that was last asked for.
     *
     * Called whenever the duration moves under the window rather than only after a rate
     * gesture, because a rate gesture is not the only thing that moves it - undo across a
     * speed change, a project load and an output-rate change all do, and a fix that lived
     * on the slider would have left three doors open.
     */
    reclamp() {
      const span = Math.min(1, Math.max(this.minSpan(), this.wantB - this.wantA));
      const start = Math.min(1 - span, Math.max(0, this.wantA));
      const moved = start !== this.a || start + span !== this.b;
      this.a = start;
      this.b = start + span;
      return moved;
    },

    /**
     * Zooms by `factor` (>1 closer) holding the fraction `at` where it is on screen.
     *
     * **The clamp is applied here rather than left to `set`, because `set` can only widen
     * the span and would keep the start that went with the narrower one.** At the minimum
     * window, another notch inward asked for a span `set` refused and a start computed for
     * it, so the window kept its width and slid to the right: a gesture that could not zoom
     * panned instead, and the time under the pointer walked away a notch at a time. Deriving
     * the start from the span that actually survives makes a further zoom-in a no-op, which
     * is what a control at the end of its travel should do.
     */
    zoomAbout(at, factor) {
      const span = Math.min(1, Math.max(this.minSpan(), (this.b - this.a) / factor));
      // Where the anchor sits in the window now, kept where it is in the window after.
      const held = (at - this.a) / Math.max(1e-9, this.b - this.a);
      const start = at - held * span;
      return this.set(start, start + span);
    },

    /** Pans by a share of the visible window, positive to the right. */
    panBy(shareOfWindow) {
      const d = (this.b - this.a) * shareOfWindow;
      return this.set(this.a + d, this.b + d);
    },

    fit() { return this.set(0, 1); },
  };
}
