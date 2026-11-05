// How far back a seek has to start for the mosh pass to land where playback did. The walk is
// the one thing standing between a feedback pass and a timeline that cannot reproduce itself,
// and it is arithmetic over two functions of program time - so it is asked here, under bare
// node, where every input can be moved one at a time.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moshFramesBack, moshRefreshes } from '../web/mosh-pass.js';

const FPS = 30;
const CEILING = 600;

// A look that is up for the whole take, refreshing every 1.2s.
const live = () => 1;
const dead = () => 0;
const period = (seconds) => () => seconds;

test('the walk stops at the nearest frame the pass refreshes on', () => {
  // 1.2s at 30fps is frame 36. A target at frame 40 decodes from frame 36, four back.
  const at = (frame) => moshFramesBack(frame / FPS, FPS, live, period(1.2), CEILING);
  assert.equal(at(40).frames, 4);
  assert.equal(at(40).covered, true);
  // A target that is itself a refresh needs no pre-roll: the pass draws what it was handed.
  assert.equal(at(36).frames, 0);
  assert.equal(at(37).frames, 1);
});

test('a pass that is not up needs no pre-roll at all', () => {
  assert.deepEqual(moshFramesBack(4, FPS, dead, period(1.2), CEILING), { frames: 0, covered: true });
});

test('the frame where the pass came up is a refresh, because its history is black', () => {
  // Up from 3s. A target at 3.4s decodes from the first live frame and no further, whatever the
  // period says - twelve frames rather than the thirty-six a 1.2s period would ask for.
  const upAtThree = (t) => (t >= 3 ? 1 : 0);
  assert.deepEqual(moshFramesBack(3.4, FPS, upAtThree, period(1.2), CEILING),
    { frames: 12, covered: true });
});

test('the head of the take stops the walk rather than running it off the front', () => {
  const back = moshFramesBack(0.2, FPS, live, period(1.2), CEILING);
  assert.equal(back.frames, 6);
  assert.equal(back.covered, true);
});

test('a ceiling the walk runs out of is reported rather than rounded off', () => {
  const back = moshFramesBack(10, FPS, live, period(4), 8);
  assert.deepEqual(back, { frames: 8, covered: false });
});

test('the period keyframes, so the boundary is asked with the value each end had', () => {
  // The same two program positions, under a period that moves between them. Under 1.2s both
  // sides floor to 4; stretched to 2.0 at the near end, the near side floors to 2 and the step
  // is a refresh - which is the whole reason the two values are asked separately.
  assert.equal(moshRefreshes(4.9, 1.2, 5.0, 1.2), false);
  assert.equal(moshRefreshes(4.9, 1.2, 5.0, 2.0), true);
  // A period of zero is not a period: it refreshes every frame rather than dividing by nothing.
  assert.equal(moshRefreshes(4.9, 1.2, 5.0, 0), true);
  assert.equal(moshRefreshes(4.9, 0, 5.0, 1.2), true);
});

test('the walk and the loop ask the same question, so a moved period moves both', () => {
  // A period that steps from 1.2 to 2.0 at 5s. The walk has to find the refresh the loop would
  // have fired, and the loop fires it on the first frame whose own period disagrees with the
  // one before it - here the frame at 5s.
  const stepped = (t) => (t >= 5 ? 2.0 : 1.2);
  const back = moshFramesBack(5.2, FPS, live, stepped, CEILING);
  assert.equal(back.frames, 6, 'six frames back from 5.2s is 5.0s, where the period changed');
  const at = 5.2 - back.frames / FPS;
  assert.ok(moshRefreshes(at - 1 / FPS, stepped(at - 1 / FPS), at, stepped(at)),
    'and that frame is one the loop would have refreshed on');
});

test('non-cycling mosh has an infinite period and walks back to the first live frame', () => {
  assert.equal(moshRefreshes(4.9, Infinity, 5.0, Infinity), false);
  assert.equal(moshRefreshes(4.9, 1.2, 5.0, Infinity), false);
  assert.equal(moshRefreshes(4.9, Infinity, 5.0, 1.2), true);
  const upAtThree = (t) => (t >= 3 ? 1 : 0);
  assert.deepEqual(moshFramesBack(4.5, FPS, upAtThree, period(Infinity), CEILING),
    { frames: 45, covered: true });
});

test('datamosh manifest declares cycleRefresh as the cycling gate on mosh', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../effects-builtin/datamosh/manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.params?.cycleRefresh?.bind?.cycles, true);
});
