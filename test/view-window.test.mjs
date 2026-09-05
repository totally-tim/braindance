// The window of program time the strip is drawn against, driven directly. Two of the rows
// carry the pre-fix arithmetic longhand beside them: without it they would compare the module
// against itself, and a zoom that did nothing at all would pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_VIEW_SEC, ZOOM_PER_NOTCH, TICK_STEPS, rulerTickSeconds, tickLabel, makeViewWindow,
} from '../web/view-window.js';

/** A window over a program of `sec` seconds, on a bed 1000px wide starting at x=100. The
 *  length is a plain box here so a speed change is a single assignment. */
const windowOver = (sec) => {
  const state = { sec, rect: { left: 100, width: 1000 } };
  const view = makeViewWindow({
    durationSec: () => state.sec,
    bedRect: () => state.rect,
  });
  return { view, state };
};

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('the ladder every rung of a ruler comes off divides the rung above it', () => {
  for (let i = 1; i < TICK_STEPS.length; i++) {
    const ratio = TICK_STEPS[i] / TICK_STEPS[i - 1];
    assert.ok(ratio > 1, `rung ${i} (${TICK_STEPS[i]}) does not climb from ${TICK_STEPS[i - 1]}`);
    assert.ok(near(ratio, Math.round(ratio), 1e-9) || near(ratio, 1.5, 1e-9) || near(ratio, 2.5, 1e-9),
      `rung ${TICK_STEPS[i]} is ${ratio} of ${TICK_STEPS[i - 1]}, which is neither a whole multiple nor one of the two half-steps the ladder uses`);
  }
});

test('a tick reads as a clock over a minute and as seconds under one', () => {
  assert.equal(tickLabel(5, 1), '5s');
  assert.equal(tickLabel(0.5, 0.5), '0.5s');
  assert.equal(tickLabel(1 / 30, 1 / 30), '0.03s');
  assert.equal(tickLabel(90, 30), '1:30');
  assert.equal(tickLabel(90.5, 0.5), '1:30.5');
  assert.equal(tickLabel(3600, 600), '60:00');
});

test('a ruler over an enormous finite program still builds a width-sized increasing set', () => {
  const { step, seconds } = rulerTickSeconds(0, 1e20, 1e19);
  assert.ok(step >= 1e19, `${step} does not cover the wanted spacing`);
  assert.ok(seconds.length > 1 && seconds.length < 20, `${seconds.length} ticks`);
  assert.ok(seconds.every((sec, index) => index === 0 || sec > seconds[index - 1]),
    seconds.join(', '));
  assert.ok(seconds.at(-1) <= 1e20, `${seconds.at(-1)} exceeds the program`);
});

test('a wheel notch is about eight to a factor of ten, which is what the constant claims', () => {
  const notches = Math.log(10) / Math.log(ZOOM_PER_NOTCH);
  assert.ok(notches > 7 && notches < 9, `${notches.toFixed(2)} notches per decade`);
});

test('a position and a time are inverses of each other, under a window that is not the whole clip', () => {
  const { view } = windowOver(60);
  view.set(0.25, 0.4);
  for (const p of [0, 12.5, 50, 87.5, 100]) {
    assert.ok(near(view.pct(view.secAtPct(p)), p, 1e-9), `${p}% -> ${view.secAtPct(p)}s -> ${view.pct(view.secAtPct(p))}%`);
  }
  assert.ok(near(view.pct(view.startSec), 0));
  assert.ok(near(view.pct(view.endSec), 100));
  assert.ok(near(view.spanSec, 0.15 * 60, 1e-9), `${view.spanSec}`);
});

test('the pointer reads through the window rather than through the clip', () => {
  const { view } = windowOver(60);
  view.set(0.5, 0.75);
  assert.ok(near(view.timeAt(100), 30), `${view.timeAt(100)}`);
  assert.ok(near(view.timeAt(600), 37.5), `${view.timeAt(600)}`);
  assert.ok(near(view.timeAt(1100), 45), `${view.timeAt(1100)}`);
  assert.equal(view.timeAt(-500), 30);
  assert.equal(view.timeAt(9000), 45);
});

test('a window is never narrower than MIN_VIEW_SEC, however many notches ask', () => {
  const { view } = windowOver(60);
  for (let i = 0; i < 40; i++) view.zoomAbout(0.5, ZOOM_PER_NOTCH);
  assert.ok(near(view.spanSec, MIN_VIEW_SEC, 1e-9), `${view.spanSec}s against a floor of ${MIN_VIEW_SEC}s`);
  const short = windowOver(0.1);
  for (let i = 0; i < 40; i++) short.view.zoomAbout(0.5, ZOOM_PER_NOTCH);
  assert.ok(short.view.whole, `${short.view.a}..${short.view.b}`);
});

