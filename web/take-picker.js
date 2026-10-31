// The clip picker: the library's tile with the lifecycle buttons taken off. Nothing in here
// deletes, renames, reveals, reclaims or downloads - it answers "which footage", and the surface
// that opened it decides what that means. Two surfaces do: the projects page's New project and
// the editor's Add clip, and neither is named anywhere below.

import { createSkim, paintMarks } from './take-draw.js';

// Bounded for the reason `web/library.js` bounds its poll: `/library/all` waits on the capture
// node, and a node that has gone away would otherwise leave the dialog reading forever.
const LISTING_TIMEOUT_MS = 15000;

const mmss = (s) => {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
// A count on its way onto the tile: `frames` and `marks.length` come off a manifest a node wrote.
const countOf = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
// The take's wall clock in the reader's zone; `toISOString` is UTC and reads two hours early.
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// The badge each refusal wears, in the library's words: a key with no entry reads as itself, and
// no prototype, because the keys come off the wire.
const BADGES = Object.assign(Object.create(null), {
  'no-hello': () => 'no hello',
  format: () => 'unknown format',
  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),
});

/** The warnings a take carries. `short` fits over a 228px poster; `why` is the sentence. */
function warningsOf(take) {
  if (take.recording === true) {
    return [{
      key: 'recording',
      short: 'recording',
      kind: 'rec',
      why: 'this take is still being written, so it has no settled length to cut against - stop the recorder first',
    }];
  }
  const out = [];
  if (take.truncated) {
    out.push({
      key: 'truncated',
      short: 'truncated',
      why: 'the writer stopped mid-frame, so the take is usable up to the cut and no further',
    });
  }
  for (const refusal of take.openRefusals) {
    out.push({ key: refusal.key, short: BADGES[refusal.key]?.(take) ?? refusal.key, why: refusal.why });
  }
  return out;
}

/** A button, built rather than interpolated, because a label is not markup either. */
function button(row, label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.dataset.act = label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  b.addEventListener('click', onClick);
  row.appendChild(b);
  return b;
}

/**
 * Why this take cannot be a clip, or the empty string. A clip is drawn from a capture on this
 * machine, so the node-only case is a refusal here rather than a take left off the list.
 */
function cannotPick(take, nodeName) {
  if (take.state === 'remote') {
    return `${take.id} is only on ${nodeName}, and a clip is drawn from a capture on this machine`;
  }
  return take.openRefusals[0]?.why ?? '';
}

/**
 * Opens the media picker and resolves to the takes that were picked, in pick order, or to null
 * for a cancel. One take picked is one clip, which is what it has always been; several are laid
 * end to end in that order by whoever asked.
 *
 * `ceiling` is how many clips this build composites and `taken` how many the asking edit already
 * holds, so the picker can refuse a pick that would cross it and say why. It reads the library
 * itself and knows nothing about the surface that opened it.
 */
