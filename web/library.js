// The gallery. Takes are tiles you skim rather than rows you open: moving across a tile
// scrubs it through the same frame API the editor reads. Nothing is stored - no proxy, no
// rendered poster - and a tile's height is CSS, which `library.html` enforces.

import { VALID_ID } from '/format.js';
import { pollRecordState } from '/record-poll.js';
import { testTimer } from '/test-timers.js';
import { createSkim, divisorFor, paintMarks, timesFor } from './take-draw.js';

const grid = document.getElementById('grid');
const dlg = document.getElementById('confirm');
const noteEl = document.getElementById('note');
const vSayEl = document.getElementById('vSay');

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
// A count on its way into markup: `frames` and `marks.length` reach `innerHTML`, and a
// manifest can come from a node.
const countOf = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
// The take's wall clock in the reader's zone; `toISOString` is UTC and read two hours early.
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Every field `paint` reads, because `paint` runs against this before the first listing lands.
let library = {
  takes: [],
  node: null,
  here: '?',
  storage: {
    freeBytes: null, bytesPerSec: null, secondsLeft: Infinity, label: '—', error: null,
  },
  reveal: { available: false, label: null, why: null },
};
let filter = 'all';

// Written to both status lines, because the viewer modal covers `#note`.
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

// The JSON content type is load-bearing: a page you merely visit can POST cross-origin
// without asking permission, but it cannot declare `application/json` while doing it.
const post = (url, body) => jsonOf(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});


// The badge each refusal wears. A key with no entry reads as itself, so an unknown refusal
// badges unmapped rather than wrong; no prototype, because the keys come off the wire.
const BADGES = Object.assign(Object.create(null), {
  'no-hello': () => 'no hello',
  format: () => 'unknown format',
  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),
});

/** The warnings a take carries. `short` fits over a 228px poster; `why` is the sentence. */
function warningsOf(take) {
  const out = [];
  if (take.recording === true) {
    out.push({
      key: 'recording',
      short: 'recording',
      kind: 'rec',
      why: 'this take is still being written - stop it before opening, downloading, renaming or removing it',
    });
    return out;
  }
  if (secondNames(take).length) {
    out.push({
      key: 'names',
      short: `${take.names.length} names`,
      why: `this take is filed here as ${take.names.join(' and ')}: one take under ${take.names.length} names, so remove the ones you do not want`,
    });
  }
  if (take.truncated) {
    out.push({
      key: 'truncated',
      short: 'truncated',
      why: 'the writer stopped mid-frame, so the take is usable up to the cut and no further',
    });
  }
  if (take.dropped > 0) {
    out.push({
      key: 'dropped',
      short: 'dropped frames',
      why: `the disk could not keep up, so ${take.dropped} frames were never written and the take has a gap where they were`,
    });
  }
  // The reasons in the server's words: written again here, badge and button disagreed.
  for (const refusal of take.openRefusals) {
    out.push({
      key: refusal.key,
      short: BADGES[refusal.key]?.(take) ?? refusal.key,
      why: refusal.why,
    });
  }
  return out;
}

const cannotOpen = (take) => take.openRefusals[0]?.why ?? '';

/** The names this take is filed under here besides the one it is listed as. */
const secondNames = (take) => (Array.isArray(take.names) ? take.names.filter((name) => name !== take.id) : []);


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
 * Why Delete cannot be pressed. One function because the tile and the viewer both ask and
 * both were wrong about a node-only take, which `serveRemoval` answers 404 for.
 */
function cannotDelete(take) {
  if (take.recording === true) return warningsOf(take)[0].why;
  // A node we could not reach is not a node with nothing on it: a failed manifest read is
  // carried as an empty array, and the last-copy rule reads exactly that count.
  if (library.node && !library.node.reachable) {
    return `${library.node.name} cannot be reached, so whether this take has a second copy `
      + 'is unknown - delete is refused rather than guessed at';
  }
  if (take.state === 'remote') {
    return `${take.id} is only on ${library.node?.name ?? 'the node'}, and delete removes a file on this machine`;
  }
  if (secondNames(take).length) {
    return `this take is filed here as ${take.names.join(' and ')}: delete would remove one name and leave the take `
      + 'under the other, so remove the extra name first';
  }
  return unnameable(take);
}

