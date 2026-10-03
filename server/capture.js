// Random access into a .knct capture: a sidecar index built by one streaming scan, and a reader
// that preads the frames a playhead asks for. Every read here is incremental because
// `fs.readFileSync` throws ERR_FS_FILE_TOO_LARGE at 2 GiB. The index is a sidecar rather than a
// footer so the capture stays append-only and a take cut off mid-write is still usable.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, resolve } from 'node:path';
import { MAGIC, HEADER_BYTES, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR, MAX_PAYLOAD_BYTES } from './protocol.js';
// A divisor applied to a flat byte count would take every k-th sample along one axis and none
// along the other, so the decimation has to know the grid's shape.
import { DEPTH_H, DEPTH_W } from '../web/format.js';

// 3 lists the colour camera's messages beside the frames, so a sidecar without that list is
// scanned again rather than read as a take with no colour.
export const INDEX_VERSION = 3;

const SCAN_CHUNK = 4 * 1024 * 1024;


const RUN_CHUNK = 1024 * 1024;

// The framing header plus the u32 depth length, u32 colour length and u64 stamp that open every
// frame payload - `handleFrame` in `web/main.js` reads exactly these three off the other end.
const STAMP_BYTES = 16;
const PREFIX_BYTES = HEADER_BYTES + STAMP_BYTES;
// A colour message opens with its u64 stamp and nothing else before the JPEG.
const COLOUR_STAMP_BYTES = 8;

// One frame's payload sampled down by a depth divisor, or the payload itself at a divisor of 1. A
// function rather than a method because the live socket holds a buffer instead of a `Capture`. The
// colour block is copied through untouched, and nothing here can reach the take.
export function decimatePayload(payload, depthDivisor, what = 'frame') {
  const k = Math.trunc(depthDivisor);
  if (!(k > 1)) return payload;

  const depthBytes = payload.readUInt32LE(0);
  const colorBytes = payload.readUInt32LE(4);
  // Checking only the depth length let an overstated colour length size `out` past what the copy
  // fills, exposing recycled heap.
  if (16 + depthBytes + colorBytes !== payload.length) {
    throw new Error(
      `${what} declares ${depthBytes} depth and ${colorBytes} colour bytes, which is not the `
      + `${payload.length - 16} it carries: refusing rather than sampling past the frame`,
    );
  }
  if (depthBytes !== DEPTH_W * DEPTH_H * 2) {
    throw new Error(
      `${what} carries ${depthBytes} depth bytes, not the ${DEPTH_W}x${DEPTH_H} grid `
      + 'this divisor samples: refusing rather than sampling a shape nobody declared',
    );
  }
  const w = Math.ceil(DEPTH_W / k);
  const h = Math.ceil(DEPTH_H / k);
  const out = Buffer.allocUnsafe(16 + w * h * 2 + colorBytes);
  out.writeUInt32LE(w * h * 2, 0);
  out.writeUInt32LE(colorBytes, 4);
  // Verbatim: a decimated frame is the same moment, and a stamp rewritten here would put a second
  // timeline into a format that has one.
  payload.copy(out, 8, 8, 16);
  for (let y = 0; y < h; y++) {
    const src = 16 + y * k * DEPTH_W * 2;
    const dst = 16 + y * w * 2;
    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(src + x * k * 2), dst + x * 2);
  }
  payload.copy(out, 16 + w * h * 2, 16 + depthBytes);
  return out;
}

/**
 * Where each colour message falls between the frames, by file order, which is the order the wire
 * delivered them in: frame `k` is followed by colour messages `from[k]` up to `from[k + 1]`. A
 * colour message ahead of the first frame goes with the first.
 */
export function colourAfterFrames(index) {
  const frames = index.frames.offset;
  const colour = index.colour.offset;
  const from = new Array(frames.length + 1).fill(0);
  let j = 0;
  for (let k = 0; k < frames.length; k++) {
    from[k] = j;
    const next = k + 1 < frames.length ? frames[k + 1] : Infinity;
    while (j < colour.length && colour[j] < next) j++;
  }
  from[frames.length] = j;
  return from;
}

export const indexPathFor = (capturePath) => `${capturePath.replace(/\.knct$/i, '')}.idx`;

