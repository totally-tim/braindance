import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyStream } from '../server/key-stream.js';
import { encodeKeyPayload, decodePair } from '../web/key-stream.js';

const payload = (ts, colourTs = ts) => encodeKeyPayload({
  ts, colourTs, fx: 1000, fy: 1000, cx: 960, cy: 540, rangeM: 9, jpeg: new Uint8Array([7]),
});
function fixture({ available = true, colour = true, loopback = false } = {}) {
  const webcam = { latest: colour ? new Uint8Array([1]) : null, latestAt: 1 };
  const sent = [], requested = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (bytes) => sent.push(bytes) };
  const key = new KeyStream({ request: (value) => requested.push(value), webcam, maxBuffered: 100 });
  if (available) key.setAvailable();
  key.attach(ws, loopback);
  return { webcam, key, ws, requested, sent, pairs: () => sent.filter((v) => typeof v !== 'string').map(decodePair) };
}

test('the key stream rejects an adjacent colour and accepts its exact declared identity', () => {
  const f = fixture();
  f.webcam.latestAt = 2;
  f.key.offer(payload(1));
  assert.equal(f.pairs().length, 0);
  assert.equal(f.key.withoutColour, 1);
  f.key.offer(payload(3, 2));
  assert.equal(f.pairs().length, 1);
  assert.equal(f.pairs()[0].colourTs, 2);
  assert.equal(f.pairs()[0].depthTs, 3);
});

test('missing or delayed colour never borrows a different frame', () => {
  const f = fixture({ colour: false });
  f.key.offer(payload(1));
  f.webcam.latest = new Uint8Array([2]); f.webcam.latestAt = 2;
  f.key.offer(payload(3, 3));
  assert.equal(f.pairs().length, 0);
  f.webcam.latestAt = 3;
  f.key.offer(payload(4, 3));
  assert.equal(f.pairs().length, 1);
});

test('an unavailable remote subscription stays attached without charging the take', () => {
  const f = fixture({ available: false });
  assert.equal(f.key.count, 1);
  assert.deepEqual(f.key.subscribersCostingTheTake(), []);
  f.key.offer(payload(1));
  assert.equal(f.pairs().length, 0);
  f.key.setAvailable();
  assert.equal(f.key.subscribersCostingTheTake().length, 1);
  f.key.offer(payload(1));
  assert.equal(f.pairs().length, 1);
});

test('loopback subscribers remain exempt while the source is available', () => {
  const f = fixture({ loopback: true });
  f.key.offer(payload(1));
  assert.equal(f.pairs().length, 1);
  assert.deepEqual(f.key.subscribersCostingTheTake(), []);
});

test('outage and recovery publish availability and resend colour even when stamps restart', () => {
  const f = fixture();
  f.key.offer(payload(1));
  f.key.offer(payload(2, 1));
  assert.equal(f.pairs()[1].colour, null);
  f.key.setUnavailable('colour off');
  assert.deepEqual(JSON.parse(f.sent.at(-1)), { key: { available: false, unavailable: 'colour off' } });
  assert.deepEqual(f.key.subscribersCostingTheTake(), []);
  f.key.setAvailable();
  assert.equal(JSON.parse(f.sent.at(-1)).key.available, true);
  f.key.offer(payload(1));
  assert.deepEqual(f.pairs().at(-1).colour, new Uint8Array([1]));
});

test('malformed depth is dropped and a blocked client is owed a whole later pair', () => {
  const f = fixture();
  f.key.offer(new Uint8Array(3));
  f.ws.bufferedAmount = 101;
  f.key.offer(payload(1));
  assert.equal(f.pairs().length, 0);
  assert.equal(f.key.dropped, 1);
  f.ws.bufferedAmount = 0;
  f.key.offer(payload(2, 1));
  assert.deepEqual(f.pairs()[0].colour, new Uint8Array([1]));
});
