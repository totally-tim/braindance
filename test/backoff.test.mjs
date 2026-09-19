import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryAfter } from '../server/backoff.js';

// The waits a grabber that keeps failing is started again after, attempt by attempt.
const ladder = (everLive, attempts) => Array.from({ length: attempts }, (_, attempt) => retryAfter({ attempt, everLive }));

test('a sensor that has been seen backs off 1, 2, 4 and then 8 seconds for as long as it keeps failing', () => {
  const plan = ladder(true, 8);
  assert.deepEqual(plan.map((p) => p.delayMs), [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000]);
  assert.ok(plan.every((p) => !p.absent), 'a link that has handshaken is never called absent');
});

test('a sensor never seen spends the whole ladder, then looks again every thirty seconds as absent', () => {
  const plan = ladder(false, 7);
  assert.deepEqual(plan.map((p) => p.delayMs), [1000, 2000, 4000, 8000, 30000, 30000, 30000]);
  assert.deepEqual(plan.map((p) => p.absent), [false, false, false, false, true, true, true]);
  // Fifteen seconds of trying before the verdict, which is what a slow enumeration at boot needs.
  assert.equal(plan.slice(0, 4).reduce((sum, p) => sum + p.delayMs, 0), 15000);
});
