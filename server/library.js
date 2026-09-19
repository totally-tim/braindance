// The library: one manifest over a captures directory, the marks that hang off each take, the
// projects and presets beside them, and the reconciliation with a capture node.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, statSync } from 'node:fs';
import { readdir, readFile, writeFile, appendFile, stat, unlink, rename, link, mkdir, open, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { basename, dirname, join, resolve } from 'node:path';
import { cachedIndex, forgetCapture, indexPathFor, captureIdFor, loadIndex, readHelloOnce } from './capture.js';

export { VALID_ID };

// A node's hash reaches a filename, so it is held to this before it can be joined to a path.
export const VALID_HASH = /^sha256:[0-9a-f]{64}$/;

import { PROJECT_VERSION, VALID_ID, captureFormatRefusal, documentNameRefusal } from '../web/format.js';
import { POLLED_NODE_FIELDS } from '../web/record-poll.js';

export { PROJECT_VERSION };

// Measured on this sensor: 424KB of depth plus 51KB of colour per frame at 30fps.
const FRAME_BYTES = 486 * 1024;
const NOMINAL_FPS = 30;
// A take that never started is a decision; a take that dies at eighty percent is a loss.
export const MIN_TAKE_SEC = 120;

const isKnct = (name) => name.toLowerCase().endsWith('.knct');


/**
 * A take's append-only marks log, merged per mark id by the highest `at`. Filed by the take's
 * content hash in `marks/` under the captures directory, never by its name: a rename frees a name,
 * and a log filed under it would attach to the next take given that name.
 */
export const marksPathFor = (dir, hash) => {
  if (!VALID_HASH.test(hash ?? '')) throw new Error(`a marks log is filed by content hash, and ${JSON.stringify(hash)} is not one`);
  return join(dir, 'marks', `${hash.slice('sha256:'.length)}.jsonl`);
};

export async function readMarkLog(dir, hash) {
  return readLogAt(marksPathFor(dir, hash));
}

async function readLogAt(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec?.id === 'string' && Number.isFinite(rec?.at)) out.push(rec);
    } catch { /* a torn final line from a writer that died mid-append */ }
  }
  return out;
}

/** The log resolved to what a reader should see: one record per id, no tombstones. */
export function resolveMarks(log) {
  const byId = new Map();
  for (const rec of log) {
    const held = byId.get(rec.id);
    // `>=` rather than `>`: the local log is concatenated last, so it wins a same-millisecond tie.
    if (!held || rec.at >= held.at) byId.set(rec.id, rec);
  }
  return [...byId.values()]
    .filter((rec) => !rec.deleted && Number.isFinite(rec.sourceMs))
    .sort((a, b) => a.sourceMs - b.sourceMs);
}

export async function readMarks(dir, hash) {
  return resolveMarks(await readMarkLog(dir, hash));
}

// Monotonic and never reset: a write-then-restore is invisible to a before-and-after read.
let markWrites = 0;
export const markWriteCount = () => markWrites;

// Renames, removals and a download's install run one at a time per take name in this process, and
// marks writes per marks log, so a check of which file a name holds, or whether a take is still
// here, still holds when the write lands. Case-folded, because the volume here folds case. A rename
// made outside this process takes no lock.
const takeLocks = new Map();

/** Runs `work` holding the lock of every take `paths` names, all taken in one turn. */
async function withTakeLock(paths, work) {
  const keys = [...new Set(paths.map((path) => resolve(path).toLowerCase()))];
  const earlier = keys.map((key) => takeLocks.get(key)).filter(Boolean);
  let release;
  const held = new Promise((done) => { release = done; });
  for (const key of keys) takeLocks.set(key, held);
  try {
    await Promise.all(earlier);
    return await work();
  } finally {
    release();
    for (const key of keys) if (takeLocks.get(key) === held) takeLocks.delete(key);
  }
}

async function appendLines(dir, hash, records) {
  const lines = records.map((rec) => `${JSON.stringify(rec)}\n`).join('');
  if (!lines) return;
  markWrites++;
  await mkdir(join(dir, 'marks'), { recursive: true });
  await appendFile(marksPathFor(dir, hash), lines);
}

/**
 * Appends records to the marks log of the take `hash` names, and answers false, writing nothing,
 * when `present` says no take here has that hash any more. Under the log's lock, which a delete
 * takes too, so a delete cannot land between the question and the write. The recorder passes no
 * `present`: the take it flushes is its own, and the listing does not answer for it until it closes.
 */
export async function appendMarks(dir, hash, records, { present = null } = {}) {
  return withTakeLock([marksPathFor(dir, hash)], async () => {
    if (present && !await present()) return false;
    await appendLines(dir, hash, records);
    return true;
  });
}

/** Where a node serves the marks log of `take`: by content, like every `/capture/` route. */
export const markLogPath = (take) => `/capture/${encodeURIComponent(take.hash)}/marks/log`;

/**
 * The records of a node's answer for `take`'s marks log, refused unless the node says they are that
 * take's: a node that ignores the hash, a build older than this one, answers by name.
 */
export function checkedMarkLog(body, take) {
  if (body?.hash !== take.hash || !Array.isArray(body.log)) {
    throw new Error(`the node's marks log for ${take.id} answers for ${JSON.stringify(body?.hash ?? null)}, not ${take.hash} - `
      + 'a node on an older build reads it by name, so its records were not taken. Upgrade the node to this build.');
  }
  return body.log;
}

/**
 * Appends the records of another machine's log that this take's log lacks, and answers how many,
 * or null, writing nothing, when `present` says no take here has that hash. Appended rather than
 * rewritten, so both logs stay whole and a merge is safe to run twice.
 */
export async function mergeMarkLog(dir, hash, theirLog, { present = null } = {}) {
  return withTakeLock([marksPathFor(dir, hash)], async () => {
    if (present && !await present()) return null;
    return mergeHeld(dir, hash, theirLog);
  });
}

// `mergeMarkLog` once it holds the log's lock.
async function mergeHeld(dir, hash, theirLog) {
  const known = new Set((await readMarkLog(dir, hash)).map((r) => `${r.id}@${r.at}`));
  const fresh = theirLog.filter((r) => !known.has(`${r.id}@${r.at}`));
  await appendLines(dir, hash, fresh);
  return fresh.length;
}

