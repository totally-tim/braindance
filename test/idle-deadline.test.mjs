import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleDeadline } from '../server/idle.js';

const AFTER = 600_000;

test('an idle live sensor is counted from the first tick that sees it and expires on the setting', () => {
  const rule = new IdleDeadline({ afterMs: AFTER });
  assert.deepEqual(rule.ask({ idle: true, state: 'live', now: 0 }), { waitingMs: 0, expired: false });
  assert.deepEqual(rule.ask({ idle: true, state: 'live', now: AFTER - 1 }), { waitingMs: AFTER - 1, expired: false });
  assert.deepEqual(rule.ask({ idle: true, state: 'live', now: AFTER }), { waitingMs: AFTER, expired: true });
});

test('a consumer arriving clears the wait it was in the middle of', () => {
  const rule = new IdleDeadline({ afterMs: AFTER });
  rule.ask({ idle: true, state: 'live', now: 0 });
  assert.deepEqual(rule.ask({ idle: false, state: 'live', now: AFTER - 1 }), { waitingMs: 0, expired: false });
  assert.deepEqual(rule.ask({ idle: true, state: 'live', now: AFTER + 1000 }), { waitingMs: 0, expired: false });
});

test('an absent sensor and one already standing down hold no deadline', () => {
  for (const state of ['absent', 'standby']) {
    const rule = new IdleDeadline({ afterMs: AFTER });
    rule.ask({ idle: true, state: 'live', now: 0 });
    assert.deepEqual(rule.ask({ idle: true, state, now: AFTER - 1 }), { waitingMs: 0, expired: false });
    // The wait it was holding is gone rather than carried across the exclusion.
    assert.deepEqual(rule.ask({ idle: true, state: 'live', now: AFTER + 1 }), { waitingMs: 0, expired: false });
  }
});

test('a sensor retrying between starting and lost keeps the deadline it already started', () => {
  const rule = new IdleDeadline({ afterMs: AFTER });
  const tick = (state, now) => rule.ask({ idle: true, state, now });
  // The flapping link: seen live once, then retry attempts and failures forever. Every `starting`
  // here would set the count back on an arm that clears it, and the sensor would never stand down
  // however long the machine was left up.
  const flap = ['live', 'starting', 'lost', 'starting', 'lost', 'starting', 'lost'];
  flap.forEach((state, i) => assert.deepEqual(
    tick(state, (i + 1) * 5_000), { waitingMs: i * 5_000, expired: false }, `tick ${i}`));
  assert.equal(tick('starting', AFTER + 5_000).expired, true, 'the deadline arrives in the middle of a retry');
  assert.equal(rule.since, 5_000, 'counted from the first tick that saw the sensor, not the last');
});

test('a sensor that has never been seen in a waited-for state begins no count', () => {
  const rule = new IdleDeadline({ afterMs: AFTER });
  for (let i = 1; i <= 200; i++) {
    assert.deepEqual(rule.ask({ idle: true, state: 'starting', now: i * 5_000 }), { waitingMs: 0, expired: false });
  }
  assert.equal(rule.since, null);
});

test('a wake begins the count again', () => {
  const rule = new IdleDeadline({ afterMs: AFTER });
  rule.ask({ idle: true, state: 'live', now: 0 });
  rule.reset();
  assert.deepEqual(rule.ask({ idle: true, state: 'live', now: AFTER - 1 }), { waitingMs: 0, expired: false });
});