export const captureIdFor = (capturePath) => basename(capturePath).replace(/\.knct$/i, '');

// Numbers each scan's scratch sidecar, taken on the tick the scan writes so no two in flight share one.
let indexWrites = 0;

/**
 * One sequential pass that produces the index and the content hash together. With `handle`, the
 * pass reads that open file and never the name, which can have been given to another file since.
 * `frames` lists the type 2 messages and `colour` the type 3; a type this build does not know is
 * walked past and listed nowhere.
 */
export async function buildIndex(capturePath, handle = null) {
  // Stamped before the read: a pre-scan mtime no longer matches on the next load if the capture
  // is written to meanwhile, where an after-scan stamp would certify the race.
  const before = handle ? await handle.stat() : await stat(capturePath);
  const hash = createHash('sha256');
  const offset = [];
  const stampMs = [];
  const length = [];
  const colour = { offset: [], stampMs: [], length: [] };
  let hello = null;

  const prefix = Buffer.alloc(PREFIX_BYTES);
  let filled = 0; // bytes of `prefix` assembled for the message in hand
  let need = HEADER_BYTES; // grows to take in the stamp once the length is known
  let skip = 0; // payload bytes still to walk past
  let pending = null; // the message whose payload is being walked
  let msgOffset = 0;
  let base = 0; // absolute offset of the chunk being walked

  // A message enters the index only once every one of its bytes has been read, which is what
  // makes a take cut short mid-frame index cleanly.
  const commit = () => {
    const payloadOffset = msgOffset + HEADER_BYTES;
    if (pending.type === TYPE_HELLO) {
      // Only the first: a second hello means two takes were concatenated.
      hello ??= { offset: payloadOffset, length: pending.len };
    } else if (pending.type === TYPE_FRAME) {
      offset.push(payloadOffset);
      length.push(pending.len);
      stampMs.push(Number(prefix.readBigUInt64LE(HEADER_BYTES + 8)));
    } else if (pending.type === TYPE_COLOR) {
      colour.offset.push(payloadOffset);
      colour.length.push(pending.len);
      colour.stampMs.push(Number(prefix.readBigUInt64LE(HEADER_BYTES)));
    }
    pending = null;
    filled = 0;
    need = HEADER_BYTES;
  };

  const chunks = handle
    ? handle.createReadStream({ start: 0, highWaterMark: SCAN_CHUNK, autoClose: false })
    : createReadStream(capturePath, { highWaterMark: SCAN_CHUNK });
  for await (const chunk of chunks) {
    hash.update(chunk);
    let i = 0;
    while (i < chunk.length) {
      if (skip > 0) {
        const n = Math.min(skip, chunk.length - i);
        i += n;
        skip -= n;
        if (skip === 0) commit();
        continue;
      }

      if (filled === 0) msgOffset = base + i;
      const n = Math.min(need - filled, chunk.length - i);
      chunk.copy(prefix, filled, i, i + n);
      filled += n;
      i += n;
      if (filled < need) continue;

      if (need === HEADER_BYTES) {
        const magic = prefix.readUInt32LE(0);
        if (magic !== MAGIC) {
          throw new Error(
            `stream desync at ${msgOffset}: expected magic KNCT, got 0x${magic.toString(16)}`,
          );
        }
        const type = prefix.readUInt32LE(4);
        const len = prefix.readUInt32LE(8);
        // The same ceiling the live parser holds, applied to a file: this number is written into
        // the sidecar and every later read allocates a buffer of it.
        if (len > MAX_PAYLOAD_BYTES) {
          throw new Error(
            `message at ${msgOffset} declares ${len} payload bytes, past the ${MAX_PAYLOAD_BYTES} `
            + 'this format allows: the stream is desynced rather than carrying a large frame',
          );
        }
        // A frame carries its lengths and stamp in its first sixteen bytes, so indexing a shorter
        // one would put a fabricated zero timestamp into the pacing.
        if (type === TYPE_FRAME && len < STAMP_BYTES) {
          throw new Error(`frame at ${msgOffset} is ${len} bytes, too short to carry its header`);
        }
        if (type === TYPE_COLOR && len < COLOUR_STAMP_BYTES) {
          throw new Error(`colour message at ${msgOffset} is ${len} bytes, too short to carry its stamp`);
        }
        pending = { type, len };
        need = HEADER_BYTES + Math.min(len, STAMP_BYTES);
        if (filled < need) continue;
      }

      skip = pending.len - (filled - HEADER_BYTES);
      if (skip === 0) commit();
    }
    base += chunk.length;
  }

  const index = {
    version: INDEX_VERSION,
    capture: basename(capturePath),
    bytes: base,
    mtimeMs: before.mtimeMs,
    hash: `sha256:${hash.digest('hex')}`,
    truncated: filled > 0 || skip > 0,
    hello,
    frames: { offset, stampMs, length },
    colour,
  };

  const sidecar = indexPathFor(capturePath);
  // Two ids differing only in case are two cache keys and one file on APFS and NTFS, so two scans
  // of one take can overlap: with one scratch name the first rename moves it away from the second.
  const scratch = `${sidecar}.${++indexWrites}.tmp`;
  try {
    // Written aside and renamed, so a crash cannot leave a sidecar that parses and lies.
    await writeFile(scratch, JSON.stringify(index));
    await rename(scratch, sidecar);
  } catch (err) {
    console.error(`[capture] could not write ${sidecar}: ${err.message}`);
    // A numbered scratch is never written again, so one left here by a failed write stays for good.
    await unlink(scratch).catch(() => {});
  }
  return index;
}