const NAMED_LOG = '.marks.jsonl';

/**
 * Moves each marks log a build that filed marks by a take's name left beside that take into the
 * take's hash log, and removes it: the one reader of that naming, run once when the server starts.
 * Merged rather than appended, so a crash between the merge and the removal merges again without
 * a second copy of any mark. A log with no take beside it is left where it is.
 */
export async function adoptNamedMarkLogs(dir, { owns = () => false } = {}) {
  const names = await directoryNames(dir, { what: 'captures directory' });
  const adopted = [];
  for (const file of names.filter((name) => name.endsWith(NAMED_LOG))) {
    const stem = file.slice(0, -NAMED_LOG.length);
    const take = names.find((name) => isKnct(name) && name.slice(0, -'.knct'.length) === stem);
    if (!take) continue;
    const path = join(dir, take);
    if (owns(path)) continue;
    const identity = takeIdentity(path);
    // A take this build cannot read keeps its log where it is, and the rest are still moved.
    const hash = (await cachedIndex(path).catch(() => null))?.hash;
    if (!hash) continue;
    // Under the take's lock and its log's, and only while the name still holds the file hashed.
    const records = await withTakeLock([path, marksPathFor(dir, hash)], async () => {
      if (!sameTake(identity, takeIdentity(path))) return null;
      const merged = await mergeHeld(dir, hash, await readLogAt(join(dir, file)));
      await unlink(join(dir, file));
      return merged;
    });
    if (records !== null) adopted.push({ file, take, hash, records });
  }
  return adopted;
}


/** Every reason this build can refuse to open a take. `web/library.js` badges these same keys. */
export const OPEN_REFUSALS = {
  recording: () => 'this take is still being written, so it has no settled hash and nothing may open it until the recorder closes it',
  'no-hello': () => 'this take carries no sensor hello, so its intrinsics are unknown and it cannot be unprojected',
  format: (format) => captureFormatRefusal('this take', format),
  short: (frames) => (frames === 0
    ? 'the scan found no whole frame in this take, so there is nothing here to draw or to open'
    : 'a take needs two frames to bracket a position, so there is nothing here to play'),
};

const refusal = (key, ...args) => ({ key, why: OPEN_REFUSALS[key](...args) });

// A shape rather than a member of this build's table, so a node one build ahead keeps badging. A
// leading underscore is admitted on purpose: `__proto__` is planted as a control and must badge.
const REFUSAL_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v) => num(v) && v >= 0;
const count = (v) => v === null || (Number.isInteger(v) && v >= 0);
function manifestRefusal(take) {
  if (!take || typeof take !== 'object' || Array.isArray(take)) return 'is not an object';
  if (typeof take.file !== 'string' || take.file.length > 255) return 'has no usable file name';
  if (!nonNeg(take.bytes)) return `has bytes ${JSON.stringify(take.bytes)}`;
  if (!count(take.frames)) return `has frames ${JSON.stringify(take.frames)}`;
  if (!nonNeg(take.durationSec)) return `has durationSec ${JSON.stringify(take.durationSec)}`;
  if (!num(take.capturedAt)) return `has capturedAt ${JSON.stringify(take.capturedAt)}`;
  if (take.dateSource !== 'hello' && take.dateSource !== 'mtime') {
    return `has dateSource ${JSON.stringify(take.dateSource)}`;
  }
  if (typeof take.truncated !== 'boolean') return `has truncated ${JSON.stringify(take.truncated)}`;
  if (take.hasHello !== null && typeof take.hasHello !== 'boolean') {
    return `has hasHello ${JSON.stringify(take.hasHello)}`;
  }
  if (take.format !== undefined && !count(take.format)) return `has format ${JSON.stringify(take.format)}`;
  if (take.hello !== null) {
    const h = take.hello;
    if (!h || typeof h !== 'object' || !['fx', 'fy', 'cx', 'cy'].every((k) => num(h[k]))) {
      return 'has a hello that is not the four intrinsics';
    }
  }
  if (typeof take.openable !== 'boolean') return `has openable ${JSON.stringify(take.openable)}`;
  if (typeof take.recording !== 'boolean') return `has recording ${JSON.stringify(take.recording)}`;
  // The hash and `recording` are one claim: a settled take with no hash was offered a Download
  // that could only fail in `downloadTake`.
  if (take.recording ? take.hash !== null : !VALID_HASH.test(take.hash ?? '')) {
    return `has hash ${JSON.stringify(take.hash)} on a take that is ${
      take.recording ? 'still recording, which has no settled hash to advertise' : 'settled, which must have one'}`;
  }
  if (take.openRefusals !== undefined) {
    if (!Array.isArray(take.openRefusals)) return 'has an open-refusal list that is not a list';
    for (const r of take.openRefusals) {
      if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !REFUSAL_KEY.test(r.key)
        || typeof r.why !== 'string' || r.why.length > 400) {
        return `carries an open refusal this build cannot read: ${JSON.stringify(r).slice(0, 60)}`;
      }
    }
  }
  // Per record: `paintMarks` reads `sourceMs` off every entry, so one peer's `marks: [null]`
  // throws inside the loop and takes the whole shelf down.
  if (!Array.isArray(take.marks)) return `has marks ${JSON.stringify(take.marks).slice(0, 40)}`;
  for (const m of take.marks) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.id !== 'string'
      || !num(m.at) || !num(m.sourceMs) || m.deleted) {
      return `carries a mark this build cannot draw: ${JSON.stringify(m).slice(0, 60)}`;
    }
  }
  return null;
}

const carriesRefusals = (take) => Array.isArray(take.openRefusals)
  && take.openRefusals.every((r) => r && typeof r.key === 'string' && typeof r.why === 'string' && r.why !== '');

