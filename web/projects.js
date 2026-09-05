import { PROJECT_VERSION, documentNameRefusal, versionRefusal } from './format.js';
import { clipAffordedSec, clipSourceSecAt, usableClipRate } from './clip-plan.js';
import { createSkim } from './take-draw.js';
import { pickTakes } from './take-picker.js';

const CLIP_CEILING = 8;

const LISTING_TIMEOUT_MS = 15000;

const listEl = document.getElementById('list');
const noteEl = document.getElementById('note');
const dlg = document.getElementById('confirm');

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const say = (text) => { noteEl.textContent = text; };

let projects = [];
let localTakes = [];

/** The local take a clip's footage hash names, or null for a clip whose footage is not here. */
const takeFor = (clip) => (clip.take?.hash
  ? localTakes.find((t) => t.hash === clip.take.hash) ?? null
  : null);

/** How much program time a clip runs for. */
function spanOf(clip, take) {
  if (clip.length !== null && Number.isFinite(clip.length)) return Math.max(0, clip.length);
  if (!take || !(take.durationSec > 0)) return 0;
  const afforded = clipAffordedSec(clip, take.durationSec);
  return Number.isFinite(afforded) ? afforded : 0;
}

/** Each clip with where it sits in program time and what it resolved to, in document order. */
function layout(body) {
  return body.clips.map((clip) => {
    const take = takeFor(clip);
    return { clip, take, start: Math.max(0, clip.start), span: spanOf(clip, take) };
  });
}

const lengthOf = (spans) => spans.reduce((a, s) => Math.max(a, s.start + s.span), 0);

/** The clip covering a program second, or null in a gap. Returns the topmost when clips overlap. */
function clipAt(spans, programSec) {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (programSec >= s.start && programSec < s.start + s.span) return s;
  }
  return null;
}

/** The frame of a take a program second lands on. */
function frameAt(span, programSec) {
  const { clip, take } = span;
  const sourceSec = clipSourceSecAt(clip, programSec - span.start);
  if (!Number.isFinite(sourceSec) || !(take.durationSec > 0)) return 0;
  const at = sourceSec / take.durationSec;
  return Math.round(Math.max(0, Math.min(1, at)) * Math.max(0, take.frames - 1));
}

/** The takes a project names and has not got, by the id the document remembers them under. */
const missingIn = (body) => body.clips
  .filter((clip) => clip.take && !takeFor(clip))
  .map((clip) => clip.take.id);

/** Why this page cannot draw a project, or null. */
function bodyRefusal(body) {
  if (!body || typeof body !== 'object') return 'this file does not hold an object';
  if (body.version !== PROJECT_VERSION) return versionRefusal('this project', body.version);
  if (!Array.isArray(body.clips)) return 'this file carries no clips array, so it is not an edit';
  if (body.clips.some((c) => !c || typeof c !== 'object' || !usableClipRate(c.speed)
    || !Number.isFinite(c.sourceStart) || c.sourceStart < 0)) {
    return 'a clip in it carries no speed and in-point, so there is no way to place its footage '
      + 'in time';
  }
  return null;
}

/** The shape a project was framed at, as a ratio a person reads. */
const shapeOf = (body) => (Array.isArray(body.aspect) && body.aspect.length === 2
  ? body.aspect.join(':')
  : String(body.outputSize ?? '—'));


async function jsonOf(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** A button, built rather than interpolated, because a label is not markup either. */
function addButton(host, label, cls, onClick, { item = null, title = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  if (title) b.title = title;
  b.dataset.act = item ?? label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  b.addEventListener('click', onClick);
  host.appendChild(b);
  return b;
}


function closeMenus(except = null) {
  for (const menu of document.querySelectorAll('.menu:not([hidden])')) {
    if (menu === except) continue;
    const toggle = menu.parentElement.querySelector('[aria-haspopup="menu"]');
    const heldFocus = menu.contains(document.activeElement);
    menu.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
    if (heldFocus && toggle && !toggle.disabled) toggle.focus();
  }
}

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

/** Puts a menu on the side of its button that has room. */
function placeMenu(menu, toggle) {
  const host = menu.offsetParent ?? menu.parentElement;
  const clip = (menu.closest('.list') ?? document.documentElement).getBoundingClientRect();
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
}

function buildMenu(row, toggle, project) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.role = 'menu';
  menu.hidden = true;
  const items = [
    { item: 'rename', label: 'Rename…', cls: 'mi', run: () => askRename(project) },
    { item: 'duplicate', label: 'Duplicate', cls: 'mi', run: () => duplicate(project) },
    { item: 'delete', label: 'Delete…', cls: 'mi danger', run: () => askDelete(project) },
  ];
  for (const entry of items) {
    const b = addButton(menu, entry.label, entry.cls, () => {
      closeMenus();
      (async () => entry.run())().catch((err) => say(err.message));
    }, { item: entry.item });
    b.dataset.item = entry.item;
    b.role = 'menuitem';
  }
  row.appendChild(menu);
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    closeMenus(menu);
    menu.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) placeMenu(menu, toggle);
  });
  return menu;
}


