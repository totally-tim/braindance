// A take is a file. Start opens one, stop closes it and scans it, and that identity - take is file
// is library entry is hash - is what the project model, the frame API and the library assume. One
// take is one continuous stream, one hello, monotonic stamps; a grabber restart splits it.

import { createWriteStream, fstatSync, openSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { encodeMessage, TYPE_HELLO } from './protocol.js';
import { buildIndex, forgetCapture } from './capture.js';
import { appendMarks, remaining, MIN_TAKE_SEC, durationLabel, sameTake, takeIdentity } from './library.js';

// `2026-07-31-take3`. Synchronous, because opening a take must finish in the same turn as the
// hello or the frames behind it find no file.
function nextTakeId(dir, atLeast = 0) {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let files = [];
  try {
    files = readdirSync(dir);
  } catch { /* the directory is made on the way to opening the file, or cannot be listed */ }
  let highest = atLeast;
  for (const file of files) {
    const m = new RegExp(`^${day}-take(\\d+)\\.knct$`).exec(file);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return { id: `${day}-take${highest + 1}`, n: highest + 1 };
}

const MAX_NAME_ATTEMPTS = 64;

// Past this, `write` drops rather than blocking: a gap still replays, where blocking would stall
// the parse loop and take the live monitor with it.
export const MAX_TAKE_BUFFER = 64 * 1024 * 1024;

// Fails soft, because the hello is the one message a take cannot do without, so an unparsable one
// is passed through unchanged.
function stampHello(helloPayload, startedAt) {
  const raw = Buffer.from(helloPayload);
  try {
    const hello = JSON.parse(raw.toString('utf8'));
    if (hello === null || typeof hello !== 'object' || Array.isArray(hello)) return raw;
    return Buffer.from(JSON.stringify({ ...hello, startedAt }), 'utf8');
  } catch {
    console.warn('[recorder] the hello is not JSON this build can read, so the take carries it '
      + 'through unchanged - its date will be the sensor\'s rather than this take\'s');
    return raw;
  }
}

function settle(take) {
  const written = take.stream.bytesWritten;
  while (take.inFlightHead < take.inFlight.length && take.inFlight[take.inFlightHead] <= written) {
    take.inFlightHead++;
    take.frames++;
  }
  if (take.inFlightHead > 0 && take.inFlightHead * 2 >= take.inFlight.length) {
    take.inFlight.splice(0, take.inFlightHead);
    take.inFlightHead = 0;
  }
  take.bytes = written;
}

// Marks hang off the take rather than the recorder, or a take that failed mid-write leaves them
// for whichever take closes next.
async function flushMarks(take) {
  if (!take.pendingMarks.length) return;
  try {
    await appendMarks(take.path, take.pendingMarks.splice(0));
  } catch (err) {
    console.error(`[recorder] take ${take.id}: could not write its marks: ${err.message}`);
  }
}

export class Recorder {
  constructor({ dir, onChange = () => {}, rateOf = () => undefined, cannotRecord = () => null }) {
    this.dir = dir;
    this.onChange = onChange;
    this.rateOf = rateOf;
    // Asked each time rather than fixed at construction, because a machine with no sensor is only
    // discovered seconds in, by a grabber failing to find one.
    this.cannotRecord = cannotRecord;
    // Armed and recording are different states: a restart closes the take while the operator's
    // intention is unchanged, so the next hello opens the next take with nobody pressing.
    this.armed = false;
    this.take = null;
    // Every take whose close is still running. A set, because `split()` closes the old take
    // unawaited while the replacement's hello opens the next, so a restart holds two at once.
    this.closing = new Set();
  }

  get state() {
    const take = this.take;
    if (take) settle(take);
    return {
      armed: this.armed,
      recording: Boolean(take),
      takeId: take?.id ?? null,
      startedAt: take?.startedAt ?? null,
      frames: take?.frames ?? 0,
      bytes: take?.bytes ?? 0,
      dropped: take?.dropped ?? 0,
      buffered: take ? take.stream.writableLength : 0,
      cannotRecord: this.cannotRecord(),
      // A longer window than `recording`: a library tile may not offer Download or Remove until
      // the index and the hash exist. Every owned take, because a restart owns two and a tile has
      // to repaint when either close finishes; sorted, so a surface compares it as a set.
      writingIds: this.ownedTakes().map((owned) => owned.id).sort(),
    };
  }

  /** The open take and every take whose close is still running. */
  ownedTakes() {
    return [this.take, ...this.closing].filter((take) => take !== null);
  }

  /** Whether `path` is a file this recorder is still writing: the open take, or one still closing. */
  owns(path) {
    // The file rather than the name: an id is joined into a path as given, and a volume that folds
    // case opens one take under many spellings of it.
    return Boolean(path) && this.ownedTakes().length > 0 && this.ownsFile(takeIdentity(path));
  }

  /** The same question about a file already opened, by its `dev` and `ino`. */
  ownsFile(identity) {
    return identity !== null && this.ownedTakes().some((take) => sameTake(identity, take.identity));
  }

  // Refuses when the disk cannot hold a sensible minimum, because with manual-only deletion the
  // card genuinely does fill mid-shoot.
  async start(helloPayload) {
    // A replay server refuses at the door: its frames come off a file on a loop, so their stamps
    // repeat, and one take is one continuous stream with monotonic stamps.
    const blocked = this.cannotRecord();
    if (blocked) throw new Error(blocked);
    if (this.armed) return this.state;
    // The rate the library reports, not a constant: the refusal and the readout have to divide by
    // the same number.
    const left = await remaining(this.dir, this.rateOf());
    if (left.error) throw new Error(`refusing to start a take: ${left.error}`);
    if (left.secondsLeft < MIN_TAKE_SEC) {
      throw new Error(
        `refusing to start a take: ${left.label} left at current settings, under the `
        + `${durationLabel(MIN_TAKE_SEC)} minimum - a take that dies partway through is a loss`,
      );
    }
    this.armed = true;
    if (helloPayload) this.open(helloPayload);
    this.onChange(this.state);
    return this.state;
  }

  // Hello first, so the file has exactly one. Synchronous end to end, because the frames of this
  // take arrive behind the hello and any await is a window where `write` finds no take.
  open(helloPayload) {
    if (this.take) return;

    // `wx`, so a take never appends to or truncates a file already there: two takes in one file
    // share a hash and a library entry. A taken name just means the next name.
    let take = null;
    let floor = 0;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS && !take; attempt++) {
      const { id, n } = nextTakeId(this.dir, floor);
      const path = join(this.dir, `${id}.knct`);
      try {
        take = { id, path, fd: openSync(path, 'wx') };
      } catch (err) {
        if (err.code !== 'EEXIST') {
          // ENOSPC, EACCES, a missing captures directory: fatal, and no other name would fix it.
          // Disarmed, because looking armed while writing nothing is the failure to avoid.
          console.error(`[recorder] cannot open ${path}: ${err.message} - recording is off`);
          this.armed = false;
          this.onChange(this.state);
          return;
        }
        console.warn(`[recorder] ${id} is already taken, trying the next name`);
        floor = n;
      }
    }
    if (!take) {
      console.error(`[recorder] no free take name after ${MAX_NAME_ATTEMPTS} tries - recording is off`);
      this.armed = false;
      this.onChange(this.state);
      return;
    }

    const stream = createWriteStream(null, { fd: take.fd, autoClose: true });
    // Past the open, an error is a failed write and no next name helps. What already landed is
    // still a usable take.
    stream.on('error', (err) => {
      console.error(`[recorder] take ${take.id} failed mid-write: ${err.message} - recording is off`);
      if (this.take?.stream === stream) {
        const failed = this.take;
        this.take = null;
        this.armed = false;
        // Into *this* take's sidecar, even though it ended badly: nulling the take without
        // flushing left them for the next take, at a source time meaningless there.
        settle(failed);
        flushMarks(failed);
        this.onChange(this.state);
      }
    });
    // The take's own wall clock: the sensor says hello once per grabber process, so every take in
    // a session used to carry one identical stamp and the library sorted on it.
    const startedAt = Date.now();
    const stamped = stampHello(helloPayload, startedAt);
    const helloMessage = encodeMessage(TYPE_HELLO, stamped);
    stream.write(helloMessage);
    this.take = {
      id: take.id,
      path: take.path,
      // Off the descriptor, which the stream closes at the end of the take.
      identity: fstatSync(take.fd),
      stream,
      startedAt,
      frames: 0,
      bytes: 0,
      dropped: 0,
      stalling: false,
      // Cumulative bytes handed to the stream, and the end offset of every frame not yet known to
      // have reached the file. `inFlightHead` is how far into that queue the drain has got.
      accepted: helloMessage.length,
      inFlight: [],
      inFlightHead: 0,
      pendingMarks: [],
    };
    console.log(`[recorder] take ${take.id} open`);
    this.onChange(this.state);
  }

  write(raw) {
    const take = this.take;
    if (!take) return;
    // Drained on the frame path rather than only when something asks for state, which is what
    // bounds the queue by the buffer ceiling below instead of by the length of the take.
    settle(take);
    // A discarded `write` return value made a slow disk into heap that grew until the process was
    // killed, having reported itself healthy throughout.
    if (take.stream.writableLength > MAX_TAKE_BUFFER) {
      take.dropped++;
      if (!take.stalling) {
        take.stalling = true;
        console.error(
          `[recorder] take ${take.id}: ${(take.stream.writableLength / 1e6).toFixed(0)}MB waiting on the disk, `
          + 'over the buffer ceiling - dropping frames until it catches up',
        );
        // Pushed at the transition rather than left to the panel's five-second poll, because
        // footage is lost for every one of those seconds and a readout that stays
        // green costs the take.
        this.onChange(this.state);
      }
      return;
    }
    if (take.stalling) {
      take.stalling = false;
      console.log(`[recorder] take ${take.id}: the disk caught up, ${take.dropped} frames dropped in the gap`);
    }
    take.stream.write(raw);
    take.accepted += raw.length;
    take.inFlight.push(take.accepted);
  }

  // The scan writes the sidecar index and the content hash, which is what makes the take a library
  // entry, so a take is not finished until it has one.
  async close(reason) {
    const take = this.take;
    if (!take) return null;
    this.take = null;
    this.closing.add(take);
    take.stream.end();
    let closeError = null;
    try {
      await once(take.stream, 'close');
    } catch (err) {
      closeError = err;
      // `events.once` attaches its own error listener and rejects on it, so a card pulled during
      // this last flush used to throw straight out of `close`, past the index and the hash.
      console.error(`[recorder] take ${take.id}: the file did not close cleanly (${err.message}) - indexing what landed`);
    }
    // Past the catch rather than inside a branch of it: the take has already been nulled, so a
    // flush skipped here sends the marks forward into whichever take closes next.
    let index;
    try {
      settle(take);
      await flushMarks(take);
      forgetCapture(take.path);
      index = await buildIndex(take.path);
    } finally {
      // In a `finally`, or an index build that threw leaves this process claiming a file it had
      // stopped working on, with the library refusing to open or remove it until a restart. This
      // take and no other: a shared slot cleared here handed a later take's guard away mid-close.
      this.closing.delete(take);
    }
    console.log(
      `[recorder] take ${take.id} closed (${reason}): ${index.frames.offset.length} frames, ${index.hash}`
      + (take.dropped ? `, ${take.dropped} frames dropped to a slow disk` : ''),
    );
    this.onChange(this.state);
    if (closeError) throw closeError;
    return {
      id: take.id,
      path: take.path,
      frames: index.frames.offset.length,
      hash: index.hash,
      bytes: take.bytes,
      dropped: take.dropped,
    };
  }

  async stop() {
    this.armed = false;
    const done = await this.close('stopped');
    this.onChange(this.state);
    return done;
  }

  /** The grabber died or restarted: the take ends here and the next hello opens the next one. */
  async split() {
    if (!this.take) return null;
    return this.close('grabber restarted');
  }

  // Synchronous, so the very next frame in the same chunk lands in the file.
  onHello(helloPayload) {
    if (this.armed && !this.take) this.open(helloPayload);
  }

  // Stamped in source milliseconds from the take's first frame, because a mark describes the
  // footage rather than any edit of it. Never pre-rolled: marks are approximate signposts.
  mark(sourceMs, label) {
    const take = this.take;
    if (!take) throw new Error('nothing is recording, so there is no moment to flag');
    const rec = {
      id: `m${take.startedAt.toString(36)}-${take.pendingMarks.length + 1}`,
      sourceMs,
      label: label || `mark ${take.pendingMarks.length + 1}`,
      at: Date.now(),
    };
    take.pendingMarks.push(rec);
    return rec;
  }
}