async function describeTake(dir, file, recording) {
  const path = join(dir, file);
  const id = captureIdFor(path);
  const st = await stat(path);

  // The take being written is described without being scanned: its size and mtime move, so the
  // cache always misses and every `/library/*` request re-hashed a growing multi-gigabyte file.
  if (recording) {
    const openRefusals = [refusal('recording')];
    return {
      id,
      file,
      bytes: st.size,
      hash: null,
      frames: null,
      durationSec: 0,
      capturedAt: st.mtimeMs,
      dateSource: 'mtime',
      truncated: false,
      hasHello: null,
      format: null,
      hello: null,
      openRefusals,
      openable: openRefusals.length === 0,
      recording: true,
      // Marks pressed during the shoot are the recorder's until the close gives them a hash.
      marks: [],
    };
  }

  const index = await cachedIndex(path);
  const stamps = index.frames.stampMs;
  const hello = await readHelloOnce(path, index);
  const marks = await readMarks(dir, index.hash);

  const fromHello = Number.isFinite(hello?.startedAt) && hello.startedAt > 0;
  const format = hello?.format ?? null;

  // Push order is badge order, since `cannotOpen` quotes the first. The format band is a gate
  // because `captureFormatRefusal` answers the empty string for a take that opens, and an empty
  // `why` would take `openable` false across the whole library.
  const openRefusals = [];
  if (!index.hello) openRefusals.push(refusal('no-hello'));
  if (captureFormatRefusal('this take', format) !== '') openRefusals.push(refusal('format', format));
  if (stamps.length < 2) openRefusals.push(refusal('short', stamps.length));

  return {
    id,
    file,
    bytes: st.size,
    hash: index.hash,
    frames: stamps.length,
    durationSec: stamps.length > 1 ? (stamps[stamps.length - 1] - stamps[0]) / 1000 : 0,
    capturedAt: fromHello ? hello.startedAt : st.mtimeMs,
    dateSource: fromHello ? 'hello' : 'mtime',
    truncated: Boolean(index.truncated),
    hasHello: Boolean(index.hello),
    format,
    hello: hello ? { fx: hello.fx, fy: hello.fy, cx: hello.cx, cy: hello.cy } : null,
    openRefusals,
    openable: openRefusals.length === 0,
    recording: false,
    marks,
  };
}

// Where each content hash was last found. A name, so it is asked again on every use.
const foundAt = new Map();

const holdsHash = async (path, hash, owns) => {
  if (owns(path)) return false;
  try {
    return (await cachedIndex(path)).hash === hash;
  } catch {
    return false;
  }
};

/**
 * The file here holding the take whose content hash is `hash`, or null when none does: the one
 * way a request names a take. The take the recorder still owns has no hash and is never answered,
 * because asking would scan a growing file. `also` names files outside `dir` that count as here.
 */
export async function takeFileFor(dir, hash, { owns = () => false, also = [] } = {}) {
  if (!VALID_HASH.test(hash ?? '')) return null;
  const held = foundAt.get(hash);
  if (held && await holdsHash(held, hash, owns)) return held;
  const names = (await directoryNames(dir, { what: 'captures directory' })).filter(isKnct);
  let found = null;
  for (const path of [...names.map((file) => join(dir, file)), ...also]) {
    if (owns(path)) continue;
    const index = await cachedIndex(path).catch(() => null);
    if (!index) continue;
    foundAt.set(index.hash, path);
    if (index.hash === hash) found ??= path;
  }
  return found;
}

export async function scanTakes(dir, owns = () => false) {
  const files = (await directoryNames(dir, { what: 'captures directory' })).filter(isKnct);
  const takes = [];
  const unreadable = [];
  for (const file of files) {
    try {
      takes.push(await describeTake(dir, file, owns(join(dir, file))));
    } catch (err) {
      unreadable.push({ id: captureIdFor(file), file, error: err.message });
    }
  }
  takes.sort((a, b) => b.capturedAt - a.capturedAt);
  return { takes, unreadable };
}


/**
 * A capture node (`--node http://host:port`). Plain HTTP, no auth; its hash only
 * says what to fetch.
 */
export class NodeLink {
  constructor(url, name) {
    this.url = url.replace(/\/$/, '');
    this.name = name;
    this.lastError = null;
    this.buildRefusal = null;
  }