const openProject = (name) => { location.href = `/edit?project=${encodeURIComponent(name)}`; };

function buildRow(project) {
  const body = project.body;
  const refusal = bodyRefusal(body);
  if (refusal) return buildUnreadableRow(project, refusal);
  const spans = layout(body);
  const length = lengthOf(spans);
  const missing = missingIn(body);

  const row = document.createElement('article');
  row.className = 'row';
  row.dataset.name = project.name;
  row.dataset.rev = project.rev;
  row.dataset.clips = String(body.clips.length);
  row.dataset.missing = String(missing.length);
  row.dataset.length = length.toFixed(3);

  row.innerHTML = `
    <div class="pic">
      <div class="skim"><canvas></canvas><span class="t">00:00</span><span class="hole"></span></div>
      <div class="bar"><span class="done"></span><span class="pos"></span></div>
    </div>
    <div class="meta">
      <div class="top"><span class="name"></span><span class="when"></span></div>
      <div class="facts">
        <span>${body.clips.length} clip${body.clips.length === 1 ? '' : 's'}</span>
        <span class="shape"></span>
        <span>${Number(body.outputFps ?? 30)} fps</span>
        <span>${mmss(length)}</span>
      </div>
      <div class="dark"></div>
    </div>
    <div class="rowacts"></div>`;

  const nameEl = row.querySelector('.name');
  nameEl.textContent = project.name;
  nameEl.title = project.name;
  row.querySelector('.when').textContent = stamp(project.savedAt);
  row.querySelector('.shape').textContent = shapeOf(body);

  if (missing.length) {
    const dark = row.querySelector('.dark');
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = missing.length === body.clips.length
      ? `No footage here. This project is cut on ${missing.join(', ')}.`
      : `${missing.length} of ${body.clips.length} clips have no footage here: ${missing.join(', ')}.`;
    dark.appendChild(what);
    addButton(dark, 'Open Media library', 'act small', (e) => {
      e.stopPropagation();
      location.href = '/library';
    }, { item: 'to-library' });
  }

  const more = addButton(row.querySelector('.rowacts'), '⋯', 'act more', () => {}, { item: 'more' });
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', `More actions for ${project.name}`);
  more.title = 'rename, duplicate and delete';
  buildMenu(row, more, project);

  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Open ${project.name}`);
  row.tabIndex = 0;
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openProject(project.name);
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.menu, .act, .skim, .bar')) return;
    openProject(project.name);
  });

  attachSkim(row, spans, length);
  return row;
}

/** A project this page cannot draw, said on its own row. */
function buildUnreadableRow(project, refusal) {
  const row = document.createElement('article');
  row.className = 'row';
  row.dataset.name = project.name;
  row.dataset.rev = project.rev;
  row.dataset.unreadable = refusal;
  row.innerHTML = `
    <div class="pic"><div class="skim"><span class="hole"></span></div></div>
    <div class="meta">
      <div class="top"><span class="name"></span><span class="when"></span></div>
      <div class="dark"><span class="what"></span></div>
    </div>
    <div class="rowacts"></div>`;
  row.querySelector('.name').textContent = project.name;
  row.querySelector('.when').textContent = stamp(project.savedAt);
  row.querySelector('.hole').textContent = 'cannot be drawn';
  row.querySelector('.what').textContent = `This project cannot be opened here: ${refusal}.`;
  const more = addButton(row.querySelector('.rowacts'), '\u22ef', 'act more', () => {}, { item: 'more' });
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', `More actions for ${project.name}`);
  buildMenu(row, more, project);
  return row;
}

/** The row's picture and its bar. */
function attachSkim(row, spans, length) {
  const skimEl = row.querySelector('.skim');
  const barEl = row.querySelector('.bar');
  const label = row.querySelector('.t');
  const hole = row.querySelector('.hole');
  const posEl = barEl.querySelector('.pos');
  const doneEl = barEl.querySelector('.done');

  for (const s of spans) {
    if (!(s.span > 0) || !(length > 0)) continue;
    const seg = document.createElement('span');
    seg.className = `seg${s.take ? '' : ' dark'}`;
    seg.style.left = `${(s.start / length) * 100}%`;
    seg.style.width = `${(s.span / length) * 100}%`;
    seg.dataset.clip = s.clip.id;
    seg.dataset.sourceStart = String(s.clip.sourceStart);
    barEl.insertBefore(seg, doneEl);
  }

  const skim = createSkim({
    canvas: row.querySelector('canvas'),
    surface: skimEl,
    onDraw: (n, requested) => {
      if (requested) return;
      row.dataset.draws = String(Number(row.dataset.draws ?? 0) + 1);
    },
  });
  row.__skim = skim;

  let shown = null;
  let at = 0;

  const seek = (programSec) => {
    at = Math.max(0, Math.min(length, programSec));
    const hit = clipAt(spans, at);
    const take = hit?.take ?? null;
    if (take !== shown) {
      skim.show(take);
      shown = take;
    }
    label.textContent = `${mmss(at)} / ${mmss(length)}`;
    hole.textContent = hit ? (take ? '' : `${hit.clip.take?.id ?? 'this clip'} is not on this machine`) : 'no clip here';
    posEl.style.left = `${length > 0 ? (at / length) * 100 : 0}%`;
    doneEl.style.width = `${length > 0 ? (at / length) * 100 : 0}%`;
    row.dataset.at = at.toFixed(3);
    row.dataset.showing = take?.id ?? '';
    skim.setIndex(take ? frameAt(hit, at) : 0);
  };

  const fromX = (clientX, el) => {
    const r = el.getBoundingClientRect();
    seek(((clientX - r.left) / r.width) * length);
  };

  let pressX = null;
  let dragged = false;
  skimEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' && !e.buttons) return;
    if (pressX !== null && Math.abs(e.clientX - pressX) > 4) dragged = true;
    fromX(e.clientX, skimEl);
  });
  skimEl.addEventListener('pointerdown', (e) => {
    skimEl.setPointerCapture(e.pointerId);
    pressX = e.clientX;
    dragged = false;
    fromX(e.clientX, skimEl);
  });
  skimEl.addEventListener('pointerup', (e) => {
    const tap = pressX !== null && !dragged && Math.abs(e.clientX - pressX) <= 4;
    pressX = null;
    if (tap) openProject(row.dataset.name);
  });
  skimEl.addEventListener('pointercancel', () => { pressX = null; dragged = false; });
  skimEl.addEventListener('pointerleave', () => { pressX = null; });
  barEl.addEventListener('pointerdown', (e) => fromX(e.clientX, barEl));
  barEl.addEventListener('pointermove', (e) => { if (e.buttons) fromX(e.clientX, barEl); });

  requestAnimationFrame(() => seek(0));
}


function paint() {
  closeMenus();
  for (const row of listEl.querySelectorAll('.row')) row.__skim?.release();
  listEl.replaceChildren();
  if (projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const p = document.createElement('p');
    p.textContent = 'No projects.';
    empty.appendChild(p);
    listEl.appendChild(empty);
  }
  for (const project of projects) listEl.appendChild(buildRow(project));
  const n = projects.length;
  document.getElementById('sum').innerHTML = `<b>${n}</b> project${n === 1 ? '' : 's'}`;
}

let refreshGeneration = 0;

async function refresh() {
  const mine = ++refreshGeneration;
  const [listing, library] = await Promise.all([
    jsonOf('/projects/all'),
    jsonOf('/library/all', { signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) })
      .catch(() => ({ takes: [] })),
  ]);
  if (mine !== refreshGeneration) return;
  localTakes = (library.takes ?? []).filter((t) => t.state !== 'remote');
  projects = [...(listing.projects ?? [])].sort((a, b) => b.savedAt - a.savedAt);
  paint();
}


const names = () => new Set(projects.map((p) => p.name));

/** The next free `Untitled N`. A name allocation and not a count: `Untitled 2` can be free. */
function nextUntitled(taken) {
  for (let n = 1; ; n++) {
    if (!taken.has(`Untitled ${n}`)) return `Untitled ${n}`;
  }
}

/** Finder's rule: `Untitled 4` becomes `Untitled 4 copy`, then `copy 2`, `copy 3`. */
function copyName(name, taken) {
  const already = /^(.*) copy(?: (\d+))?$/.exec(name);
  const base = already ? already[1] : name;
  if (!taken.has(`${base} copy`)) return `${base} copy`;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} copy ${n}`)) return `${base} copy ${n}`;
  }
}

