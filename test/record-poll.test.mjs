import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollRecordState } from '../web/record-poll.js';

// The shipped cadence. The rows below run the poll as it ships, so a cadence that moved fails them.
const EVERY = 5000;

// Lets the fetch and the handler's awaits settle between clock steps.
const settle = () => new Promise((done) => setImmediate(done));

function recorder(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(url);
    return { json: async () => ({ writingIds: [] }) };
  });
  return asked;
}

test('the recorder is asked once at start and then once a cadence, not before it', async (t) => {
  const asked = recorder(t);
  pollRecordState(() => {});
  await settle();
  assert.equal(asked.length, 1, 'the first tick is immediate');
  t.mock.timers.tick(EVERY - 1);
  await settle();
  assert.equal(asked.length, 1, 'nothing inside the cadence');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(asked.length, 2, 'the second tick lands on the cadence');
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(EVERY);
    await settle();
  }
  assert.equal(asked.length, 5, 'one a cadence thereafter');
  assert.ok(asked.every((url) => url === '/record/state'));
});

test('a cadence that arrives while a tick is still being handled asks nothing', async (t) => {
  const asked = recorder(t);
  let release;
  const hung = new Promise((done) => { release = done; });
  let handled = 0;
  pollRecordState(async () => { handled++; if (handled === 2) await hung; });
  await settle();
  t.mock.timers.tick(EVERY);
  await settle();
  assert.equal(asked.length, 2, 'the second tick is in its handler');
  t.mock.timers.tick(EVERY * 4);
  await settle();
  assert.equal(asked.length, 2, 'four cadences later nothing more was asked');
  release();
  await settle();
  t.mock.timers.tick(EVERY);
  await settle();
  assert.equal(asked.length, 3, 'and the cadence resumes once the handler returns');
});