// Whether a sidecar's numbers describe the file it sits beside. The staleness test says only that
// it was written for a file of this size at this mtime, and everything in it then reaches
// `readAt`, which allocates and preads on those numbers. Failing a bound is treated as absent.
function indexDescribes(cached, size) {
  const spans = (offset, length, least) => Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= HEADER_BYTES && length >= least && length <= MAX_PAYLOAD_BYTES && offset + length <= size;
  const lists = (list, least) => {
    if (!list || !Array.isArray(list.offset) || !Array.isArray(list.length) || !Array.isArray(list.stampMs)) {
      return false;
    }
    if (list.length.length !== list.offset.length || list.stampMs.length !== list.offset.length) return false;
    let after = 0;
    for (let i = 0; i < list.offset.length; i++) {
      if (!spans(list.offset[i], list.length[i], least)) return false;
      // Ordered and non-overlapping, because that is what appending messages to a file produces.
      if (list.offset[i] < after) return false;
      if (!Number.isFinite(list.stampMs[i])) return false;
      after = list.offset[i] + list.length[i];
    }
    return true;
  };
  if (cached?.hello !== null && !spans(cached?.hello?.offset, cached?.hello?.length, 0)) return false;
  return lists(cached?.frames, STAMP_BYTES) && lists(cached?.colour, COLOUR_STAMP_BYTES);
}

/** The sidecar when it still describes the file, else a scan. `handle` as for `buildIndex`. */
export async function loadIndex(capturePath, handle = null) {
  const st = handle ? await handle.stat() : await stat(capturePath);
  try {
    // The sidecar is three orders of magnitude smaller than the take, so this is the one read
    // here that can safely be a whole-file read.
    const cached = JSON.parse(await readFile(indexPathFor(capturePath), 'utf8'));
    // Modification time has to sit beside the byte length, or a same-size substitution is waved
    // through to the stale hash in this very sidecar.
    if (cached.version === INDEX_VERSION && cached.bytes === st.size && cached.mtimeMs === st.mtimeMs) {
      if (indexDescribes(cached, st.size)) return cached;
      console.error(`[capture] the sidecar for ${basename(capturePath)} does not describe it - scanning again`);
    }
  } catch {
  }
  return buildIndex(capturePath, handle);
}

export class Capture {
  constructor(path, index, handle) {
    this.path = path;
    this.index = index;
    this.handle = handle;
    // Eviction only ever closes a capture nobody is holding: a descriptor closed under a frame run
    // fails inside a stream nobody can catch.
    this.leases = 0;
    this.usedAt = 0;
    // Dropped from the map while a reader still holds it, so the last lease released is the only
    // thing left that can close it - see `forgetCapture`.
    this.doomed = false;
    // Set by `close()`, and separate from `doomed` - see the comment there.
    this.closed = false;
  }

  get frameCount() {
    return this.index.frames.offset.length;
  }

