// The gallery. Takes are tiles you can skim rather than rows you have to open:
// moving across a tile scrubs that take, and the take's marks sit on the scrub bar
// underneath, so the moments someone flagged in the room are visible before the
// take is opened at all.
//
// **There is no proxy, and that is a deliberate deletion.** An earlier draft of the
// design called for a reduced-resolution depth pyramid built at import; settling
// what a draft scrub actually costs removed the need, and it was then measured at
// 2.7ms against the master. So a skim here is one frame pulled through the same
// frame API the editor reads, decoded and drawn, and nothing is stored: no
// generation pass, no second artifact per take, no staleness question. A rendered
// video poster was rejected separately, because it bakes one look at import and the
// draft image would stop matching the edit the moment the grade changed.
//
// **Skimming costs different amounts depending on where the take is, so it looks
// different.** A local take scrubs at the measured 2.7ms. A remote one goes through
// the decimation parameter - the same depth divisor the monitor negotiates, applied
// to the frame API - at roughly 21ms a position over that 3.8 MB/s link, which is
// browsable and not smooth. A gallery that skimmed both identically would be
// promising a responsiveness the architecture does not have, so remote tiles
// decimate visibly and say so.
//
// **Skimming is a pointer affordance, so nothing is gated behind it.** The library
// runs on the node's touch panel, where there is no hover at all. Download, open,
// reclaim, rename, reveal and delete are reachable by tap at all times - on the tile
// or one tap into the ⋯ menu; skimming is how you find the take you want, never how
// you act on one.
//
// ---
//
// **There are two surfaces here and the split is what each size is good for.** A
// 228px tile is enough to recognise a take and not enough to look at one, so the
// grid answers "which take" and the viewer - one take, large, opened by tapping its
// poster - answers "what is in it". Both scrub through `createSkim` rather than
// through two copies of the pump: a second implementation of "ask for a frame,
// throw away the ones that arrived late, draw the one that did not" is a second
// place for the drag to lag the finger.
//
// **A tile's height is a property of this file and not of the take it shows**, which
// it was not until the layout was measured. Warnings rendered as extra lines under
// the poster, so `no-hello-take` carried two of them and stood 41.19px taller than a
// take with none, at every viewport width tested; a fourth action button wrapped to a
// second row on `both` takes and nowhere else; and the poster's height was assigned
// in JavaScript from a measured width, which was right at first paint and stale after
// every resize - 2.496:1 against the 16:9 it draws, measured dragging 1512 to 700. So
// the poster's box is CSS, the rows below it are one line each, and the warnings sit
// over the picture where they cost no height. See `library.html` for each of those in
// the place it is enforced.

import { DEPTH_H, DEPTH_W, VALID_ID } from '/format.js';
import { pollRecordState } from '/record-poll.js';

// The depth divisor per state. A local take is read whole; a take that is only on
// the node comes through the divisor, which is what turns a 486KB frame into about
// 79KB - 27KB of depth plus the colour block carried through untouched, since
// colour is what a decimated frame mostly is.
const DIVISOR = { local: 1, both: 1, remote: 4 };

const grid = document.getElementById('grid');
const dlg = document.getElementById('confirm');
const noteEl = document.getElementById('note');
const vSayEl = document.getElementById('vSay');

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
// The wall clock the take was shot on, in the zone of whoever is reading the
// gallery. `toISOString` was the first spelling of this and it is UTC by
// definition, so every tile in a CEST room read two hours early - a take shot at
// 03:40 filed as 01:40, which is the one field an operator uses to tell this
// afternoon's takes from last night's. Built from the local getters rather than
// `toLocaleString` so the shape stays the sortable `YYYY-MM-DD HH:MM` the tiles are
// laid out for, whatever locale the browser is set to.
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// **Every field `paint` reads, because `paint` can now run against it.** This is what the
// page holds before the first listing lands, and until the load was allowed to fail it
// was never drawn - so `storage` being absent cost nothing and stayed absent. The moment
// a failed first listing paints an empty shelf instead of ending module evaluation,
// `paint` reads `library.storage.label` off `undefined` and throws from inside the very
// catch that was meant to keep the page alive, stranding it exactly as before for a
// second reason. `remaining` reports the same fields, so what the page draws before it
// has asked and what it draws after are one shape rather than two.
//
// `secondsLeft` at `Infinity` rather than zero: the readout below turns red under fifteen
// minutes, and a page that has not asked yet has not been told the card is nearly full.
let library = {
  takes: [],
  node: null,
  here: '?',
  storage: {
    // A dash rather than a sentence, because the readout reads `<label> left at current
    // settings` and any phrase here becomes a claim inside it.
    freeBytes: null, bytesPerSec: null, secondsLeft: Infinity, label: '—', error: null,
  },
  reveal: { available: false, label: null, why: null },
};
let filter = 'all';

// **Written to both status lines, because a modal covers one of them.** `#note` sits
// under the grid, which is exactly where an operator cannot see it while the viewer is
// open - so a download started from the viewer put its progress, and its failure, on a
// surface behind the one being looked at. The viewer runs for the minutes a transfer
// takes, so this was the whole of what it had to say. Both rather than a branch: the
// hidden one costs a `textContent` write and `:empty` keeps it out of the layout.
const say = (text) => {
  noteEl.textContent = text;
  vSayEl.textContent = text;
};

async function jsonOf(url, init) {
  const res = await fetch(url, init);
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body;
}

/**
 * Every call on this page that changes something, in one shape.
 *
 * The method and the JSON content type are both required by the server now, and the
 * content type is the load-bearing half: a page you merely visit can send a
 * cross-origin POST without asking permission, but it cannot declare
 * `application/json` while doing it. Written once here because five call sites each
 * spelling out their own headers is five chances for one of them to be the request
 * that gets refused in front of an operator.
 */
const post = (url, body) => jsonOf(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

// -------------------------------------------------------------- what a take says

/**
 * The badge each refusal wears over a poster, as a table rather than a conditional
 * with an else on the end.
 *
 * The sentence under a badge is the server's and this is the part that is not: a
 * 228px poster is a page constraint, and "no frames" against "< 2 frames" is a
 * distinction only something drawing the tile can be asked to make. Zero and one are
 * different facts and the badge says which - a take cut before its first whole frame
 * has no picture to show at all, which is why the skim never asks for one, where a
 * single-frame take has exactly one and draws it. Reading `< 2 frames` on a tile with
 * a blank poster would send somebody looking for the frame it has.
 *
 * **A key with no entry here reads as itself.** The first spelling of this was
 * `key === 'short' ? … : 'no hello'`, which is a table of two wearing an else - so a
 * third refusal, of the kind the server is free to add and which has since arrived,
 * would have been badged "no hello" over a take that has one. Visibly unmapped beats
 * confidently wrong, and `library-check` asserts the two tables agree rather than
 * leaving it to be noticed.
 *
 * **No prototype, because the keys come off the wire and `Object.prototype` answers to
 * some of them.** A refusal key is a string another machine chose - `NodeLink` gates
 * the *shape* of a manifest and deliberately not its vocabulary, so that a newer node
 * can name a reason this build has never heard of and get the fallback above - and an
 * ordinary object literal answers `BADGES['__proto__']` with its own prototype rather
 * than with `undefined`. The `?.` then does not short-circuit, the call throws on a
 * value that is not a function, and the gallery dies painting the tile: the same blank
 * shelf the version gate exists to prevent, arriving through the door the gate was
 * told to leave open. `constructor`, `toString` and `valueOf` do not throw and are
 * worse, badging a take `[object Object]` under a promise that an unmapped key reads
 * as itself.
 *
 * Fixed at the table rather than at the one lookup, because the lookup is one today
 * and the property that makes it safe belongs to the table. `Object.keys` still sees
 * exactly the three entries, which is what `badgeKeys()` reports.
 */
const BADGES = Object.assign(Object.create(null), {
  'no-hello': () => 'no hello',
  // The third refusal the paragraph above predicted, arriving exactly as predicted: the
  // server grew a capture-format band and this table gained a label and nothing else.
  // The label is short because the sentence is `refusal.why` and the server wrote it -
  // which matters more here than for its neighbours, since that sentence names the
  // generation it found and "unknown format" on its own cannot.
  //
  // **The tile under this badge still draws, and that is decided rather than left over.**
  // The skim unprojects the take's depth on this build's intrinsics, which is the very
  // thing the refusal calls geometry nobody can check - so a badged tile is showing a
  // picture whose shape may not be the room's. It draws anyway, because the poster's job
  // here is recognition and not measurement: a gallery is where somebody goes to find
  // which take this is, a blank tile answers that worse than an approximate one, and the
  // badge over it says the picture is not to be trusted. Nothing bakes: the take cannot
  // be opened, and `render-worker` reaches a take through `/edit?take=` - the same door
  // `openTake` refuses at - so no export can be made from one of these.
  format: () => 'unknown format',
  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),
});

/**
 * The warnings a take carries, short enough for a badge and long enough to act on.
 *
 * One list, read by the poster badges, by the ⋯ menu and by the viewer, because
 * these are the facts that decide whether a take is worth opening and three copies
 * of them is three places for one to be forgotten. The `short` is what fits over a
 * 228px poster; the `why` is the sentence, and it is never behind a hover - the
 * panel this runs on has no pointer.
 */
function warningsOf(take) {
  const out = [];
  if (take.recording === true) {
    // **The one sentence this page still writes, and it is a warning rather than a
    // refusal.** It names four actions, so it is not an answer to "why is Open off" -
    // the server carries that one, in a sentence about the hash a take being written
    // does not have yet. The two are different claims about one take rather than two
    // copies of one claim, which is why this did not move to the library scanner with
    // the others: an action list is not something a scanner knows.
    out.push({
      key: 'recording',
      short: 'recording',
      kind: 'rec',
      why: 'this take is still being written - stop it before opening, downloading, renaming or removing it',
    });
    return out;
  }
  if (take.truncated) {
    out.push({
      key: 'truncated',
      short: 'truncated',
      why: 'the writer stopped mid-frame, so the take is usable up to the cut and no further',
    });
  }
  // The reasons the take cannot be opened, in the server's words. This page used to
  // write them again from `hasHello` and `frames`, which is how the badge and the
  // Open button beside it ended up saying different things about one take - so the
  // sentence arrives with the take now and the only thing decided here is the badge
  // it goes under. **Not a courtesy copy in the sense `web/format.js` uses for
  // `VALID_ID`**: there is no local derivation left to fall back to, because a second
  // one is exactly what was wrong.
  //
  // No `?? []` guarding this. `describeTake` sets the field in both its branches, so a
  // take that reached this page without one is a server this page cannot render
  // anyway, and a silent empty list would draw a tile claiming a take is fine - which
  // is a second implementation wearing a fallback, and the fallback is the half that
  // would be believed.
  for (const refusal of take.openRefusals) {
    out.push({
      key: refusal.key,
      short: BADGES[refusal.key]?.(take) ?? refusal.key,
      why: refusal.why,
    });
  }
  return out;
}

/**
 * Why a take cannot be opened, or the empty string when it can.
 *
 * Read rather than derived. The four sentences this used to compose disagreed with the
 * badges over the same poster, and the fix is not a fifth careful copy - it is that
 * the take carries its own reasons and every surface quotes them. The format band is
 * the one that shows why quoting beats shortening: it has to name the generation it
 * found, because "unknown format" with no number is a refusal nobody can act on, and a
 * page shortening the server's sentence is how that number went missing.
 */
const cannotOpen = (take) => take.openRefusals[0]?.why ?? '';

// ------------------------------------------------------------------ the skim frame

