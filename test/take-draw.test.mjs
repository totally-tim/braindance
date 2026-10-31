import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkim } from '../web/take-draw.js';
import { DEPTH_H, DEPTH_W } from '../web/format.js';

function makeMockCanvas(width = 320, height = 180) {
  let putCount = 0;
  let fillCount = 0;
  let lastImage = null;
  const ctx = {
    fillStyle: '#000',
    fillRect() { fillCount++; },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img) {
      putCount++;
      lastImage = img;
    },
  };
  return {
    width,
    height,
    getContext() { return ctx; },
    get putCount() { return putCount; },
    get fillCount() { return fillCount; },
    get lastImage() { return lastImage; },
  };
}

function makeSurface(width = 320, height = 180) {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
  };
}

function withBrowserGlobals(fetchImpl, fn) {
  const prevRO = globalThis.ResizeObserver;
  const prevDPR = globalThis.devicePixelRatio;
  const prevFetch = globalThis.fetch;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.devicePixelRatio = 1;
  globalThis.fetch = fetchImpl;
  return Promise.resolve().then(fn).finally(() => {
    globalThis.ResizeObserver = prevRO;
    globalThis.devicePixelRatio = prevDPR;
    globalThis.fetch = prevFetch;
  });
}

const SAMPLE_TAKE = {
  id: 'sample',
  hash: `sha256:${'a'.repeat(64)}`,
  state: 'local',
  frames: 2,
  durationSec: 1,
  hello: { fx: 366, fy: 366, cx: DEPTH_W / 2, cy: DEPTH_H / 2 },
};

test('createSkim tolerates truncated frame payloads without throwing RangeError', async () => {
  const payloads = [new ArrayBuffer(8), (() => {
    const short = new ArrayBuffer(32);
    new DataView(short).setUint32(0, DEPTH_W * DEPTH_H * 2, true);
    return short;
  })()];
  for (const bad of payloads) {
    const canvas = makeMockCanvas(160, 90);
    await withBrowserGlobals(async () => ({ ok: true, arrayBuffer: async () => bad }), async () => {
      let drawn = 0;
      const skim = createSkim({
        canvas,
        surface: makeSurface(160, 90),
        onDraw: (_n, requested) => { if (!requested) drawn++; },
      });
      skim.show(SAMPLE_TAKE);
      skim.setIndex(0);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(drawn, 1);
      assert.equal(canvas.putCount, 0);
      skim.release();
    });
  }
});

test('createSkim requests depth=1, aborts superseded take fetches on release, and z-buffers overlapping splats', async () => {
  const depthBytes = DEPTH_W * DEPTH_H * 2;
  const buf = new ArrayBuffer(16 + depthBytes);
  new DataView(buf).setUint32(0, depthBytes, true);
  const depth = new Uint16Array(buf, 16, DEPTH_W * DEPTH_H);
  // Two adjacent rows whose splats overlap at 640x360 (`splat = round(360*1.15/366) = 1`, at 960x540 `splat = 2`):
  // place a near bright sample at y=212, x=256 and a far dim sample at y=213, x=256 so the far row is visited second.
  depth[212 * DEPTH_W + 256] = 1000;
  depth[213 * DEPTH_W + 256] = 4500;

  const seenUrls = [];
  const signals = [];
  let resolveSlow;
  const slowFetch = new Promise((r) => { resolveSlow = r; });

  await withBrowserGlobals(async (url, init) => {
    seenUrls.push(url);
    signals.push(init?.signal ?? null);
    if (seenUrls.length === 2) return slowFetch;
    return { ok: true, arrayBuffer: async () => buf };
  }, async () => {
    const canvas = makeMockCanvas(960, 540);
    const skim = createSkim({ canvas, surface: makeSurface(960, 540) });
    skim.show(SAMPLE_TAKE);
    skim.setIndex(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    assert.match(seenUrls[0], /[?&]depth=1\b/, 'poster fetch asks the server to strip unused colour JPEG bytes');
    assert.ok(canvas.lastImage, 'valid depth frame drew an ImageData');

    // Check overlapping pixel between the two 2x2 splats: y=212 projects to oy=227, y=213 projects to 229?
    // With scale = 540 * 1.15 = 621, kY = 621 / 366 = 1.6967, y=212 -> round(226.8 + 0) = 227 (covers py 227, 228),
    // y=213 -> round(226.8 + 1.6967) = 228 (covers py 228, 229). Row py=228, qx=480 overlaps!
    const overlapIdx = (228 * 960 + 480) * 4;
    const nearV = Math.max(24, Math.round(255 * ((5000 - 1000) / 5000)));
    assert.equal(canvas.lastImage.data[overlapIdx], nearV, 'nearer depth sample wins over far sample visited later');

    // Start a second fetch on a remote take and release while in flight.
    skim.show({ ...SAMPLE_TAKE, state: 'remote', hash: `sha256:${'b'.repeat(64)}` });
    skim.setIndex(0);
    await Promise.resolve();
    assert.equal(signals[1]?.aborted, false);
    skim.release();
    assert.equal(signals[1]?.aborted, true, 'releasing a skim aborts its in-flight frame fetch');
    resolveSlow({ ok: true, arrayBuffer: async () => buf });
  });
});