  // Holds this capture open for the life of the process. The replay loop preads forever with
  // nothing a lease could hang off, so without this it is the *first* thing evicted.
  retain() {
    this.leases++;
    this.usedAt = ++useClock;
    return this;
  }

  async readAt(position, bytes) {
    // The one allocation both readers reach, so the bound is asserted here as well as where the
    // numbers came from: a guard at the allocation cannot be reached around.
    if (!Number.isSafeInteger(position) || position < 0
      || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `refusing to read ${bytes} bytes at ${position} in ${this.path}: that is not a span `
        + `a payload of at most ${MAX_PAYLOAD_BYTES} bytes can occupy`,
      );
    }
    const buf = Buffer.allocUnsafe(bytes);
    let got = 0;
    // Nothing promises a positioned read returns everything asked for, and a short read here
    // would ship a frame with a tail of whatever was in memory.
    while (got < bytes) {
      const { bytesRead } = await this.handle.read(buf, got, bytes - got, position + got);
      if (bytesRead === 0) throw new Error(`short read at ${position + got} in ${this.path}`);
      got += bytesRead;
    }
    return buf;
  }

  readHello() {
    const h = this.index.hello;
    return h ? this.readAt(h.offset, h.length) : Promise.resolve(null);
  }

  // Sampled down by `decimatePayload`, which the live socket shares rather than reimplementing.
  async readFrame(n, depthDivisor = 1) {
    const { offset, length } = this.index.frames;
    const payload = await this.readAt(offset[n], length[n]);
    return decimatePayload(payload, depthDivisor, `frame ${n}`);
  }

  get colourCount() {
    return this.index.colour.offset.length;
  }

  /** Colour message `n`'s payload: the u64 stamp, then the JPEG. */
  readColour(n) {
    const { offset, length } = this.index.colour;
    return this.readAt(offset[n], length[n]);
  }

  /**
   * The byte ranges holding frames a..b, framing included and ends inclusive: a run of bare
   * payloads would have no boundaries to parse back. Adjacent frames share a range, so a take with
   * nothing between its frames is one range; a colour message between two frames splits it, and a
   * reader walking the run as one frame per message never meets one.
   */
  frameRunSpans(a, b) {
    const { offset, length } = this.index.frames;
    const spans = [];
    let bytes = 0;
    for (let k = a; k <= b; k++) {
      const start = offset[k] - HEADER_BYTES;
      const end = offset[k] + length[k] - 1;
      const last = spans[spans.length - 1];
      if (last && last[1] + 1 === start) last[1] = end;
      else spans.push([start, end]);
      bytes += end - start + 1;
    }
    return { spans, bytes };
  }

  // Streams in bounded chunks off the same retained handle every other call uses: reopening by
  // path would serve a re-recorded take's bytes at the old file's offsets.
  createFrameRunStream(a, b) {
    const { spans } = this.frameRunSpans(a, b);
    const { handle, path } = this;
    let at = 0;
    let pos = spans[0][0];
    return new Readable({
      highWaterMark: RUN_CHUNK,
      read() {
        if (pos > spans[at][1]) {
          at++;
          if (at === spans.length) {
            this.push(null);
            return;
          }
          pos = spans[at][0];
        }
        const end = spans[at][1];
        const want = Math.min(RUN_CHUNK, end - pos + 1);
        const buf = Buffer.allocUnsafe(want);
        handle.read(buf, 0, want, pos).then(
          ({ bytesRead }) => {
            if (bytesRead === 0) {
              this.destroy(new Error(`short read at ${pos} in ${path}`));
              return;
            }
            pos += bytesRead;
            this.push(bytesRead === want ? buf : buf.subarray(0, bytesRead));
          },
          (err) => this.destroy(err),
        );
      },
    });
  }

  close() {
    // `doomed` is not the question `withCapture` has to ask - a capture can be doomed and still
    // readable, which is the ordinary case for a read already in flight.
    this.closed = true;
    return this.handle.close();
  }
}


