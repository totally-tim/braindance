import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyFrames } from '../web/key-frames.js';
import { encodePair } from '../web/key-stream.js';

const pair = (depthTs, colourTs = depthTs, colour = colourTs) => encodePair({
  depthTs, colourTs, colour: colour === null ? null : new Uint8Array([colour]),
  depth: new Uint8Array([depthTs]), fx: 1000, fy: 1000, cx: 960, cy: 540, rangeM: 9,
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const bitmap = (id) => ({ id, closed: 0, close() { this.closed++; } });
function fixture(decode = async (bytes) => bitmap(bytes[0])) {
  const draws = [], timers = new Map();
  let clears = 0, sequence = 0;
  const stream = new KeyFrames({
    decode, draw: (p, c, d) => draws.push({ p, c, d }), clear: () => { clears++; },
    clock: {
      setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  return { stream, draws, timers, get clears() { return clears; } };
}

test('a matching pair draws, and a held colour serves its later depth without another decode', async () => {
  const f = fixture();
  f.stream.offer(pair(1)); await flush();
  f.stream.offer(pair(2, 1, null)); await flush();
  assert.equal(f.draws.length, 2);
  assert.equal(f.draws[1].c, null);
  assert.equal(f.stream.lastColourTs, 1);
  assert.equal(f.stream.lastDepthTs, 2);
  assert.equal(f.draws[0].d.closed, 1);
  assert.equal(f.draws[0].c.closed, 0);
});

test('an outage clears held images and invalidates an in-flight decode', async () => {
  const gate = deferred();
  const f = fixture(async (bytes) => bytes[0] === 2 ? gate.promise : bitmap(bytes[0]));
  f.stream.offer(pair(1)); await flush();
  f.stream.offer(pair(2)); await flush();
  f.stream.reset();
  const late = bitmap(2); gate.resolve(late); await flush();
  assert.equal(f.draws.length, 1, 'the old decode must not repaint after clear');
  assert.equal(f.clears, 1);
  assert.equal(f.stream.lastColourTs, null);
  assert.equal(f.draws[0].c.closed, 1);
  assert.equal(f.draws[0].d.closed, 1);
  assert.ok(late.closed > 0);
  f.stream.offer(pair(3)); await flush();
  assert.equal(f.draws.length, 2, 'fresh colour recovers without reconnecting the page');
  assert.equal(f.stream.lastColourTs, 3);
});

test('recovery may queue while an obsolete decode finishes', async () => {
  const gate = deferred();
  const f = fixture(async (bytes) => bytes[0] === 1 ? gate.promise : bitmap(bytes[0]));
  f.stream.offer(pair(1)); await flush();
  f.stream.reset();
  f.stream.offer(pair(2));
  gate.resolve(bitmap(1)); await flush();
  assert.equal(f.draws.length, 1);
  assert.equal(f.draws[0].p.colourTs, 2);
});

test('malformed colour clears instead of applying its depth to the previous image', async () => {
  const f = fixture(async (bytes) => bytes[0] === 9 ? null : bitmap(bytes[0]));
  f.stream.offer(pair(1)); await flush();
  f.stream.offer(pair(2, 1, 9)); await flush();
  assert.equal(f.draws.length, 1);
  assert.equal(f.clears, 1);
  assert.equal(f.stream.errors, 1);
  f.stream.offer(pair(3)); await flush();
  assert.equal(f.draws.length, 2);
});

test('no colour, an unknown elided colour, and malformed depth each clear the output', async () => {
  for (const invalid of [pair(2, 2, null), pair(9, 1, null)]) {
    const f = fixture(async (bytes) => bytes[0] === 9 ? null : bitmap(bytes[0]));
    f.stream.offer(pair(1)); await flush();
    f.stream.offer(invalid); await flush();
    assert.equal(f.draws.length, 1);
    assert.equal(f.clears, 1);
  }
  const f = fixture();
  f.stream.offer(pair(1, 1, null)); await flush();
  assert.equal(f.draws.length, 0);
  assert.equal(f.stream.errors, 1);
});

test('a malformed wire message cancels pending work and clears the output', async () => {
  const f = fixture();
  f.stream.offer(pair(1)); await flush();
  f.stream.offer(new Uint8Array(3));
  assert.equal(f.clears, 1);
  assert.equal(f.stream.errors, 1);
  assert.equal(f.stream.lastColourTs, null);
});

test('dropping pending depth carries only the colour with the same identity', async () => {
  for (const same of [true, false]) {
    const gate = deferred();
    const f = fixture(async (bytes) => bytes[0] === 1 ? gate.promise : bitmap(bytes[0]));
    f.stream.offer(pair(1)); await flush();
    f.stream.offer(pair(2));
    f.stream.offer(pair(3, same ? 2 : 3, null));
    gate.resolve(bitmap(1)); await flush();
    if (same) {
      assert.equal(f.draws.length, 2);
      assert.equal(f.draws[1].c.id, 2);
      assert.equal(f.draws[1].p.depthTs, 3);
    } else {
      assert.equal(f.draws.length, 1);
      assert.equal(f.clears, 1);
    }
  }
});

test('new depth cannot keep a frozen colour alive, and a late decode cannot undo expiry', async () => {
  const gate = deferred();
  const f = fixture(async (bytes) => bytes[0] === 3 ? gate.promise : bitmap(bytes[0]));
  f.stream.offer(pair(1)); await flush();
  const [id, timer] = [...f.timers][0];
  assert.equal(timer.ms, 1000);
  f.stream.offer(pair(2, 1, null)); await flush();
  assert.equal([...f.timers.keys()][0], id, 'only a fresh colour renews freshness');
  f.stream.offer(pair(3, 1, null)); await flush();
  timer.fn();
  gate.resolve(bitmap(3)); await flush();
  assert.equal(f.draws.length, 2);
  assert.equal(f.clears, 1);
  assert.equal(f.stream.lastColourTs, null);
});