test('a notch at the minimum window does nothing rather than panning', () => {
  const { view } = windowOver(60);
  for (let i = 0; i < 40; i++) view.zoomAbout(0.5, ZOOM_PER_NOTCH);
  const at = { a: view.a, b: view.b };
  const moved = view.zoomAbout(0.5, ZOOM_PER_NOTCH);
  assert.equal(moved, false, `the window reported moving from ${at.a} to ${view.a}`);
  assert.ok(near(view.a, at.a) && near(view.b, at.b), `${at.a}..${at.b} -> ${view.a}..${view.b}`);

  // The pre-fix arithmetic: the span taken without the clamp, and the start derived from the
  // factor rather than from the span that survives - so a gesture that could not zoom pans.
  const anchor = 0.5;
  const wouldBeSpan = (at.b - at.a) / ZOOM_PER_NOTCH;
  const wouldBeStart = anchor - (anchor - at.a) / ZOOM_PER_NOTCH;
  const { view: other } = windowOver(60);
  other.set(wouldBeStart, wouldBeStart + wouldBeSpan);
  assert.ok(!near(other.a, at.a, 1e-12),
    `the pre-fix start lands at ${other.a} where the clamped one holds ${at.a}, so this row is about the clamp`);
});

test('a round trip through two speeds comes back to the same window', () => {
  const { view, state } = windowOver(480);
  view.zoomAbout(0.5, 1e9);
  const asked = { a: view.wantA, b: view.wantB };
  assert.ok(near(view.spanSec, MIN_VIEW_SEC, 1e-9), `${view.spanSec}s at 0.1x`);

  state.sec = 12;
  view.reclamp();
  assert.ok(near(view.spanSec, MIN_VIEW_SEC, 1e-9), `${view.spanSec}s at 4x`);
  assert.ok(view.b - view.a > asked.b - asked.a,
    `the clamp did not bind at 4x, so the trip back proves nothing: ${view.b - view.a} against ${asked.b - asked.a}`);

  state.sec = 480;
  view.reclamp();
  assert.ok(near(view.spanSec, MIN_VIEW_SEC, 1e-9),
    `${view.spanSec}s back at 0.1x, where the window started at ${MIN_VIEW_SEC}s`);
  assert.ok(near(view.a, asked.a, 1e-12) && near(view.b, asked.b, 1e-12),
    `${asked.a}..${asked.b} -> ${view.a}..${view.b}`);

  // The accumulating clamp beside it: it re-asks for what the clamp last allowed rather than
  // for what was wanted, so the widening at 4x survives the trip.
  const ratchet = windowOver(480);
  ratchet.view.zoomAbout(0.5, 1e9);
  const began = ratchet.view.b - ratchet.view.a;
  ratchet.state.sec = 12;
  ratchet.view.set(ratchet.view.a, ratchet.view.b);
  ratchet.state.sec = 480;
  ratchet.view.set(ratchet.view.a, ratchet.view.b);
  assert.ok(ratchet.view.spanSec > MIN_VIEW_SEC * 30,
    `the accumulating clamp came back to ${ratchet.view.spanSec}s, so this row is not about the difference between the two`);
  assert.ok(ratchet.view.b - ratchet.view.a > began * 30,
    `${began} -> ${ratchet.view.b - ratchet.view.a}`);
});

test('a zoom holds the fraction it was given where it already was', () => {
  const { view } = windowOver(100);
  view.set(0.2, 0.8);
  const anchor = 0.35;
  const before = view.pct(anchor * 100);
  view.zoomAbout(anchor, 2);
  assert.ok(near(view.pct(anchor * 100), before, 1e-9),
    `the anchor sat at ${before}% and now sits at ${view.pct(anchor * 100)}%`);
  assert.ok(near(view.b - view.a, 0.3, 1e-12), `${view.b - view.a}`);
});

test('the window stays inside the clip however it is asked to move', () => {
  const { view } = windowOver(100);
  view.set(0.5, 0.7);
  view.panBy(-10);
  assert.ok(view.a >= 0 && view.b <= 1, `${view.a}..${view.b}`);
  assert.ok(near(view.b - view.a, 0.2, 1e-12), 'a pan that hit the edge kept its width');
  view.panBy(10);
  assert.ok(view.a >= 0 && view.b <= 1, `${view.a}..${view.b}`);
  assert.ok(near(view.b, 1, 1e-12), `${view.b}`);
  assert.equal(view.fit(), true);
  assert.ok(view.whole && view.a === 0 && view.b === 1);
  assert.equal(view.fit(), false, 'fitting an already-whole window reports that nothing moved');
});

test('a marker just outside the window is still drawn, because its corner is inside', () => {
  const { view } = windowOver(100);
  view.set(0.4, 0.6);
  assert.equal(view.holds(50), true);
  assert.equal(view.holds(40.5), true);
  assert.equal(view.holds(39.7), true);
  assert.equal(view.holds(35), false);
  assert.equal(view.holds(80), false);
});

test('a window over nothing still divides, which is what the floor is for', () => {
  // `main.js` builds this before a take is open, so the first paint runs before anything
  // guards the divide.
  const { view, state } = windowOver(0);
  assert.ok(Number.isFinite(view.duration) && view.duration > 0, `${view.duration}`);
  assert.ok(Number.isFinite(view.pct(0)) && Number.isFinite(view.secAtPct(50)) && Number.isFinite(view.minSpan()));
  state.sec = -5;
  assert.ok(view.duration > 0, `${view.duration}`);
});