// Where a take's points actually are, laterally, so the editor can fit the crop box to a take
// instead of a plus-or-minus seven metre box whose edges are all off screen. Percentiles rather
// than extremes, because the widest samples are corner texels at the range limit where depth is
// mostly speckle. Over the whole take at a stride, or the box crops what the take does later.
// Depth is not fitted - a fit to the cloud fits to the back wall - so the range is an argument
// deciding which points the lateral fit is over, and the cache keys on it.
const EXTENT_FRAME_STRIDE = 8;
const EXTENT_TEXEL_STRIDE = 4;
const EXTENT_PERCENTILE = 0.5;
// Ten millimetre bins across twenty metres: finer than the fit's own 50mm step.
const EXTENT_BINS = 2000;
const EXTENT_SPAN = 20;

const percentile = (bins, total, p) => {
  const want = total * p / 100;
  let acc = 0;
  for (let i = 0; i < bins.length; i++) {
    acc += bins[i];
    if (acc >= want) return -EXTENT_SPAN / 2 + ((i + 0.5) / bins.length) * EXTENT_SPAN;
  }
  return EXTENT_SPAN / 2;
};

// `hello` is the take's own, so the unprojection uses the intrinsics the footage was shot with
// rather than the sensor's today.
export async function cloudExtent(capture, hello, near, far) {
  const { fx, fy, cx, cy } = hello;
  const x = new Float64Array(EXTENT_BINS);
  const y = new Float64Array(EXTENT_BINS);
  let total = 0;
  let scanned = 0;
  const bin = (v) => Math.min(EXTENT_BINS - 1, Math.max(0,
    Math.floor(((v + EXTENT_SPAN / 2) / EXTENT_SPAN) * EXTENT_BINS)));
  for (let n = 0; n < capture.frameCount; n += EXTENT_FRAME_STRIDE) {
    const payload = await capture.readFrame(n);
    // A frame whose grid is not this build's is skipped rather than sampled past.
    if (payload.readUInt32LE(0) !== DEPTH_W * DEPTH_H * 2) continue;
    scanned++;
    for (let row = 0; row < DEPTH_H; row += EXTENT_TEXEL_STRIDE) {
      const base = 16 + row * DEPTH_W * 2;
      for (let col = 0; col < DEPTH_W; col += EXTENT_TEXEL_STRIDE) {
        const mm = payload.readUInt16LE(base + col * 2);
        if (mm === 0) continue;
        const z = mm * 0.001;
        if (z < near || z > far) continue;
        // The negation on x is the same mirror correction `drawPlanCloud` carries: without it the
        // box comes back reflected about the optical axis.
        x[bin((-(col + 0.5 - cx) / fx) * z)]++;
        y[bin(-((row + 0.5 - cy) / fy) * z)]++;
        total++;
      }
    }
  }
  if (!total) return { frames: scanned, samples: 0, x: null, y: null };
  return {
    frames: scanned,
    samples: total,
    x: [percentile(x, total, EXTENT_PERCENTILE), percentile(x, total, 100 - EXTENT_PERCENTILE)],
    y: [percentile(y, total, EXTENT_PERCENTILE), percentile(y, total, 100 - EXTENT_PERCENTILE)],
  };
}

const openCaptures = new Map();

// The scarce resource is descriptors: each open capture holds one fd against a soft limit of 256,
// and a library skim touches every take. Far below the limit, because this process also holds the
// listener, every socket and the replay.
export const MAX_OPEN_CAPTURES = 24;

// The index without the descriptor, for a manifest that wants a hash for every take and none of
// them held open. Cached on the sidecar's own staleness test.
const indexCache = new Map();

// Scans in flight, keyed by path: a take being written moves its size and mtime continuously, so
// every poll fails the staleness test and used to start its own full read plus sha256.
const indexPending = new Map();

export async function cachedIndex(capturePath) {
  const path = resolve(capturePath);
  const st = await stat(path);
  const held = indexCache.get(path);
  if (held && held.bytes === st.size && held.mtimeMs === st.mtimeMs) return held;
  const running = indexPending.get(path);
  if (running) return running;
  const started = loadIndex(path);
  indexPending.set(path, started);
  started.then(
    (index) => {
      // Only if this scan is still the one in flight: `forgetCapture` clears the entry when the
      // file changes underneath, and a later-finishing scan describes bytes now gone.
      if (indexPending.get(path) === started) {
        indexCache.set(path, index);
        indexPending.delete(path);
      }
    },
    () => { if (indexPending.get(path) === started) indexPending.delete(path); },
  );
  return started;
}