/**
 * One frame of a take, drawn to a 2D canvas.
 *
 * Depth rather than the colour JPEG, and the reason is that a poster has to exist
 * for every take: a node shooting with `--no-color` records no JPEG at all, and a
 * gallery whose tiles went blank for those takes would be unusable in exactly the
 * setup that produces them. Depth is also what the take *is* - the colour stream is
 * half-rate and lags - so a depth poster is the honest preview of the material.
 *
 * Unprojected through the take's own intrinsics rather than drawn as a range image.
 * A raw depth buffer laid out as pixels is a picture of the sensor's grid, where
 * what someone skimming needs to recognise is where a body was standing.
 *
 * **This draws into whatever backing store the canvas already has and never sizes
 * one.** It used to set `canvas.style.height` from the parent's measured width,
 * which put the poster's layout in JavaScript that runs once per fetched frame - so
 * the box was right at first paint and stale after every resize. The box is CSS now
 * and the backing store follows it through a ResizeObserver, which leaves this
 * function with one job.
 */
function drawFrame(canvas, take, payload, divisor) {
  const W = canvas.width;
  const H = canvas.height;
  if (!W || !H) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04060a';
  ctx.fillRect(0, 0, W, H);
  if (!payload) return;

  const view = new DataView(payload);
  const depthBytes = view.getUint32(0, true);
  const gw = Math.ceil(DEPTH_W / divisor);
  const gh = Math.ceil(DEPTH_H / divisor);
  if (depthBytes !== gw * gh * 2) return;
  const depth = new Uint16Array(payload, 16, depthBytes / 2);

  // The take's own intrinsics, scaled by the divisor - the grid shrank, so the
  // focal length and the principal point shrank with it. A poster drawn on the boot
  // defaults would translate every point together, which is an error nothing on
  // screen can show.
  const fx = (take.hello?.fx ?? 366) / divisor;
  const fy = (take.hello?.fy ?? 366) / divisor;
  const cx = (take.hello?.cx ?? DEPTH_W / 2) / divisor;
  const cy = (take.hello?.cy ?? DEPTH_H / 2) / divisor;

  // In backing-store pixels throughout. The framing is the same one the tile has
  // always drawn - the height sets the scale, so a bigger canvas is the same picture
  // larger rather than a wider crop of it, which is what makes the viewer a
  // magnification of the tile rather than a second composition.
  const scale = H * 1.15;
  const ox = W / 2;
  const oy = H * 0.42;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  // **How many pixels a depth sample covers, and it is exact rather than a proxy.**
  // Two horizontally adjacent samples land `scale / fx` pixels apart on screen - the
  // depth cancels out of `(-(x - cx) * z / fx) * scale / z`, so the spacing is the same
  // at every distance and is a property of the canvas alone. One pixel each is dense
  // at a 228px tile and threadbare at a viewer four times the size, which is where
  // this was measured: the same take that reads solid on its tile came up a faint dot
  // screen.
  //
  // **From the sensor's own focal length and never from the decimated one**, which is
  // the difference between filling the gaps and erasing a signal. Dividing by the
  // divisor as well would give a coarse frame four-times-larger splats, so a remote
  // take would look exactly like a local one - and "a decimated skim is measurably
  // sparser than a local one, not just labelled" is a claim this gallery makes on
  // purpose, because promising a smoothness the link does not have is the thing the
  // decimation is honest about. So every divisor gets the same sample size and a
  // coarse frame simply has sixteen times fewer of them.
  //
  // The floor at one is why the tile's poster is bit-identical to what it has always
  // drawn: at tile heights this lands under one and rounds there.
  const fxFull = take.hello?.fx ?? 366;
  const splat = Math.max(1, Math.round(scale / fxFull));
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const mm = depth[y * gw + x];
      if (mm === 0) continue;
      const z = mm / 1000;
      if (z < 0.4 || z > 6) continue;
      // The negation on x is the mirror correction, and the poster needs it for the same
      // reason the cloud does: the sensor's frames arrive horizontally flipped, so a
      // gallery tile drawn without it is a reflection of the take the editor then opens
      // the right way round. `unproject` in `web/main.js` carries the reasoning.
      const wx = (-(x - cx) * z) / fx;
      const wy = -((y - cy) * z) / fy;
      const sx = Math.round(ox + (wx * scale) / z);
      const sy = Math.round(oy - (wy * scale) / z);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      // Near is bright, far falls away. One channel, because a poster is a shape
      // rather than a grade and a colour ramp here would be inventing a look.
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
 * A scrubbable surface over one take: the tile's poster and the viewer's stage are
 * both this, mounted on different elements.
 *
 * **Positions are frame indices and not fractions**, which is what lets the viewer's
 * arrow keys step exactly one frame. A fraction is what a pointer produces, so the
 * pointer path rounds into an index on the way in and everything downstream - the
 * playhead, the time readout, the request - reads the index. A take of 60 frames has
 * 60 positions and no more, and a scrub that appeared to move between two of them
 * would be a readout that is not the picture.
 *
 * **One request in flight at a time, with the latest wanted position kept.** A scrub
 * fires a pointer event per pixel and a queue of them would draw the whole drag in
 * order, arriving later and later behind the finger - which is the shape of lag
 * people read as "the file is slow".
 */
function createSkim({ take, divisor, canvas, surface, bar, onDraw }) {
  // **Zero is a real answer and it is not clamped to one.** A take cut before its
  // first whole frame indexes none, and a skim that treated that as one frame asked
  // the server for frame 0 of a take that has no frame 0 - answered 404, swallowed by
  // the pump's own catch, and visible only as a failed request in the console. The
  // tile is not wrong to exist: the take is in the library, it can be renamed and
  // deleted, and its badge says there is nothing to draw.
  const frames = Math.max(0, take.frames ?? 0);
  const last = Math.max(0, frames - 1);
  const pos = bar.querySelector('.pos');
  const done = bar.querySelector('.done');
  let wanted = 0;
  let showing = -1;
  let busy = false;
  // **Set by `release`, and checked on the far side of every await in the pump.** The
  // viewer draws every take into one `vCanvas`, and it changes takes by releasing the
  // old skim and building a new one on that same canvas - which `paint` also does on
  // its own, for every refresh that happens while the viewer is open. A pump suspended
  // in `frameAt` when that happens wakes up holding the previous take's frame and, with
  // nothing to stop it, draws it under the new take's name and counts it on the new
  // take's counter. Disconnecting the ResizeObserver was all `release` did, which
  // stops the redraws it owns and none of the ones already in flight.
  let released = false;
  // Kept so a resize can redraw the frame that is on screen. Without it every
  // resize blanks the poster until somebody scrubs it, and a window drag is a
  // continuous stream of resizes.
  let payload = null;

  const frameAt = async (n) => {
    // The take's frame count is what a position indexes into. A remote take is
    // read through the node, which this side proxies rather than reaching across
    // from the browser - one origin, and the node never learns a browser exists.
    const url = take.state === 'remote'
      ? `/library/remote-frame/${encodeURIComponent(take.id)}/${n}?decimate=${divisor}`
      : `/capture/${encodeURIComponent(take.id)}/frame/${n}?decimate=${divisor}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.arrayBuffer();
  };

  const pump = async () => {
    if (released) return;
    if (frames === 0) {
      // Drawn and counted, so a reader waiting on the counter gets the answer "this
      // take has no picture" rather than waiting out its timeout on a take that was
      // never going to draw one.
      drawFrame(canvas, take, null, divisor);
      onDraw?.(0);
      return;
    }
    if (busy) return;
    busy = true;
    try {
      while (true) {
        const n = wanted;
        let got = null;
        try {
          got = await frameAt(n);
        } catch { /* a take deleted mid-skim draws nothing rather than throwing */ }
        // Checked here rather than only at the top: the await above is exactly where
        // the viewer changes takes, and this frame belongs to the take that was open
        // before it did.
        if (released) return;
        payload = got;
        showing = n;
        drawFrame(canvas, take, got, divisor);
        onDraw?.(n);
        if (n === wanted) break;
      }
    } finally {
      busy = false;
    }
  };

  const api = {
    get frames() { return frames; },
    get index() { return wanted; },
    get seconds() { return (last === 0 ? 0 : wanted / last) * take.durationSec; },

    setIndex(n) {
      wanted = Math.max(0, Math.min(last, Math.round(n)));
      const at = last === 0 ? 0 : wanted / last;
      // Written straight from the pointer with no transition: skimming is direct
      // manipulation, and a position line that eased would lag the finger.
      pos.style.left = `${at * 100}%`;
      done.style.width = `${at * 100}%`;
      onDraw?.(wanted, true);
      pump();
      return wanted;
    },
    setT(t) { return api.setIndex(Math.max(0, Math.min(1, t)) * last); },
    step(by) { return api.setIndex(wanted + by); },
    fromX(clientX, el) {
      const r = el.getBoundingClientRect();
      return api.setT((clientX - r.left) / r.width);
    },
    /** Redraws the frame already on screen, for a backing store that just changed. */
    repaint() { drawFrame(canvas, take, payload, divisor); },
    get showing() { return showing; },
  };

  // The backing store follows the box, and the box is CSS. A ResizeObserver rather
  // than a window `resize` listener, because the tile's width changes when the grid
  // reflows the column count as well as when the window moves - and a canvas resized
  // is a canvas cleared, so every one of them is followed by a redraw.
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

// ------------------------------------------------------------------------- tiles

/** A button, built rather than interpolated, because a label is not markup either. */
function addButton(row, label, cls, onClick, { disabled = false, why = '', item = null } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.disabled = disabled;
  if (why) b.title = why;
  b.dataset.act = item ?? label.toLowerCase();
  b.addEventListener('click', onClick);
  row.appendChild(b);
  return b;
}

/**
 * The ⋯ menu's items for one take, as data.
 *
 * Data rather than DOM calls, because the sweep in `library-check` requires every
 * interactive control the gallery renders to have a driver - and a list that is
 * also what gets rendered is a list that cannot describe a menu the page does not
 * have. `enabled` and `why` are computed here so that a disabled item still says
 * what would make it work, which is the same reading the disabled Open already gets:
 * a control that vanishes reads as the page being broken, and on a touch panel there
 * is no tooltip to explain a control that stayed.
 */
/**
 * Why Delete cannot be pressed on this take, or an empty string when it can.
 *
 * **One function because two surfaces ask, and both of them were wrong about the same
 * take.** A node-only take had a lit Delete on the tile and, once the viewer existed,
 * a second lit Delete there - and `/library/delete/:id` answers 404 for it, because
 * `serveRemoval` looks the take up among the local ones and there is no local one.
 * Worse than a control that fails: the confirm in front of it reads "This is the only
 * copy. Deleting it cannot be undone", which is the most alarming sentence this page
 * can show, in front of a button that was never going to do anything.
 *
 * The review named the viewer's copy of this. Fixing that alone would have left the
 * tile offering the same button with the same dialog, so the rule lives here and both
 * surfaces read it - the same shape `menuItemsFor` already uses for the items whose
 * answer depends on where a take is.
 */
function cannotDelete(take) {
  if (take.recording === true) return warningsOf(take)[0].why;
  // **A node we could not reach is not a node with nothing on it.** `/library/all` hands
  // `reconcile` a null when the manifest read fails and null is read as an empty array,
  // so a link dropping removes every node-only tile and turns every `both` take into a
  // `local` one - and the confirmation that refuses to delete the last copy is drawn
  // from exactly that count. The take then offers a delete whose safety rests on a
  // reading that says "no second copy" when what happened is "no answer".
  //
  // Refused for every take rather than only the ones that were `both`, because after the
  // repaint there is no way to tell which those were: the reading that would say so is
  // the one that failed. This is the conservative half of the fix and it is deliberately
  // not the whole of it - the tiles still disappear on a failed read, which is a
  // separate change to how a failed manifest is carried.
  if (library.node && !library.node.reachable) {
    return `${library.node.name} cannot be reached, so whether this take has a second copy `
      + 'is unknown - delete is refused rather than guessed at';
  }
  if (take.state === 'remote') {
    return `${take.id} is only on ${library.node?.name ?? 'the node'}, and delete removes a file on this machine`;
  }
  return unnameable(take);
}

/**
 * Why an action that forms a path from this take's id cannot run, or an empty string.
 *
 * **Three server functions hold the id to `VALID_ID` before they touch anything, and
 * the gallery knew about one of them.** `removeTake`, `renameTake` and `revealTake` all
 * refuse a source id outside the rule, because each one joins it to a path - so for a
 * take copied onto the card by hand as `my take.knct`, which `scanTakes` lists on
 * purpose, Delete, Rename and Show in the file manager are all round trips whose only
 * answer is a 409.
 *
 * Rename was fixed on its own a round earlier and that was the instance rather than the
 * class: the review came straight back with Reveal, and Delete had the same hole and
 * was not reported at all. The rule is one sentence here and every action that forms a
 * path reads it, so the next such action is asked by existing.
 */
function unnameable(take) {
  if (VALID_ID.test(take.id)) return '';
  return `${take.id} did not come from the recorder and its name is outside the rule this program forms paths from, `
    + 'so it is listed and played but cannot be renamed, revealed or deleted here';
}

/**
 * Everything a take allows, as data, for whichever surface is drawing it.
 *
 * **The grid tile and the modal viewer offer the same take the same things, and this is
 * the only place that decides what those are.** They used to decide separately, in two
 * blocks that read almost identically, and the gap between "almost" and "identically"
 * has now produced four separate findings: Delete live on the viewer for a take that is
 * only on the node, the `VALID_ID` name rule known to one surface and not the other,
 * Download offered on a take still being recorded, and Download surviving on a take that
 * had just been reclaimed. Every one of them was the same bug - a rule taught to the
 * tile and not to the viewer - and every one was fixed as an instance.
 *
 * The reason it kept happening is structural rather than careless. A tile is built by
 * `buildTile` for each take the current filter shows; the viewer is reached by
 * arrow-browsing, which walks takes *without* going through `buildTile` at all. So the
 * viewer sees takes no tile was ever built for, and any rule living in `buildTile` was
 * a rule the viewer had never been told. Two lists that agree today is the shape this
 * file spends its comments refusing, and this was that shape.
 *
 * Data rather than DOM calls, for the reason `menuItemsFor` already gives: a list that
 * is also what gets rendered is a list that cannot describe an action the page does not
 * have. `enabled` and `why` travel together because a control that is off still has to
 * say what would make it work - on a touch panel a control that vanishes reads as a
 * broken page, and there is no hover to explain one that is merely grey.
 *
 * `run` takes the surface it was pressed on, so the same entry works from either. That
 * is the one thing the two surfaces genuinely do differently and it is a parameter
 * rather than a branch.
 */
function availability(take) {
  const shooting = take.recording === true;
  const nodeName = library.node?.name ?? 'the node';
  const acts = [];
  if (take.state === 'remote' && !shooting) {
    // The `!shooting` half is load-bearing rather than tidy: a take still being recorded
    // has no settled hash, so the server answers 409 for a download of it. The tile had
    // suppressed this since before the viewer existed and the viewer had not, which is
    // the third of the four disagreements.
    acts.push({
      item: 'download',
      label: 'Download',
      cls: 'act primary',
      enabled: true,
      why: '',
      // Caught rather than left to reject: a click handler has no caller to rethrow to,
      // and the node dropping mid-transfer is the ordinary failure here. `run` has
      // already put the message on the status line by then.
      run: (host) => run(
        host,
        `downloading ${take.id} — asking ${nodeName} for ${gb(take.bytes)}`,
        () => post(`/library/download/${encodeURIComponent(take.id)}`),
        () => downloadProgress(take.id),
      ).catch(() => {}),
    });
  } else {
    // A take that cannot be opened says so on the button rather than throwing when
    // pressed. Two frames is the floor for a pair source and a hello is what carries the
    // intrinsics, so both are properties of the take rather than of the editor - and the
    // gallery is where they are visible. A take still being recorded lands here too:
    // every action on it needs a hash it does not have yet.
    acts.push({
      item: 'open',
      label: 'Open',
      cls: 'act primary',
      enabled: Boolean(take.openable),
      why: cannotOpen(take),
      run: () => { location.href = `/edit?take=${encodeURIComponent(take.id)}`; },
    });
  }
  acts.push({
    item: 'delete',
    label: 'Delete',
    cls: 'act danger',
    enabled: !cannotDelete(take),
    why: cannotDelete(take),
    run: (host) => askDelete(host, take),
  });
  return { acts, menu: menuItemsFor(take) };
}

/**
 * Draws one surface's action row from `availability`.
 *
 * Here rather than at each surface, because "the tile and the viewer render the same
 * list the same way" is the property `availability` exists to hold and a second copy of
 * the loop is where it would go again.
 */
function paintActs(row, take, hostFor) {
  for (const a of availability(take).acts) {
    addButton(row, a.label, a.cls, () => a.run(hostFor()), {
      disabled: !a.enabled,
      why: a.why,
      item: a.item,
    });
  }
}

function menuItemsFor(take) {
  const shooting = take.recording === true;
  const onlyThere = take.state === 'remote';
  const nodeName = library.node?.name ?? 'the node';
  const reveal = library.reveal ?? { available: false, label: null, why: null };
  const label = reveal.label ?? 'the file manager';
  // The listing is wider than the rule on purpose - `scanTakes` admits any file ending
  // `.knct`, so a take copied onto the card by hand gets a tile and should, because it
  // is footage and it is here. What that costs is `unnameable` above, read by every
  // action that forms a path from the id rather than by rename alone.
  const noName = unnameable(take);
  return [
    {
      item: 'rename',
      label: 'Rename…',
      enabled: !shooting && !onlyThere && !noName,
      why: shooting
        ? 'this take is still being recorded: renaming it while the recorder holds it would make the manifest re-scan a growing file'
        : onlyThere ? `${take.id} is only on ${nodeName}, and this button does not rename files over there`
          : noName,
      run: (tile) => askRename(tile, take),
    },
    {
      item: 'reveal',
      label: `Show in ${label}`,
      // **Off while the take is being written, and the reason is the one this program
      // keeps closing rather than tidiness.** Revealing looks read-only - no byte of
      // the library moves - but handing the file to a file manager is handing it to
      // something that will stat it, size it, index it and generate a preview of it,
      // against the disk the recorder is writing to. That is the same contention the
      // manifest refuses to cause by not scanning the open take, arriving through a
      // door the gallery would have opened. Found by a proof tool, which had this
      // item enabled mid-shoot on a tile whose every other control was off.
      enabled: !shooting && !onlyThere && reveal.available && !noName,
      why: shooting
        ? `${label} would stat, preview and index the file the recorder is writing to, which is disk the take needs`
        : onlyThere
          ? `${take.id} is only on ${nodeName}, so there is no file here to show`
          : noName || (reveal.why ?? ''),
      run: (tile) => run(tile, `showing ${take.id} in ${label}`, () => post(`/library/reveal/${encodeURIComponent(take.id)}`), null, { refresh: false }),
    },
    {
      item: 'reclaim',
      label: `Reclaim on ${nodeName}`,
      enabled: take.state === 'both',
      why: take.state === 'both' ? ''
        : `reclaim frees the copy on ${nodeName}, and this take is not in two places`,
      run: (tile) => askReclaim(tile, take),
    },
  ];
}

/**
 * Which control a control is, and how to find that control again once the surface
 * holding it has been rebuilt.
 *
 * **One rule, because there are two places that rebuild a surface and put focus back
 * on it** - `openViewer` after arrow-browsing, and `run` after an action it held the
 * surface down for - and two rules that agreed today would be the shape this file
 * spends its comments refusing. Neither can key on the node: `#vActs` is emptied and
 * refilled and the ⋯ is cloned, so every control is a new element after a rebuild.
 * Neither can key on the visible text either: a menu item's label carries the node's
 * name, so a rebuild that learned a different name would be looking for a control that
 * no longer answers.
 *
 * `data-act` is what they key on instead, because it is already this page's term for
 * which control a control is - `addButton` sets it on everything it makes and the test
 * API keys on it. The ⋯ in the viewer is markup in `library.html` rather than an
 * `addButton`, so it answers to its id, which its clone carries too.
 */
const controlKey = (el) => el?.dataset?.act || el?.id || null;
const findControl = (host, key) => {
  if (!key || !host?.isConnected) return null;
  const byAct = host.querySelector(`[data-act="${CSS.escape(key)}"]`);
  if (byAct) return byAct;
  // **An id is the whole document's namespace rather than this surface's, so what it
  // finds has to be checked before focus is sent there.** `library.html` has a
  // `<dialog id="rename">` and `rename` is one of the menu item keys; the dialog is a
  // sibling of the viewer rather than inside it, so the scoped search cannot reach it
  // today - but "today" is the wrong thing for this to rest on, since a dialog is not
  // focusable and `focus()` on one is a silent no-op that leaves the caret on the body.
  // That is this bug for the fifth time, arriving through a hole nobody moved.
  const byId = host.querySelector(`#${CSS.escape(key)}`);
  return byId?.matches('.act, .mi') ? byId : null;
};

/** Closes whichever ⋯ menu is open, if any. */
function closeMenus(except = null) {
  for (const menu of document.querySelectorAll('.menu:not([hidden])')) {
    if (menu === except) continue;
    // **Focus comes back to the toggle whenever the menu holding it is hidden, and
    // that belongs here rather than at any one caller.** Hiding an ancestor of the
    // focused element drops focus to the body, which inside the viewer means outside
    // the dialog - so the arrows stop reaching its handler and browsing dies, exactly
    // as it did when the header button was replaced. Escape already restored focus
    // because it was written to; choosing an item did not, and neither would the next
    // caller added. This is the fourth focus fix on this branch and the first one that
    // is a rule rather than a case: every path that hides a menu now goes through it.
    const toggle = menu.parentElement.querySelector('[aria-haspopup="menu"]');
    const heldFocus = menu.contains(document.activeElement);
    menu.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
    if (heldFocus && toggle && !toggle.disabled) toggle.focus();
  }
}

// A tap anywhere that is not inside a menu closes it. On `pointerdown` rather than
// `click`, so pressing a button elsewhere on the page does not have to be pressed
// twice - and captured, so a handler that stops propagation cannot leave a menu open
// over a page that has moved on.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.menu') || e.target.closest('[aria-haspopup="menu"]')) return;
  closeMenus();
}, true);

// **And Escape closes it, which `library.html` said next to the menu's own rules and
// nothing here did.** The menu is a `div` rather than a `dialog`, so it gets none of
// the cancel behaviour a browser would otherwise supply - a keyboard user who opened
// one had a tap as the only way out, on a surface whose comment promised otherwise.
// Captured, and the focus put back on the toggle that opened it, because a menu
// dismissed while focus sat inside it would leave the caret nowhere.
//
// Stopped only when a menu was actually open: inside the viewer, Escape is the
// browser's own way of closing the dialog, and swallowing it unconditionally would
// take the way out of the surface away to close a menu that was not there.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.menu:not([hidden])');
  if (!open) return;
  e.stopPropagation();
  e.preventDefault();
  const toggle = open.parentElement.querySelector('[aria-haspopup="menu"]');
  closeMenus();
  toggle?.focus();
}, true);