  async fetchJson(path, init) {
    const res = await fetch(`${this.url}${path}`, init);
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * The node's own takes, or null if it cannot be read. The whole manifest is refused rather than
   * take by take, because a shelf that drops the unreadable ones looks complete.
   */
  async takes(signal = null) {
    if (this.buildRefusal) {
      this.lastError = this.buildRefusal;
      return null;
    }
    try {
      const body = await this.fetchJson('/library/takes', signal ? { signal } : undefined);
      const takes = body.takes.filter((t) => VALID_ID.test(t.id) && (t.hash === null || VALID_HASH.test(t.hash)));
      for (const t of takes) {
        const why = manifestRefusal(t);
        if (why) {
          this.lastError = `its take manifest ${why}, so nothing it holds can be listed here `
            + `- ${t?.id ?? 'a take'} arrived that way. A node's manifest is drawn on this `
            + 'machine, so one this build cannot read is refused whole rather than in part.';
          return null;
        }
      }
      const older = takes.find((t) => !carriesRefusals(t));
      if (older) {
        this.lastError = 'it is running an older build whose take manifest carries no open-refusal reasons, '
          + `so nothing it holds can be listed here - ${older.id} arrived with none. Upgrade the node to this build.`;
        return null;
      }
      this.lastError = null;
      return takes;
    } catch (err) {
      this.lastError = err.message;
      return null;
    }
  }

  /**
   * Whether the node is shooting, and which take. A fingerprint saying when to re-ask the library.
   */
  async recordState() {
    try {
      const body = await this.fetchJson('/record/state', { signal: AbortSignal.timeout(3000) });
      // Absent and not-writing are two facts, spelled `undefined` and `[]`, or the fingerprint
      // never moves. Asked of `POLLED_NODE_FIELDS`, so a field added there tightens it.
      const missing = POLLED_NODE_FIELDS.filter((f) => body[f] === undefined);
      this.buildRefusal = missing.length === 0 ? null
        : `it is running an older build whose recorder state carries no ${missing.join(', ')}, `
          + 'so this library cannot tell which of its takes are still being written, and its takes '
          + 'are not listed here. Upgrade the node to this build.';
      if (this.buildRefusal) {
        return { name: this.name, reachable: false, recording: false, takeId: null, writingIds: [] };
      }
      return {
        name: this.name,
        reachable: true,
        recording: Boolean(body.recording),
        takeId: body.takeId ?? null,
        writingIds: body.writingIds,
      };
    } catch {
      return { name: this.name, reachable: false, recording: false, takeId: null, writingIds: [] };
    }
  }
}

/**
 * The node's copy of a take, found by content hash, or null when the node answered and holds none.
 * `there` is what `NodeLink.takes` returned, and its null throws: a node that could not be asked is
 * not a node with nothing on it, and every caller acts on whether a second copy exists.
 */
export function copyOnNode(node, there, hash) {
  if (there === null) throw new Error(`${node.name} could not be asked which takes it holds: ${node.lastError}`);
  // A take still being written has no hash, and two of those are not one take - see `reconcile`.
  if (!VALID_HASH.test(hash ?? '')) return null;
  return there.find((t) => t.hash === hash) ?? null;
}

export function reconcile(localTakes, nodeTakes) {
  const byHash = new Map();
  // A take mid-write has no hash, so it is keyed by side and name. That is not identity: a take
  // still being written cannot be reconciled with anything.
  const keyOf = (take, side) => take.hash ?? `${side}:${take.id}`;
  for (const take of localTakes) {
    // A second name for one hash is listed on the entry the first made, and never written over
    // it: the gallery flags it, and `removeName` is the way to take it away.
    const held = byHash.get(keyOf(take, 'local'));
    if (held) {
      held.names.push(take.id);
      continue;
    }
    byHash.set(keyOf(take, 'local'), { ...take, names: [take.id], state: 'local', local: take, remote: null });
  }
  for (const take of nodeTakes ?? []) {
    const held = byHash.get(keyOf(take, 'remote'));
    if (held) {
      held.state = 'both';
      held.remote = take;
      continue;
    }
    byHash.set(keyOf(take, 'remote'), { ...take, names: [], state: 'remote', local: null, remote: take });
  }
  const out = [...byHash.values()];
  out.sort((a, b) => b.capturedAt - a.capturedAt);
  return out;
}


export async function remaining(dir, bytesPerSec = FRAME_BYTES * NOMINAL_FPS) {
  let fs;
  try {
    fs = await statfs(dir);
  } catch (err) {
    return {
      freeBytes: 0,
      bytesPerSec,
      secondsLeft: 0,
      label: 'no room reported',
      error: `there is no captures directory at ${dir}: ${err.message}`,
    };
  }
  const freeBytes = fs.bavail * fs.bsize;
  const secondsLeft = bytesPerSec > 0 ? freeBytes / bytesPerSec : Infinity;
  return { freeBytes, bytesPerSec, secondsLeft, label: durationLabel(secondsLeft), error: null };
}

export function durationLabel(sec) {
  if (!Number.isFinite(sec)) return 'unbounded';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
  return `${Math.floor(sec)}s`;
}


/** What each download in flight has moved. Off the stream, not `stat`: the buffered write lags. */
export const downloadsInFlight = new Map();

/**
 * The ids a download has claimed - a claim taken before any await, where the map above is a report.
 */
const downloadClaims = new Set();

/** No-progress bound. A total timeout short enough to catch a dead node would kill a real copy. */
const STALL_MS = 30_000;

const MARKS_MS = 20_000;

function untilItStalls(readSoFar) {
  const ctl = new AbortController();
  let last = readSoFar();
  const timer = setInterval(() => {
    const now = readSoFar();
    if (now === last) {
      ctl.abort(new Error(`no bytes for ${(STALL_MS * 2) / 1000}s`));
      clearInterval(timer);
    }
    last = now;
  }, STALL_MS);
  timer.unref?.();
  return { signal: ctl.signal, stop: () => clearInterval(timer) };
}

export async function downloadTake(node, take, dir, { ownsFile = () => false } = {}) {
  if (!VALID_ID.test(take.id)) throw new Error(`the node offered an unusable id: ${take.id}`);
  if (!VALID_HASH.test(take.hash ?? '')) {
    throw new Error(`the node offered ${take.id} with an unusable hash: ${JSON.stringify(take.hash ?? null)}`);
  }
  // Claimed with nothing awaited between the reading and the taking, which makes it a guard.
  // Case-folded because `Take-1` and `take-1` are two ids and one file on APFS and on NTFS.
  const claim = take.id.toLowerCase();
  if (downloadClaims.has(claim)) {
    throw new Error(`${take.id} is already downloading: wait for that transfer rather than starting a second one`);
  }
  downloadClaims.add(claim);
  try {
    return await downloadClaimed(node, take, dir, ownsFile);
  } finally {
    downloadClaims.delete(claim);
  }
}

async function downloadClaimed(node, take, dir, ownsFile) {
  const plain = join(dir, `${take.id}.knct`);
  // The probe is a full read plus sha256 of whatever holds the plain name, and two machines
  // shooting on one day name their takes alike, so that is routinely the take being recorded here.
  // Opened first and asked about by the file opened: a name found free and then read by name can
  // be taken by the recorder in between, and the read would scan the take it is writing.
  let target = plain;
  const held = await open(plain, 'r').catch(() => null);
  if (held) {
    try {
      if (ownsFile(await held.stat())) {
        throw new Error(`${take.id} is being recorded on this machine right now, under the name `
          + `this download would check first: download ${take.id} once that take has closed`);
      }
      const local = await loadIndex(plain, held).catch(() => null);
      if (local?.hash !== take.hash) target = join(dir, `${take.id}-${take.hash.slice(7, 15)}.knct`);
    } finally {
      await held.close();
    }
  }
  // The path as well as the id, because the line above rewrites `target`: a take called foo can
  // write `foo-1a2b3c4d.knct.part`, which is a different take's literal `.part`.
  const pathClaim = `path:${target.toLowerCase()}`;
  if (downloadClaims.has(pathClaim)) {
    throw new Error(
      `${take.id} would write ${basename(target)}, which another download is already writing: `
      + 'wait for that transfer rather than racing it',
    );
  }
  downloadClaims.add(pathClaim);
  try {
    return await downloadToPath(node, take, dir, target);
  } finally {
    downloadClaims.delete(pathClaim);
  }
}

async function downloadToPath(node, take, dir, targetIn) {
  let target = targetIn;
  const temp = `${target}.part`;
  // The file installed, taken off `temp`, the name only this download uses: `target` is a name, and
  // once its lock is released a rename can give it another take before the marks are written.
  let installed = null;
  // Refused against the volume before a byte moves, because the ceiling below only holds the node
  // to its claim. The margin is a minute of recording: a take may be landing on this disk now.
  const space = await remaining(dir);
  if (take.bytes > space.freeBytes - space.bytesPerSec * 60) {
    throw new Error(`downloading ${take.id}: it advertises ${take.bytes} bytes and the volume under `
      + `${dir} has ${space.freeBytes} free - refused before a byte moved, keeping a minute of `
      + 'recording headroom for the shoot this disk may be carrying');
  }
  const progress = { id: take.id, phase: 'transferring', received: 0, bytes: take.bytes, startedAt: Date.now() };
  const stall = untilItStalls(() => progress.received);
  let res;
  try {
    res = await fetch(`${node.url}/capture/${encodeURIComponent(take.hash)}/file`, { signal: stall.signal });
  } catch (err) {
    stall.stop();
    throw new Error(`downloading ${take.id}: ${err.message}`);
  }
  if (!res.ok) {
    stall.stop();
    throw new Error(`downloading ${take.id}: ${res.status} ${res.statusText}`);
  }

  downloadsInFlight.set(take.id, progress);
  try {
    const counted = new Transform({
      transform(chunk, _enc, done) {
        progress.received += chunk.length;
        // Bounded on the size the node advertised, so an endless stream cannot fill the volume the
        // recorder is writing to. Zero is a bound like any other and used to disable this entirely.
        if (progress.received > take.bytes) {
          done(new Error(`${take.id} is still sending past the ${take.bytes} bytes it advertised`
            + ' - discarded rather than written on past the size the transfer was checked against'));
          return;
        }
        done(null, chunk);
      },
    });
    // Unlinked before it is opened, and that is about an inode: the install claims its name with
    // `link` and then drops `temp`, so a kill between them leaves `.part` and a good take sharing
    // one inode that `createWriteStream` would truncate.
    try {
      await unlink(temp);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(
          `refusing to download ${take.id}: ${basename(temp)} is in the way and could not be removed `
          + `(${err.code}), and opening it would truncate whatever else is linked to it`,
        );
      }
    }
    await pipeline(Readable.fromWeb(res.body), counted, createWriteStream(temp));

    progress.phase = 'verifying';
    const got = await hashFile(temp);
    if (got !== take.hash) {
      throw new Error(
        `${take.id} arrived as ${got}, not the ${take.hash} the node advertised: `
        + 'discarded rather than filed under a hash it does not have',
      );
    }
    // Linked and unlinked rather than renamed: `rename(2)` replaces an existing file without a
    // word, and this name was chosen minutes ago. A list rather than one fallback, because the
    // fallback could be the name that just failed.
    const suffixed = join(dir, `${take.id}-${take.hash.slice(7, 15)}.knct`);
    const candidates = [target, suffixed].filter((p, i, all) => all.indexOf(p) === i);
    for (let n = 2; n <= 9; n++) candidates.push(join(dir, `${take.id}-${take.hash.slice(7, 15)}-${n}.knct`));
    const claimed = await withTakeLock(candidates, async () => {
      for (const candidate of candidates) {
        try {
          await link(temp, candidate);
          return candidate;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      return null;
    });
    if (!claimed) {
      throw new Error(
        `${take.id} arrived and verified, but every name it could take in ${dir} is occupied `
        + `(tried ${candidates.length}): move something out of the way and download it again`,
      );
    }
    target = claimed;
    installed = await stat(temp);
    await unlink(temp);
    forgetCapture(target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  } finally {
    downloadsInFlight.delete(take.id);
    stall.stop();
  }

  // Filed by the hash the copy was just verified against, so a rename landing while the log is
  // on its way changes nothing about where it goes.
  let body;
  try {
    body = await node.fetchJson(markLogPath(take), { signal: AbortSignal.timeout(MARKS_MS) });
  } catch (err) {
    // A node that went away mid-download still leaves a verified take; one that answered with a
    // refusal gets a line, since its answer is why the take's marks are absent here.
    if (!(err instanceof TypeError) && err?.name !== 'TimeoutError' && err?.name !== 'AbortError') {
      console.warn(`[library] ${take.id}: the node's marks answer was refused or unreadable - ${err?.message ?? err}`);
    }
  }
  if (body !== undefined) {
    try {
      await appendMarks(dir, take.hash, checkedMarkLog(body, take));
    } catch (err) {
      console.warn(`[library] ${take.id}: its marks were not written - ${err?.message ?? err}`);
    }
  }
  return target;
}

/**
 * Which file a path names right now, as `dev` and `ino`, or null when it names none. The inode
 * rather than the path, because a rename frees an id and a later take renamed into it is a
 * different take under the same name.
 */
export const takeIdentity = (path) => {
  try {
    const st = statSync(path ?? '');
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
};

/** Whether two identities are one file. Anything carrying `dev` and `ino` compares, a `Stats` too. */
export const sameTake = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/** The content hash of an open file, streamed from its first byte. The caller closes the handle. */
async function hashOpenFile(handle) {
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ start: 0, highWaterMark: 4 * 1024 * 1024, autoClose: false })) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The content hash of a file, streamed. Nothing here ever holds a capture whole. */
export async function hashFile(path) {
  const handle = await open(path, 'r');
  try {
    return await hashOpenFile(handle);
  } finally {
    await handle.close();
  }
}

/**
 * Removes a copy of a take. Both hashes are read rather than trusted - `verifiedElsewhere` is what
 * the surviving copy reported, and this take's own is re-derived, because delete cannot be undone.
 */
export async function removeTake(dir, id, { hash, verifiedElsewhere = null, marksRead = null, ownsFile = () => false }) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const path = join(dir, `${id}.knct`);
  // The marks log's lock as well, so no marks write lands between the hash and the unlink.
  const log = VALID_HASH.test(hash ?? '') ? [marksPathFor(dir, hash)] : [];
  return withTakeLock([path, ...log], () => removeHeld(dir, id, path, { hash, verifiedElsewhere, marksRead, ownsFile }));
}

/**
 * The content hash of the file a name holds, and which file that was. Through one descriptor,
 * because a removal unlinks by name and has to ask the name again before it does.
 */
async function hashThrough(path, { id = basename(path), ownsFile = () => false } = {}) {
  const handle = await open(path, 'r');
  try {
    const identity = await handle.stat();
    // The file opened, not the name the route asked about before the lock: that name can have
    // gone to the recorder's next take since, and hashing it reads the take being written.
    if (ownsFile(identity)) throw new Error(`${id} is being recorded right now: stop the take before removing it`);
    return { identity, hash: await hashOpenFile(handle) };
  } finally {
    await handle.close();
  }
}

// `removeTake` once it holds the take's lock.
async function removeHeld(dir, id, path, { hash, verifiedElsewhere, marksRead, ownsFile }) {
  // Hashed through one descriptor and unlinked by name, so the name is asked again before the
  // unlink: a rename landing during the hash can free this id and move another take into it.
  const { identity: hashed, hash: actual } = await hashThrough(path, { id, ownsFile });
  if (actual !== hash) {
    throw new Error(
      `${id} is ${actual} here, not the ${hash} this removal named: `
      + 'the library moved underneath the request and nothing was removed',
    );
  }
  if (verifiedElsewhere !== null && verifiedElsewhere !== actual) {
    throw new Error(
      `refusing to reclaim ${id}: the copy that is supposed to survive reports `
      + `${verifiedElsewhere}, not ${actual} - that is a different take, and this `
      + 'would be deleting the last copy of both',
    );
  }
  if (!sameTake(hashed, takeIdentity(path))) {
    throw new Error(
      `${id} was renamed or replaced while it was being hashed: the file under that name now is not `
      + 'the one whose bytes were checked, and nothing was removed',
    );
  }
  // A reclaim says how many of this copy's marks the machine keeping the other copy merged. A mark
  // added here since - the reclaim's read and this removal are two requests - goes with this copy
  // unless it is refused, and a mark write waits on this lock, so none lands after the count.
  if (verifiedElsewhere !== null) {
    const now = (await readMarkLog(dir, actual)).length;
    if (!Number.isInteger(marksRead)) {
      throw new Error(`refusing to reclaim ${id}: the request does not say how many of this copy's marks the `
        + 'other machine merged, which a build older than this one leaves out, and nothing was removed');
    }
    if (now !== marksRead) {
      throw new Error(`refusing to reclaim ${id}: its marks log holds ${now} records, not the ${marksRead} the `
        + 'other machine merged - a mark was added here since, and removing this copy would lose it. '
        + 'Reclaim again to bring it across.');
    }
  }
  // `unlink` takes a name, so a rename can still land between the check above and this line. That
  // remainder is a few microtasks, where the window it replaces was a streaming sha256 of the take.
  await unlink(path);
  // The marks go with the last copy here. `serveRemoval` refuses a take with a second name, and a
  // reclaim has already merged the node's log into the copy it keeps.
  await unlink(marksPathFor(dir, actual)).catch((err) => {
    if (err.code !== 'ENOENT') console.warn(`[library] ${id} was removed but its marks log was not: ${err.message}`);
  });
  await unlink(indexPathFor(path)).catch(() => {});
  forgetCapture(path);
  return { removed: `${id}.knct`, hash: actual };
}

/**
 * Takes one name away from a take filed under two, keeping `keep`. Refused unless both names
 * still hold the take `hash` names: one file, or two files each hashed here to those bytes.
 */
export async function removeName(dir, id, { keep, hash, owns = () => false }) {
  for (const name of [id, keep]) {
    if (!VALID_ID.test(String(name ?? ''))) throw new Error(`unusable take id ${name}`);
  }
  // Case-folded, because on this volume `Take-1` and `take-1` are one name for one file.
  if (id.toLowerCase() === keep.toLowerCase()) {
    throw new Error(`${id} and ${keep} are one name, so removing it would leave the take no name at all`);
  }
  const path = join(dir, `${id}.knct`);
  const kept = join(dir, `${keep}.knct`);
  // Asking which take a name holds reads the file, and the take being written has no hash yet.
  if (owns(path) || owns(kept)) throw new Error(`${owns(path) ? id : keep} is being recorded right now: stop the take first`);
  return withTakeLock([path, kept], async () => {
    const dropping = takeIdentity(path);
    const keeping = takeIdentity(kept);
    if (dropping === null) throw new Error(`${id} is not in ${resolve(dir)}, so there is no name to remove`);
    if (keeping === null) {
      throw new Error(`${keep} is not in ${resolve(dir)}, so ${id} is this take's only name and removing it would delete the take`);
    }
    const sameFile = sameTake(dropping, keeping);
    if (sameFile) {
      const held = (await cachedIndex(kept)).hash;
      if (held !== hash) {
        throw new Error(`${keep} is ${held} here, not the ${hash} this request named: nothing was removed`);
      }
    } else {
      // Two files, so the one under `id` goes and its bytes with it: both are hashed, as delete
      // hashes, and each name is asked again after its hash.
      for (const [name, at] of [[id, path], [keep, kept]]) {
        const { identity, hash: actual } = await hashThrough(at);
        if (actual !== hash) {
          throw new Error(`${name} is ${actual} here, not the ${hash} this request named: `
            + `${id} and ${keep} are not one take, and nothing was removed`);
        }
        if (!sameTake(identity, takeIdentity(at))) {
          throw new Error(`${name} was renamed or replaced while it was being hashed, and nothing was removed`);
        }
      }
    }
    await unlink(path);
    await unlink(indexPathFor(path)).catch(() => {});
    forgetCapture(path);
    return { removed: `${id}.knct`, kept: `${keep}.knct`, hash, sameFile };
  });
}

/**
 * Renames a take and its index. Safe because nothing here goes by name: projects, marks, the
 * reconciliation and the menu all reference footage by content hash. The take being recorded is
 * refused, because the recorder names the files it owns by path and a renamed one stops matching.
 */
export async function renameTake(dir, id, requested, { hash, ownsFile = () => false }) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const to = String(requested ?? '').trim().replace(/\.knct$/i, '');
  if (!VALID_ID.test(to)) {
    throw new Error(
      `${JSON.stringify(to)} cannot be a take name: it has to start with a letter, a digit or an `
      + 'underscore and carry only letters, digits, dots, dashes and underscores',
    );
  }
  if (to === id) throw new Error(`${id} is already its name, so there is nothing to rename`);

