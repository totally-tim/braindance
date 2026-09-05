#!/usr/bin/env node
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const flag = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const URL_BASE = flag('--url', 'http://127.0.0.1:8080');
const TAKE = flag('--take', 'sample');
const HTTP_ORIGIN = process.argv.includes('--http-origin');
const BROWSER_BASE = new URL(URL_BASE);
if (HTTP_ORIGIN) BROWSER_BASE.hostname = 'preview.local';
const MUTATE = flag('--mutate', null);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'preview-check-'));

const MUTATIONS = {
  'coverage-uses-whole-clip': {
    file: 'web/previews.js',
    edits: [['    const start = viewStart * fps;\n    const span = Math.max(1, (viewEnd - viewStart) * fps);',
      '    const start = 0;\n    const span = Math.max(1, current.duration * fps);']],
    fails: 'preview coverage follows the zoomed ruler and playhead',
  },
  'coverage-hides-gaps': {
    file: 'web/previews.js',
    edits: [["    for (const [a, b] of ranges) addBar(a, b, 'ready');",
      "    if (ranges.length) addBar(ranges[0][0], ranges.at(-1)[1], 'ready');"]],
    fails: 'preview coverage leaves missing frames visibly unrendered',
  },
  'coverage-stays-in-overview': {
    file: 'web/index.html',
    edits: [['          <div id="tPreviewCoverage" role="img" aria-label="No rendered previews"></div>\n', ''],
      ['      <div class="tminibed" id="tMini">',
        '      <div class="tminibed" id="tMini">\n        <div id="tPreviewCoverage" role="img" aria-label="No rendered previews"></div>']],
    fails: 'preview coverage sits directly under the time ruler',
  },
  'clear-keeps-frame-blobs': {
    file: 'web/preview-cache.js',
    edits: [["        tx.objectStore('frames').clear();", '        /* mutation: leave the encoded images stored */']],
    fails: 'Clear previews empties the database and releases the hidden renderer',
  },
  'stale-storage-error-survives': {
    file: 'web/previews.js',
    edits: [['      if (!closed && mine === generation && key === signature) fail(problem);', '      fail(problem);']],
    fails: 'a delayed storage error cannot disable previews for a newer edit',
  },
  'preview-error-stops-loop': {
    file: 'web/previews.js',
    edits: [['      disable(problem);\n      return fallback;', '      throw problem;']],
    fails: 'a preview exception leaves the live editor animation loop running',
  },
  'manual-render-skips-settle': {
    file: 'web/previews.js',
    edits: [['    await settle();', '    /* mutation: start before the restoring seek settles */']],
    fails: 'Render range waits for cached playback to restore the live editor',
  },
  'camera-drag-rebuilds-identity': {
    file: 'web/previews.js',
    edits: [['    refresh(current.moving || current.busy || current.blocked);', '    refresh();']],
    fails: 'a camera drag defers document identity work until the camera settles',
  },
  'storage-changes-stay-local': {
    file: 'web/preview-cache.js',
    edits: [['      for (const listener of this.listeners) listener(data);', '      /* mutation: ignore changes from another editor */']],
    fails: 'another editor clearing storage updates the visible coverage',
  },
  'preview-is-misplaced': {
    file: 'web/previews.js',
    edits: [["    for (const name of ['width', 'height', 'left', 'top']) canvas.style[name] = stage.style[name];", "    canvas.style.left = '-9999px';"]],
    fails: 'the visible preview covers the live stage exactly',
  },
  'preview-plan-is-empty': {
    file: 'web/main.js',
    edits: [['sample[at++] = depth[row * DEPTH_W + col];', 'sample[at++] = 0;']],
    fails: 'the cached top-down inset matches the live depth samples',
  },
  'cache-boundary-stays-cold': {
    file: 'web/main.js',
    edits: [['      wanted = this.planSeek(target / this.outputFps).spans;', '      return null;']],
    fails: 'source prefetch fills live history before cached playback reaches the boundary',
  },
  'corrupt-frame-stops-idle': {
    file: 'web/previews.js',
    edits: [['        warning = `A cached frame could not be read; playback will render it live. ${problem.message}`;', '        error = `A cached frame could not be read; playback will render it live. ${problem.message}`;']],
    fails: 'idle rendering repairs an unreadable cached frame',
  },
  'clear-allows-stale-render': {
    file: 'web/preview-cache.js',
    edits: [['        if (epoch !== null && epoch !== (epochRequest.result ?? 0)) {', '        if (false) {']],
    fails: 'a storage clear rejects renders started before that clear',
  },
  'hidden-preview-stays-visible': {
    file: 'web/previews.js',
    edits: [["    for (const name of ['width', 'height', 'left', 'top']) canvas.style[name] = stage.style[name];", '    canvas.style.cssText = stage.style.cssText;']],
    fails: 'pausing removes the cached image from the visible page',
  },
  'cache-never-displays': {
    file: 'web/previews.js',
    edits: [['    const held = images.get(frame);', '    const held = null;']],
    fails: 'cached playback replaces foreground rendering',
  },
  'edits-keep-old-previews': {
    file: 'web/previews.js',
    edits: [['    if (key === signature) return;', '    if (signature !== null) return;']],
    fails: 'changing the look invalidates the previous images',
  },
  'preview-skips-history': {
    file: 'web/main.js',
    edits: [['      const seek = await timeline.seek(t, { checkpoint });', '      const seek = await timeline.seek(t, { checkpoint, frames: 0 });']],
    fails: 'cached pixels equal an accurate render including effect history',
  },
  'preview-ignores-free-camera': {
    file: 'web/main.js',
    edits: [['  if (snapshot.camera.pose) {', "  if (snapshot.camera.pose && snapshot.camera.kind !== 'free') {"]],
    fails: 'a parked free camera uses its own view',
  },
  'first-frame-is-skipped': {
    file: 'web/main.js',
    edits: [['    if (run.last >= 0 && run.last === frame - 1) await timeline.runTo(frame);', '    if (run.last === frame - 1) await timeline.runTo(frame);']],
    fails: 'a range containing only frame zero renders that frame',
  },
  'late-decode-survives-camera-change': {
    file: 'web/previews.js',
    edits: [['        if (mine !== generation || closed) { image.close(); return; }', '        /* mutation: accept a bitmap decoded for the previous view */']],
    fails: 'a delayed decode cannot enter the new camera cache',
  },
  'live-resume-skips-history': {
    file: 'web/main.js',
    edits: [['      if (this.previewed) {\n        const gen = this.playGen;', '      if (false) {\n        const gen = this.playGen;']],
    fails: 'playback crosses a cache boundary and rebuilds live history',
  },
};
const ADVANCED = !MUTATE || ['cache-boundary-stays-cold', 'corrupt-frame-stops-idle', 'clear-allows-stale-render',
  'preview-error-stops-loop', 'manual-render-skips-settle', 'camera-drag-rebuilds-identity', 'storage-changes-stay-local',
  'stale-storage-error-survives'].includes(MUTATE);