/**
 * Builds a ⋯ menu into a container, hidden, with a toggle that opens it.
 *
 * Rendered up front rather than on the first press, so what the page offers is in
 * the document whether or not anybody has clicked - see `library.html` for why that
 * matters to the sweep.
 */
function buildMenu(host, toggle, take, hostFor) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.role = 'menu';
  menu.hidden = true;
  // Computed once, and through `availability` rather than by calling `menuItemsFor`
  // here, so that there is one entry point describing what a take allows rather than
  // one for the row and one for the menu. Asking twice would be two lists that agree
  // today, which is the shape this file spends its comments refusing.
  const entries = availability(take).menu;
  for (const entry of entries) {
    const b = addButton(menu, entry.label, 'mi', () => {
      closeMenus();
      // **Consumed here rather than at each item, because this is the boundary where a
      // rejection stops having anywhere to go.** `run` reports the failure by putting
      // it on the status line and then rethrows, which is right for the callers that
      // await it - but a click handler is nobody's caller, so a Reveal that could not
      // start its file manager became an unhandled rejection and a page-level error
      // for a failure the page had already handled and displayed. Wrapped at the one
      // place every item goes through, so an item added later cannot forget it; the
      // items that open a dialog return undefined and pass through untouched.
      Promise.resolve(entry.run(hostFor())).catch(() => {});
    }, { disabled: !entry.enabled, why: entry.why, item: entry.item });
    b.dataset.item = entry.item;
    b.role = 'menuitem';
  }
  // The sentences: why an item is off, and what each badge over the poster is short
  // for. Both in the menu, because the menu is a tap and a tooltip is not.
  const note = document.createElement('div');
  note.className = 'mnote';
  const lines = [
    ...entries.filter((e) => !e.enabled && e.why).map((e) => `${e.label}: ${e.why}`),
    ...warningsOf(take).map((w) => `${w.short}: ${w.why}`),
  ];
  note.textContent = lines.join('\n');
  menu.appendChild(note);
  host.appendChild(menu);

  toggle.addEventListener('click', () => {
    const opening = menu.hidden;
    closeMenus(menu);
    menu.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) placeMenu(menu, toggle);
  });
  return menu;
}