  const from = join(dir, `${id}.knct`);
  const target = join(dir, `${to}.knct`);
  const root = resolve(dir);
  for (const path of [from, target]) {
    if (resolve(path) !== join(root, basename(path))) {
      throw new Error(`refusing to rename outside ${root}`);
    }
  }
  // Under both names' locks, so no removal or install in this process lands on either mid-rename.
  return withTakeLock([from, target], async () => {
    // Opened and asked about by the file opened, as `downloadClaimed` does: while this waited for
    // the lock the name could have gone to the recorder's next take, which a read by name would scan.
    const opened = await open(from, 'r').catch((err) => {
      throw err.code === 'ENOENT' ? new Error(`${id} is no longer in ${root}`) : err;
    });
    let index;
    try {
      if (ownsFile(await opened.stat())) {
        throw new Error(`${id} is being recorded right now: stop the take before renaming it`);
      }
      index = await loadIndex(from, opened);
    } finally {
      await opened.close();
    }
    if (index.hash !== hash) {
      throw new Error(
        `${id} is ${index.hash} here, not the ${hash} this rename named: `
        + 'the library moved underneath the request and nothing was renamed',
      );
    }

    for (const path of [target, indexPathFor(target)]) {
      try {
        await stat(path);
        throw new Error(`${to} is taken: ${basename(path)} is already in ${root}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }

    // Linked then unlinked, never renamed: the `stat` loop above is check-then-act and `rename(2)`
    // replaces silently, where `link(2)` fails EEXIST atomically. The window it admits is a take
    // under both names, which the gallery flags as a second name and `removeName` takes away.
    const linkInto = async (source, dest) => {
      try {
        await link(source, dest);
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        if (err.code === 'EEXIST') throw new Error(`${to} is taken: ${basename(dest)} appeared in ${root} while this rename was running`);
        throw err;
      }
    };
    if (!await linkInto(from, target)) throw new Error(`${id} is no longer in ${root}`);
    try {
      await unlink(from);
    } catch (err) {
      // ENOENT is the old name already being gone rather than a failure to undo - a delete from
      // outside this process, which takes no lock - and the rollback below would unlink the last entry.
      if (err.code !== 'ENOENT') {
        await unlink(target).catch(() => {});
        throw err;
      }
    }
    await rename(indexPathFor(from), indexPathFor(target))
      .catch(() => unlink(indexPathFor(from)).catch(() => {}));
    forgetCapture(from);
    forgetCapture(target);
    return { renamed: `${id}.knct`, id: to, file: `${to}.knct`, hash: index.hash };
  });
}


export const REVEAL = {
  darwin: { program: 'open', label: 'Finder', args: (path) => ['-R', path] },
  linux: { program: 'xdg-open', label: 'the file manager', args: (path) => [dirname(path)] },
  win32: { program: 'explorer', label: 'Explorer', args: (path) => [`/select,${path}`] },
};

export const revealSupport = () => {
  const shape = REVEAL[process.platform];
  return shape ? { supported: true, label: shape.label } : { supported: false, label: null };
};

/**
 * Opens the file manager on a take - the only route that starts a process on the operator's behalf.
 */
export async function revealTake(dir, id, { program = null } = {}) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const shape = REVEAL[process.platform];
  if (!shape) {
    throw new Error(`no file manager is known for ${process.platform}, so there is nothing to open a take in`);
  }
  const root = resolve(dir);
  const path = join(root, `${id}.knct`);
  if (resolve(path) !== join(root, `${id}.knct`)) throw new Error(`refusing to reveal outside ${root}`);
  await stat(path);
  const args = shape.args(path);
  const bin = program ?? shape.program;
  return new Promise((settle, fail) => {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => fail(new Error(`${bin} could not be started: ${err.message}`)));
    child.on('spawn', () => {
      child.unref();
      settle({ revealed: `${id}.knct`, path, program: bin, args, label: shape.label });
    });
  });
}


/**
 * The names in a directory, sorted, and the one place that decides a missing directory may read as
 * an empty one. Only `ENOENT` is an absence. `EACCES`, `EIO`, `ENOTDIR` or `EMFILE` turned into `[]`
 * answers 200 with no reason, and a captures directory answering that way tells the machine asking
 * it that the node holds no second copy, which is the answer delete's refusal rests on.
 */
export async function directoryNames(dir, { required = false, what = 'directory' } = {}) {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if (required || err?.code !== 'ENOENT') {
      throw new Error(`the ${what} ${dir} cannot be read: ${err.message}`);
    }
    return [];
  }
}

/** The JSON documents in a directory, under the rule `directoryNames` keeps. */
export async function listJsonNames(dir, { required = false, what = 'directory' } = {}) {
  return (await directoryNames(dir, { required, what })).filter((f) => f.endsWith('.json'));
}

/** The revision of a name nothing is filed under: what a write says when it expects to create. */
export const ABSENT_REV = 'absent';

const revOf = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export class DocumentStore {
  // Serialises writes to each name, so the revision check and the write it guards are atomic.
  #inFlight = new Map();

  /** `builtinDir` is read and never written, which is what makes saving over a built-in fork it. */
  constructor(dir, kind, version = PROJECT_VERSION, builtinDir = null) {
    this.dir = dir;
    this.kind = kind;
    this.version = version;
    this.builtinDir = builtinDir;
    this.writes = 0;
    this.reservedBy = new Map();
  }

  /** Takes names away from this store, each against the route that took it. */
  reserve(taken) {
    for (const [name, why] of taken) this.reservedBy.set(name, why);
  }

  /** Queues a change behind every change already queued on any name it touches. */
  #serialise(names, run) {
    const held = [...new Set(names)].sort();
    const mine = Promise.all(held.map((n) => this.#inFlight.get(n) ?? Promise.resolve())).then(run);
    // Swallows failures so one refusal does not block the queue.
    const settled = mine.then(() => {}, () => {});
    for (const n of held) this.#inFlight.set(n, settled);
    settled.then(() => {
      for (const n of held) if (this.#inFlight.get(n) === settled) this.#inFlight.delete(n);
    });
    return mine;
  }

  /** Where a document is filed. Checks both the name rule and that the path stays in this store. */
  pathFor(name) {
    const refused = documentNameRefusal(this.kind, name);
    if (refused) throw new Error(refused);
    if (this.reservedBy.has(name)) {
      throw new Error(
        `${name} cannot be a ${this.kind} name: ${this.reservedBy.get(name)} is a route of this `
        + `server, so a ${this.kind} filed under it would be written here and read back as the route`,
      );
    }
    const root = resolve(this.dir);
    const path = join(this.dir, `${name}.json`);
    if (resolve(path) !== join(root, basename(path))) {
      throw new Error(`refusing to file a ${this.kind} outside ${root}`);
    }
    return path;
  }

  async readPathFor(name) {
    const own = this.pathFor(name);
    if (!this.builtinDir) return { path: own, builtin: false };
    try {
      await stat(own);
      return { path: own, builtin: false };
    } catch (err) {
      // Only there-is-no-fork falls back. Any other `stat` failure is a case where a fork does
      // exist, and serving the shipped document under the forked name loses a grade silently.
      if (err?.code !== 'ENOENT') throw err;
      return { path: join(this.builtinDir, `${name}.json`), builtin: true };
    }
  }

  async list() {
    // The two roots fail differently: the user's directory is made on the first write, where the
    // built-in root is only consulted because somebody configured it and has no fallback behind it.
    const own = await listJsonNames(this.dir, { what: `${this.kind} directory` });
    const owned = new Set(own);
    const shipped = this.builtinDir
      ? (await listJsonNames(this.builtinDir, { required: true, what: `shipped ${this.kind} directory` }))
        .filter((f) => !owned.has(f)).map((f) => [this.builtinDir, f, true])
      : [];
    const files = [...shipped, ...own.map((f) => [this.dir, f, false])];
    const out = [];
    for (const [dir, file, builtin] of files) {
      const path = join(dir, file);
      try {
        const text = await readFile(path, 'utf8');
        const st = await stat(path);
        out.push({
          name: basename(file, '.json'),
          rev: revOf(text),
          bytes: st.size,
          savedAt: st.mtimeMs,
          builtin,
          body: JSON.parse(text),
        });
      } catch { /* a document this build cannot read is not a reason to hide the rest */ }
    }
    return out;
  }

  async read(name) {
    const { path, builtin } = await this.readPathFor(name);
    const text = await readFile(path, 'utf8');
    return { name, rev: revOf(text), builtin, body: JSON.parse(text) };
  }

  /** The revision a read of this name would return right now, or `absent` when nothing is filed. */
  async currentRev(name) {
    const { path } = await this.readPathFor(name);
    try {
      return revOf(await readFile(path, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return ABSENT_REV;
      throw err;
    }
  }

  /** Refuses when the revision a change was made against has moved. */
  async #heldToRev(name, rev, act) {
    if (typeof rev !== 'string' || rev === '') {
      throw new Error(
        `this ${act} of the ${this.kind} ${name} names no revision it was made against: every change `
        + `here says which revision it read, so a ${this.kind} open in two places is answered by the `
        + 'file rather than by whichever wrote last',
      );
    }
    const current = await this.currentRev(name);
    if (rev === current) return current;
    const moved = (message) => Object.assign(new Error(message), { stale: true, rev: current });
    if (current === ABSENT_REV) {
      throw moved(
        `there is no ${this.kind} named ${name} any more: this ${act} was made against ${rev} and the `
        + 'file is gone, so somebody else removed or renamed it',
      );
    }
    if (rev === ABSENT_REV) {
      throw moved(
        `there is already a ${this.kind} named ${name}: this ${act} expected the name to be free, so `
        + 'it would have replaced work somebody else has open',
      );
    }
    throw moved(
      `${name} is at ${current} here, not the ${rev} this ${act} was made against: somebody else has `
      + `this ${this.kind} open and this ${act} did not land`,
    );
  }

  /** Writes a document, after checking the version and the revision. */
  async write(name, body, rev) {
    if (body?.version !== undefined && body.version !== this.version) {
      throw new Error(
        `this ${this.kind} says version ${JSON.stringify(body.version)}, and this build writes `
        + `version ${this.version}: refused rather than restamped, because a document this build `
        + 'cannot faithfully interpret is exactly what the version field exists to catch',
      );
    }
    const path = this.pathFor(name);
    return this.#serialise([name], async () => {
      await this.#heldToRev(name, rev, 'write');
      await mkdir(this.dir, { recursive: true });
      const text = `${JSON.stringify({ ...body, version: this.version }, null, 2)}\n`;
      const seq = ++this.writes;
      const scratch = join(this.dir, `.write-${seq}.tmp`);
      await writeFile(scratch, text);
      try {
        await rename(scratch, path);
      } finally {
        await unlink(scratch).catch(() => {});
      }
      return { name, rev: revOf(text), bytes: text.length };
    });
  }

  async remove(name, rev) {
    const path = this.pathFor(name);
    return this.#serialise([name], async () => {
      await this.#heldToRev(name, rev, 'delete');
      this.writes++;
      await unlink(path);
      return { removed: name };
    });
  }

  /** Moves a document to a new name, holding both names for the whole move. */
  async rename(name, to, rev) {
    const fromPath = this.pathFor(name);
    const toPath = this.pathFor(to);
    if (resolve(fromPath) === resolve(toPath)) {
      throw new Error(`${name} is already its name, so there is nothing to rename`);
    }
    return this.#serialise([name, to], async () => {
      const { builtin } = await this.readPathFor(name);
      if (builtin) {
        throw new Error(
          `${name} is a ${this.kind} this build ships, and a shipped one is read and never moved: `
          + `save it as ${to} to fork it, which leaves the shipped one where it is`,
        );
      }
      await this.#heldToRev(name, rev, 'rename');
      if (await this.currentRev(to) !== ABSENT_REV) {
        throw new Error(`${to} is taken: there is already a ${this.kind} filed under that name`);
      }
      this.writes++;
      await rename(fromPath, toPath);
      return { renamed: name, name: to, rev: revOf(await readFile(toPath, 'utf8')) };
    });
  }
}

export const captureDirOf = (dir) => resolve(dir);