if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`Unknown mutation: ${MUTATE}. Choose ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

let assertions = 0;
let failures = 0;
const failed = [];
function check(ok, label, detail = '') {
  assertions++;
  if (!ok) { failures++; failed.push(label); }
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chromium', headless: !process.argv.includes('--headed'),
  args: HTTP_ORIGIN ? [`--host-resolver-rules=MAP preview.local ${new URL(URL_BASE).hostname}`, '--no-proxy-server'] : [],
});
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
await context.addInitScript(() => localStorage.setItem('braindance.preview.auto', 'off'));
await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
let served = 0;
if (MUTATE) {
  const mutation = MUTATIONS[MUTATE];
  let source = readFileSync(join(ROOT, mutation.file), 'utf8');
  for (const [from, to] of mutation.edits) {
    if (source.split(from).length !== 2) throw new Error(`Mutation ${MUTATE} does not match exactly once.`);
    source = source.replace(from, () => to);
  }
  const html = mutation.file.endsWith('.html');
  await context.route(html ? '**/edit?*' : `**/${mutation.file.slice(4)}`, (route) => {
    served++;
    return route.fulfill({ contentType: html ? 'text/html' : 'text/javascript', body: source });
  });
  console.log(`[preview] MUTATED ${MUTATE}: must fail ${mutation.fails}`);
}
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
const read = () => page.evaluate(() => {
  const p = __kinect.previews.state();
  const t = __kinect.timeline.transport();
  return { ...p, frame: t.frame, playing: t.playing, previewed: t.previewed,
    counters: { ...__kinect.timeline.counters }, status: document.querySelector('#tPreviewStatus').textContent };
});
async function waitFor(predicate, timeout = 30000) {
  try { await page.waitForFunction(predicate, null, { timeout }); return true; }
  catch { return false; }
}
async function range(from, to) {
  await page.evaluate(async ({ from, to }) => {
    __kinect.timeline.transport().pause();
    await __kinect.timeline.settled();
    __kinect.editor.setClipRange(from, to);
    await __kinect.timeline.transport().seek(from);
    await __kinect.timeline.settled();
  }, { from, to });
}
async function previewCommand(id) {
  if (!await page.locator('#viewMenu').isVisible()) await page.locator('#viewMenuButton').click();
  await page.locator(id).click();
}
async function setAutomatic(enabled) {
  if (await page.locator('#tPreviewAuto').getAttribute('aria-checked') !== String(enabled)) {
    await previewCommand('#tPreviewAuto');
  }
}
async function renderRange() {
  await previewCommand('#tPreviewRender');
  return waitFor(() => {
    const p = __kinect.previews.state();
    const t = __kinect.timeline.transport();
    const a = t.frameAt(t.clipInSec), b = t.frameAt(t.clipOutSec);
    return p.error || p.full || Array.from({ length: b - a + 1 }, (_, i) => a + i).every((n) => p.ready.includes(n));
  }, 60000);
}

async function checkCoverage() {
  await range(1, 5);
  await page.evaluate(() => {
    const duration = __kinect.timeline.transport().duration;
    __kinect.editor.view.set(1 / duration, 5 / duration);
  });
  await waitFor(() => document.querySelector('#tPreviewPercent')?.textContent === '50%');
  const positions = () => page.evaluate(() => {
    const box = (el) => el?.getBoundingClientRect().toJSON() ?? null;
    const tick = (sec) => [...document.querySelectorAll('#tRuler .ttick')]
      .find((el) => parseFloat(el.textContent) === sec)?.getBoundingClientRect().left ?? null;
    return { bed: box(document.querySelector('#tBed')), coverage: box(document.querySelector('#tPreviewCoverage')),
      bars: [...document.querySelectorAll('#tPreviewCoverage .ready')].map(box),
      two: tick(2), three: tick(3), four: tick(4), head: box(document.querySelector('#tPlayhead')),
      percent: document.querySelector('#tPreviewPercent')?.textContent };
  });
  let p = await positions();
  check(p.coverage.height >= 6 && p.coverage.top >= p.bed.top && p.coverage.bottom <= p.bed.bottom
    && Math.abs(p.coverage.left - p.bed.left) < 1 && Math.abs(p.coverage.width - p.bed.width) < 1,
  'preview coverage sits directly under the time ruler', JSON.stringify({ bed: p.bed, coverage: p.coverage }));
  await page.mouse.click(p.three, p.bed.bottom - 4);
  await waitFor(() => __kinect.timeline.transport().frame === 90);
  await page.evaluate(() => __kinect.timeline.settled());
  await waitFor(() => __kinect.previews.state().loaded
    && document.querySelector('#tPreviewPercent')?.textContent === '50%');
  p = await positions();
  const frameWidth = (p.three - p.two) / 30;
  check(p.bars.length === 1 && Math.abs(p.bars[0].left - p.two) < 1
    && Math.abs(p.bars[0].right - p.four - frameWidth) < 1 && Math.abs(p.head.left - p.three) < 1,
  'preview coverage follows the zoomed ruler and playhead', JSON.stringify(p));
  check((await read()).frame === 90, 'the preview band preserves ruler scrubbing');
  check(p.percent === '50%', 'the ruler shows readiness for the selected playback range');

  await page.evaluate(async () => {
    const { PreviewStore } = await import('/preview-cache.js');
    const disk = new PreviewStore();
    for (let frame = 90; frame < 100; frame++) await disk.remove(__kinect.previews.state().signature, frame);
    await disk.close();
  });
  await waitFor(() => !__kinect.previews.state().ready.includes(90)
    && document.querySelector('#tPreviewPercent')?.textContent === '42%');
  p = await positions();
  const gap = p.three + (p.three - p.two) * .15;
  check(p.bars.length === 2 && !p.bars.some((bar) => bar.left <= gap && bar.right > gap)
    && p.percent === '42%', 'preview coverage leaves missing frames visibly unrendered', JSON.stringify(p));
  await page.evaluate(() => {
    const duration = __kinect.timeline.transport().duration;
    __kinect.editor.view.set(2.5 / duration, 6.5 / duration);
  });
  await page.waitForTimeout(50);
  p = await positions();
  check(p.bars.length > 0 && Math.abs(p.bars[0].left - p.bed.left) < 1,
    'panning clips preview coverage at the visible window edge');
  await page.screenshot({ path: join(TMP, 'coverage.png') });
  await page.evaluate(() => __kinect.editor.view.fit());
  await range(2, 4);
  await renderRange();
}
async function pixelsAt(frame) {
  return page.evaluate(async (frame) => {
    const t = __kinect.timeline.transport();
    t.pause();
    await __kinect.timeline.settled();
    await t.seek(frame / t.outputFps);
    const gl = __kinect.renderer.getContext();
    const raw = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const pixels = new Uint8Array(raw.length);
    const rowBytes = gl.drawingBufferWidth * 4;
    for (let row = 0; row < gl.drawingBufferHeight; row++) {
      const from = (gl.drawingBufferHeight - row - 1) * rowBytes;
      pixels.set(raw.subarray(from, from + rowBytes), row * rowBytes);
    }
    window.__previewReference = pixels;
    const chrome = document.querySelector('#chrome');
    const rect = __kinect.keyframes.chrome.inset();
    const scale = chrome.width / rect.stage.w;
    const box = [rect.x, rect.y, rect.w, rect.h].map((n) => Math.round(n * scale));
    window.__previewInsetBox = box;
    window.__previewInsetReference = chrome.getContext('2d').getImageData(...box).data;
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  }, frame);
}
async function compareCached(frame, label, tolerance = 0) {
  await pixelsAt(frame);
  await page.evaluate(async (frame) => {
    const t = __kinect.timeline.transport();
    await t.seek((frame - 1) / t.outputFps);
    await t.play();
    t.tickNow(t.nextDueMs);
    t.playing = false;
  }, frame);
  const difference = await page.evaluate(() => {
    const canvas = document.querySelector('#previewStage');
    if (canvas.hidden) return { cached: false };
    const actual = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const expected = window.__previewReference;
    let max = 0, sum = 0, changed = 0;
    for (let i = 0; i < actual.length; i++) {
      if (i % 4 === 3) continue;
      const delta = Math.abs(actual[i] - expected[i]);
      max = Math.max(max, delta); sum += delta; if (delta) changed++;
    }
    return { cached: true, max, mean: sum / (actual.length * .75), changed };
  });
  check(difference.cached && difference.max <= tolerance, label, JSON.stringify(difference));
  const placement = await page.evaluate(() => {
    const canvas = document.querySelector('#previewStage');
    const actual = canvas.getBoundingClientRect(), expected = document.querySelector('#stage').getBoundingClientRect();
    return getComputedStyle(canvas).display !== 'none' && ['x', 'y', 'width', 'height'].every((n) => actual[n] === expected[n]);
  });
  check(placement, 'the visible preview covers the live stage exactly');
  const inset = await page.evaluate(() => {
    const actual = document.querySelector('#chrome').getContext('2d').getImageData(...window.__previewInsetBox).data;
    const expected = window.__previewInsetReference;
    let changed = 0;
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) changed++;
    return { changed, visible: __kinect.keyframes.chrome.on() && __kinect.keyframes.chrome.topView() };
  });
  check(inset.visible && inset.changed === 0, 'the cached top-down inset matches the live depth samples', JSON.stringify(inset));
  return difference;
}

try {
  const version = await (await context.request.get(`${URL_BASE}/preview/renderer`)).json();
  check(/^[a-f0-9]{64}$/.test(version.version), 'the renderer version endpoint is mounted');
  await page.goto(`${BROWSER_BASE.origin}/edit?take=${encodeURIComponent(TAKE)}`);
  if (HTTP_ORIGIN) check(await page.evaluate(() => !isSecureContext && typeof crypto.subtle === 'undefined'),
    'the editor runs on an ordinary HTTP origin without Web Crypto');
  if (!await waitFor(() => window.__kinect?.previews.state()?.loaded)) throw new Error('The editor did not boot with preview storage.');
  const duration = await page.evaluate(() => __kinect.timeline.transport().duration);
  if (duration < 9) throw new Error(`The fixture needs at least 9 seconds; ${TAKE} has ${duration}.`);
  check(await page.locator('#stage').isVisible(), 'the editor shows the real stage');
  check(!await page.locator('#tPreviewRender').isVisible(), 'the preview menu is closed at boot');
  await page.locator('#viewMenuButton').click();
  check(await page.locator('#viewMenu #tPreviewSettings').isVisible()
    && await page.locator('#timeline details').count() === 0,
  'View contains the preview settings and the timeline has no popup');
  await page.keyboard.press('Escape');
  await range(0, 0);
  await renderRange();
  let p = await read();
  check(p.ready.includes(0), 'a range containing only frame zero renders that frame', p.status);
  await previewCommand('#tPreviewClear');
  check(await waitFor(() => __kinect.previews.state().ready.length === 0), 'Clear previews removes the rendered range');

  await page.evaluate(async () => {
    __kinect.params.set('fade', 1600);
    __kinect.params.set('wake', 600);
    __kinect.params.set('trails', .88);
    __kinect.params.set('bloom', .35);
    __kinect.params.set('pointSize', 4);
    __kinect.params.set('readDepth', .5);
    __kinect.params.set('readRgb', .5);
    __kinect.setViewCamera(__kinect.programCamera);
    await __kinect.timeline.settled();
  });
  await range(2, 4);
  const before = await read();
  await renderRange();
  p = await read();
  check(p.ready.filter((n) => n >= 60 && n <= 120).length === 61, 'Render range fills only the selected range', p.status);
  check(p.frame === before.frame && p.counters.renders === before.counters.renders,
    'background rendering leaves the editor playhead and renderer untouched', `${before.frame}->${p.frame}; renders ${before.counters.renders}->${p.counters.renders}`);
  await checkCoverage();
  await compareCached(90, 'cached pixels equal an accurate render including effect history');

  await range(2, 4);
  const started = await read();
  await page.locator('#tPlay').click();
  const finished = await waitFor(() => !__kinect.timeline.transport().playing && __kinect.timeline.transport().frame === 120, 10000);
  await page.evaluate(() => __kinect.timeline.settled());
  p = await read();
  check(finished && p.shown - started.shown === 60,
    'cached playback replaces foreground rendering', `${p.shown - started.shown} cached frames; ${p.counters.renders - started.counters.renders} foreground renders including pause restoration`);
  await page.evaluate(() => __kinect.timeline.settled());
  check(!await page.locator('#previewStage').isVisible(), 'pausing removes the cached image from the visible page');
  check(p.memoryBytes <= p.memoryLimit && p.storageBytes <= p.storageLimit, 'both preview caches stay within their byte limits');

  if (ADVANCED) {
    await range(2, 5);
    await page.evaluate(() => {
      const t = __kinect.timeline.transport();
      const original = t.seekNow.bind(t);
      t.seekNow = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 300)); return original(...args); };
      window.__restorePreviewSeek = () => { t.seekNow = original; };
    });
    await page.locator('#tPlay').click();
    await waitFor(() => __kinect.timeline.transport().previewed);
    await previewCommand('#tPreviewRender');
    check(await waitFor(() => __kinect.previews.state().ready.includes(150), 12000),
      'Render range waits for cached playback to restore the live editor');
    await page.evaluate(() => window.__restorePreviewSeek());
    await page.evaluate(async () => {
      const { PreviewStore } = await import('/preview-cache.js');
      const other = new PreviewStore();
      await other.clear();
      await other.close();
    });
    check(await waitFor(() => __kinect.previews.state().ready.length === 0, 3000),
      'another editor clearing storage updates the visible coverage');
    await range(2, 4);
    await renderRange();
    await page.evaluate(async () => {
      const { PreviewStore } = await import('/preview-cache.js');
      const other = new PreviewStore({ limit: 1024 });
      await other.put('another-edit', 0, new Blob(['a small replacement frame']));
      await other.close();
    });
    check(await waitFor(() => __kinect.previews.state().ready.length === 0, 3000),
      'another editor evicting frames updates the visible coverage');
    await renderRange();
  }

  await range(2, 5);
  const boundary = await read();
  await page.locator('#tPlay').click();
  const crossed = await waitFor(() => __kinect.timeline.transport().frame >= 135, 10000);
  p = await read();
  check(crossed && p.counters.seeks > boundary.counters.seeks, 'playback crosses a cache boundary and rebuilds live history', `frame ${p.frame}, seeks ${boundary.counters.seeks}->${p.counters.seeks}`);
  await page.locator('#tPlay').click();
  await page.evaluate(() => __kinect.timeline.settled());

  await page.evaluate(async () => {
    __kinect.params.set('pointSize', 7);
    await __kinect.timeline.settled();
  });
  check(await waitFor(() => __kinect.previews.state().loaded && __kinect.previews.state().ready.length === 0, 3000),
    'changing the look invalidates the previous images');
  await page.evaluate(async () => {
    __kinect.params.set('pointSize', 4);
    await __kinect.timeline.settled();
  });
  check(await waitFor(() => __kinect.previews.state().ready.includes(90), 3000), 'returning to an unchanged edit reuses its previews');

  await range(2, 2.3);
  await page.evaluate(async () => {
    __kinect.setViewCamera(__kinect.freeCamera);
    __kinect.freeCamera.position.set(.55, .3, 1.2);
    __kinect.controls.target.set(0, 0, -2.2);
    __kinect.controls.update(0);
    await __kinect.timeline.transport().seek(2);
    await __kinect.timeline.settled();
  });
  await renderRange();
  await compareCached(65, 'a parked free camera uses its own view');
  await page.evaluate(() => __kinect.setViewCamera(__kinect.programCamera));
  check(await waitFor(() => __kinect.previews.state().view === 'program' && __kinect.previews.state().ready.includes(90), 3000),
    'free-camera previews preserve the authored-camera cache');

  await page.evaluate(async () => {
    __kinect.timeline.transport().pause();
    await __kinect.timeline.settled();
    __kinect.setViewCamera(__kinect.freeCamera);
  });
  await waitFor(() => __kinect.previews.state().view === 'free' && __kinect.previews.state().loaded);
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window);
    window.__previewDecodeWait = new Promise((resolve) => { window.__releasePreviewDecode = resolve; });
    window.createImageBitmap = async (...args) => {
      const image = await original(...args);
      window.__previewDecodeStarted = true;
      await window.__previewDecodeWait;
      return image;
    };
    window.__restorePreviewDecode = () => { window.createImageBitmap = original; };
    __kinect.timeline.transport().play();
  });
  const delayed = await waitFor(() => window.__previewDecodeStarted, 3000);
  await page.evaluate(() => {
    __kinect.timeline.transport().pause();
    __kinect.freeCamera.position.x += .4;
    __kinect.controls.update(0);
  });
  await waitFor(() => __kinect.previews.state().loaded && __kinect.previews.state().ready.length === 0, 3000);
  await page.evaluate(() => { window.__releasePreviewDecode(); window.__restorePreviewDecode(); });
  await page.waitForTimeout(100);
  p = await read();
  check(delayed && p.memoryBytes === 0 && !p.playing, 'a delayed decode cannot enter the new camera cache', `${p.memoryBytes} decoded bytes; playing ${p.playing}`);

  await range(5, 8);
  await setAutomatic(true);
  check(await waitFor(() => __kinect.previews.state().rendered > 71 && __kinect.previews.state().rendering, 15000),
    'a settled free camera starts rendering while idle');
  await setAutomatic(false);
  const stopped = (await read()).rendered;
  await page.waitForTimeout(500);
  p = await read();
  check(!p.rendering && p.rendered <= stopped + 1, 'turning off idle rendering interrupts the active render');
  await previewCommand('#tPreviewRender');
  check(await waitFor(() => __kinect.previews.state().rendering, 3000), 'manual rendering works with idle rendering off');
  await setAutomatic(true);
  await page.waitForTimeout(100);
  check((await read()).rendering, 'enabling idle rendering preserves a manual render');
  await setAutomatic(false);
  check((await read()).rendering, 'disabling idle rendering preserves a manual render');
  await page.mouse.move(990, 20);
  await page.waitForTimeout(100);
  check((await read()).rendering, 'moving the pointer preserves a manual render');
  await previewCommand('#tPreviewRender');
  await page.waitForTimeout(150);
  check(!(await read()).rendering, 'Stop rendering interrupts the manual render');
  await previewCommand('#tPreviewRender');
  await waitFor(() => __kinect.previews.state().rendering, 3000);
  await previewCommand('#tPreviewClear');
  await page.waitForTimeout(500);
  p = await read();
  check(!p.rendering && p.ready.length === 0 && p.storageBytes === 0, 'clearing during a render prevents late frames from returning', p.status);
  const empty = await page.evaluate(async () => {
    const { PreviewStore } = await import('/preview-cache.js');
    const disk = new PreviewStore();
    const usage = await disk.usage();
    const db = await disk.open;
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(['frames', 'entries']);
      const frames = tx.objectStore('frames').count();
      const entries = tx.objectStore('entries').count();
      tx.oncomplete = () => resolve(frames.result + entries.result);
      tx.onabort = () => reject(tx.error);
    });
    await disk.close();
    return usage.bytes === 0 && count === 0 && document.querySelectorAll('.preview-renderer').length === 0;
  });
  check(empty, 'Clear previews empties the database and releases the hidden renderer');

  if (ADVANCED) {
    const animated = await page.evaluate(async () => {
      const body = __kinect.library.serialiseProjectBody();
      const pose = __kinect.params.get('camera');
      body.composition.camera = [
        { t: 0, value: pose },
        { t: 4, value: { ...pose, position: [pose.position[0] + .8, pose.position[1] + .2, pose.position[2]], fov: pose.fov + 10 } },
      ];
      body.clips[0].tracks.pointSize = [{ t: 0, value: 3 }, { t: 4, value: 8 }];
      await __kinect.library.loadProject('preview-proof', body);
      __kinect.setViewCamera(__kinect.programCamera);
      await __kinect.timeline.settled();
      return body;
    });
    await range(2, 2.3);
    await renderRange();
    const authored = await read();
    check(authored.ready.includes(65), 'the animated range finishes rendering', JSON.stringify(authored));
    await compareCached(65, 'animated camera and effect keys match the live image');
    check((await read()).generation === authored.generation, 'evaluating animated keys preserves cache identity');
    await page.reload();
    await waitFor(() => window.__kinect?.previews.state()?.loaded);
    await page.evaluate(async (body) => {
      await __kinect.library.loadProject('preview-proof', body);
      __kinect.setViewCamera(__kinect.programCamera);
      await __kinect.timeline.settled();
    }, animated);
    check(await waitFor(() => __kinect.previews.state().ready.includes(65), 3000), 'previews survive a page reload');
    await range(2, 2.3);
    await compareCached(65, 'a persisted preview still matches the authored edit');

    await page.evaluate(async () => {
      __kinect.params.set('datamosh.amount', .85);
      __kinect.params.set('datamosh.decay', .98);
      __kinect.params.set('datamosh.refresh', 2);
      const body = __kinect.library.serialiseProjectBody();
      body.composition.camera = [];
      body.clips.push({ ...structuredClone(body.clips[0]), id: 'preview-second', start: .5, sourceStart: 1, length: 6 });
      await __kinect.library.loadProject('preview-overlap', body);
      await __kinect.timeline.settled();
    });
    await range(3, 3.3);
    await renderRange();
    const liveResidual = await page.evaluate(async () => {
      const t = __kinect.timeline.transport();
      t.pause();
      await __kinect.timeline.settled();
      await t.seek(3);
      await t.runTo(95);
      const gl = __kinect.renderer.getContext();
      const before = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      const after = new Uint8Array(before.length);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, before);
      await t.seek(95 / t.outputFps);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, after);
      let max = 0;
      for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(before[i] - after[i]));
      return max;
    });
    check(liveResidual <= 2, 'the live feedback baseline stays within the timeline tolerance', `maximum RGB difference ${liveResidual}/255`);
    await compareCached(95, 'overlapping clips and datamosh history match the live image', 2);
    await page.evaluate(() => __kinect.editor.selectClipRow('preview-second'));
    await compareCached(95, 'selecting the second clip preserves the composite preview', 2);
    check(await page.evaluate(() => __kinect.mosh.enabled && __kinect.timeline.clips().length === 2),
      'the overlap comparison actually includes two clips and an enabled datamosh pass');
    const oldWidth = (await read()).width;
    await page.setViewportSize({ width: 1100, height: 740 });
    check(await waitFor(() => __kinect.previews.state().loaded && __kinect.previews.state().ready.length === 0, 3000)
      && (await read()).width !== oldWidth, 'resizing the viewport invalidates images at the old resolution');
    check(!await page.locator('#previewStage').isVisible(), 'resizing removes the old preview overlay');

    const storage = await page.evaluate(async () => {
      const { PreviewStore } = await import('/preview-cache.js');
      const name = `preview-proof-${Date.now()}`;
      const store = new PreviewStore({ name, limit: 800 });
      const blob = new Blob([new Uint8Array(100)]);
      await Promise.all(['a', 'b', 'c'].map((key) => store.put(key, 0, blob)));
      const count = (await Promise.all(['a', 'b', 'c'].map(async (key) => (await store.frames(key)).size))).reduce((a, b) => a + b, 0);
      const bounded = count === 2 && (await store.usage()).bytes === 720;
      let malformed = false, oversized = false;
      try { await store.put('d', -1, blob); } catch { malformed = true; }
      try { await store.put('d', 0, new Blob([new Uint8Array(900)])); } catch { oversized = true; }
      const intact = (await store.usage()).bytes === 720;
      await store.close();
      const reopened = new PreviewStore({ name, limit: 800 });
      const persisted = (await reopened.usage()).bytes === 720;
      const epoch = (await reopened.status('late')).epoch;
      await reopened.clear();
      let stale = false;
      try { await reopened.put('late', 0, blob, {}, epoch); }
      catch (err) { stale = err.name === 'AbortError'; }
      const cleared = (await reopened.usage()).bytes === 0;
      await reopened.close();
      indexedDB.deleteDatabase(name);
      return { bounded, refused: malformed && oversized && intact, persisted, cleared, stale };
    });
    check(storage.bounded, 'concurrent storage writes evict frames within one shared byte limit');
    check(storage.refused, 'malformed and oversized frames leave existing storage intact');
    check(storage.persisted && storage.cleared, 'storage accounting survives reopen and resets on clear');
    check(storage.stale && storage.cleared, 'a storage clear rejects renders started before that clear');

    await page.evaluate(async () => {
      await __kinect.previews.clear();
      const { PreviewStore } = await import('/preview-cache.js');
      const original = PreviewStore.prototype.put;
      PreviewStore.prototype.put = async () => { throw new DOMException('Injected full disk', 'QuotaExceededError'); };
      window.__restorePreviewStore = () => { PreviewStore.prototype.put = original; };
    });
    await range(0, 0);
    await renderRange();
    p = await read();
    check(p.error?.includes('Injected full disk') && p.ready.length === 0 && await page.locator('#stage').isVisible(),
      'storage quota failure preserves the live editor and reports the error', p.status);
    await page.evaluate(() => window.__restorePreviewStore());
    await renderRange();
    check((await read()).ready.includes(0), 'manual retry recovers after storage becomes writable');

    await range(6, 7.5);
    await renderRange();
    await range(6, 8);
    const cold = await page.evaluate(async () => {
      const t = __kinect.timeline.transport();
      await Promise.all(t.prefetching.values());
      const spans = t.planSeek(226 / t.outputFps).spans;
      for (const take of new Set(spans.map((span) => span.source.take))) {
        const applied = Math.max(...spans.filter((span) => span.source.take === take).map((span) => span.source.applied));
        for (const [frame, data] of take.cache) {
          if (frame <= applied) continue;
          data.bitmap?.close();
          take.cache.delete(frame);
        }
      }
      return !t.resident(spans);
    });
    await page.locator('#tPlay').click();
    const prefetched = await waitFor(() => {
      const t = __kinect.timeline.transport();
      return t.previewed && t.frame >= 210 && t.frame < 226 && t.resident(t.planSeek(226 / t.outputFps).spans);
    }, 10000);
    check(cold && prefetched, 'source prefetch fills live history before cached playback reaches the boundary');
    await page.evaluate(async () => { __kinect.timeline.transport().pause(); await __kinect.timeline.settled(); });

    await page.evaluate(() => __kinect.previews.clear());
    await range(0, 1);
    await renderRange();
    await page.evaluate(async () => {
      const { PreviewStore } = await import('/preview-cache.js');
      const disk = new PreviewStore();
      await disk.put(__kinect.previews.state().signature, 1, new Blob(['not a PNG']));
      await disk.close();
    });
    await page.locator('#tPlay').click();
    const unreadable = await waitFor(() => Boolean(__kinect.previews.state().warning || __kinect.previews.state().error), 3000);
    await waitFor(() => !__kinect.timeline.transport().playing);
    await setAutomatic(true);
    const repaired = await waitFor(() => __kinect.previews.state().ready.includes(1)
      && !__kinect.previews.state().warning && !__kinect.previews.state().error, 12000);
    check(unreadable && repaired, 'idle rendering repairs an unreadable cached frame');
    await setAutomatic(false);

    await page.evaluate(async () => {
      __kinect.setViewCamera(__kinect.freeCamera);
      await __kinect.timeline.settled();
    });
    await waitFor(() => __kinect.previews.state().loaded);
    const stage = await page.locator('#stage').boundingBox();
    await page.mouse.move(stage.x + stage.width / 3, stage.y + stage.height / 2);
    await page.mouse.down();
    await page.evaluate(() => {
      const original = window.structuredClone;
      window.__previewIdentityCalls = 0;
      window.structuredClone = (value, ...args) => {
        if (value?.project && value?.camera && value?.version) window.__previewIdentityCalls++;
        return original(value, ...args);
      };
      window.__restorePreviewClone = () => { window.structuredClone = original; };
    });
    await page.mouse.move(stage.x + stage.width / 3 + 80, stage.y + stage.height / 2 + 40, { steps: 12 });
    const duringMove = await page.evaluate(() => window.__previewIdentityCalls);
    await page.mouse.up();
    await page.evaluate(() => __kinect.timeline.settled());
    await waitFor(() => __kinect.previews.state().loaded);
    const afterMove = await page.evaluate(() => { const n = window.__previewIdentityCalls; window.__restorePreviewClone(); return n; });
    check(duringMove === 0 && afterMove > 0, 'a camera drag defers document identity work until the camera settles', `${duringMove} during drag; ${afterMove} after settling`);

    await range(0, 1);
    await page.evaluate(() => {
      const original = window.structuredClone;
      window.structuredClone = (value, ...args) => {
        if (value?.project && value?.camera && value?.version) throw new Error('Injected preview identity failure');
        return original(value, ...args);
      };
      window.__restorePreviewClone = () => { window.structuredClone = original; };
      __kinect.params.set('pointSize', __kinect.params.get('pointSize') + 1);
    });
    const guarded = await waitFor(() => __kinect.previews.state().faulted, 3000);
    await page.evaluate(() => window.__restorePreviewClone());
    await page.locator('#tPlay').click();
    check(guarded && await waitFor(() => __kinect.timeline.transport().frame === 30, 5000),
      'a preview exception leaves the live editor animation loop running');
    if (guarded) {
      await page.evaluate(() => __kinect.previews.clear());
      await range(0, 0);
      await renderRange();
      check((await read()).ready.includes(0), 'clearing previews recovers from a preview coordinator failure');

      await page.evaluate(async () => {
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      check(await waitFor(() => __kinect.previews.state().loaded && __kinect.previews.state().ready.includes(0)),
        'a restored page reconnects preview storage and retains its coverage');
      await page.evaluate(() => __kinect.previews.clear());
      await renderRange();
      check((await read()).ready.includes(0), 'a restored page can render new previews');
      await page.evaluate(async () => {
        const { PreviewStore } = await import('/preview-cache.js');
        const original = PreviewStore.prototype.status;
        let hold = true;
        PreviewStore.prototype.status = function (...args) {
          if (!hold) return original.apply(this, args);
          hold = false;
          return new Promise((resolve, reject) => { window.__rejectOldPreviewStatus = reject; });
        };
        window.__restorePreviewStatus = () => { PreviewStore.prototype.status = original; };
        __kinect.params.set('exposure', __kinect.params.get('exposure') + .1);
      });
      const heldStatus = await waitFor(() => Boolean(window.__rejectOldPreviewStatus), 3000);
      const oldGeneration = (await read()).generation;
      await page.evaluate(async () => {
        __kinect.params.set('exposure', __kinect.params.get('exposure') + .1);
        await __kinect.timeline.settled();
      });
      const changedGeneration = await page.waitForFunction((generation) => __kinect.previews.state().generation > generation, oldGeneration,
        { timeout: 3000 }).then(() => true, () => false);
      await page.evaluate(() => { window.__restorePreviewStatus(); window.__rejectOldPreviewStatus?.(new Error('Injected old storage failure')); });
      await waitFor(() => __kinect.previews.state().loaded);
      check(heldStatus && changedGeneration && !(await read()).error,
        'a delayed storage error cannot disable previews for a newer edit', `held ${heldStatus}; edit changed ${changedGeneration}; error ${(await read()).error}`);
      await renderRange();
      if (!MUTATE) check(await waitFor(() => !document.querySelector('.preview-renderer'), 35000),
        'an idle preview renderer removes its hidden frame');
    }
  }
  await page.screenshot({ path: join(TMP, 'editor.png') });
  check(errors.length === 0, 'the browser reported no uncaught errors', errors.join('; '));
} catch (err) {
  check(false, 'the preview workflow completed', `${err.stack ?? err}; browser errors: ${errors.join('; ')}`);
} finally {
  await browser.close();
}

if (MUTATE) check(served > 0, 'the browser actually loaded the mutation', `${served} responses`);
writeFileSync(join(TMP, 'result.json'), JSON.stringify({ assertions, failures, failed, mutation: MUTATE, served }, null, 2));
console.log(`\n[preview] ${assertions} assertions, ${failures} failed`);
console.log(`[preview] evidence ${TMP}`);
if (MUTATE) {
  const caught = failed.includes(MUTATIONS[MUTATE].fails);
  console.log(`[preview] ${caught ? 'CAUGHT for the declared reason' : 'NOT CAUGHT for the declared reason'}`);
  process.exitCode = caught && served > 0 ? 0 : 1;
} else process.exitCode = failures ? 1 : 0;