/**
 * Puts a menu on the side of its button that has room, and caps it at the room there.
 *
 * **Measured on open rather than decided in the stylesheet**, because the answer
 * depends on where in a scrolling grid the tile happens to be. Opening upward is right
 * for most of the grid and wrong for the top row, where `.grid` clips it - and the
 * menu that got cut off was the tall one, the take carrying three warnings, so the
 * tile whose sentences most needed reading was the one that could not show them.
 *
 * The bound is the scroll container's box rather than the viewport's: the grid is what
 * clips, and a menu that fits on screen while hanging outside the grid is still half a
 * menu.
 */
function placeMenu(menu, toggle) {
  const host = menu.offsetParent ?? menu.parentElement;
  const clip = (menu.closest('.grid') ?? document.documentElement).getBoundingClientRect();
  const button = toggle.getBoundingClientRect();
  const hostBox = host.getBoundingClientRect();
  const GAP = 6;
  const above = button.top - clip.top - GAP;
  const below = clip.bottom - button.bottom - GAP;
  const up = above >= below;
  // The room there is, with no floor under it. A floor of 96px was the first spelling
  // and it is the thing that breaks the claim: a tile scrolled so its ⋯ has 92px above
  // it got a 98px menu, six pixels of which sat under the grid's edge - the check
  // measured exactly that. `overflow-y: auto` is what makes the honest number usable,
  // and the side chosen is already the larger of the two, so this is as much room as
  // the grid has to give.
  menu.style.maxHeight = `${Math.max(0, Math.round(up ? above : below))}px`;
  if (up) {
    menu.style.top = 'auto';
    menu.style.bottom = `${Math.round(hostBox.bottom - button.top + GAP)}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${Math.round(button.bottom - hostBox.top + GAP)}px`;
  }

  // **Then the box is measured and corrected, because the arithmetic above is about
  // where the menu was asked to go and this is about where it went.** The two differ
  // whenever the button itself is outside the clip - a tile in a row below the fold
  // has a ⋯ the grid is not showing, so "the room above it" is a number about a
  // position nothing can see, and the menu lands wholly outside. It came back as six
  // pixels of a 98px menu on the one tile in the fixture whose menu has no warnings
  // under it, which is the shortest menu there is and therefore the one whose
  // overflow a height cap cannot explain. Written as a shift of whatever is left over
  // rather than as a third branch, because the property is the box being inside and
  // not the reasoning that put it there.
  const landed = menu.getBoundingClientRect();
  const over = Math.max(0, landed.bottom - clip.bottom);
  const under = Math.max(0, clip.top - landed.top);
  if (over > 0 || under > 0) {
    const shift = over > 0 ? -over : under;
    const nowTop = menu.style.top !== 'auto'
      ? Number.parseFloat(menu.style.top) + shift
      : null;
    if (nowTop !== null) menu.style.top = `${Math.round(nowTop)}px`;
    else menu.style.bottom = `${Math.round(Number.parseFloat(menu.style.bottom) - shift)}px`;
    // And cap again against the clip, so a menu taller than the whole grid scrolls
    // inside it rather than being shifted from one edge into the other.
    const after = menu.getBoundingClientRect();
    if (after.height > clip.height - 2 * GAP) menu.style.maxHeight = `${Math.round(clip.height - 2 * GAP)}px`;
  }
}

/** The badges over a poster, built from the same warning list the menu explains. */
function paintFlags(host, take) {
  host.replaceChildren();
  for (const w of warningsOf(take)) {
    const chip = document.createElement('span');
    chip.className = `flag${w.kind ? ` ${w.kind}` : ''}`;
    chip.dataset.flag = w.key;
    chip.textContent = w.short;
    chip.title = w.why;
    host.appendChild(chip);
  }
}

/** The mark ticks for a take, on a bar. `onPick` makes them pressable where given. */
function paintMarks(bar, take, onPick = null) {
  for (const old of bar.querySelectorAll('.mk')) old.remove();
  const durationMs = Math.max(1, take.durationSec * 1000);
  for (const m of take.marks ?? []) {
    // The marks go on through the DOM rather than through a template. A label is
    // written by whoever pressed mark - on this machine or on a node whose log
    // arrived over the link - so it is text from outside this page, and text from
    // outside this page is never markup.
    const tick = document.createElement(onPick ? 'button' : 'span');
    tick.className = 'mk';
    const at = Math.max(0, Math.min(1, m.sourceMs / durationMs));
    tick.style.left = `${at * 100}%`;
    tick.title = `${m.label ?? m.id} · ${(m.sourceMs / 1000).toFixed(2)}s`;
    if (onPick) {
      tick.type = 'button';
      tick.dataset.act = 'mark';
      tick.addEventListener('click', (e) => { e.stopPropagation(); onPick(at); });
    }
    bar.appendChild(tick);
  }
}

function buildTile(take) {
  const tile = document.createElement('article');
  tile.className = 'tile';
  tile.dataset.id = take.id;
  // The hash, because a filename is not an identity here. Two machines can hold
  // genuinely different takes under one name, the library lists them as two
  // entries, and a tile keyed by name would be two tiles one selector cannot tell
  // apart - which is the same mistake the reconciliation refuses one layer down.
  tile.dataset.hash = take.hash ?? '';
  tile.dataset.state = take.state;
  // A take the recorder still has open. It is deliberately unscanned - no hash, no
  // frame count, no duration - because scanning a file that is still growing costs a
  // full read and a sha256 of a multi-gigabyte take against the disk the recorder is
  // writing to, and produces numbers that stop being true immediately. So its tile
  // says what it is rather than drawing zeros that look like facts.
  const shooting = take.recording === true;
  tile.dataset.recording = String(shooting);
  const divisor = DIVISOR[take.state] ?? 1;

  tile.innerHTML = `
    <div class="skim"><canvas></canvas><span class="t">00:00</span>
      ${divisor > 1 ? `<span class="coarse">decimated ÷${divisor}</span>` : ''}
      <div class="flags"></div></div>
    <div class="bar"><span class="done"></span><span class="pos"></span></div>
    <div class="meta">
      <div class="top"><span class="name"></span><span class="dur">${shooting ? '···' : mmss(take.durationSec)}</span></div>
      <div class="facts">
        <span class="state ${take.state}"><i></i>${take.state === 'remote' ? 'node' : take.state}</span>
        <span>${gb(take.bytes)}</span>
        <span>${shooting ? 'recording now' : `${take.frames} frames`}</span>
      </div>
      <div class="facts">
        <span>${(take.marks ?? []).length ? `${take.marks.length} mark${take.marks.length === 1 ? '' : 's'}` : 'no marks'}</span>
        <span>${stamp(take.capturedAt)}${take.dateSource === 'mtime' ? ' (file date)' : ''}</span>
      </div>
      <div class="acts"></div>
    </div>`;

  // **A take's id is a filename, so it is text from outside this page too, and the
  // rule below applies to it exactly as it applies to a mark's label.** The id is
  // `basename(path)` with `.knct` taken off (`server/capture.js`), and `scanTakes`
  // admits any file whose name ends that way - `VALID_ID` guards the ids that arrive
  // from a *node*, and the recorder names its own takes, but nothing constrains a
  // file somebody dropped into the captures directory by hand. That is an ordinary
  // move in a design built around carrying takes between machines, and interpolating
  // the name into the template made `<img src=x onerror=...>.knct` run script on this
  // page's real origin the moment the gallery drew it - with every mutating route
  // then reachable, because the guard has nothing to say about a request the page
  // itself makes. Filtering the file out of the listing would be the wrong repair:
  // a gallery that hides footage is how footage gets lost.
  tile.querySelector('.name').textContent = take.id;
  tile.querySelector('.name').title = take.id;

  paintFlags(tile.querySelector('.flags'), take);
  const barEl = tile.querySelector('.bar');
  paintMarks(barEl, take);

  const acts = tile.querySelector('.acts');
  paintActs(acts, take, () => tile);
  const more = addButton(acts, '⋯', 'act more', () => {}, { item: 'more' });
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.title = 'rename, reveal and reclaim';
  more.setAttribute('aria-label', `More actions for ${take.id}`);
  buildMenu(tile.querySelector('.meta'), more, take, () => tile);

  // ---- skimming
  const skimEl = tile.querySelector('.skim');
  const label = tile.querySelector('.t');
  // A take still being recorded has no frame count to index a position into - it is
  // listed without being scanned - so it gets no skim at all rather than a scrub bar
  // that divides by a null. The tile still says what it is; there is simply nothing
  // to scrub through yet.
  if (shooting) return tile;

  const skim = createSkim({
    take,
    divisor,
    canvas: tile.querySelector('canvas'),
    surface: skimEl,
    bar: barEl,
    onDraw: (n, requested = false) => {
      if (requested) {
        label.textContent = mmss(skim.seconds);
        return;
      }
      // Counted, because "the poster is drawn" is otherwise unobservable from
      // outside: the first draw is a fetch behind a requestAnimationFrame, and a
      // reader that arrived before it landed would be measuring a blank canvas and
      // calling it the take.
      tile.dataset.draws = String(Number(tile.dataset.draws ?? 0) + 1);
    },
  });
  tile.__skim = skim;

  // **The poster does two things and a drag is what tells them apart.** Moving across
  // it scrubs, which is the affordance the gallery has always had; a press that goes
  // nowhere opens the viewer. Four pixels rather than zero because a finger never
  // holds still, and the alternative - a separate button to open a take - is a fourth
  // control in a row that has to stay one line tall.
  let pressX = null;
  let dragged = false;
  skimEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' && !e.buttons) return;
    if (pressX !== null && Math.abs(e.clientX - pressX) > 4) dragged = true;
    skim.fromX(e.clientX, skimEl);
  });
  skimEl.addEventListener('pointerdown', (e) => {
    skimEl.setPointerCapture(e.pointerId);
    pressX = e.clientX;
    dragged = false;
    skim.fromX(e.clientX, skimEl);
  });
  skimEl.addEventListener('pointerup', (e) => {
    const tap = pressX !== null && !dragged && Math.abs(e.clientX - pressX) <= 4;
    pressX = null;
    if (tap) openViewer(take.hash ?? take.id);
  });
  skimEl.addEventListener('pointerleave', () => { pressX = null; skim.setIndex(0); });
  // **And a keyboard can reach it, which it could not.** Opening the viewer was a
  // `pointerup` on a `div` and nothing else, so the whole surface was unreachable
  // without a pointer - while the viewer, once open, implements arrows, home, end and
  // escape. Keyboard support that begins one step after the step a keyboard cannot
  // take is support nobody can use.
  //
  // A focusable element with a role and a name rather than a `<button>`, because the
  // poster is also the scrub surface: a button here would announce itself as one
  // action while a drag across it does something else entirely, and it would put a
  // native activation on the pointer path that the four-pixel test above exists to
  // keep off. Enter and Space are the two keys the role promises, and they are the two
  // that are handled.
  skimEl.tabIndex = 0;
  skimEl.setAttribute('role', 'button');
  skimEl.setAttribute('aria-label', `Open ${take.id}`);
  skimEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openViewer(take.hash ?? take.id);
  });
  // The bar scrubs and never opens: it is the scrub affordance, so a press on it is
  // unambiguously a position.
  barEl.addEventListener('pointerdown', (e) => skim.fromX(e.clientX, barEl));
  requestAnimationFrame(() => skim.setIndex(0));

  return tile;
}

