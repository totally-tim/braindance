// Drawing a take: one frame of depth onto a 2D canvas, a scrubbable surface over that canvas,
// and the mark ticks on a scrub bar. The take is not fixed at construction - `show` changes it,
// so one skim can walk across a cut - and nothing here knows about clips or program time.

import { frameAtOrBefore, sourceTimes } from './clip-plan.js';
import { DEPTH_H, DEPTH_W } from './format.js';

// How coarsely a take's frames may be asked for. A take that is only on the node crosses the
// network for every scrub position, so it is fetched at a quarter.
const DIVISOR = { local: 1, both: 1, remote: 4 };

/** How coarsely this take's frames are fetched. A surface that says so reads it too. */
export const divisorFor = (take) => DIVISOR[take?.state] ?? 1;

// How long a take whose frame times did not arrive waits before they are asked for again.
const TIMES_RETRY_MS = 5000;
// Takes whose frame times are held, oldest dropped first. Keyed by hash, because a hash names
// bytes that never change and every surface here is rebuilt on each refresh.
const TIMED_TAKES = 64;
const timesByKey = new Map();

/**
 * A take's frame times in source seconds, from the stamps in its index: the take here, or the
 * node's copy through this server. `times` is null until they land and `error` says why they
 * did not; `ready` settles either way and never rejects.
 */