/** Creates a document under the first free name `pick` offers. */
async function createUnder(pick, body) {
  const taken = names();
  for (let tries = 0; tries < 12; tries++) {
    const name = pick(taken);
    const res = await fetch(`/projects/${encodeURIComponent(name)}?rev=absent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await res.json().catch(() => null);
    if (res.ok && !answer?.error) return name;
    if (res.status !== 409) throw new Error(answer?.error ?? `HTTP ${res.status}`);
    taken.add(name);
  }
  throw new Error('twelve names in a row were taken while this copy was being made');
}

async function duplicate(project) {
  say('');
  const to = await createUnder((taken) => copyName(project.name, taken), project.body);
  openProject(to);
}


let confirmAction = null;
document.getElementById('cCancel').addEventListener('click', () => dlg.close());
document.getElementById('cGo').addEventListener('click', () => {
  dlg.close();
  Promise.resolve(confirmAction?.()).catch((err) => say(err.message));
});

function askDelete(project) {
  const body = document.getElementById('cBody');
  body.innerHTML = '<b class="pid"></b>';
  body.querySelector('.pid').textContent = project.name;
  document.getElementById('cWarn').textContent = 'Footage is kept. This cannot be undone.';
  document.getElementById('cGo').textContent = 'Delete';
  document.getElementById('cGo').disabled = false;
  confirmAction = async () => {
    const res = await fetch(`/projects/${encodeURIComponent(project.name)}?rev=${encodeURIComponent(project.rev)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    const answer = await res.json().catch(() => null);
    if (!res.ok || answer?.error) throw new Error(answer?.error ?? `HTTP ${res.status}`);
    await refresh();
  };
  dlg.showModal();
}


const renameDlg = document.getElementById('rename');
const renameInput = document.getElementById('pName');
const renameWhy = document.getElementById('pWhy');
const renameGo = document.getElementById('pGo');
let renaming = null;

function askRename(project) {
  renaming = project;
  renameInput.value = project.name;
  validateRename();
  renameDlg.showModal();
  renameInput.focus();
  renameInput.select();
}

function validateRename() {
  if (!renaming) return false;
  const typed = renameInput.value.trim();
  let why = documentNameRefusal('project', typed) ?? '';
  if (!why && typed === renaming.name) why = 'that is already its name';
  else if (!why && names().has(typed)) why = `${typed} is taken by another project`;
  renameWhy.textContent = why;
  renameInput.classList.toggle('bad', Boolean(why) && Boolean(typed));
  renameGo.disabled = Boolean(why);
  return !why;
}

renameInput.addEventListener('input', validateRename);
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && validateRename()) commitRename();
});
document.getElementById('pCancel').addEventListener('click', () => renameDlg.close());
renameGo.addEventListener('click', () => commitRename());

