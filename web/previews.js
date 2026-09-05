import { PreviewImages, PreviewStore, previewIdentity, previewRanges } from './preview-cache.js';

const IDLE_MS = 2500;
const RENDERER_IDLE_MS = 30000;
const AUTO_KEY = 'braindance.preview.auto';
const cancelled = () => new DOMException('Preview rendering was interrupted.', 'AbortError');

// A macrotask yield that lets input run without the 4 ms clamp nested timers carry.
const yieldTask = globalThis.scheduler?.yield
  ? () => scheduler.yield()
  : () => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(null);
  });

/** The frames the store holds for the current edit, with their runs computed once per change. */
class Coverage {
  constructor() { this.frames = new Set(); this.version = 0; this.runs = null; }
  has(frame) { return this.frames.has(frame); }
  add(frame) { if (!this.frames.has(frame)) { this.frames.add(frame); this.touch(); } }
  delete(frame) { if (this.frames.delete(frame)) this.touch(); }
  clear() { if (this.frames.size) { this.frames.clear(); this.touch(); } }
  replace(frames) { this.frames = frames; this.touch(); }
  touch() { this.version++; this.runs = null; }
  ranges() { return this.runs ??= previewRanges(this.frames); }
  sorted() { return [...this.frames].sort((a, b) => a - b); }
}