/**
 * Runs one surface's action with its controls held down, and reports on it while it
 * runs.
 *
 * `watch` is a function returning the sentence to show right now, or null for
 * nothing new to say. It exists for the download, which is gigabytes over a room's
 * wifi behind one request that answers when it is done - so without it this printed
 * a fixed word for four minutes, indistinguishable from a transfer that had died.
 *
 * `refresh` is false for the one action that changes nothing here: revealing a take
 * opens a window on this machine and moves not a byte, and repainting the grid
 * underneath it would only throw away the viewer the operator had open.
 *
 * **`host` is whichever surface the press came from, and that is the whole of what
 * gets held down.** It was the grid tile for both surfaces, which read as harmless
 * because the viewer is modal and the tile behind it cannot be pressed - but the
 * controls being disabled were then the ones nobody could reach, while the viewer's
 * own stayed live. A second tap on the viewer's Download starts a second transfer of
 * the same take: `downloadTake` has no duplicate guard, so both write one `.part`
 * file and overwrite one progress entry, and the two verifications race over bytes
 * neither of them wrote alone.
 *
 * Close is excluded rather than swept up with the rest, because it is not an action
 * on the take: a viewer that could not be dismissed for the four minutes a download
 * takes would hold the operator on a surface with nothing else to offer.
 */
async function run(host, message, action, watch = null, { refresh: doRefresh = true } = {}) {
  const buttons = host ? [...host.querySelectorAll('.act:not(.vclose), .mi')] : [];
  // **What each control was before this ran, because finishing means putting the
  // surface back rather than lighting up everything on it.** Reveal is the one action
  // that does not repaint, so its controls are the same nodes afterwards - and a
  // blanket enable there offered Reclaim on a take that is in one place and Open on a
  // take that cannot be opened, both of which the server then refuses. The failure
  // path did it for every action, not only for Reveal.
  const was = buttons.map((b) => b.disabled);
  // **And which control had focus, taken as a name here rather than looked for later,
  // because disabling the focused element blurs it.** A menu item chosen by keyboard
  // closes its menu, which puts focus on the ⋯ toggle - and this then disables that
  // toggle, so the browser drops focus to the body and the viewer stops receiving keys.
  // `closeMenus` restoring focus was necessary and not sufficient: the thing that takes
  // it away is here.
  //
  // It was an index into `buttons`, which could only ever work for the one action that
  // does not repaint. Every other action awaits `refresh`, which empties `#vActs` and
  // clones the ⋯, so by the time `restore` runs every node in `buttons` is detached and
  // the liveness test declined all of them. `openViewer` cannot cover that gap either:
  // it reads the focus that is live at the time, and this function has already taken it
  // away, so the rebuild it performs on this path sees the body and can identify
  // nothing. Hence the rule, which is that **whoever takes focus away is who puts it
  // back** - and the two never both fire, because `openViewer` places focus only on the
  // rebuild it was given live focus for, which is arrow-browsing.
  const wanted = host?.contains(document.activeElement) ? controlKey(document.activeElement) : null;
  const restore = () => {
    buttons.forEach((b, i) => { b.disabled = was[i]; });
    if (!wanted) return;
    // The control may not have come back under that name: a download that succeeds
    // turns Download into Open, and a reclaim takes the menu item that started it out
    // of the menu. Focus falls to the surface's ⋯ then, because what has to hold is
    // that focus is still inside the surface - a dialog that has dropped focus to the
    // body stops receiving arrow keys, and browsing dies silently one step later.
    const back = findControl(host, wanted)
      ?? (host?.isConnected ? host.querySelector('[aria-haspopup="menu"]') : null);
    if (back && !back.disabled) back.focus();
  };
  for (const b of buttons) b.disabled = true;
  say(message);
  // Polled rather than streamed: the progress is a number that changes slowly and a
  // second connection to carry it would be a second thing that can fail while the
  // transfer it describes is fine.
  const ticking = watch ? setInterval(async () => {
    try {
      const line = await watch();
      if (line) say(line);
    } catch { /* a poll that failed says nothing rather than replacing the state with an error */ }
  }, 700) : null;
  try {
    const answer = await action();
    say('');
    // The repaint replaces the grid's tiles outright, so restoring them is writing to
    // nodes already discarded - harmless, and not worth a branch that would have to
    // know which surface it was called from. The viewer is the case that needs it:
    // `paint` rebuilds it only while the take is still listed, and never at all on the
    // path that does not repaint.
    if (doRefresh) await refresh();
    restore();
    return answer;
  } catch (err) {
    say(err.message);
    restore();
    throw err;
  } finally {
    if (ticking) clearInterval(ticking);
  }
}

/** The sentence for a download in flight, or null once the server stops listing it. */
async function downloadProgress(id) {
  const res = await fetch('/library/downloads');
  const d = (await res.json()).downloading?.find((x) => x.id === id);
  if (!d) return null;
  if (d.phase === 'verifying') return `verifying ${id} — hashing ${gb(d.bytes)} to check the copy against the node`;
  const pct = d.bytes ? Math.min(100, (d.received / d.bytes) * 100) : 0;
  const rate = d.bytesPerSec / 1e6;
  // Remaining time from the average rate so far, which is the only rate that does
  // not swing by a factor of three between two polls of a wifi link.
  const left = d.bytesPerSec > 0 ? (d.bytes - d.received) / d.bytesPerSec : 0;
  return `downloading ${id} — ${pct.toFixed(0)}% of ${gb(d.bytes)} at ${rate.toFixed(1)} MB/s, `
    + `about ${left < 90 ? `${Math.ceil(left)}s` : `${Math.ceil(left / 60)}m`} left`;
}

// ------------------------------------------------------------------- the confirms

let confirmAction = null;
document.getElementById('cCancel').addEventListener('click', () => dlg.close());
document.getElementById('cGo').addEventListener('click', () => {
  dlg.close();
  confirmAction?.();
});

/**
 * The delete confirm, which now says what the server will actually do.
 *
 * **A `both` take cannot be deleted here, and the dialog used to promise it could.**
 * It read "a copy exists on both machines; this removes the one here", and
 * `serveRemoval` answers that exact request with a 409 - delete is the last copy,
 * reclaim is a copy while another survives, and they are two actions rather than one
 * action with two buttons. So the operator pressed Delete, agreed to something, and
 * got a refusal. It errs safe, which is why it survived a review, but a confirm that
 * describes an outcome the server declines is a confirm nobody can trust the next
 * time it says something irreversible.
 *
 * So a `both` take gets the explanation and no destructive button at all. Pointing
 * at Reclaim rather than quietly performing one: reclaim removes the copy on the
 * *node*, which is the opposite end from the one this dialog was offering, and
 * silently substituting it would be the wrong action confirmed under the right name.
 */
function askDelete(tile, take) {
  const alsoOnNode = take.state === 'both';
  document.getElementById('cTitle').textContent = alsoOnNode ? 'Two copies exist' : 'Delete take';
  // The id goes in as text, for the reason `buildTile` states: it is a filename and
  // nobody promised it was not markup. The dialogs are the worse place for it of the
  // two, because this one is the confirm in front of the only irreversible action.
  const body = document.getElementById('cBody');
  body.innerHTML =
    `<b class="tid"></b> · ${mmss(take.durationSec)} · ${gb(take.bytes)}`
    + (take.marks?.length ? ` · ${take.marks.length} marks` : ' · no marks')
    + `<br>on ${take.state === 'remote' ? library.node?.name : alsoOnNode ? `this ${library.here} and ${library.node?.name}` : `this ${library.here}`}.`;
  body.querySelector('.tid').textContent = take.id;
  document.getElementById('cWarn').textContent = alsoOnNode
    ? `Delete removes the last copy, and this take has two - so it is refused while ${library.node?.name} still holds one. `
      + 'Reclaim removes the copy over there, after re-hashing the one here.'
    : 'This is the only copy. Deleting it cannot be undone, and any project built on it loses its footage.';
  const go = document.getElementById('cGo');
  go.textContent = 'Delete';
  go.disabled = alsoOnNode;
  // The hash goes with the request, so a confirm built against one listing cannot
  // remove a take that changed since it was drawn.
  confirmAction = alsoOnNode ? null : () => run(tile, `deleting ${take.id}`,
    () => post(`/library/delete/${encodeURIComponent(take.id)}`, { hash: take.hash, confirm: true })).catch(() => {});
  dlg.showModal();
}

function askReclaim(tile, take) {
  document.getElementById('cGo').disabled = false;
  document.getElementById('cTitle').textContent = `Reclaim on ${library.node?.name}`;
  const rBody = document.getElementById('cBody');
  rBody.innerHTML =
    `Free <b>${gb(take.bytes)}</b> on ${library.node?.name} by removing its copy of <b class="tid"></b>. `
    + `The copy here is re-hashed before anything is removed, and stays.`;
  rBody.querySelector('.tid').textContent = take.id;
  document.getElementById('cWarn').textContent = '';
  document.getElementById('cGo').textContent = 'Reclaim';
  confirmAction = () => run(tile, `reclaiming ${take.id}`,
    () => post(`/library/reclaim/${encodeURIComponent(take.id)}`)).catch(() => {});
  dlg.showModal();
}

// -------------------------------------------------------------------- the rename

const renameDlg = document.getElementById('rename');
const renameInput = document.getElementById('rName');
const renameWhy = document.getElementById('rWhy');
const renameGo = document.getElementById('rGo');
let renaming = null;

/**
 * The rename box.
 *
 * **The name rule is checked here as it is typed and again on the server, and it is
 * one rule rather than two spellings of one** - `VALID_ID` comes from
 * `web/format.js`, which `server/library.js` imports as well. What that buys is not
 * belt and braces: it is that the button greys out on the character that would have
 * been refused, instead of the operator learning the rule from an error message after
 * a round trip. The server's copy is the gate; this one is a courtesy, because a
 * request does not have to come from this page at all.
 *
 * Renaming is offered because a take's id is what an operator reads on a tile and the
 * recorder names takes after the clock. It is safe to offer because nothing in this
 * program identifies footage by name: projects reference their capture by content
 * hash, the two-machine reconciliation joins on the hash, and the menu resumes on the
 * hash. So this moves a label and never a reference.
 */