export function timesFor(take) {
  const key = take.hash ?? `${take.state}:${take.id}`;
  const held = timesByKey.get(key);
  timesByKey.delete(key);
  if (held && !(held.error && Date.now() - held.failedAt > TIMES_RETRY_MS)) {
    timesByKey.set(key, held);
    return held;
  }
  const entry = { times: null, error: null, failedAt: 0, ready: null };
  const url = take.state === 'remote'
    ? `/library/remote-index/${encodeURIComponent(take.hash)}`
    : `/capture/${encodeURIComponent(take.hash)}/index`;
  entry.ready = fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 80)}`);
      return res.json();
    })
    .then((index) => {
      const stamps = index?.frames?.stampMs;
      // Against the listing, because a take renamed or replaced since is another take's index.
      if (take.hash && index.hash !== take.hash) throw new Error('the index is of another take');
      if (!Array.isArray(stamps) || stamps.length !== take.frames || !stamps.every(Number.isFinite)) {
        throw new Error(`the index carries no stamp for each of its ${take.frames} frames`);
      }
      entry.times = sourceTimes(stamps);
    })
    .catch((err) => {
      entry.error = err.message;
      entry.failedAt = Date.now();
    });
  timesByKey.set(key, entry);
  if (timesByKey.size > TIMED_TAKES) timesByKey.delete(timesByKey.keys().next().value);
  return entry;
}

// One frame of a take, drawn to a 2D canvas. Depth rather than the colour JPEG, because
// `--no-color` records none. Never sizes the backing store - the box is CSS.
function drawFrame(canvas, take, payload) {
  const W = canvas.width;
  const H = canvas.height;
  if (!W || !H) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04060a';
  ctx.fillRect(0, 0, W, H);
  if (!payload) return;

  const divisor = divisorFor(take);
  const view = new DataView(payload);
  const depthBytes = view.getUint32(0, true);
  const gw = Math.ceil(DEPTH_W / divisor);
  const gh = Math.ceil(DEPTH_H / divisor);
  if (depthBytes !== gw * gh * 2) return;
  const depth = new Uint16Array(payload, 16, depthBytes / 2);

  const fx = (take.hello?.fx ?? 366) / divisor;
  const fy = (take.hello?.fy ?? 366) / divisor;
  const cx = (take.hello?.cx ?? DEPTH_W / 2) / divisor;
  const cy = (take.hello?.cy ?? DEPTH_H / 2) / divisor;

  const scale = H * 1.15;
  const ox = W / 2;
  const oy = H * 0.42;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  // From the sensor's own focal length and never the decimated one, so a coarse frame is
  // visibly sparser rather than splatted up to look local.
  const fxFull = take.hello?.fx ?? 366;
  const splat = Math.max(1, Math.round(scale / fxFull));
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const mm = depth[y * gw + x];
      if (mm === 0) continue;
      const z = mm / 1000;
      if (z < 0.4 || z > 6) continue;
      // The negation on x is the mirror correction: the sensor's frames arrive flipped.
      const wx = (-(x - cx) * z) / fx;
      const wy = -((y - cy) * z) / fy;
      const sx = Math.round(ox + (wx * scale) / z);
      const sy = Math.round(oy - (wy * scale) / z);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const v = Math.max(24, Math.round(255 * Math.max(0, (5 - z) / 5)));
      for (let dy = 0; dy < splat; dy++) {
        const py = sy + dy;
        if (py >= H) break;
        for (let dx = 0; dx < splat; dx++) {
          const qx = sx + dx;
          if (qx >= W) break;
          const i = (py * W + qx) * 4;
          px[i] = v; px[i + 1] = v; px[i + 2] = Math.min(255, v + 12); px[i + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * The take's marks as ticks on a scrub bar, at their source time. `onPick` makes each one a
 * button handed the mark's source seconds; without it they are labels.
 */
export function paintMarks(bar, take, onPick = null) {
  for (const old of bar.querySelectorAll('.mk')) old.remove();
  const durationMs = Math.max(1, take.durationSec * 1000);
  for (const m of take.marks ?? []) {
    // Through the DOM and not a template: a mark's label is text from outside this page.
    const tick = document.createElement(onPick ? 'button' : 'span');
    tick.className = 'mk';
    const at = Math.max(0, Math.min(1, m.sourceMs / durationMs));
    tick.style.left = `${at * 100}%`;
    tick.title = `${m.label ?? m.id} · ${(m.sourceMs / 1000).toFixed(2)}s`;
    if (onPick) {
      tick.type = 'button';
      tick.dataset.act = 'mark';
      tick.addEventListener('click', (e) => { e.stopPropagation(); onPick(m.sourceMs / 1000); });
    }
    bar.appendChild(tick);
  }
}

/**
 * A scrubbable surface over whichever take `show` has been given. A position is a frame index,
 * so a caller's arrows step one frame, and the bar under it is the take's time: a fraction of
 * the bar or a source second finds its frame through `frameAtOrBefore` over the take's stamps.
 * `onDraw(index, requested, take)` runs when a position is asked for and again when the frame
 * for it lands.
 *
 * `bar` is the scrub bar of the take being drawn: the skim fills it from the position within
 * that take, so a surface whose bar measures something else - an edit rather than a take -
 * passes none and draws its own.
 */
export function createSkim({ canvas, surface, bar = null, onDraw }) {
  let take = null;
  // Zero is a real answer and not clamped: frame 0 of a take with no whole frame is a 404.
  let frames = 0;
  let last = 0;
  // The shown take's frame times, and the move asked for before they landed. Nothing moves
  // without them except to frame 0, which is at time 0 whatever the stamps say.
  let times = null;
  let waiting = null;
  const pos = bar?.querySelector('.pos') ?? null;
  const done = bar?.querySelector('.done') ?? null;
  let wanted = 0;
  let showing = -1;
  let busy = false;
  // Set by `release` and checked past every await, so a pump outliving its surface stops.
  let released = false;
  // Kept so a resize can redraw the frame on screen; a window drag is a stream of resizes.
  let payload = null;

  // By content hash, so a rename landing mid-skim can never draw another take under this one's name.
  const frameAt = async (t, n) => {
    const url = t.state === 'remote'
      ? `/library/remote-frame/${encodeURIComponent(t.hash)}/${n}?decimate=${divisorFor(t)}`
      : `/capture/${encodeURIComponent(t.hash)}/frame/${n}?decimate=${divisorFor(t)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.arrayBuffer();
  };

  // Whether the shown take's times are here, asking for them if not. A move that needed them
  // runs when they land.
  const timed = () => {
    if (times) return true;
    if (!take || frames === 0) return false;
    const mine = take;
    const entry = timesFor(mine);
    if (entry.times) {
      times = entry.times;
      return true;
    }
    entry.ready.then(() => {
      if (released || take !== mine || times || !entry.times) return;
      times = entry.times;
      const move = waiting;
      waiting = null;
      move?.();
    });
    return false;
  };

  // The bar at the shown frame's time, as a fraction of the take's.
  const place = () => {
    const span = times?.[last] ?? 0;
    const at = span > 0 ? Math.max(0, Math.min(1, times[wanted] / span)) : 0;
    if (pos) pos.style.left = `${at * 100}%`;
    if (done) done.style.width = `${at * 100}%`;
  };

  const pump = async () => {
    if (released) return;
    if (frames === 0) {
      drawFrame(canvas, take, null);
      onDraw?.(0, false, take);
      return;
    }
    if (busy) return;
    busy = true;
    try {
      while (true) {
        const mine = take;
        const n = wanted;
        // A take swapped for one with no frames - a project's missing footage - ends the pump
        // the way an empty take entering it does.
        if (frames === 0) {
          drawFrame(canvas, mine, null);
          onDraw?.(0, false, mine);
          break;
        }
        let got = null;
        try {
          got = await frameAt(mine, n);
        } catch { /* a take deleted mid-skim draws nothing rather than throwing */ }
        if (released) return;
        // The await above is where the take changes, so `got` may be the old take's frame:
        // thrown away and asked again rather than drawn under the new take's name. Asked
        // again and not returned from, because the caller is waiting on this pump.
        if (take !== mine) continue;
        payload = got;
        showing = n;
        drawFrame(canvas, mine, got);
        onDraw?.(n, false, mine);
        if (n === wanted) break;
      }
    } finally {
      busy = false;
    }
  };

  const api = {
    get frames() { return frames; },
    get index() { return wanted; },
    get seconds() { return times ? times[wanted] : 0; },

    /**
     * The take drawn from now on, `null` for one that is not here. Nothing is drawn until the
     * next seek, so a caller crossing a cut leaves the frame it had rather than flashing.
     */
    show(next) {
      take = next;
      frames = Math.max(0, next?.frames ?? 0);
      last = Math.max(0, frames - 1);
      wanted = Math.min(wanted, last);
      showing = -1;
      // The old take's frame, which would otherwise be redrawn by a resize under the new name.
      payload = null;
      times = null;
      waiting = null;
    },

    setIndex(n) {
      const k = Math.max(0, Math.min(last, Math.round(n)));
      if (k > 0 && !timed()) {
        waiting = () => api.setIndex(k);
        return wanted;
      }
      waiting = null;
      wanted = k;
      place();
      onDraw?.(wanted, true, take);
      pump();
      return wanted;
    },
    /** To the frame at or before a source second, the frame the editor brackets it with. */
    seek(sourceSec) {
      if (!timed()) {
        waiting = () => api.seek(sourceSec);
        return wanted;
      }
      return api.setIndex(frameAtOrBefore(times, sourceSec));
    },
    /** To a fraction of the take's time. */
    setT(t) {
      if (!timed()) {
        waiting = () => api.setT(t);
        return wanted;
      }
      return api.seek(Math.max(0, Math.min(1, t)) * times[last]);
    },
    step(by) { return api.setIndex(wanted + by); },
    fromX(clientX, el) {
      const r = el.getBoundingClientRect();
      return api.setT((clientX - r.left) / r.width);
    },
    repaint() { drawFrame(canvas, take, payload); },
    get showing() { return showing; },
  };

  // A ResizeObserver, not a window `resize`: a grid reflowing its columns also resizes the
  // tile, and a canvas resized is a canvas cleared.
  const dpr = () => Math.min(devicePixelRatio || 1, 2);
  const fit = () => {
    const r = surface.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr()));
    const h = Math.max(1, Math.round(r.height * dpr()));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    api.repaint();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(surface);
  fit();
  api.release = () => {
    released = true;
    ro.disconnect();
  };
  return api;
}
