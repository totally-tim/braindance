import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function createLibraryDom() {
  const html = readFileSync(new URL('../web/library.html', import.meta.url), 'utf8');
  const bodyHtml = html.match(/<body>([\s\S]*?)<script\b/i)?.[1] ?? '';
  const camelToKebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  let doc;
  class MockElement {
    constructor(tagName) {
      Object.assign(this, {
        tagName: tagName.toUpperCase(), id: '', className: '', disabled: false, hidden: false,
        open: false, value: '', title: '', type: '', role: '', tabIndex: 0, parentElement: null,
        children: [], _text: '', _attrs: Object.create(null), _dataset: Object.create(null),
        _listeners: new Map(), style: { position: '', left: '', width: '', top: '', bottom: '', maxHeight: '' },
      });
      this.dataset = new Proxy(this._dataset, {
        get: (t, k) => t[k],
        set: (t, k, v) => { t[k] = String(v); this._attrs[`data-${camelToKebab(String(k))}`] = String(v); return true; },
      });
      this.classList = {
        contains: (c) => this.className.split(/\s+/).filter(Boolean).includes(c),
        add: (c) => { if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim(); },
        toggle: (c, force) => {
          const next = force === undefined ? !this.classList.contains(c) : Boolean(force);
          const list = this.className.split(/\s+/).filter((x) => x && x !== c);
          if (next) list.push(c);
          this.className = list.join(' ');
          return next;
        },
      };
      if (this.tagName === 'CANVAS') {
        const mockCanvas = makeMockCanvas(320, 180);
        this.width = mockCanvas.width;
        this.height = mockCanvas.height;
        this.getContext = (kind) => {
          const ctx = mockCanvas.getContext(kind);
          ctx.getImageData = (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
          return ctx;
        };
      }
    }
    get isConnected() {
      for (let cur = this; cur; cur = cur.parentElement) if (cur === doc.body) return true;
      return false;
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); this._text = String(v ?? ''); }
    set innerHTML(markup) { this.replaceChildren(); parseInto(this, String(markup ?? '')); }
    get innerHTML() { return this.textContent; }
    setAttribute(k, v) {
      const str = String(v);
      this._attrs[k] = str;
      if (k === 'id') this.id = str;
      else if (k === 'class') this.className = str;
      else if (k.startsWith('data-')) this._dataset[kebabToCamel(k.slice(5))] = str;
    }
    getAttribute(k) { return k === 'id' ? (this.id || null) : k === 'class' ? (this.className || null) : (this._attrs[k] ?? null); }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    append(...items) {
      for (const item of items) {
        if (typeof item === 'string') { const t = new MockElement('#text'); t._text = item; this.appendChild(t); }
        else if (item) this.appendChild(item);
      }
    }
    replaceChildren(...items) {
      for (const c of this.children) c.parentElement = null;
      this.children = [];
      this._text = '';
      this.append(...items);
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
    replaceWith(other) {
      if (!this.parentElement) return;
      const p = this.parentElement;
      const idx = p.children.indexOf(this);
      if (idx >= 0) { if (other.parentElement) other.remove(); other.parentElement = p; p.children[idx] = other; }
      this.parentElement = null;
    }
    cloneNode(deep = false) {
      const copy = new MockElement(this.tagName);
      Object.assign(copy, { id: this.id, className: this.className, disabled: this.disabled, hidden: this.hidden, title: this.title, type: this.type, role: this.role, _text: this._text });
      Object.assign(copy._attrs, this._attrs);
      Object.assign(copy._dataset, this._dataset);
      Object.assign(copy.style, this.style);
      if (deep) for (const c of this.children) copy.appendChild(c.cloneNode(true));
      return copy;
    }
    contains(other) {
      for (let cur = other; cur; cur = cur.parentElement) if (cur === this) return true;
      return false;
    }
    addEventListener(type, fn) {
      const list = this._listeners.get(type) ?? [];
      list.push(fn);
      this._listeners.set(type, list);
    }
    dispatchEvent(ev = {}) {
      if (!ev.target) ev.target = this;
      ev.preventDefault ??= () => {};
      ev.stopPropagation ??= () => {};
      for (let cur = this; cur; cur = ev.bubbles ? cur.parentElement : null) {
        for (const fn of cur._listeners.get(ev.type) ?? []) fn(ev);
      }
      return true;
    }
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click', bubbles: true }); }
    focus() { doc.activeElement = this; }
    select() {}
    setPointerCapture() {}
    hasPointerCapture() { return false; }
    getBoundingClientRect() { return { width: 320, height: 180, top: 0, left: 0, bottom: 180, right: 320 }; }
    showModal() { this.open = true; if (!this.contains(doc.activeElement)) (this.querySelector('button, input') ?? this).focus(); }
    close() { if (this.open) { this.open = false; this.dispatchEvent({ type: 'close', bubbles: false }); } }
    matches(selector) { return selector.split(',').some((part) => matchesChain(this, part.trim().split(/\s+/))); }
    closest(selector) {
      for (let cur = this; cur && cur.tagName !== '#TEXT'; cur = cur.parentElement) if (cur.matches(selector)) return cur;
      return null;
    }
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => { for (const c of node.children) if (c.tagName !== '#TEXT') { if (c.matches(selector)) out.push(c); visit(c); } };
      visit(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }

  function matchesSingle(el, step) {
    if (!el || el.tagName === '#TEXT') return false;
    let rest = step;
    if (rest.includes(':not([hidden])')) { if (el.hidden) return false; rest = rest.replace(':not([hidden])', ''); }
    if (rest.includes(':not(.vclose)')) { if (el.classList.contains('vclose')) return false; rest = rest.replace(':not(.vclose)', ''); }
    for (const m of rest.matchAll(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g)) {
      const val = el.getAttribute(m[1]);
      if (m[2] !== undefined ? val !== m[2] : val === null) return false;
    }
    rest = rest.replace(/\[[^\]]+\]/g, '');
    for (const m of rest.matchAll(/#([a-zA-Z0-9_-]+)/g)) if (el.id !== m[1]) return false;
    rest = rest.replace(/#[a-zA-Z0-9_-]+/g, '');
    for (const m of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) if (!el.classList.contains(m[1])) return false;
    rest = rest.replace(/\.[a-zA-Z0-9_-]+/g, '').trim();
    return !rest || el.tagName === rest.toUpperCase();
  }

  function matchesChain(el, chain) {
    if (!matchesSingle(el, chain[chain.length - 1])) return false;
    let cur = el.parentElement;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (cur && !matchesSingle(cur, chain[i])) cur = cur.parentElement;
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function parseInto(root, fragment) {
    const stack = [root];
    const tokenRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9]+)((?:\s+[^>]*)?)(\/?)>|([^<]+)/g;
    for (const m of fragment.matchAll(tokenRe)) {
      if (m[0].startsWith('<!--')) continue;
      if (m[5] !== undefined) {
        const text = m[5].replace(/&lt;/g, '<').replace(/&times;/g, '×').replace(/&mdash;/g, '—');
        if (text.trim() || stack[stack.length - 1].children.length === 0) {
          const t = new MockElement('#text');
          t._text = text;
          stack[stack.length - 1].appendChild(t);
        }
        continue;
      }
      if (m[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const tag = m[2].toLowerCase();
      const el = new MockElement(tag);
      for (const a of (m[3] ?? '').matchAll(/([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g)) {
        if (a[1] === 'hidden') el.hidden = true;
        else if (a[1] === 'disabled') el.disabled = true;
        else el.setAttribute(a[1], a[2] ?? '');
      }
      stack[stack.length - 1].appendChild(el);
      if (m[4] !== '/' && tag !== 'input' && tag !== 'link' && tag !== 'meta') stack.push(el);
    }
  }

  const body = new MockElement('body');
  doc = {
    body, documentElement: body, activeElement: body,
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => body.querySelector(`#${id}`),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (type, fn) => body.addEventListener(type, fn),
  };
  parseInto(body, bodyHtml);
  return doc;
}

async function bootLibraryModule(fetchImpl, transformSource = (s) => s) {
  const doc = createLibraryDom();
  const resolveWeb = (f) => JSON.stringify(new URL(`../web/${f}`, import.meta.url).href);
  let src = readFileSync(new URL('../web/library.js', import.meta.url), 'utf8')
    .replace("from '/format.js'", `from ${resolveWeb('format.js')}`)
    .replace("from '/record-poll.js'", `from ${resolveWeb('record-poll.js')}`)
    .replace("from '/test-timers.js'", `from ${resolveWeb('test-timers.js')}`)
    .replace("from './take-draw.js'", `from ${resolveWeb('take-draw.js')}`)
    .replace('pollRecordState(async', '(() => {})(async');
  src = transformSource(src);

  const keys = ['document', 'location', 'CSS', 'KeyboardEvent', 'requestAnimationFrame', 'ResizeObserver', 'devicePixelRatio', 'fetch', '__library'];
  const prev = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  Object.assign(globalThis, {
    document: doc,
    location: { search: '', href: 'http://127.0.0.1/library' },
    CSS: { escape: (s) => String(s) },
    KeyboardEvent: class { constructor(type, i = {}) { Object.assign(this, { type, key: i.key ?? '', shiftKey: Boolean(i.shiftKey), bubbles: Boolean(i.bubbles), cancelable: Boolean(i.cancelable) }); } },
    requestAnimationFrame: () => 1,
    ResizeObserver: class { observe() {} disconnect() {} },
    devicePixelRatio: 1,
    fetch: fetchImpl,
  });
  const restore = () => { for (const k of keys) if (prev[k] === undefined) delete globalThis[k]; else globalThis[k] = prev[k]; };
  await import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`);
  return { doc, api: globalThis.__library, restore };
}

test('a take opened while its hash is still settling stays open and keeps its position when the hash arrives', async () => {
  const settledOtherHash = `sha256:${'1'.repeat(64)}`;
  const settledTargetHash = `sha256:${'2'.repeat(64)}`;
  const depthBytes = DEPTH_W * DEPTH_H * 2;
  const frameBuf = new ArrayBuffer(16 + depthBytes);
  new DataView(frameBuf).setUint32(0, depthBytes, true);
  const hello = { fx: 366, fy: 366, cx: DEPTH_W / 2, cy: DEPTH_H / 2 };

  let currentTakes = [
    { id: 'shared-take', hash: settledOtherHash, state: 'local', recording: false, bytes: 12e6, frames: 4, durationSec: 2, capturedAt: 2000, marks: [], openRefusals: [], openable: true, hello },
    { id: 'shared-take', hash: null, state: 'remote', recording: true, bytes: 8e6, frames: null, durationSec: 0, capturedAt: 1900, marks: [], openRefusals: [{ key: 'recording', why: 'still recording' }], openable: false, hello },
    { id: 'settling-dup', hash: null, state: 'local', recording: false, bytes: 9e6, frames: 4, durationSec: 1, capturedAt: 1800, marks: [{ t: 0.5 }], openRefusals: [], openable: true, hello },
  ];
  let failIndex = false;
  const storage = { freeBytes: 1e10, bytesPerSec: 1e6, secondsLeft: 10000, label: '10 GB', error: null };
  const reveal = { available: false, label: null, why: null };
  const fetchImpl = async (url) => {
    if (String(url).startsWith('/library/all')) {
      return { ok: true, status: 200, json: async () => ({ takes: currentTakes, node: { name: 'pi', reachable: true, error: null }, here: 'mac', storage, reveal }) };
    }
    if (String(url).includes('index')) {
      if (failIndex) return { ok: false, status: 503, text: async () => 'index unavailable' };
      const hash = decodeURIComponent(String(url).match(/\/(?:capture|remote-index)\/([^/?]+)/)?.[1] ?? '');
      return { ok: true, status: 200, json: async () => ({ hash: hash === 'null' ? null : hash, frames: { stampMs: [0, 33, 66, 100] } }) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => frameBuf };
  };

  const { doc, api, restore } = await bootLibraryModule(fetchImpl);
  try {
    const tiles = api.tiles();
    const unsettledRemote = tiles.find((t) => t.id === 'shared-take' && t.state === 'remote');
    const unsettledLocal = tiles.find((t) => t.id === 'settling-dup');
    assert.equal(unsettledRemote?.hash, null, 'an unsettled tile reports hash: null so tile.hash ?? tile.id names its id');
    assert.equal(unsettledLocal?.hash, null, 'every unsettled tile reports hash: null rather than the empty string');

    api.viewer.open(unsettledRemote.hash ?? unsettledRemote.id);
    assert.equal(api.viewer.isOpen(), true, 'viewer.open(tile.hash ?? tile.id) opens the unsettled take');
    assert.doesNotMatch(doc.getElementById('vFacts').textContent, /null frames/);
    assert.match(doc.getElementById('vFacts').textContent, /recording now/);

    currentTakes = [
      currentTakes[0],
      { ...currentTakes[1], hash: settledTargetHash, recording: false, frames: 4, durationSec: 1, openRefusals: [], openable: true },
      currentTakes[2],
    ];
    await api.refresh();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(api.viewer.isOpen(), true, 'viewer stays open when the remote take settles its hash');
    assert.equal(api.viewer.state().hash, settledTargetHash, 'viewer resolves the settling take on the same side rather than an earlier take sharing its id');
    assert.match(doc.getElementById('vFacts').textContent, /4 frames/);
    api.viewer.key('ArrowRight');
    assert.equal(api.viewer.state().index, 1);
    api.viewer.key('ArrowUp');
    assert.equal(api.viewer.state().hash, settledOtherHash, 'ArrowUp from the second of two takes sharing an id steps to the first');
    assert.equal(api.viewer.state().index, 0, 'stepping to a different take that shares an id starts at frame 0');
    api.viewer.key('ArrowDown');
    assert.equal(api.viewer.state().hash, settledTargetHash, 'ArrowDown returns to the second take');
    api.viewer.key('ArrowDown');
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(api.viewer.state().id, 'settling-dup', 'ArrowDown from the second take advances to the third take instead of looping on the shared id');
    assert.equal(api.viewer.state().hash, null);
    api.viewer.key('ArrowRight');
    api.viewer.key('ArrowRight');
    assert.equal(api.viewer.state().index, 2, 'scrubbed to frame 2 before the hash settled');

    failIndex = true;
    currentTakes = [
      currentTakes[0],
      currentTakes[1],
      { ...currentTakes[2], id: 'canonical-dup', names: ['canonical-dup', 'settling-dup'], hash: `sha256:${'3'.repeat(64)}` },
    ];
    await api.refresh();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    assert.equal(api.viewer.isOpen(), true, 'viewer stays open when the take hash settles and folds into names');
    assert.equal(api.viewer.state().hash, `sha256:${'3'.repeat(64)}`, 'viewer adopts the settled hash');
    assert.equal(api.viewer.state().index, 2, 'viewer keeps the operator frame index across hash settlement');
    assert.equal(doc.getElementById('note').textContent, '', 'does not claim the take is no longer in the media library');
    assert.match(api.viewer.state().note, /its marks cannot be pressed: the frame times did not arrive/);
  } finally {
    api.viewer.close();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    restore();
  }

  let controlTakes = [
    { id: 'settling-control', hash: null, state: 'local', recording: true, bytes: 8e6, frames: null, durationSec: 0, capturedAt: 1900, marks: [], openRefusals: [{ key: 'recording', why: 'still recording' }], openable: false, hello },
  ];
  const controlBoot = await bootLibraryModule(
    async (url) => (String(url).startsWith('/library/all')
      ? { ok: true, status: 200, json: async () => ({ takes: controlTakes, node: null, here: 'mac', storage, reveal }) }
      : { ok: true, status: 200, json: async () => ({ hash: settledTargetHash, frames: { stampMs: [0, 33] } }), arrayBuffer: async () => frameBuf }),
    (src) => src
      .replace('  return library.takes.find((t) => matchesId(t, key)) ?? null;', '  return null;')
      .replace('  if (viewing?.key === key) {', '  if (false && viewing?.key === key) {'),
  );
  try {
    controlBoot.api.viewer.open('settling-control');
    assert.equal(controlBoot.api.viewer.isOpen(), true);
    controlTakes = [{ ...controlTakes[0], hash: settledTargetHash, recording: false, frames: 2, durationSec: 1, openRefusals: [], openable: true }];
    await controlBoot.api.refresh();
    assert.equal(controlBoot.api.viewer.isOpen(), false, 'falsification control: without id fallback, settling closes the viewer');
    assert.equal(controlBoot.doc.getElementById('note').textContent, 'that take is no longer in the media library');
  } finally {
    controlBoot.api.viewer.close();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    controlBoot.restore();
  }
});