function askRename(tile, take) {
  renaming = { tile, take };
  const body = document.getElementById('nBody');
  body.innerHTML = `Renaming <b class="tid"></b> · ${gb(take.bytes)} · ${take.frames} frames.<br>`
    + 'The take keeps its content hash, so every project built on it still finds its footage.';
  body.querySelector('.tid').textContent = take.id;
  renameInput.value = take.id;
  validateRename();
  renameDlg.showModal();
  renameInput.focus();
  renameInput.select();
}

/** What the typed name is worth, said before the request rather than after it. */
function validateRename() {
  if (!renaming) return false;
  const typed = renameInput.value.trim().replace(/\.knct$/i, '');
  // **Only the takes with a copy on this machine, because the name being claimed is a
  // filename in one captures directory.** The listing is reconciled across two
  // machines and a name is not an identity in it - `downloadTake` says so where it
  // costs something, keeping both copies when the node offers a take whose name is
  // already here and whose hash is not, by putting the hash into the name. So a
  // node-only take called `foo` leaves `foo` free in this directory, which is the
  // only place this rename lands and the only thing the server's own collision check
  // looks at. Counting it here refused a rename the server would have performed.
  const clash = library.takes.some(
    (t) => t.id === typed && t.hash !== renaming.take.hash && t.state !== 'remote',
  );
  let why = '';
  if (!typed) why = 'a take needs a name';
  else if (!VALID_ID.test(typed)) {
    why = 'letters, digits, dots, dashes and underscores only, starting with a letter, a digit or an underscore';
  } else if (typed === renaming.take.id) why = 'that is already its name';
  else if (clash) why = `${typed} is taken by another take in this library`;
  renameWhy.textContent = why || `${renaming.take.id}.knct becomes ${typed}.knct, marks and index with it`;
  renameWhy.classList.toggle('ok', !why);
  renameInput.classList.toggle('bad', Boolean(why) && Boolean(typed));
  renameGo.disabled = Boolean(why);
  return !why;
}

renameInput.addEventListener('input', validateRename);
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && validateRename()) commitRename();
});
document.getElementById('rCancel').addEventListener('click', () => renameDlg.close());
renameGo.addEventListener('click', () => commitRename());

async function commitRename() {
  if (!validateRename()) return;
  const { tile, take } = renaming;
  const to = renameInput.value.trim().replace(/\.knct$/i, '');
  renameDlg.close();
  // The hash goes with the request for the same reason delete's does: a rename built
  // against one listing must not land on a take that changed since it was drawn.
  await run(tile, `renaming ${take.id} to ${to}`,
    () => post(`/library/rename/${encodeURIComponent(take.id)}`, { hash: take.hash, to }))
    .catch(() => {});
}

// -------------------------------------------------------------------- the viewer

const viewer = document.getElementById('viewer');
const vStage = document.getElementById('vStage');
const vBar = document.getElementById('vBar');
const vCanvas = document.getElementById('vCanvas');
const vTime = document.getElementById('vTime');
const vNote = document.getElementById('vNote');
let viewing = null;

/** The take a hash names in the current listing, or null once it is gone. */
const takeByKey = (key) => library.takes.find((t) => (t.hash ?? t.id) === key) ?? null;

/** The takes the grid is showing, in the order it shows them. */
const shownTakes = () => library.takes.filter((t) => filter === 'all' || t.state === filter);

/**
 * Opens one take large.
 *
 * Keyed by hash rather than by id, and rebuilt from the listing every time, because
 * a rename changes the id underneath an open viewer and a delete removes the take
 * entirely. The hash is what survives both - it is the same key the tiles are keyed
 * by, for the same reason.
 */
function openViewer(key) {
  const take = takeByKey(key);
  if (!take) return;
  closeMenus();
  // **Where the operator was, kept across a rebuild of the same take.** `paint` re-opens
  // the viewer on every refresh while it is open, which is how it follows a take across
  // a rename - so every completed action rebuilt the skim and the unconditional
  // `setIndex(0)` below sent somebody inspecting a moment four minutes in back to the
  // first frame. Read before `release`, because the old skim is what knows it. Zero for
  // a first open and zero for a move to another take, which are the two cases where
  // there is no position to keep.
  const resumeAt = viewing && viewing.key === (take.hash ?? take.id) ? viewing.skim.index : 0;
  if (viewing) viewing.skim.release();
  const divisor = DIVISOR[take.state] ?? 1;

  document.getElementById('vName').textContent = take.id;
  const state = document.getElementById('vState');
  state.className = `state ${take.state}`;
  state.replaceChildren(document.createElement('i'));
  state.append(take.state === 'remote' ? 'node' : take.state);
  document.getElementById('vCoarse').textContent = divisor > 1 ? `decimated ÷${divisor}` : '';
  paintFlags(document.getElementById('vFlags'), take);
  document.getElementById('vFacts').replaceChildren(...[
    gb(take.bytes),
    `${take.frames} frames`,
    (take.marks ?? []).length ? `${take.marks.length} mark${take.marks.length === 1 ? '' : 's'}` : 'no marks',
    stamp(take.capturedAt),
    take.hash ? `${take.hash.slice(0, 15)}…` : '',
  ].filter(Boolean).map((text) => {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }));
  vNote.textContent = warningsOf(take).map((w) => w.why).join(' · ');

  const skim = createSkim({
    take,
    divisor,
    canvas: vCanvas,
    surface: vStage,
    bar: vBar,
    onDraw: (n, requested = false) => {
      // The readout moves with the pointer and the counter moves with the picture.
      // Counting both would make "wait until the frame I asked for is drawn" satisfied
      // by the asking, which is a wait on the wrong quantity - the same distinction the
      // tile's counter makes and for the same reason.
      vTime.textContent = `${mmss(skim.seconds)} / ${mmss(take.durationSec)}`;
      if (!requested) viewer.dataset.draws = String(Number(viewer.dataset.draws ?? 0) + 1);
    },
  });
  viewing = { key: take.hash ?? take.id, take, skim };
  paintMarks(vBar, take, (at) => skim.setT(at));

  // The actions, which are the tile's - one surface should not offer a take a
  // different set of things to do from the other.
  const acts = document.getElementById('vActs');
  // Read before the rebuild empties everything, and as a name because the nodes it
  // names are about to stop existing. Null whenever focus is not live inside the
  // viewer, which is every rebuild `run` asked for: it disables the focused control
  // first, so there is nothing here to read and putting focus back is its job rather
  // than this one's. See `controlKey` for why the two share a rule and not a caller.
  const focusWas = viewer.contains(document.activeElement) ? controlKey(document.activeElement) : null;
  acts.replaceChildren();
  // **The surface an action is running on is this one, so this is what `run` holds
  // down.** It used to hand over the grid tile behind the modal, which disabled
  // controls nobody could press and left every control here live. The tile was also
  // not always there to hand over: it is absent whenever the current filter does not
  // show this take, and `take.hash` is null for a take that has not been scanned, so
  // the selector became `[data-hash=""]` and matched nothing - and a null host
  // disables nothing at all rather than disabling the wrong thing.
  const hostOf = () => viewer;
  // **The same list the tile draws, from the same call, rather than the same conditions
  // written again.** This block used to restate what a take allows, and it drifted from
  // the tile's copy four separate times - Delete, the name rule, Download while
  // recording, and Download after a reclaim. Arrow-browsing reaches takes the grid is
  // showing without ever going through `buildTile`, so a rule taught there was a rule
  // this surface had not been told. There is one rule now and both surfaces read it.
  paintActs(acts, take, hostOf);
  const vMore = document.getElementById('vMore');
  // Replaced rather than re-wired: the ⋯ in the header belongs to whichever take is
  // open, and a listener left on the old node would act on the take before this one.
  const freshMore = vMore.cloneNode(true);
  freshMore.setAttribute('aria-expanded', 'false');
  // **And it comes back enabled, because the node it was cloned from may not be.**
  // `run` holds this button down with the rest of the surface and puts it back
  // afterwards - but a successful action repaints first, and the repaint clones the
  // button while it is still held. `restore` then writes the old state onto the node
  // it captured, which by then is detached, so the ⋯ the operator can see stays dead.
  // Closing and reopening does not help: the next rebuild clones the dead one again.
  // Its availability does not depend on the take, so the intended state is simply
  // "enabled" and it is set rather than inherited.
  freshMore.disabled = false;
  // **Focus moves to the replacement, or arrow-browsing stops after one take.** A
  // viewer opened from the keyboard puts focus on its first control, which is this
  // button; ArrowUp or ArrowDown rebuilds the next take and this line removes the very
  // node holding focus. Focus then falls back outside the dialog, real key presses stop
  // reaching the viewer's handler, and browsing dies silently after exactly one step.
  //
  // The review is right that the check could not see this: the test helper dispatches
  // its key events straight at `viewer`, which arrive wherever focus is, so the arm
  // walking takes passed against a build a person could not have walked. The helper
  // sends them at `document.activeElement` now, and a row asserts focus is still inside
  // the viewer after a move.
  vMore.replaceWith(freshMore);
  // Where focus was before this surface was rebuilt, moved to the control that replaced
  // it. **This covers the rebuild that arrives with focus still live, which is
  // arrow-browsing, and only that one.** The rebuild an action asks for arrives with
  // focus already on the body, because `run` disabled the control to hold the surface
  // down - `focusWas` is null there by construction, and `run` places focus itself. A
  // second attempt here would be a rediscovery of something already known, and the two
  // would drift.
  //
  // Found by name rather than by node, because every one of these buttons is a new
  // element by the time this line runs; falling back to the ⋯ when the name did not
  // come back, since a take that changed state offers a different set of actions.
  if (focusWas) {
    const same = findControl(viewer, focusWas);
    (same && !same.disabled ? same : freshMore).focus();
  }
  for (const old of viewer.querySelectorAll('.vhead .menu')) old.remove();
  viewer.querySelector('.vhead').style.position = 'relative';
  buildMenu(viewer.querySelector('.vhead'), freshMore, take, hostOf);

  skim.setIndex(resumeAt);
  if (!viewer.open) viewer.showModal();
}

document.getElementById('vClose').addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => {
  if (viewing) viewing.skim.release();
  viewing = null;
  closeMenus();
});
// A press on the backdrop closes, which is what a modal overlay is expected to do -
// the dialog element itself fills only part of the backdrop, so a click whose target
// is the dialog node is a click outside its contents.
viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.close(); });

let vPressX = null;
vStage.addEventListener('pointerdown', (e) => {
  vStage.setPointerCapture(e.pointerId);
  vPressX = e.clientX;
  viewing?.skim.fromX(e.clientX, vStage);
});
vStage.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' && !e.buttons) return;
  if (vPressX !== null || e.buttons) viewing?.skim.fromX(e.clientX, vStage);
});
vStage.addEventListener('pointerup', () => { vPressX = null; });
vBar.addEventListener('pointerdown', (e) => {
  if (e.target.classList.contains('mk')) return;
  viewing?.skim.fromX(e.clientX, vBar);
});

/**
 * The viewer's keys.
 *
 * A frame at a time with the arrows, ten with shift, the ends with home and end, and
 * another take with up and down. **The step is a frame rather than a fraction of the
 * duration**, which is the whole reason `createSkim` counts in indices: a take is a
 * list of frames and a viewer that stepped by 0.5% would land between two of them and
 * round to whichever was nearer, so pressing right twice could show the same picture.
 *
 * Escape is not here - a `<dialog>` closes on it already, and a second handler would
 * be a second rule to keep in step with the first.
 */