/**
 * Why an action forming a path from this take's id cannot run. `removeTake`, `renameTake`
 * and `revealTake` each hold the id to `VALID_ID`, so `my take.knct` is a 409 from all three.
 */
function unnameable(take) {
  if (VALID_ID.test(take.id)) return '';
  return `${take.id} did not come from the recorder and its name is outside the rule this program forms paths from, `
    + 'so it is listed and played but cannot be renamed, revealed or deleted here';
}

/**
 * Everything a take allows, as data, for whichever surface is drawing it. The tile and the
 * viewer must offer the same take the same things; deciding separately drifted four times,
 * because arrow-browsing reaches takes `buildTile` never ran for.
 */
function availability(take) {
  const shooting = take.recording === true;
  const nodeName = library.node?.name ?? 'the node';
  const acts = [];
  if (take.state === 'remote' && !shooting) {
    // Load-bearing: a take still recording has no settled hash, so a download of it is 409.
    acts.push({
      item: 'download',
      label: 'Download',
      cls: 'act primary',
      enabled: true,
      why: '',
      // Caught rather than left to reject: a click handler has no caller to rethrow to.
      run: (host) => run(
        host,
        `downloading ${take.id} — asking ${nodeName} for ${gb(take.bytes)}`,
        () => post(`/library/download/${encodeURIComponent(take.id)}`),
        () => downloadProgress(take.id),
      ).catch(() => {}),
    });
  } else {
    acts.push({
      // A control that mints a document is a different act from one that shows you footage, and
      // one word covering both is how a list fills with projects somebody only meant to look at.
      // Looking is the viewer above; this makes something.
      item: 'new-project',
      label: 'New project from this take',
      cls: 'act primary',
      enabled: Boolean(take.openable),
      why: cannotOpen(take),
      run: () => { location.href = `/edit?new=${encodeURIComponent(take.id)}`; },
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
 * Runs a tile action, catching what it throws on the way out as well as what it rejects with.
 * `Promise.resolve(run())` does not catch a synchronous throw, so an action that died on a
 * field a take was missing left the button doing nothing and saying nothing about why - and a
 * take off a node's manifest is exactly where a field goes missing.
 */
function runAct(act, hostFor) {
  (async () => act.run(hostFor()))().catch((err) => say(`${act.label.toLowerCase()} could not run: ${err.message}`));
}

function paintActs(row, take, hostFor) {
  for (const a of availability(take).acts) {
    addButton(row, a.label, a.cls, () => runAct(a, hostFor), {
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
  // `scanTakes` admits any `.knct`, so a hand-copied take gets a tile; that costs `unnameable`.
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
      // Off while the take is being written: a file manager stats, indexes and previews the
      // file against the disk the recorder is writing to.
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
    // One per name, so either can be the one kept. The server refuses unless both still hold this take.
    ...(secondNames(take).length ? take.names : []).map((name) => ({
      item: `remove-name:${name}`,
      label: `Remove the name ${name}`,
      enabled: VALID_ID.test(name),
      why: VALID_ID.test(name) ? '' : unnameable({ id: name }),
      run: (tile) => run(tile, `removing the name ${name}`, () => post(`/library/remove-name/${encodeURIComponent(name)}`,
        { hash: take.hash, keep: take.names.find((other) => other !== name) })).catch(() => {}),
    })),
  ];
}

// Which control a control is, so focus survives a rebuild. Keyed on `data-act`, not the
// node - new after every rebuild - nor the label, which carries the node's name.
const controlKey = (el) => el?.dataset?.act || el?.id || null;
const findControl = (host, key) => {
  if (!key || !host?.isConnected) return null;
  const byAct = host.querySelector(`[data-act="${CSS.escape(key)}"]`);
  if (byAct) return byAct;
  // An id is the document's namespace, and `focus()` on the `<dialog id="rename">` it can
  // reach is a silent no-op.
  const byId = host.querySelector(`#${CSS.escape(key)}`);
  return byId?.matches('.act, .mi') ? byId : null;
};

function closeMenus(except = null) {
  for (const menu of document.querySelectorAll('.menu:not([hidden])')) {
    if (menu === except) continue;
    // Focus comes back to the toggle whenever the menu holding it is hidden: hiding an
    // ancestor of the focused element drops focus to the body, outside the viewer's dialog.
    const toggle = menu.parentElement.querySelector('[aria-haspopup="menu"]');
    const heldFocus = menu.contains(document.activeElement);
    menu.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
    if (heldFocus && toggle && !toggle.disabled) toggle.focus();
  }
}

// On `pointerdown` so a button elsewhere is not pressed twice, and captured so a handler
// that stops propagation cannot leave a menu open.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.menu') || e.target.closest('[aria-haspopup="menu"]')) return;
  closeMenus();
}, true);

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

function buildMenu(host, toggle, take, hostFor) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.role = 'menu';
  menu.hidden = true;
  const entries = availability(take).menu;
  for (const entry of entries) {
    const b = addButton(menu, entry.label, 'mi', () => {
      closeMenus();
      runAct(entry, hostFor);
    }, { disabled: !entry.enabled, why: entry.why, item: entry.item });
    b.dataset.item = entry.item;
    b.role = 'menuitem';
  }
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
 * Measured on open, and bounded by the scroll container's box: the grid is what clips.
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
  menu.style.maxHeight = `${Math.max(0, Math.round(up ? above : below))}px`;
  if (up) {
    menu.style.top = 'auto';
    menu.style.bottom = `${Math.round(hostBox.bottom - button.top + GAP)}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${Math.round(button.bottom - hostBox.top + GAP)}px`;
  }

  // Then the box is measured and corrected, because the button itself may be outside the clip.
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
    const after = menu.getBoundingClientRect();
    if (after.height > clip.height - 2 * GAP) menu.style.maxHeight = `${Math.round(clip.height - 2 * GAP)}px`;
  }
}

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

function buildTile(take) {
  const tile = document.createElement('article');
  tile.className = 'tile';
  tile.dataset.id = take.id;
  // The hash, because a filename is not an identity: two machines can hold different takes
  // under one name.
  tile.dataset.hash = take.hash ?? '';
  tile.dataset.state = take.state;
  // Deliberately unscanned: hashing a growing file contends with the recorder's own disk.
  const shooting = take.recording === true;
  tile.dataset.recording = String(shooting);
  const divisor = divisorFor(take);

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
        <span>${shooting ? 'recording now' : `${countOf(take.frames)} frames`}</span>
      </div>
      <div class="facts">
        <span>${countOf((take.marks ?? []).length) ? `${countOf(take.marks.length)} mark${countOf(take.marks.length) === 1 ? '' : 's'}` : 'no marks'}</span>
        <span>${stamp(take.capturedAt)}${take.dateSource === 'mtime' ? ' (file date)' : ''}</span>
      </div>
      <div class="acts"></div>
    </div>`;

  // A take's id is a filename and `scanTakes` admits any `.knct`, so it is text from outside
  // this page: interpolated, `<img src=x onerror=...>.knct` ran script on this origin.
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

  const skimEl = tile.querySelector('.skim');
  const label = tile.querySelector('.t');
  // A take being recorded is listed unscanned, so it has no frame count to index into.
  if (shooting) return tile;

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
  tile.__skim = skim;

  // Moving across the poster scrubs, a press that goes nowhere opens the viewer; four pixels
  // rather than zero because a finger never holds still.
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
  // A captured pointer can end without a `pointerup` - the browser fires `pointercancel` -
  // and `pressX` left set makes the next move over this tile scrub with no button held.
  skimEl.addEventListener('pointercancel', () => { pressX = null; dragged = false; });
  skimEl.addEventListener('pointerleave', () => { pressX = null; skim.setIndex(0); });
  // A role rather than a `<button>`: the poster is also the scrub surface, and a button would
  // put a native activation on the pointer path.
  skimEl.tabIndex = 0;
  skimEl.setAttribute('role', 'button');
  skimEl.setAttribute('aria-label', `View ${take.id}`);
  skimEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openViewer(take.hash ?? take.id);
  });
  barEl.addEventListener('pointerdown', (e) => skim.fromX(e.clientX, barEl));
  requestAnimationFrame(() => skim.setIndex(0));

  return tile;
}

/**
 * Runs one surface's action with its controls held down, and reports while it runs. `watch`
 * returns the sentence to show right now, for the download; `refresh` is false for reveal.
 * `host` is the surface the press came from, so the viewer holds its own controls down.
 */
async function run(host, message, action, watch = null, { refresh: doRefresh = true } = {}) {
  const buttons = host ? [...host.querySelectorAll('.act:not(.vclose), .mi')] : [];
  // What each control was, because reveal does not repaint and these are the same nodes.
  const was = buttons.map((b) => b.disabled);
  // Focus taken as a name rather than an index, because disabling the focused element blurs
  // it and every repaint detaches the node. Whoever takes focus away is who puts it back.
  const wanted = host?.contains(document.activeElement) ? controlKey(document.activeElement) : null;
  const restore = () => {
    buttons.forEach((b, i) => { b.disabled = was[i]; });
    if (!wanted) return;
    // What has to hold is that focus stays inside the surface, or the arrow keys stop.
    const back = findControl(host, wanted)
      ?? (host?.isConnected ? host.querySelector('[aria-haspopup="menu"]') : null);
    if (back && !back.disabled) back.focus();
  };
  for (const b of buttons) b.disabled = true;
  say(message);
  const ticking = watch ? setInterval(async () => {
    try {
      const line = await watch();
      if (line) say(line);
    } catch { /* a poll that failed says nothing rather than replacing the state with an error */ }
  }, 700) : null;
  try {
    const answer = await action();
    say('');
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

async function downloadProgress(id) {
  const res = await fetch('/library/downloads');
  const d = (await res.json()).downloading?.find((x) => x.id === id);
  if (!d) return null;
  if (d.phase === 'verifying') return `verifying ${id} — hashing ${gb(d.bytes)} to check the copy against the node`;
  const pct = d.bytes ? Math.min(100, (d.received / d.bytes) * 100) : 0;
  const rate = d.bytesPerSec / 1e6;
  const left = d.bytesPerSec > 0 ? (d.bytes - d.received) / d.bytesPerSec : 0;
  return `downloading ${id} — ${pct.toFixed(0)}% of ${gb(d.bytes)} at ${rate.toFixed(1)} MB/s, `
    + `about ${left < 90 ? `${Math.ceil(left)}s` : `${Math.ceil(left / 60)}m`} left`;
}


let confirmAction = null;
document.getElementById('cCancel').addEventListener('click', () => dlg.close());
document.getElementById('cGo').addEventListener('click', () => {
  dlg.close();
  confirmAction?.();
});

/**
 * The delete confirm. A `both` take cannot be deleted here - `serveRemoval` answers 409 - so
 * it gets the explanation and no destructive button, pointing at Reclaim rather than quietly
 * performing one: reclaim removes the copy on the *node*, the opposite end.
 */
function askDelete(tile, take) {
  const alsoOnNode = take.state === 'both';
  document.getElementById('cTitle').textContent = alsoOnNode ? 'Two copies exist' : 'Delete take';
  // The id goes in as text: this is the confirm in front of the only irreversible action.
  const body = document.getElementById('cBody');
  body.innerHTML = '<b class="tid"></b>';
  body.querySelector('.tid').textContent = take.id;
  document.getElementById('cWarn').textContent = alsoOnNode
    ? `Delete is disabled: two copies exist. Reclaim the copy on ${library.node?.name} first.`
    : 'This is the only copy. Cannot be undone. Projects using it will lose footage.';
  const go = document.getElementById('cGo');
  go.textContent = 'Delete';
  go.disabled = alsoOnNode;
  // The hash goes with it, so a confirm built against one listing cannot remove a changed take.
  confirmAction = alsoOnNode ? null : () => run(tile, `deleting ${take.id}`,
    () => post(`/library/delete/${encodeURIComponent(take.id)}`, { hash: take.hash, confirm: true })).catch(() => {});
  dlg.showModal();
}

function askReclaim(tile, take) {
  document.getElementById('cGo').disabled = false;
  document.getElementById('cTitle').textContent = `Reclaim on ${library.node?.name}`;
  const rBody = document.getElementById('cBody');
  rBody.innerHTML = '<b class="tid"></b>';
  rBody.querySelector('.tid').textContent = take.id;
  document.getElementById('cWarn').textContent = 'Removes the node copy after this copy is verified.';
  document.getElementById('cGo').textContent = 'Reclaim';
  confirmAction = () => run(tile, `reclaiming ${take.id}`,
    () => post(`/library/reclaim/${encodeURIComponent(take.id)}`)).catch(() => {});
  dlg.showModal();
}


const renameDlg = document.getElementById('rename');
const renameInput = document.getElementById('rName');
const renameWhy = document.getElementById('rWhy');
const renameGo = document.getElementById('rGo');
let renaming = null;

/**
 * The rename box. `VALID_ID` comes from `web/format.js`, which `server/library.js` imports
 * too: the server's copy is the gate and this one greys the button out early. Safe because
 * projects, reconciliation and the menu all key on the hash, never the name.
 */
function askRename(tile, take) {
  renaming = { tile, take };
  renameInput.value = take.id;
  validateRename();
  renameDlg.showModal();
  renameInput.focus();
  renameInput.select();
}

function validateRename() {
  if (!renaming) return false;
  const typed = renameInput.value.trim().replace(/\.knct$/i, '');
  // Only takes with a copy here: counting a node-only one refused a legal rename.
  const clash = library.takes.some(
    (t) => t.id === typed && t.hash !== renaming.take.hash && t.state !== 'remote',
  );
  let why = '';
  if (!typed) why = 'a take needs a name';
  else if (!VALID_ID.test(typed)) {
    why = 'letters, digits, dots, dashes and underscores only, starting with a letter, a digit or an underscore';
  } else if (typed === renaming.take.id) why = 'that is already its name';
  else if (clash) why = `${typed} is taken by another take in this media library`;
  renameWhy.textContent = why;
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
  await run(tile, `renaming ${take.id} to ${to}`,
    () => post(`/library/rename/${encodeURIComponent(take.id)}`, { hash: take.hash, to }))
    .catch(() => {});
}


const viewer = document.getElementById('viewer');
const vStage = document.getElementById('vStage');
const vBar = document.getElementById('vBar');
const vCanvas = document.getElementById('vCanvas');
const vTime = document.getElementById('vTime');
const vNote = document.getElementById('vNote');
let viewing = null;

const takeByKey = (key) => library.takes.find((t) => (t.hash ?? t.id) === key) ?? null;

const shownTakes = () => library.takes.filter((t) => filter === 'all' || t.state === filter);

/**
 * Opens one take large. Keyed by hash and rebuilt from the listing every time, because a
 * rename changes the id underneath an open viewer and a delete removes the take.
 */
function openViewer(key) {
  const take = takeByKey(key);
  if (!take) return;
  closeMenus();
  // Read as a name before anything here is rebuilt: a focused mark tick is destroyed by
  // `paintMarks`, and a rebuild `run` asked for reads null.
  const focusWas = viewer.contains(document.activeElement) ? controlKey(document.activeElement) : null;
  // Where the operator was, kept across a rebuild: `paint` re-opens the viewer on every
  // refresh, so the `setIndex(0)` below sent them back to the first frame.
  const resumeAt = viewing && viewing.key === (take.hash ?? take.id) ? viewing.skim.index : 0;
  const divisor = divisorFor(take);

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
  // A mark is pressed through the take's frame times, so without them its ticks are labels and
  // the note says why. Rebuilt once they fail, the way a refresh rebuilds it. A take being
  // recorded has no index yet, and its badge already says so.
  const timed = take.frames > 0 ? timesFor(take) : null;
  if (timed && !timed.times && !timed.error) {
    timed.ready.then(() => { if (timed.error && viewing?.key === key) openViewer(key); });
  }
  vNote.textContent = [
    ...warningsOf(take).map((w) => w.why),
    timed?.error ? `its marks cannot be pressed: the frame times did not arrive (${timed.error})` : '',
  ].filter(Boolean).join(' · ');

  // One skim for as long as the dialog is open, given each take in turn: the arrow keys and
  // every refresh change the take on this canvas rather than opening a second viewer. The
  // take reaches `onDraw` as an argument because the callback outlives the call that made it.
  const skim = viewing?.skim ?? createSkim({
    canvas: vCanvas,
    surface: vStage,
    bar: vBar,
    onDraw: (n, requested, drawn) => {
      vTime.textContent = `${mmss(skim.seconds)} / ${mmss(drawn?.durationSec ?? 0)}`;
      if (!requested) viewer.dataset.draws = String(Number(viewer.dataset.draws ?? 0) + 1);
    },
  });
  skim.show(take);
  viewing = { key: take.hash ?? take.id, take, skim };
  paintMarks(vBar, take, timed && !timed.error ? (sourceSec) => skim.seek(sourceSec) : null);

  const acts = document.getElementById('vActs');
  acts.replaceChildren();
  // The surface an action runs on is this one: the tile behind the modal is absent whenever
  // the filter does not show this take, and a null host disables nothing.
  const hostOf = () => viewer;
  // The same list the tile draws, from the same call; restating it drifted four times.
  paintActs(acts, take, hostOf);
  const vMore = document.getElementById('vMore');
  // Replaced rather than re-wired: a listener left on the old node would act on the old take.
  const freshMore = vMore.cloneNode(true);
  freshMore.setAttribute('aria-expanded', 'false');
  // And enabled, because the node it was cloned from may not be: a successful action
  // repaints while `run` holds this button down, so `restore` writes to a detached node.
  freshMore.disabled = false;
  // Focus moves to the replacement, or arrow-browsing stops after one take.
  vMore.replaceWith(freshMore);
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
vStage.addEventListener('pointercancel', () => { vPressX = null; });
vBar.addEventListener('pointerdown', (e) => {
  if (e.target.classList.contains('mk')) return;
  viewing?.skim.fromX(e.clientX, vBar);
});

// The viewer's keys. The step is a frame and not a fraction, which is why `createSkim`
// counts in indices. Escape is not here - a `<dialog>` closes on it already.
viewer.addEventListener('keydown', (e) => {
  if (!viewing) return;
  const shown = shownTakes();
  const here = shown.findIndex((t) => (t.hash ?? t.id) === viewing.key);
  // A take can leave the filter while the viewer holds it open, so `here` is -1 and both
  // branches fell through. `shown` is sorted by capture time, so this is where it would sit.
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


function paint() {
  closeMenus();
  const shown = shownTakes();
  for (const tile of grid.querySelectorAll('.tile')) tile.__skim?.release();
  grid.replaceChildren();
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = library.takes.length === 0
      ? 'No takes.'
      : `No takes are ${filter}.`;
    grid.appendChild(empty);
  }
  for (const take of shown) grid.appendChild(buildTile(take));

  const total = library.takes.reduce((a, t) => a + t.durationSec, 0);
  document.getElementById('sum').innerHTML =
    `<b>${library.takes.length}</b> take${library.takes.length === 1 ? '' : 's'} · <b>${mmss(total)}</b>`;
  const node = library.node;
  document.getElementById('where').innerHTML = node
    ? `<span class="dot${node.reachable ? '' : ' off'}"></span><b>${library.here}</b> · <b>${node.name}</b> ${node.reachable ? '' : 'unreachable'}`
    : `<span class="dot"></span><b>${library.here}</b>`;
  const space = document.getElementById('space');
  space.textContent = `${library.storage.label} available`;
  space.classList.toggle('low', library.storage.secondsLeft < 15 * 60);

  for (const tab of document.querySelectorAll('.tab')) {
    const f = tab.dataset.filter;
    const n = library.takes.filter((t) => f === 'all' || t.state === f).length;
    tab.textContent = `${f === 'remote' ? 'node only' : f} ${n}`;
    tab.setAttribute('aria-pressed', String(f === filter));
  }
  if (library.node && !library.node.reachable) say(`${library.node.name} is unreachable: ${library.node.error}`);

  if (viewing) {
    const still = takeByKey(viewing.key);
    if (still) openViewer(viewing.key);
    else {
      viewer.close();
      say('that take is no longer in the media library');
    }
  }
}

// Bounded, because `NodeLink.takes` carries no timeout and the poll's single-flight guard
// then skips every tick. Only the poll passes `bound`: a cold library takes minutes to index.
const LISTING_TIMEOUT_MS = testTimer('listing-timeout', 15000);

// Which listing is newest: a poll refresh on the wire when Delete is pressed resolves later.
let refreshGeneration = 0;

// The newest refresh's outcome, so a superseded one does not report a success it never had.
let newestRefresh = Promise.resolve();

function refresh({ bound = false } = {}) {
  const mine = ++refreshGeneration;
  const run = refreshNow(mine, bound);
  newestRefresh = run;
  return run;
}

async function refreshNow(mine, bound) {
  const res = await fetch('/library/all', {
    signal: bound ? AbortSignal.timeout(LISTING_TIMEOUT_MS) : undefined,
  });
  const body = await res.json().catch(() => null);
  // Checked before it replaces the last library that worked: the server's refusals are JSON,
  // so `paint` reads `storage.label` off one and throws out of the top-level catch.
  if (!res.ok || !Array.isArray(body?.takes)) {
    throw new Error(body?.error ?? `the media library could not be listed: HTTP ${res.status}`);
  }
  if (mine !== refreshGeneration) return newestRefresh;
  library = body;
  paint();
  return undefined;
}

// Off `local` and `remote`, because the reconciled record is whichever side won the spread.
const believedFromLibrary = () => ({
  writingIds: library.takes.filter((t) => t.local?.recording).map((t) => t.local.id).sort(),
  node: library.node
    ? {
      reachable: library.node.reachable,
      writingIds: library.takes.filter((t) => t.remote?.recording).map((t) => t.remote.id).sort(),
    }
    : null,
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { filter = tab.dataset.filter; paint(); });
}

// A top-level await, so anything it throws ends the module before the poll is started.
try {
  await refresh();
} catch (err) {
  say(`the media library could not be read: ${err.message}`);
  paint();
}

// Gated on the recording flag and the take id rather than repainting every tick, because
// `paint` closes every menu and releases every skim. Seeded with what the grid already says.
pollRecordState(async (state, changed) => {
  if (!changed) return;
  try {
    await refresh({ bound: true });
  } catch (err) {
    say(`the media library could not be reread: ${err.message}`);
    throw err;
  }
}, believedFromLibrary());

// Every number is the library's own state except the mark ticks, read back off the page.
globalThis.__library = {
  state: () => library,
  filter: (f) => { filter = f; paint(); },
  refresh,
  tiles: () => [...grid.querySelectorAll('.tile')].map((el) => ({
    id: el.dataset.id,
    hash: el.dataset.hash,
    state: el.dataset.state,
    acts: [...el.querySelectorAll('.acts .act')].map((b) => ({
      item: b.dataset.act, label: b.textContent, disabled: b.disabled, why: b.title,
    })),
    menu: [...el.querySelectorAll('.menu .mi')].map((b) => ({
      item: b.dataset.item, label: b.textContent, disabled: b.disabled, why: b.title,
    })),
    flags: [...el.querySelectorAll('.skim .flag')].map((f) => f.dataset.flag),
    badges: [...el.querySelectorAll('.skim .flag')].map((f) => ({
      key: f.dataset.flag, short: f.textContent, why: f.title,
    })),
    marks: [...el.querySelectorAll('.bar .mk')].map((m) => Number.parseFloat(m.style.left)),
    coarse: el.querySelector('.coarse')?.textContent ?? null,
    empty: false,
  })),
  emptyLine: () => grid.querySelector('.empty')?.textContent ?? null,
  badgeKeys: () => Object.keys(BADGES),

  // Off `getBoundingClientRect` and not the CSS: uniform height is a claim about the boxes.
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
      factsOverflow: facts.some((f) => f.scrollWidth > f.clientWidth + 1),
      actsWrapped: acts.scrollHeight > acts.clientHeight + 1,
      canvasPixels: (() => {
        const c = el.querySelector('canvas');
        return { w: c.width, h: c.height };
      })(),
    };
  }),

  // Read out of the document, which is why the menus are built hidden rather than on demand.
  controls: () => [...document.querySelectorAll(
    '.appbar a, .tab, .tile .act, .tile .mi, #viewer .act, #viewer .mi, #viewer .mk, dialog .act, dialog input',
  )].map((el) => ({
    // `||` and never `??`: the DOM answers the absent ones with `''`, which `??` keeps.
    key: el.dataset.act || el.dataset.item || el.id || el.dataset.filter || el.className,
    tag: el.tagName.toLowerCase(),
    where: el.closest('#viewer') ? 'viewer' : el.closest('dialog') ? 'dialog' : el.closest('.tile') ? 'tile' : 'chrome',
    text: (el.textContent ?? '').trim().slice(0, 24),
    disabled: el.disabled === true,
  })),

  // The press is conditional because the button is a toggle, and a shut menu measures 0x0.
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
      inside: box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5,
      clipped: {
        above: Math.round(clip.top - box.top),
        below: Math.round(box.bottom - clip.bottom),
        height: Math.round(box.height),
      },
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
  // A rule three classes deep beat `.act:disabled`, so a lit button was disabled anyway.
      goPaint: (() => {
        const s = getComputedStyle(go);
        return `${s.color}|${s.borderColor}`;
      })(),
    };
    dlg.close();
    return out;
  },

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
      pressable: [...vBar.querySelectorAll('.mk')].map((m) => m.tagName === 'BUTTON'),
      pos: Number.parseFloat(vBar.querySelector('.pos').style.left),
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
    // Fired at `document.activeElement` so it bubbles; at `viewer` the arm measures itself.
    key: (name, shift = false) => (document.activeElement ?? viewer).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true }),
    ),
    focusInside: () => viewer.contains(document.activeElement),
    draws: () => Number(viewer.dataset.draws ?? 0),
    async drawn(atLeast) {
      for (let i = 0; i < 200; i++) {
        if (this.draws() >= atLeast) return this.draws();
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error(`the viewer never drew ${atLeast} frames`);
    },
    picture: () => signatureOf(vCanvas),
    clickMark: (n) => vBar.querySelectorAll('.mk')[n].click(),
  },

  draws: (hash) => Number(grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`)?.dataset.draws ?? 0),

  async drawn(hash, atLeast = 1) {
    for (let i = 0; i < 200; i++) {
      if (this.draws(hash) >= atLeast) return this.draws(hash);
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`tile ${hash} never drew ${atLeast} frames`);
  },

  async skimTo(hash, t) {
    const tile = grid.querySelector(`.tile[data-hash="${CSS.escape(hash)}"]`);
    const before = this.draws(hash);
    const skim = tile.querySelector('.skim');
    const r = skim.getBoundingClientRect();
    skim.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: r.left + r.width * t, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1,
    }));
    await this.drawn(hash, before + 1);
    return { label: tile.querySelector('.t').textContent, left: tile.querySelector('.pos').style.left };
  },

  // Two frames a second apart have almost the same mean, so only the signature sees a change.
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