/** Coordinates one disposable renderer, a disk cache, and the editor's playback canvas. */
export function createPreviews({ describe, viewStamp, state, pause, settle, stage, closeMenu, report }) {
  let store = new PreviewStore();
  const images = new PreviewImages();
  const canvas = document.createElement('canvas');
  canvas.id = 'previewStage';
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden', 'true');
  stage.after(canvas);
  const context = canvas.getContext('2d', { alpha: false });
  const renderButton = document.getElementById('tPreviewRender');
  const auto = document.getElementById('tPreviewAuto');
  const clearButton = document.getElementById('tPreviewClear');
  const status = document.getElementById('tPreviewStatus');
  const coverage = document.getElementById('tPreviewCoverage');
  const viewLabel = document.getElementById('tPreviewView');
  let automatic = true;
  try { automatic = localStorage.getItem(AUTO_KEY) !== 'off'; } catch { /* Session preference. */ }
  auto.setAttribute('aria-checked', String(automatic));
  let version = null;
  let snapshot = null;
  let signature = null;
  let stamp = null;
  let dirty = true;
  let generation = 0;
  const available = new Coverage();
  let loaded = false;
  let lastActivity = performance.now();
  let manual = false;
  let manualWaiting = false;
  let manualRequest = 0;
  let task = null;
  let worker = null;
  let workerReady = null;
  let workerSignature = null;
  let pending = new Map();
  let shownPlans = null;
  let error = null;
  let warning = null;
  let faulted = false;
  let full = false;
  let closed = false;
  let decodeCount = 0;
  let shownCount = 0;
  let renderedCount = 0;
  let interruptions = 0;
  let painted = null;
  let reported = null;
  let tickMs = 0;
  let ticks = 0;
  let stalls = 0;
  let resumes = 0;
  let storageBytes = 0;
  let storageEpoch = null;
  let storageDirty = true;
  let storageSync = null;
  let workerUsedAt = 0;
  let releaseWorker = false;

  function observeStore() {
    store.subscribe((change) => {
      if (closed) return;
      if (change.cleared) {
        cancel();
        generation++;
        available.clear();
        images.clear();
        hide();
        loaded = false;
        full = false;
        releaseWorker = true;
      }
      for (const [key, frame] of change.removed ?? []) {
        if (key !== signature) continue;
        available.delete(frame);
        images.delete(frame);
        full = false;
      }
      storageDirty = true;
    });
  }
  observeStore();

  fetch('/preview/renderer', { cache: 'no-store' }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || !/^[a-f0-9]{64}$/.test(body.version)) {
      throw new Error('The renderer version could not be read.');
    }
    version = body.version;
    dirty = true;
  }).catch(fail);

  function syncStorage() {
    if (!storageDirty || storageSync) return;
    storageDirty = false;
    const mine = generation, key = signature;
    const pending = store.status(key).then((result) => {
      if (closed || mine !== generation || key !== signature) { storageDirty = true; return; }
      storageBytes = result.bytes;
      storageEpoch = result.epoch;
      available.replace(result.frames);
      loaded = key !== null;
    }).catch((problem) => {
      if (!closed && mine === generation && key === signature) fail(problem);
    }).finally(() => { if (storageSync === pending) storageSync = null; });
    storageSync = pending;
  }

  function fail(problem) {
    if (closed || problem?.name === 'AbortError') return;
    error = problem?.message ?? String(problem);
    cancel();
    status.textContent = `Preview unavailable: ${error}`;
    status.dataset.state = 'error';
    if (reported !== error) { reported = error; report?.(status.textContent); }
  }

  function hide() {
    canvas.hidden = true;
    shownPlans = null;
  }

  function cancel() {
    if (task && !task.cancelled) { task.cancelled = true; interruptions++; }
    manual = false;
    manualWaiting = false;
    manualRequest++;
  }

  function activity() {
    lastActivity = performance.now();
    cancel();
  }

  function interaction() {
    lastActivity = performance.now();
    if (!manual) cancel();
  }

  function changed() { dirty = true; }

  function refresh(defer = false) {
    const nextStamp = viewStamp();
    if (stamp !== nextStamp) {
      stamp = nextStamp;
      dirty = true;
      activity();
    }
    if (!dirty || !version) return;
    if (defer) {
      if (signature !== null || snapshot !== null) {
        activity();
        generation++;
        signature = snapshot = null;
        available.clear();
        loaded = false;
        images.clear();
        hide();
      }
      return;
    }
    dirty = false;
    const described = describe();
    const next = described ? { ...described, version } : null;
    const key = next ? previewIdentity(next) : null;
    if (key === signature) return;
    activity();
    generation++;
    snapshot = next;
    signature = key;
    available.clear();
    loaded = false;
    full = false;
    error = null;
    reported = null;
    warning = null;
    images.clear();
    hide();
    if (key === null) return;
    storageDirty = true;
    syncStorage();
  }

  function write(node, property, value) {
    if (node[property] !== value) node[property] = value;
  }

  function paint() {
    const current = state();
    if (!current) return;
    const { from, to, fps, viewStart, viewEnd } = current;
    const rendering = task && !task.cancelled;
    const renderingFrame = rendering ? task.frame : null;
    const next = { version: available.version, from, to, fps, viewStart, viewEnd, renderingFrame, signature };
    const same = (...names) => painted !== null && names.every((name) => painted[name] === next[name]);
    const ranges = available.ranges();
    const ready = same('version', 'from', 'to') ? painted.ready
      : ranges.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from) + 1), 0);
    next.ready = ready;
    const total = to - from + 1;
    const text = error ? `Preview unavailable: ${error}`
      : warning ? warning
      : full ? `Cache full · ${ready}/${total} frames ready`
        : rendering ? `Rendering · ${ready}/${total} frames`
          : ready === total ? `Ready · ${total} frame${total === 1 ? '' : 's'}`
            : `${ready}/${total} frames ready`;
    write(status, 'textContent', text);
    const kind = error ? 'error' : full ? 'full' : rendering ? 'rendering' : ready === total ? 'ready' : 'partial';
    write(status.dataset, 'state', kind);
    write(viewLabel, 'textContent', snapshot?.camera.kind === 'free' ? 'Free camera' : 'Camera path');
    write(renderButton, 'textContent', manual && (manualWaiting || rendering) ? 'Stop rendering' : 'Render range');
    write(renderButton, 'disabled', !loaded || !snapshot || Boolean(current.blocked));
    const unchanged = same('version', 'from', 'to', 'fps', 'viewStart', 'viewEnd', 'renderingFrame', 'signature');
    painted = next;
    if (unchanged) return;
    const start = viewStart * fps;
    const span = Math.max(1, (viewEnd - viewStart) * fps);
    const bars = [];
    function addBar(a, b, kind) {
      const left = Math.max(0, 100 * (a - start) / span);
      const right = Math.min(100, 100 * (b + 1 - start) / span);
      if (right <= left) return;
      const bar = document.createElement('i');
      bar.className = kind;
      bar.style.left = `${left}%`;
      bar.style.width = `${right - left}%`;
      bars.push(bar);
    }
    addBar(from, to, 'pending');
    for (const [a, b] of ranges) addBar(a, b, 'ready');
    if (renderingFrame !== null) addBar(renderingFrame, renderingFrame, 'rendering');
    coverage.replaceChildren(...bars);
    coverage.setAttribute('aria-label', `Rendered previews: ${ready} of ${total} frames in the playback range`);
  }

  async function decode(frame) {
    if (!available.has(frame) || images.get(frame)) return;
    if (pending.has(frame)) return pending.get(frame);
    const mine = generation;
    const key = signature;
    const promise = (async () => {
      decodeCount++;
      try {
        const row = await store.read(key, frame);
        if (mine !== generation || closed) return;
        if (!row) { available.delete(frame); paint(); return; }
        const image = await createImageBitmap(row.blob);
        if (mine !== generation || closed) { image.close(); return; }
        if (image.width !== snapshot.width || image.height !== snapshot.height) {
          image.close();
          throw new Error('The cached image has the wrong dimensions.');
        }
        if (!images.put(frame, image, row.plans)) {
          throw new Error('The preview exceeds the decoded image budget. Reduce render % or the viewport size.');
        }
      } catch (problem) {
        if (mine !== generation || closed) return;
        available.delete(frame);
        await store.remove(key, frame).catch(() => {});
        storageDirty = true;
        warning = `A cached frame could not be read; playback will render it live. ${problem.message}`;
        paint();
      } finally {
        decodeCount--;
        if (pending.get(frame) === promise) pending.delete(frame);
      }
    })();
    pending.set(frame, promise);
    return promise;
  }

  function prefetch(from) {
    if (!snapshot || !loaded) return;
    const current = state();
    if (!current) return;
    const count = Math.max(1, Math.min(30, Math.floor(images.limit / (snapshot.width * snapshot.height * 4 * 1.1)) - 2));
    for (let frame = from; frame <= Math.min(current.to, from + count - 1); frame++) {
      if (decodeCount >= 2) break;
      if (available.has(frame) && !images.get(frame) && !pending.has(frame)) decode(frame);
    }
  }

  function show(frame) {
    if (faulted) return false;
    const current = state();
    refresh(current?.moving || current?.busy || current?.blocked);
    if (!signature || state()?.blocked) return false;
    const held = images.get(frame);
    if (!held) { prefetch(frame); return false; }
    if (canvas.width !== held.image.width || canvas.height !== held.image.height) {
      canvas.width = held.image.width;
      canvas.height = held.image.height;
    }
    for (const name of ['width', 'height', 'left', 'top']) canvas.style[name] = stage.style[name];
    context.drawImage(held.image, 0, 0);
    canvas.hidden = false;
    shownPlans = held.plans;
    shownCount++;
    prefetch(frame + 1);
    return true;
  }

  function warm(from) {
    refresh();
    cancel();
    if (!snapshot || !loaded || !available.has(from)) return null;
    return (async () => {
      for (let n = from; n < from + 3 && available.has(n); n++) await decode(n);
      prefetch(from + 3);
    })().catch(disable);
  }

  async function rendererFor(run) {
    workerUsedAt = performance.now();
    if (!worker) {
      const iframe = document.createElement('iframe');
      iframe.className = 'preview-renderer';
      iframe.title = 'Preview renderer';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.src = `/edit?take=${encodeURIComponent(run.snapshot.project.clips[0].take.id)}&preview-renderer=1`;
      worker = iframe;
      workerReady = new Promise((resolve, reject) => {
        const began = performance.now();
        const poll = () => {
          if (closed || worker !== iframe) { reject(cancelled()); return; }
          const api = iframe.contentWindow?.__kinect?.previewRenderer;
          const problem = api?.error();
          if (problem) { reject(new Error(problem)); return; }
          if (api?.ready()) { resolve(api); return; }
          if (performance.now() - began > 60000) { reject(new Error('The preview renderer did not start.')); return; }
          setTimeout(poll, 50);
        };
        setTimeout(poll, 0);
        iframe.addEventListener('error', () => reject(new Error('The preview renderer could not load.')), { once: true });
      });
      document.body.appendChild(iframe);
    }
    const api = await workerReady;
    await checkpoint(run);
    if (workerSignature !== run.signature) {
      await api.prepare(run.snapshot);
      workerSignature = run.signature;
    }
    await checkpoint(run);
    return api;
  }

  async function checkpoint(run) {
    await yieldTask();
    refresh();
    const current = state();
    if (closed || run.cancelled || run.generation !== generation || !current
        || current.from !== run.from || current.to !== run.to
        || current.playing || current.moving || current.busy || current.blocked || document.hidden) {
      throw cancelled();
    }
  }

  async function render(run) {
    try {
      const api = await rendererFor(run);
      const spans = [[run.start, run.to], [run.from, run.start - 1]];
      for (const [from, to] of spans) {
        for (let frame = from; frame <= to; frame++) {
          await checkpoint(run);
          if (available.has(frame)) continue;
          run.frame = frame;
          paint();
          const result = structuredClone(await api.frame(frame, () => checkpoint(run)));
          await checkpoint(run);
          const saved = await store.put(run.signature, frame, result.blob, result.plans, run.epoch);
          if (run.generation !== generation || closed) { storageDirty = true; return; }
          available.add(frame);
          renderedCount++;
          warning = null;
          for (const [key, evicted] of saved.removed) {
            if (key !== signature) continue;
            available.delete(evicted);
            if (evicted >= run.from && evicted <= run.to) full = true;
          }
          storageBytes = saved.total;
          paint();
          if (full) return;
        }
      }
    } catch (problem) {
      if (problem.name !== 'AbortError' && run.generation === generation && !closed) {
        disposeWorker();
        fail(problem);
      }
    } finally {
      if (task === run) {
        task = null;
        if (run.request === manualRequest) manual = false;
        workerUsedAt = performance.now();
        if (releaseWorker || document.hidden) disposeWorker();
        paint();
      }
    }
  }

  function tick(now = performance.now()) {
    guarded(() => advance(now));
    tickMs += performance.now() - now;
    ticks++;
  }

  function guarded(action, fallback = null) {
    if (closed || faulted) return fallback;
    try { return action(); }
    catch (problem) {
      disable(problem);
      return fallback;
    }
  }

  function disable(problem) {
    faulted = true;
    generation++;
    signature = snapshot = null;
    dirty = true;
    loaded = false;
    available.clear();
    images.clear();
    hide();
    fail(problem);
  }

  function disposeWorker() {
    worker?.remove();
    worker = null;
    workerReady = null;
    workerSignature = null;
    releaseWorker = false;
  }

  function advance(now) {
    const current = state();
    if (!current) return;
    refresh(current.moving || current.busy || current.blocked);
    syncStorage();
    if (!task && worker && (releaseWorker || now - workerUsedAt > RENDERER_IDLE_MS)) disposeWorker();
    if (current.playing) { cancel(); prefetch(current.frame + 1); }
    if (current.moving || current.busy || current.blocked) {
      lastActivity = now;
      if (task) cancel();
    }
    paint();
    if (!snapshot || !loaded || task || manualWaiting || full || error || document.hidden || current.playing
        || current.moving || current.busy || current.blocked || (!manual && (!automatic || now - lastActivity < IDLE_MS))) return;
    const { from, to, frame } = current;
    if (available.ranges().some(([a, b]) => a <= from && b >= to)) { manual = false; return; }
    task = { snapshot, signature, generation, epoch: storageEpoch, request: manualRequest,
      from, to, start: Math.max(from, Math.min(to, frame)), frame: null, cancelled: false };
    render(task);
  }

  async function renderRange() {
    if (manual && (manualWaiting || task && !task.cancelled)) { cancel(); paint(); return; }
    pause();
    refresh();
    faulted = false;
    error = null;
    reported = null;
    full = false;
    manual = true;
    manualWaiting = true;
    const request = ++manualRequest;
    await settle();
    if (closed || request !== manualRequest) return;
    manualWaiting = false;
    tick();
  }

  async function clear() {
    cancel();
    generation++;
    images.clear();
    hide();
    available.clear();
    full = false;
    error = null;
    reported = null;
    warning = null;
    faulted = false;
    releaseWorker = true;
    lastActivity = performance.now();
    await store.clear();
    loaded = false;
    storageDirty = true;
    storageBytes = 0;
    if (!task) disposeWorker();
    syncStorage();
    paint();
  }

  renderButton.addEventListener('click', () => {
    closeMenu({ restore: true });
    renderRange().catch(fail);
  });
  clearButton.addEventListener('click', () => {
    closeMenu({ restore: true });
    clear().catch(fail);
  });
  auto.addEventListener('click', () => {
    automatic = !automatic;
    auto.setAttribute('aria-checked', String(automatic));
    if (!manual) activity();
    try { localStorage.setItem(AUTO_KEY, automatic ? 'on' : 'off'); } catch { /* Session preference. */ }
    closeMenu({ restore: true });
  });
  for (const event of ['pointerdown', 'keydown', 'wheel', 'input']) {
    addEventListener(event, interaction, { capture: true, passive: true });
  }
  // A pointer drifting across the page is not work; a press or a drag is.
  addEventListener('pointermove', (event) => { if (event.buttons !== 0) interaction(); }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', activity);
  addEventListener('pagehide', () => {
    closed = true;
    cancel();
    disposeWorker();
    task = null;
    generation++;
    images.clear();
    store.close().catch(() => {});
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted || !closed) return;
    closed = false;
    faulted = false;
    store = new PreviewStore();
    observeStore();
    signature = snapshot = null;
    dirty = storageDirty = true;
    storageSync = null;
    loaded = false;
    lastActivity = performance.now();
  });

  return {
    tick, changed, activity, hide, renderRange, clear,
    show: (frame) => guarded(() => show(frame), false),
    // The frame playback needs now: queued past the prefetch limit, one at a time, and waited for.
    pending: (frame) => guarded(() => {
      const waiting = signature !== null && available.has(frame) && !images.get(frame);
      if (waiting) { decode(frame); stalls++; } else resumes++;
      return waiting;
    }, false),
    warm: (from) => guarded(() => warm(from)),
    prefetch: (from) => guarded(() => prefetch(from)),
    firstMissing: (from, to) => {
      for (let frame = from; frame <= to; frame++) if (!available.has(frame)) return frame;
      return null;
    },
    plan: (clip) => shownPlans?.[clip] ?? null,
    inspect: () => ({
      automatic, ready: available.sorted(), loaded, rendering: Boolean(task && !task.cancelled),
      rendered: renderedCount, shown: shownCount, interruptions, error, warning, full, faulted, renderer: Boolean(worker),
      tickMs, ticks, stalls, resumes,
      memoryBytes: images.bytes, memoryLimit: images.limit, storageBytes, storageLimit: store.limit,
      view: snapshot?.camera.kind ?? null, width: snapshot?.width ?? null, height: snapshot?.height ?? null,
      cached: !canvas.hidden, generation, signature,
    }),
  };
}