// The descriptor is closed again before this returns: routing a manifest through `openCapture`
// would hold one per take for the length of a listing.
export async function readHelloOnce(capturePath, index) {
  const h = index.hello;
  if (!h) return null;
  const handle = await open(resolve(capturePath), 'r');
  try {
    const buf = Buffer.allocUnsafe(h.length);
    let got = 0;
    while (got < h.length) {
      const { bytesRead } = await handle.read(buf, got, h.length - got, h.offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    try {
      return JSON.parse(buf.subarray(0, got).toString('utf8'));
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

// Drops a take's cached index and closes the descriptor whenever the last reader lets go. A
// `FileHandle` collected unclosed throws `ERR_INVALID_STATE` from the garbage collector on Node
// 26, where nothing can catch it.
export function forgetCapture(capturePath) {
  const path = resolve(capturePath);
  indexCache.delete(path);
  indexPending.delete(path);
  const pending = openCaptures.get(path);
  openCaptures.delete(path);
  pending?.then((capture) => {
    capture.doomed = true;
    if (capture.leases === 0) capture.close().catch(() => {});
  }, () => {});
}

// The promise rather than the result is memoised, so two requests during a scan share it.
// Eviction is least-recently-used and only takes a capture with no lease, so the map may exceed
// the cap while requests are in flight - the bound is on descriptors left lying about.
export function openCapture(capturePath) {
  const path = resolve(capturePath);
  let pending = openCaptures.get(path);
  if (!pending) {
    pending = (async () => new Capture(path, await cachedIndex(path), await open(path, 'r')))();
    // A failure must not be remembered, or a capture that appears a moment later would keep
    // reporting the error from before it existed.
    pending.catch(() => openCaptures.delete(path));
    pending.then((capture) => {
      settledValue.set(pending, capture);
      // Swept again now this one has a descriptor: the pass below runs while the promise is still
      // unresolved, and an unresolved entry is not a candidate.
      evictIdle();
    }, () => {});
    openCaptures.set(path, pending);
    evictIdle();
  }
  return pending;
}

function evictIdle() {
  if (openCaptures.size <= MAX_OPEN_CAPTURES) return;
  // Resolved entries only, or the sweep waits on the scan it is making room for. A `usedAt` of
  // zero is a capture nobody has touched yet, which would otherwise sort to the front and be
  // closed into the read it was opened for - so a caller that neither leases nor retains leaks one.
  const settled = [];
  for (const [path, pending] of openCaptures) {
    const capture = pendingValue(pending);
    if (capture && capture.leases === 0 && capture.usedAt > 0) settled.push([path, capture]);
  }
  settled.sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [path, capture] of settled) {
    if (openCaptures.size <= MAX_OPEN_CAPTURES) break;
    openCaptures.delete(path);
    capture.close().catch(() => {});
  }
}

// A promise's resolved value, or null if it has not settled. There is no way to ask a promise.
const settledValue = new WeakMap();
const pendingValue = (pending) => settledValue.get(pending) ?? null;

// A lease released early is a descriptor closed under a read; one never released is
// an unbounded map.
export async function withCapture(capturePath, fn) {
  const pending = openCapture(capturePath);
  // Taken in this turn when there is anything to take it on, because an `await` on a resolved
  // promise is still a microtask - and `evictIdle` runs synchronously out of `openCapture`.
  const already = pendingValue(pending);
  let capture;
  if (already) {
    already.leases++;
    capture = already;
  } else {
    capture = await pending;
    capture.leases++;
  }
  // Asked after the lease, because `forgetCapture` does not check `usedAt`. Both flags, and
  // narrower than `doomed` alone on purpose: `forgetCapture` also runs on a rename, where the
  // inode survives and a read already holding the handle returns the take's own bytes.
  if (capture.doomed && capture.closed) {
    capture.leases--;
    throw new Error(`${capturePath} was removed or renamed while it was being opened`);
  }
  capture.usedAt = ++useClock;
  try {
    return await fn(capture);
  } finally {
    capture.leases--;
    // Not an optimisation: an unclosed `FileHandle` is a process death on Node 26.
    if (capture.doomed && capture.leases === 0) await capture.close().catch(() => {});
  }
}

let useClock = 0;

export const openCaptureCount = () => openCaptures.size;