export function pickTakes({ ceiling, taken = 0, title = 'Pick footage', confirmLabel = 'Add clips' }) {
  const room = Math.max(0, ceiling - taken);
  const dlg = document.createElement('dialog');
  dlg.className = 'takepicker';
  dlg.id = 'takePicker';
  dlg.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'tp-head';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const roomLine = document.createElement('span');
  roomLine.className = 'tp-room';
  roomLine.textContent = `${room} available`;
  head.append(heading, roomLine);

  const note = document.createElement('div');
  note.className = 'tp-note';
  const grid = document.createElement('div');
  grid.className = 'tp-grid';

  const foot = document.createElement('div');
  foot.className = 'tp-foot';
  const spacer = document.createElement('span');
  spacer.className = 'tp-spacer';
  foot.appendChild(spacer);

  dlg.append(head, note, grid, foot);
  document.body.appendChild(dlg);

  // Every skim this dialog made, released together on the way out: a pump left running against a
  // detached canvas goes on fetching frames nobody will see.
  const skims = [];
  /** @type {object[]} */
  const picked = [];
  let settle = null;
  const answer = new Promise((resolve) => { settle = resolve; });
  let answered = false;

  const finish = (result) => {
    if (answered) return;
    answered = true;
    for (const s of skims) s.release();
    dlg.close();
    dlg.remove();
    settle(result);
  };

  button(head, '×', 'tp-act close', () => finish(null)).setAttribute('aria-label', 'Close');
  const cancel = button(foot, 'Cancel', 'tp-act', () => finish(null));
  const go = button(foot, confirmLabel, 'tp-act go', () => finish(picked.slice()));
  go.disabled = true;

  // A dialog closed by Escape or by the backdrop is a cancel: `close` fires for every route out,
  // and `finish` is idempotent, so the one it was called from wins and this one does nothing.
  dlg.addEventListener('close', () => finish(null));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null); });

  const paintPicked = () => {
    for (const tile of grid.querySelectorAll('.tp-tile')) {
      const at = picked.findIndex((t) => (t.hash ?? t.id) === tile.dataset.key);
      tile.setAttribute('aria-pressed', String(at >= 0));
      const chip = tile.querySelector('.tp-order');
      chip.textContent = at >= 0 ? String(at + 1) : '';
      chip.hidden = at < 0;
    }
    go.disabled = picked.length === 0;
  };

  const toggle = (take, why) => {
    note.textContent = '';
    if (why) {
      note.textContent = why;
      return;
    }
    const at = picked.findIndex((t) => (t.hash ?? t.id) === (take.hash ?? take.id));
    if (at >= 0) picked.splice(at, 1);
    else if (picked.length >= room) {
      note.textContent = `Clip limit: ${ceiling}. Unpick one first.`;
      return;
    } else picked.push(take);
    paintPicked();
  };

  function buildTile(take, nodeName) {
    const tile = document.createElement('article');
    tile.className = 'tp-tile';
    // The hash, because a filename is not an identity: two machines can hold different takes
    // under one name.
    tile.dataset.key = take.hash ?? take.id;
    tile.dataset.take = take.id;
    const why = cannotPick(take, nodeName);
    const shooting = take.recording === true;

    tile.innerHTML = `
      <div class="tp-skim"><canvas></canvas><span class="tp-time">00:00</span>
        <span class="tp-order" hidden></span>
        <div class="tp-flags"></div></div>
      <div class="tp-bar"><span class="done"></span><span class="pos"></span></div>
      <div class="tp-meta">
        <div class="tp-top"><span class="tp-name"></span><span class="tp-dur">${shooting ? '···' : mmss(take.durationSec)}</span></div>
        <div class="tp-facts">
          <span>${gb(take.bytes)}</span>
          <span>${shooting ? 'recording now' : `${countOf(take.frames)} frames`}</span>
          <span>${countOf((take.marks ?? []).length) ? `${countOf(take.marks.length)} mark${countOf(take.marks.length) === 1 ? '' : 's'}` : 'no marks'}</span>
        </div>
        <div class="tp-facts"><span>${stamp(take.capturedAt)}${take.dateSource === 'mtime' ? ' (file date)' : ''}</span></div>
      </div>`;

    // A take's id is a filename and `scanTakes` admits any `.knct`, so it is text from outside
    // this page: interpolated, `<img src=x onerror=...>.knct` ran script on this origin.
    const name = tile.querySelector('.tp-name');
    name.textContent = take.id;
    name.title = take.id;

    const flags = tile.querySelector('.tp-flags');
    for (const w of warningsOf(take)) {
      const chip = document.createElement('span');
      chip.className = `tp-flag${w.kind ? ` ${w.kind}` : ''}`;
      chip.dataset.flag = w.key;
      chip.textContent = w.short;
      chip.title = w.why;
      flags.appendChild(chip);
    }

    const barEl = tile.querySelector('.tp-bar');
    if (!shooting) paintMarks(barEl, take);

    // A toggle rather than a link, and the pick order is read off the chip beside it: `aria-label`
    // names the take because the tile's own text is a poster.
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-pressed', 'false');
    tile.setAttribute('aria-label', take.id);
    tile.tabIndex = 0;
    if (why) tile.setAttribute('aria-disabled', 'true');
    tile.addEventListener('keydown', (e) => {
      if (e.target !== tile) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle(take, why);
    });

    const skimEl = tile.querySelector('.tp-skim');
    // A take being recorded is listed unscanned, so it has no frame count to index into. The tile
    // is still a click target, and clicking it says why it cannot be picked.
    if (shooting) {
      tile.addEventListener('click', () => toggle(take, why));
      return tile;
    }

    const label = tile.querySelector('.tp-time');
    const skim = createSkim({
      canvas: tile.querySelector('canvas'),
      surface: skimEl,
      bar: barEl,
      onDraw: (n, requested) => {
        if (requested) {
          label.textContent = mmss(skim.seconds);
          return;
        }
        // Counted, because "the poster is drawn" is otherwise unobservable from outside.
        tile.dataset.draws = String(Number(tile.dataset.draws ?? 0) + 1);
      },
    });
    skim.show(take);
    skims.push(skim);

    // Moving across the poster scrubs and a press that goes nowhere picks; four pixels rather
    // than zero because a finger never holds still. The same gesture the library tile runs,
    // arriving somewhere else.
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
      if (tap) toggle(take, why);
    });
    // A captured pointer can end without a `pointerup` - the browser fires `pointercancel` -
    // and `pressX` left set makes the next move over this tile scrub with no button held.
    skimEl.addEventListener('pointercancel', () => { pressX = null; dragged = false; });
    skimEl.addEventListener('pointerleave', (e) => {
      if (skimEl.hasPointerCapture?.(e.pointerId)) return;
      pressX = null;
    });
    barEl.addEventListener('pointerdown', (e) => {
      barEl.setPointerCapture?.(e.pointerId);
      skim.fromX(e.clientX, barEl);
    });
    barEl.addEventListener('pointermove', (e) => {
      if (e.buttons) skim.fromX(e.clientX, barEl);
    });
    // Everything below the poster picks: the poster is the scrub surface and the meta is not.
    tile.querySelector('.tp-meta').addEventListener('click', () => toggle(take, why));
    requestAnimationFrame(() => skim.setIndex(0));

    return tile;
  }

  /** The whole dialog is the message when there is nothing to pick, and it carries the way on. */
  function deadEnd(sentence, actLabel, href) {
    const box = document.createElement('div');
    box.className = 'tp-empty';
    const p = document.createElement('p');
    p.textContent = sentence;
    box.appendChild(p);
    if (actLabel) button(box, actLabel, 'tp-act go', () => { location.href = href; });
    grid.replaceChildren(box);
    go.hidden = true;
    cancel.textContent = 'Close';
  }

  async function fill() {
    let body;
    try {
      const res = await fetch('/library/all', { signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
      body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.takes)) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      deadEnd(`Media library unavailable: ${err.message}`, null, null);
      return;
    }
    const nodeName = body.node?.name ?? 'the capture node';
    // Newest first, and sorted here rather than trusted off the wire: one order that does not
    // depend on which project asked is this dialog's own rule, so this dialog is what holds it.
    const takes = [...body.takes].sort((a, b) => b.capturedAt - a.capturedAt);
    const here = takes.filter((t) => t.state !== 'remote');
    if (here.length === 0) {
      if (takes.length === 0) {
        deadEnd(
          'No takes.',
          'Record a take', '/record',
        );
      } else {
        deadEnd(
          `No local takes. ${nodeName} has ${takes.length}.`,
          'Open Media library', '/library',
        );
      }
      return;
    }
    grid.replaceChildren(...here.map((take) => buildTile(take, nodeName)));
    paintPicked();
  }

  dlg.showModal();
  fill();
  return answer;
}
