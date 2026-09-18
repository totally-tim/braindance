// The library: one manifest over a captures directory, the marks that hang off each take, the
// projects and presets beside them, and the reconciliation with a capture node.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, writeFile, appendFile, stat, unlink, rename, link, mkdir, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { basename, dirname, join, resolve } from 'node:path';
import { cachedIndex, forgetCapture, indexPathFor, captureIdFor, readHelloOnce } from './capture.js';

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


/** The take's append-only marks sidecar, merged per mark id by the highest `at`. */
export const marksPathFor = (capturePath) => `${capturePath.replace(/\.knct$/i, '')}.marks.jsonl`;

export async function readMarkLog(capturePath) {
  let text;
  try {
    text = await readFile(marksPathFor(capturePath), 'utf8');
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

export async function readMarks(capturePath) {
  return resolveMarks(await readMarkLog(capturePath));
}

// Monotonic and never reset: a write-then-restore is invisible to a before-and-after read.
let markWrites = 0;
export const markWriteCount = () => markWrites;

export async function appendMarks(capturePath, records) {
  const lines = records.map((rec) => `${JSON.stringify(rec)}\n`).join('');
  if (lines) markWrites++;
  if (lines) await appendFile(marksPathFor(capturePath), lines);
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
      marks: await readMarks(path),
    };
  }

  const index = await cachedIndex(path);
  const stamps = index.frames.stampMs;
  const hello = await readHelloOnce(path, index);
  const marks = await readMarks(path);

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

export async function scanTakes(dir, owns = () => false) {
  let files;
  try {
    files = (await readdir(dir)).filter(isKnct).sort();
  } catch {
    return { takes: [], unreadable: [] };
  }
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

export function reconcile(localTakes, nodeTakes) {
  const byHash = new Map();
  // A take mid-write has no hash, so it is keyed by side and name. That is not identity: a take
  // still being written cannot be reconciled with anything.
  const keyOf = (take, side) => take.hash ?? `${side}:${take.id}`;
  for (const take of localTakes) {
    byHash.set(keyOf(take, 'local'), { ...take, state: 'local', local: take, remote: null });
  }
  for (const take of nodeTakes ?? []) {
    const held = byHash.get(keyOf(take, 'remote'));
    if (held) {
      held.state = 'both';
      held.remote = take;
      continue;
    }
    byHash.set(keyOf(take, 'remote'), { ...take, state: 'remote', local: null, remote: take });
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

export async function downloadTake(node, take, dir) {
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
    return await downloadClaimed(node, take, dir);
  } finally {
    downloadClaims.delete(claim);
  }
}

async function downloadClaimed(node, take, dir) {
  let target = join(dir, `${take.id}.knct`);
  try {
    const local = await cachedIndex(target);
    if (local.hash !== take.hash) target = join(dir, `${take.id}-${take.hash.slice(7, 15)}.knct`);
  } catch { /* nothing at that name, or nothing readable: the plain name is free */ }
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
    res = await fetch(`${node.url}/capture/${encodeURIComponent(take.id)}/file`, { signal: stall.signal });
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
    let claimed = null;
    for (const candidate of candidates) {
      try {
        await link(temp, candidate);
        claimed = candidate;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!claimed) {
      throw new Error(
        `${take.id} arrived and verified, but every name it could take in ${dir} is occupied `
        + `(tried ${candidates.length}): move something out of the way and download it again`,
      );
    }
    target = claimed;
    await unlink(temp);
    forgetCapture(target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  } finally {
    downloadsInFlight.delete(take.id);
    stall.stop();
  }

  // Checked again because fetching the log is a round trip and `target` is a name: a rename in that
  // window would leave this appending beside a take that moved. The inode rather than the name.
  const installed = await stat(target).catch(() => null);
  try {
    const log = await node.fetchJson(`/capture/${encodeURIComponent(take.id)}/marks/log`,
      { signal: AbortSignal.timeout(MARKS_MS) });
    const stillThere = await stat(target).catch(() => null);
    const same = installed !== null && stillThere !== null
      && stillThere.dev === installed.dev && stillThere.ino === installed.ino;
    if (!same) {
      console.warn(`[library] ${take.id} was renamed or replaced while its marks were arriving, `
        + 'so they were not written here - sync marks on the take under its new name to bring them across');
    } else {
      await appendMarks(target, log.log ?? []);
    }
  } catch { /* a node that went away mid-download still leaves a verified take */ }
  return target;
}

/** The content hash of a file, streamed. Nothing here ever holds a capture whole. */
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Removes a copy of a take. Both hashes are read rather than trusted - `verifiedElsewhere` is what
 * the surviving copy reported, and this take's own is re-derived, because delete cannot be undone.
 */
export async function removeTake(dir, id, { hash, verifiedElsewhere = null }) {
  if (!VALID_ID.test(id)) throw new Error(`unusable take id ${id}`);
  const path = join(dir, `${id}.knct`);
  const actual = await hashFile(path);
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
  await unlink(path);
  await unlink(indexPathFor(path)).catch(() => {});
  forgetCapture(path);
  return { removed: `${id}.knct`, hash: actual };
}

/**
 * Renames a take and everything filed beside it. Safe because nothing here goes by name: projects,
 * the reconciliation and the menu all reference footage by content hash. The take being recorded is
 * refused, because the recorder names the files it owns by path and a renamed one stops matching.
 */
export async function renameTake(dir, id, requested, { hash, owns = () => false }) {
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
  if (owns(from)) {
    throw new Error(`${id} is being recorded right now: stop the take before renaming it`);
  }

  const index = await cachedIndex(from);
  if (index.hash !== hash) {
    throw new Error(
      `${id} is ${index.hash} here, not the ${hash} this rename named: `
      + 'the library moved underneath the request and nothing was renamed',
    );
  }

  for (const path of [target, marksPathFor(target), indexPathFor(target)]) {
    try {
      await stat(path);
      throw new Error(`${to} is taken: ${basename(path)} is already in ${root}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // Linked then unlinked, never renamed: the `stat` loop above is check-then-act and `rename(2)`
  // replaces silently, where `link(2)` fails EEXIST atomically. The window it admits is a take
  // under both names, which the reconciliation folds by hash.
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
  const marksMoved = await linkInto(marksPathFor(from), marksPathFor(target));
  try {
    if (!await linkInto(from, target)) throw new Error(`${id} is no longer in ${root}`);
  } catch (err) {
    if (marksMoved) await unlink(marksPathFor(target)).catch(() => {});
    throw err;
  }
  try {
    await unlink(from);
  } catch (err) {
    // ENOENT is the old name already being gone rather than a failure to undo: `removeTake`
    // unlinks `from` during its sha256, and the rollback below would unlink the last entry.
    if (err.code !== 'ENOENT') {
      await unlink(target).catch(() => {});
      if (marksMoved) await unlink(marksPathFor(target)).catch(() => {});
      throw err;
    }
  }
  if (marksMoved) await unlink(marksPathFor(from)).catch(() => {});
  await rename(indexPathFor(from), indexPathFor(target))
    .catch(() => unlink(indexPathFor(from)).catch(() => {}));
  forgetCapture(from);
  forgetCapture(target);
  return { renamed: `${id}.knct`, id: to, file: `${to}.knct`, hash: index.hash, marks: marksMoved };
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
 * The JSON documents in a directory, and the one place that decides a missing directory may read as
 * an empty one. Only `ENOENT` is an absence: `EACCES` turned into `[]` answers 200 with no reason.
 */
export async function listJsonNames(dir, { required = false, what = 'directory' } = {}) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (required || err?.code !== 'ENOENT') {
      throw new Error(`the ${what} ${dir} cannot be read: ${err.message}`);
    }
    return [];
  }
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