async function commitRename() {
  if (!validateRename()) return;
  const project = renaming;
  const to = renameInput.value.trim();
  renameDlg.close();
  say('');
  try {
    await jsonOf(`/projects/${encodeURIComponent(project.name)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, rev: project.rev }),
    });
    await refresh();
  } catch (err) {
    say(err.message);
  }
}


document.getElementById('newProject').addEventListener('click', async () => {
  say('');
  const takes = await pickTakes({
    ceiling: CLIP_CEILING,
    title: 'New project',
    confirmLabel: 'Make the project',
  });
  if (!takes) return;
  location.href = `/edit?new=${takes.map((t) => encodeURIComponent(t.id)).join(',')}`;
});


try {
  await refresh();
} catch (err) {
  say(`the projects could not be listed: ${err.message}`);
  paint();
}

globalThis.__projects = {
  state: () => ({ projects, localTakes }),
  refresh,
  nextUntitled: () => nextUntitled(names()),
  copyName: (name) => copyName(name, names()),
  emptyLine: () => listEl.querySelector('.empty p')?.textContent ?? null,

  rows: () => [...listEl.querySelectorAll('.row')].map((el) => ({
    name: el.dataset.name,
    rev: el.dataset.rev,
    clips: Number(el.dataset.clips),
    missing: Number(el.dataset.missing),
    length: Number(el.dataset.length),
    when: el.querySelector('.when').textContent,
    facts: [...el.querySelectorAll('.facts span')].map((s) => s.textContent),
    dark: el.querySelector('.dark .what')?.textContent ?? null,
    darkAct: el.querySelector('.dark .act')?.textContent ?? null,
    segments: [...el.querySelectorAll('.bar .seg')].map((s) => ({
      clip: s.dataset.clip,
      sourceStart: Number(s.dataset.sourceStart),
      left: s.style.left,
      width: s.style.width,
      dark: s.classList.contains('dark'),
    })),
    menu: [...el.querySelectorAll('.menu .mi')].map((b) => b.dataset.item),
  })),

  showing: (name) => {
    const el = listEl.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
    return el ? {
      take: el.dataset.showing,
      at: Number(el.dataset.at),
      frame: el.__skim?.index ?? null,
      drawnFrame: el.__skim?.showing ?? null,
      hole: el.querySelector('.hole').textContent,
    } : null;
  },

  draws: (name) => Number(listEl.querySelector(`.row[data-name="${CSS.escape(name)}"]`)?.dataset.draws ?? 0),

  async drawn(name, atLeast = 1) {
    for (let i = 0; i < 200; i++) {
      if (this.draws(name) >= atLeast) return this.draws(name);
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`row ${name} never drew ${atLeast} frames`);
  },

  /** Drags the row's picture to a fraction of the edit and answers with what it landed on. */
  async skimTo(name, t) {
    const el = listEl.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
    const skim = el.querySelector('.skim');
    const r = skim.getBoundingClientRect();
    skim.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: r.left + r.width * t, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1,
    }));
    return {
      take: el.dataset.showing,
      at: Number(el.dataset.at),
      label: el.querySelector('.t').textContent,
      hole: el.querySelector('.hole').textContent,
      draws: this.draws(name),
    };
  },

  picture(name) {
    const canvas = listEl.querySelector(`.row[data-name="${CSS.escape(name)}"] canvas`);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let h = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i];
      h = Math.imul(h ^ data[i], 16777619) >>> 0;
    }
    return { mean: sum / (data.length / 4), signature: h.toString(16) };
  },

  openMenu: (name) => {
    const el = listEl.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
    if (el.querySelector('.menu').hidden) el.querySelector('.act.more').click();
    const menu = el.querySelector('.menu');
    const box = menu.getBoundingClientRect();
    const clip = listEl.getBoundingClientRect();
    return {
      open: !menu.hidden,
      items: [...menu.querySelectorAll('.mi')].map((b) => ({ item: b.dataset.item, label: b.textContent })),
      inside: box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5,
    };
  },
  clickMenuItem: (name, item) => {
    const el = listEl.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
    if (el.querySelector('.menu').hidden) el.querySelector('.act.more').click();
    el.querySelector(`.mi[data-item="${item}"]`).click();
  },

  rename: {
    type: (text) => {
      renameInput.value = text;
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
      return { why: renameWhy.textContent, blocked: renameGo.disabled, bad: renameInput.classList.contains('bad') };
    },
    commit: () => { renameGo.click(); },
    isOpen: () => renameDlg.open,
    close: () => renameDlg.close(),
  },

  confirm: () => ({
    open: dlg.open,
    title: document.getElementById('cTitle').textContent,
    body: document.getElementById('cBody').textContent,
    warn: document.getElementById('cWarn').textContent,
  }),
  confirmGo: () => { document.getElementById('cGo').click(); },
  confirmCancel: () => { document.getElementById('cCancel').click(); },

  newProject: () => { document.getElementById('newProject').click(); },
  note: () => noteEl.textContent,
};