viewer.addEventListener('keydown', (e) => {
  if (!viewing) return;
  const shown = shownTakes();
  const here = shown.findIndex((t) => (t.hash ?? t.id) === viewing.key);
  // **A take can leave the filter while the viewer is holding it open, and the arrows
  // died when it did.** Downloading under the `remote` tab turns that take into
  // `both`, and `paint` deliberately keeps the viewer on it by hash - so the open take
  // is no longer in `shownTakes`, `here` is -1, and both branches below fall through
  // to nothing. The operator is left on a take they have just acted on with no way to
  // continue through the rest of the tab.
  //
  // Where it *would* sit is the answer, because `shown` is sorted by capture time and
  // the take still has one: the first entry no newer than it is the position it left.
  // Up goes to the neighbour before that, down to the entry now occupying it, so a
  // list that closed over the gap still walks in both directions.
  const gap = here >= 0 ? -1 : shown.findIndex((t) => t.capturedAt <= viewing.take.capturedAt);
  const prev = here >= 0 ? here - 1 : (gap === -1 ? shown.length - 1 : gap - 1);
  const next = here >= 0 ? here + 1 : gap;
  const jump = e.shiftKey ? 10 : 1;
  const keys = {
    ArrowLeft: () => viewing.skim.step(-jump),
    ArrowRight: () => viewing.skim.step(jump),
    Home: () => viewing.skim.setIndex(0),
    End: () => viewing.skim.setIndex(viewing.skim.frames - 1),
    ArrowUp: () => { if (prev >= 0 && prev < shown.length) openViewer(shown[prev].hash ?? shown[prev].id); },
    ArrowDown: () => { if (next >= 0 && next < shown.length) openViewer(shown[next].hash ?? shown[next].id); },
  };
  const act = keys[e.key];
  if (!act) return;
  e.preventDefault();
  act();
});

// ------------------------------------------------------------------------ the list

function paint() {
  // Any open menu belongs to a tile that is about to be replaced, so it goes first
  // rather than being left as a floating node over a grid that has moved on.
  closeMenus();
  const shown = shownTakes();
  for (const tile of grid.querySelectorAll('.tile')) tile.__skim?.release();
  grid.replaceChildren();
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    // An empty library and a filtered-empty library are different facts and the
    // line says which. So is a node that could not be reached: reporting it as
    // having no takes would make a dropped link look like an operator who deleted
    // everything, and the Delete on the last copy would then be offered on a
    // belief that is wrong.
    empty.textContent = library.takes.length === 0
      ? 'No takes here yet. Record one, or link a capture node with --node.'
      : `No takes are ${filter}.`;
    grid.appendChild(empty);
  }
  for (const take of shown) grid.appendChild(buildTile(take));

  const total = library.takes.reduce((a, t) => a + t.durationSec, 0);
  document.getElementById('sum').innerHTML =
    `<b>${library.takes.length}</b> take${library.takes.length === 1 ? '' : 's'} · <b>${mmss(total)}</b>`;
  const node = library.node;
  document.getElementById('where').innerHTML = node
    ? `<span class="dot${node.reachable ? '' : ' off'}"></span>on <b>${library.here}</b> · node <b>${node.name}</b> ${node.reachable ? 'linked' : 'unreachable'} · reconciled by hash`
    : `<span class="dot"></span>on <b>${library.here}</b> · no node linked`;
  const space = document.getElementById('space');
  space.textContent = `${library.storage.label} left at current settings`;
  space.classList.toggle('low', library.storage.secondsLeft < 15 * 60);

  for (const tab of document.querySelectorAll('.tab')) {
    const f = tab.dataset.filter;
    const n = library.takes.filter((t) => f === 'all' || t.state === f).length;
    tab.textContent = `${f === 'remote' ? 'node only' : f} ${n}`;
    tab.setAttribute('aria-pressed', String(f === filter));
  }
  if (library.node && !library.node.reachable) say(`${library.node.name} is unreachable: ${library.node.error}`);

  // A viewer open across a repaint follows the take rather than the tile. The take
  // may have been renamed, which changes the id in the header and nothing else, or
  // removed, in which case there is nothing left to show and saying so beats leaving
  // a picture of something that is gone.
  if (viewing) {
    const still = takeByKey(viewing.key);
    if (still) openViewer(viewing.key);
    else {
      viewer.close();
      say('that take is no longer in the library');
    }
  }
}

// **Bounded, because a listing that never comes back stops this page following the
// recorder at all.** `NodeLink.recordState` carries a three-second timeout and
// `NodeLink.takes` carries none, so a node that accepts a connection and then says
// nothing leaves `/library/all` hanging - and single-flight, which is what stops those
// piling up, then means every later tick is skipped for as long as it hangs. The two
// together turn one unlucky listing into a gallery frozen until somebody reloads.
//
// Fifteen seconds rather than the node poll's three: this crosses the network to have a
// directory walked and a sidecar read per take, measured at 145ms against a 200-take
// library, so the bound is there to catch a link that has died rather than to hurry a
// listing that is working. Failing is enough, because a failed refresh is a transition
// this poll has not seen - it says so and the next tick offers it again.
//
// **The bound belongs to the poll's refresh and to nothing else, and the first draft of
// it put the bound in here where every caller got it.** There are three: the load below,
// an operator action's refresh in `run`, and the poll. Only the poll has the single-
// flight guard, so only the poll can turn one dead listing into a page that has stopped
// asking - the other two fail an action or a load that somebody is watching, and would
// rather wait than be cut off. That matters most on the load: a **cold** library is slow
// for a legitimate reason, `cachedIndex` scans each file once and writes a `.idx` beside
// it, and the first listing over 200 unindexed takes measured **7m30s** against the 2.4s
// a second server took off those sidecars. Bounded at fifteen seconds, the one case this
// page exists to get through would have been the case it refused.
const LISTING_TIMEOUT_MS = 15000;

async function refresh({ bound = false } = {}) {
  const res = await fetch('/library/all', {
    signal: bound ? AbortSignal.timeout(LISTING_TIMEOUT_MS) : undefined,
  });
  const body = await res.json().catch(() => null);
  // **Checked before it replaces the last library that worked**, because the server's
  // refusals are JSON. `res.json()` on a 500 carrying `{ error: ... }` resolves
  // perfectly happily, so assigning it straight through put an object with no `takes`
  // and no `storage` into `library` - and `paint()` reads `library.storage.label`. The
  // throw then landed *inside* the top-level catch, which paints again against the same
  // wrecked object, and a throw inside a catch is uncaught: module evaluation ends,
  // `__library` is never installed and the poll never starts. That is the exact failure
  // the catch was added to end, arriving through the one door it did not cover, and the
  // fixture missed it by serving a body that was not JSON - so `res.json()` threw, the
  // assignment never happened, and the intact default was what got painted.
  //
  // The same shape `documentsIn` in `web/main.js` uses against the same server, rather
  // than a second way of asking whether a listing is a listing.
  if (!res.ok || !Array.isArray(body?.takes)) {
    throw new Error(body?.error ?? `the library could not be listed: HTTP ${res.status}`);
  }
  library = body;
  paint();
}

/**
 * The listing just painted, said back in the shape `/record/state` answers in, so the
 * poll can compare its first tick against the grid rather than against nothing.
 *
 * Read off `local` and `remote` rather than off the reconciled record, because those
 * are the two recorders the poll asks and the reconciled `recording` flag is whichever
 * side won the spread. A take mid-write has no hash and so is never merged, which is
 * why one of the two is always the whole answer for its machine.
 */
const believedFromLibrary = () => ({
  writingId: library.takes.find((t) => t.local?.recording)?.local.id ?? null,
  node: library.node
    ? {
      reachable: library.node.reachable,
      writingId: library.takes.find((t) => t.remote?.recording)?.remote.id ?? null,
    }
    : null,
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { filter = tab.dataset.filter; paint(); });
}

// **A first listing that fails leaves a page that works, and that is the class rather
// than the timeout that revealed it.** This is a top-level await, so anything it throws
// ends the module here - before the poll is started and before `globalThis.__library`
// exists. The bound above was one way to reach that and unbounding it closes only that
// one: a node that resets the connection, a 500 out of `serveLibrary`, a listing that
// parses as something other than JSON all end module evaluation identically, and what
// the operator gets is a blank shelf with no error on it and no way to retry short of a
// reload. Caught here, the page paints what it has, says what went wrong, and starts the
// poll - which asks again every five seconds and repairs the grid the moment the library
// can be read.
try {
  await refresh();
} catch (err) {
  say(`the library could not be read: ${err.message}`);
  paint();
}

/**
 * The gallery stops being a snapshot taken at load.
 *
 * A tile of a take that is mid-write says so, and `cannotOpen` reads that same
 * warning out to disable Open, Download, Rename and Remove behind it. Nothing polled,
 * so the moment the recorder stopped every one of those was wrong until somebody
 * reloaded: the take is finished, hashed and openable, and the gallery went on
 * refusing to open it for as long as the page stayed up.
 *
 * **Gated here rather than inside the poll, and the gate is the whole of this.**
 * `paint()` closes every menu, releases every skim and replaces every tile, so an
 * ungated refresh would take an open menu away every five seconds and reset a skim
 * under the pointer. The recording flag and the take id are what decide what a tile
 * is allowed to claim about a take, so they are what a repaint is worth paying for;
 * a frame count ticking up is not.
 *
 * The failure is reported rather than swallowed, on the line the unreachable node
 * already uses: a gallery that quietly stopped following the recorder looks exactly
 * like a gallery with nothing to follow.
 *
 * **And re-thrown after it is reported, which is what buys the retry.** The poll only
 * records a tick as seen once this handler returns, so a refresh that lost its
 * connection leaves the fingerprint where it was and the next tick offers the same
 * transition again. Reporting it and returning normally - which is what this did - made
 * one unlucky five-second window permanent: the fingerprint had already advanced past
 * the transition the refresh failed on, every later tick matched it, and the grid kept a
 * finished take's Open, Download, Rename and Remove disabled until some *other*
 * transition happened along.
 *
 * **Seeded with what the grid on screen already says, because the listing above and
 * the poll's first tick are two reads of a moving world.** A take that stopped between
 * them left the paint saying "being written" and every fingerprint from then on saying
 * "nothing is" - all identical, so nothing ever changed, and the tile refused to open a
 * finished take for as long as the page stayed up. The seed makes the first tick a
 * comparison against the paint rather than against nothing, so the disagreement is
 * caught on the tick that finds it.
 */
pollRecordState(async (state, changed) => {
  if (!changed) return;
  try {
    await refresh({ bound: true });
  } catch (err) {
    say(`the library could not be reread: ${err.message}`);
    throw err;
  }
}, believedFromLibrary());

