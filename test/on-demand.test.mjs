import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnDemand } from '../server/on-demand.js';
import { fakeClock } from './fake-clock.mjs';

// The shipped linger. The rows below run the class as it ships, so a linger that moved fails them.
const LINGER = 6000;

// A stream with `subscribers` attached, and every edge it asked the grabber for.
function stream() {
  const asked = [];
  const s = { subscribers: 0, asked };
  s.demand = new OnDemand({ request: (wanted) => asked.push(wanted), count: () => s.subscribers });
  return s;
}

test('the last subscriber leaving stops the stream when the linger runs out, not before', (t) => {
  const clock = fakeClock(t);
  const s = stream();
  s.subscribers = 1;
  s.demand.settle();
  assert.deepEqual(s.asked, [true]);
  s.subscribers = 0;
  s.demand.settle();
  clock.tick(LINGER - 1);
  assert.deepEqual(s.asked, [true], 'still up one millisecond inside the linger');
  clock.tick(1);
  assert.deepEqual(s.asked, [true, false], 'asked to stop as the linger runs out');
});

test('a subscriber returning inside the linger keeps the stream up without a second start', (t) => {
  const clock = fakeClock(t);
  const s = stream();
  s.subscribers = 1;
  s.demand.settle();
  s.subscribers = 0;
  s.demand.settle();
  clock.tick(LINGER - 1);
  s.subscribers = 1;
  s.demand.settle();
  clock.tick(LINGER * 3);
  assert.deepEqual(s.asked, [true], 'one start, no stop, however long the returning subscriber stays');
});

test('a subscriber arriving while the timer is already due is counted before the stop', (t) => {
  const clock = fakeClock(t);
  const s = stream();
  s.subscribers = 1;
  s.demand.settle();
  s.subscribers = 0;
  s.demand.settle();
  // Attached without a settle, which is the order a socket arriving inside the timer's turn has.
  s.subscribers = 1;
  clock.tick(LINGER);
  assert.deepEqual(s.asked, [true]);
});