// What a check reads. Every number here comes from the library's own state rather
// than from the DOM, except the mark ticks - those are read back off the page on
// purpose, because a tile that drew the right count in the wrong places is exactly
// the failure a state-only assertion would pass.
globalThis.__library = {
  state: () => library,
  filter: (f) => { filter = f; paint(); },
  refresh,
  tiles: () => [...grid.querySelectorAll('.tile')].map((el) => ({
    id: el.dataset.id,
    hash: el.dataset.hash,
    state: el.dataset.state,
    // `why` off the rendered `title` rather than out of `availability`, so a row
    // asking whether two surfaces say the same thing reads the sentence an operator
    // would actually get rather than the one the function returned.
    //
    // `item` for the same reason the menu below carries one, and the symmetry is
    // load-bearing rather than tidy: acts reported the label alone, so a check looking
    // an act up by name had only `menu` to look in - and `menu` holds rename, reveal
    // and reclaim and has no `delete` on any build. A row asserting that no tile offers
    // Delete while a node is unreachable was therefore a filter over a match that
    // cannot exist, and passed whatever the page did. Both lists answer the same four
    // questions now, so an act can be found where an act is.
    acts: [...el.querySelectorAll('.acts .act')].map((b) => ({
      item: b.dataset.act, label: b.textContent, disabled: b.disabled, why: b.title,
    })),
    menu: [...el.querySelectorAll('.menu .mi')].map((b) => ({
      item: b.dataset.item, label: b.textContent, disabled: b.disabled, why: b.title,
    })),
    flags: [...el.querySelectorAll('.skim .flag')].map((f) => f.dataset.flag),
    // The same badges with the sentence each one is short for. A second field rather
    // than a richer `flags`, because a dozen rows above read `flags` as a list of
    // keys and a shape change there would be a rewrite of all of them to add one
    // reading.
    badges: [...el.querySelectorAll('.skim .flag')].map((f) => ({
      key: f.dataset.flag, short: f.textContent, why: f.title,
    })),
    marks: [...el.querySelectorAll('.bar .mk')].map((m) => Number.parseFloat(m.style.left)),
    coarse: el.querySelector('.coarse')?.textContent ?? null,
    empty: false,
  })),
  emptyLine: () => grid.querySelector('.empty')?.textContent ?? null,
  // Which refusal keys this page has a badge for, so a check can hold the two tables
  // against each other rather than against the refusals that happen to exist today.
  // A key the server can send and this page cannot badge is the next wrong label,
  // and it is a row rather than something to notice.
  badgeKeys: () => Object.keys(BADGES),

  /**
   * Every tile's geometry as it actually rendered, which is the only place the
   * uniform-height claim can be read from.
   *
   * Off `getBoundingClientRect` rather than off the CSS, because "every tile is the
   * same height" is a statement about the boxes the browser produced - a rule that
   * looks like it should hold is what the JavaScript-assigned poster height also
   * looked like, and it was 2.496:1 after a resize.
   */
  geometry: () => [...grid.querySelectorAll('.tile')].map((el) => {
    const r = el.getBoundingClientRect();
    const skim = el.querySelector('.skim').getBoundingClientRect();
    const facts = [...el.querySelectorAll('.facts')];
    const acts = el.querySelector('.acts');
    return {
      id: el.dataset.id,
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      width: r.width,
      posterHeight: skim.height,
      posterRatio: skim.width / skim.height,
      // A row that has wrapped is taller than one line, and a row whose content
      // overflows has more to draw than it drew. Both are how a tile grows.
      factsOverflow: facts.some((f) => f.scrollWidth > f.clientWidth + 1),
      actsWrapped: acts.scrollHeight > acts.clientHeight + 1,
      canvasPixels: (() => {
        const c = el.querySelector('canvas');
        return { w: c.width, h: c.height };
      })(),
    };
  }),

  /**
   * Every interactive control the gallery renders, so a sweep can require a driver
   * for each rather than testing the ones somebody remembered.
   *
   * Read out of the document, which is why the ⋯ menus are built hidden rather than
   * on demand - a menu that only exists after a click could only be enumerated by
   * asking this file what it would have built, and a list describing itself is not a
   * measurement.
   */
  controls: () => [...document.querySelectorAll(
    '.appbar a, .tab, .tile .act, .tile .mi, #viewer .act, #viewer .mi, #viewer .mk, dialog .act, dialog input',
  )].map((el) => ({
    // `||` and never `??`, because the DOM answers the absent ones with an empty
    // string rather than with undefined - `el.id` on a button that has no id is `''`,
    // which `??` keeps. The first spelling of this gave every tab the key `''`, so a
    // sweep asserting a driver per control reported four controls it could not name
    // and four drivers naming nothing, both of them true and neither of them the
    // thing under test.
    key: el.dataset.act || el.dataset.item || el.id || el.dataset.filter || el.className,
    tag: el.tagName.toLowerCase(),
    where: el.closest('#viewer') ? 'viewer' : el.closest('dialog') ? 'dialog' : el.closest('.tile') ? 'tile' : 'chrome',
    text: (el.textContent ?? '').trim().slice(0, 24),
    disabled: el.disabled === true,
  })),

  /**
   * What the ⋯ menu on a tile offers, opened by pressing the tile's own button.
   *
   * **The press is conditional, the way `clickMenuItem`'s is**, because the button is a
   * toggle and this hook is named for one direction of it. A caller that had already
   * opened this tile's menu got it shut instead, and a shut menu measures 0x0 at the
   * origin - so `clipped` read as the whole menu sitting above the grid and the
   * placement row reddened over a menu that had never been placed. The reading was of
   * the hook, not of the page.
   */
  openMenu: (hash) => {
    const tile = grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`);
    if (tile.querySelector('.menu').hidden) tile.querySelector('.act.more').click();
    const menu = tile.querySelector('.menu');
    const box = menu.getBoundingClientRect();
    const clip = grid.getBoundingClientRect();
    return {
      open: !menu.hidden,
      items: [...menu.querySelectorAll('.mi')].map((b) => ({
        item: b.dataset.item, label: b.textContent, disabled: b.disabled,
      })),
      note: menu.querySelector('.mnote').textContent,
      // Whether an open menu is actually on screen. A menu clipped by the scroll
      // container is a menu whose first item nobody can read, and every assertion
      // about what it offers passes on one - the items are in the document either way.
      inside: box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5,
      clipped: {
        above: Math.round(clip.top - box.top),
        below: Math.round(box.bottom - clip.bottom),
        height: Math.round(box.height),
      },
      // What the placement was working from, so a row that goes red says which
      // decision was wrong rather than only that the box ended up outside. The button
      // being off-screen is the case the arithmetic alone cannot see, and it shows up
      // here as a negative room on both sides.
      room: (() => {
        const b = tile.querySelector('.act.more').getBoundingClientRect();
        return { above: Math.round(b.top - clip.top), below: Math.round(clip.bottom - b.bottom) };
      })(),
      placed: menu.style.top !== 'auto' && menu.style.top ? `top ${menu.style.top}` : `bottom ${menu.style.bottom}`,
    };
  },
  menuOpen: () => document.querySelectorAll('.menu:not([hidden])').length,
  clickMenuItem: (hash, item) => {
    const tile = grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`);
    if (tile.querySelector('.menu').hidden) tile.querySelector('.act.more').click();
    tile.querySelector(`.mi[data-item="${item}"]`).click();
  },

  /** What a tile's confirm actually says, opened by pressing the tile's own button. */
  confirmFor: (hash, act) => {
    const tile = grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`);
    const button = [...tile.querySelectorAll('.acts .act')].find((b) => b.textContent === act);
    button.click();
    const go = document.getElementById('cGo');
    const out = {
      title: document.getElementById('cTitle').textContent,
      warn: document.getElementById('cWarn').textContent,
      go: go.textContent,
      goDisabled: go.disabled,
      // What it looks like, which `disabled` does not answer. A rule three classes
      // deep beat `.act:disabled` on specificity here, so both dialogs showed a lit,
      // pressable-looking button beside the sentence explaining why pressing it would
      // be refused - functionally disabled the whole time, which is exactly why every
      // assertion about `disabled` passed.
      goPaint: (() => {
        const s = getComputedStyle(go);
        return `${s.color}|${s.borderColor}`;
      })(),
    };
    dlg.close();
    return out;
  },

  /** The rename box, driven the way an operator drives it. */
  rename: {
    open: (hash) => globalThis.__library.clickMenuItem(hash, 'rename'),
    type: (text) => {
      renameInput.value = text;
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        why: renameWhy.textContent,
        blocked: renameGo.disabled,
        bad: renameInput.classList.contains('bad'),
      };
    },
    commit: () => { renameGo.click(); },
    isOpen: () => renameDlg.open,
    close: () => renameDlg.close(),
  },

  /** The viewer, and what it is showing. */
  viewer: {
    open: (hash) => openViewer(hash),
    isOpen: () => viewer.open,
    close: () => viewer.close(),
    state: () => (viewing ? {
      id: viewing.take.id,
      hash: viewing.take.hash,
      index: viewing.skim.index,
      frames: viewing.skim.frames,
      time: vTime.textContent,
      note: vNote.textContent,
      flags: [...document.querySelectorAll('#vFlags .flag')].map((f) => f.dataset.flag),
      marks: [...vBar.querySelectorAll('.mk')].map((m) => Number.parseFloat(m.style.left)),
      // Reported in the same shape `tiles()` reports a tile's, because what reads them
      // is one comparison: the two surfaces have to offer a take the same things, and a
      // reader that could see only one half of each would be comparing the halves that
      // never disagreed. The ⋯ itself is in the header rather than in `#vActs`, so the
      // action rows line up without either side needing to be trimmed of it. That is
      // why the key order here is the key order there - the comparison is on the
      // serialised object, so a field in a different place reads as a disagreement.
      acts: [...document.querySelectorAll('#vActs .act')].map((b) => ({
        item: b.dataset.act, label: b.textContent, disabled: b.disabled, why: b.title,
      })),
      menu: [...viewer.querySelectorAll('.menu .mi')].map((b) => ({
        item: b.dataset.item, label: b.textContent, disabled: b.disabled, why: b.title,
      })),
      stage: (() => {
        const r = vStage.getBoundingClientRect();
        return { width: r.width, height: r.height, ratio: r.width / r.height };
      })(),
    } : null),
    // **Sent from wherever focus actually is, not at the viewer.** Dispatching straight
    // at `viewer` delivers the event however focus is arranged, so an arm that walked
    // takes with the arrows passed against a build where rebuilding the header dropped
    // focus out of the dialog and a real key press reached nothing. The check was
    // measuring its own dispatch. Firing at `document.activeElement` lets it bubble the
    // way a keyboard's does, so focus escaping the viewer is a failure here too.
    key: (name, shift = false) => (document.activeElement ?? viewer).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true }),
    ),
    /** Whether focus is still somewhere inside the viewer, which arrow-browsing needs. */
    focusInside: () => viewer.contains(document.activeElement),
    draws: () => Number(viewer.dataset.draws ?? 0),
    async drawn(atLeast) {
      for (let i = 0; i < 200; i++) {
        if (this.draws() >= atLeast) return this.draws();
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error(`the viewer never drew ${atLeast} frames`);
    },
    /** What is on the viewer's canvas, the same two numbers `poster` answers with. */
    picture: () => signatureOf(vCanvas),
    clickMark: (n) => vBar.querySelectorAll('.mk')[n].click(),
  },

  /** How many frames a tile has drawn. Waited on rather than slept against. */
  draws: (hash) => Number(grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`)?.dataset.draws ?? 0),

  async drawn(hash, atLeast = 1) {
    for (let i = 0; i < 200; i++) {
      if (this.draws(hash) >= atLeast) return this.draws(hash);
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`tile ${hash} never drew ${atLeast} frames`);
  },

  /** Skims a tile to a position and resolves once the frame it asked for is drawn. */
  async skimTo(hash, t) {
    const tile = grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`);
    const before = this.draws(hash);
    const skim = tile.querySelector('.skim');
    const r = skim.getBoundingClientRect();
    skim.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: r.left + r.width * t, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1,
    }));
    // Waited on the draw counter rather than on a duration, so the assertion that
    // follows is about the frame the pointer asked for rather than about whatever
    // had been drawn when a timer happened to expire.
    await this.drawn(hash, before + 1);
    return { label: tile.querySelector('.t').textContent, left: tile.querySelector('.pos').style.left };
  },

  /**
   * What is actually on a tile's canvas: how bright it is on average, and a
   * signature over every pixel.
   *
   * Both, because they answer different questions and a check that only had the
   * mean would be blind to the one that matters. Two frames of the same take a
   * second apart have almost the same mean - the room did not get brighter - so a
   * mean-only assertion that a skim moved would sit on a threshold barely above its
   * own noise. The signature says whether the picture changed at all; the mean says
   * whether there is a picture there and how dense it is.
   */
  poster(hash) {
    const canvas = grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"] canvas`);
    return canvas ? signatureOf(canvas) : null;
  },
};

function signatureOf(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let h = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i];
    h = Math.imul(h ^ data[i], 16777619) >>> 0;
  }
  return { mean: sum / (data.length / 4), signature: h.toString(16) };
}
