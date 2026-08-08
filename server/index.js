// Bridges the native Kinect grabber to the browser: spawns (or replays) the
// framed binary stream and fans it out over WebSocket, while serving the viewer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, normalize, extname, sep, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { MessageParser, encodeMessage, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR } from './protocol.js';
import { openCapture, withCapture, captureIdFor, openCaptureCount, decimatePayload } from './capture.js';
import { handleExportSocket, MAX_FRAME_BYTES } from './export.js';
import {
  VALID_ID, DocumentStore, NodeLink, PROJECT_VERSION, appendMarks, downloadTake,
  downloadsInFlight, hashFile, markWriteCount, readMarkLog, readMarks, reconcile, remaining,
  removeTake, renameTake, resolveMarks, revealSupport, revealTake, scanTakes,
} from './library.js';
import { Recorder } from './recorder.js';
import { JobStore } from './jobs.js';
import { Webcam } from './webcam.js';
import { requireMutation, originAllowed } from './http-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', '8080'));
// Loopback unless somebody says otherwise, and saying otherwise is a flag rather
// than a default, because this server has no authentication of any kind: the
// recorder's arm, start and stop are reachable by anything that can route to the
// port. A capture node genuinely has to be reachable - the whole two-machine
// design is a browser on the Mac driving a node over Wi-Fi - so `--host 0.0.0.0`
// is a supported and expected thing to type. What it must not be is what happens
// when nobody thought about it.
//
// The origin checks are the other half and they are not a substitute for this one.
// Host equality cannot survive DNS rebinding on its own: a name the attacker
// controls, re-resolved onto the address this server listens on, makes `Origin`
// and `Host` the same string, so the request is genuinely same-origin by every
// test a server can run on itself.
//
// **This comment used to claim the bind address answered that, and it does not.**
// The argument was that the attack has to be routable to happen at all, so
// listening on loopback removes it - but the browser doing the connecting is
// already on the machine, which is what makes loopback routable to it. Measured
// rather than argued: on the default `127.0.0.1` bind, a request carrying an
// attacker's name in both headers wrote a preset, drove `/record/start` and
// `/record/stop` against the sensor, opened the socket, and deleted a take.
//
// So the answer is in the guard, where it belongs. `originAllowed` additionally
// requires that a browser arrived at an *address* rather than a name, because
// rebinding needs a name whose resolution the attacker owns and an address literal
// cannot be rebound without owning the address - which is the thing this line
// decides. The bind still matters for everything that is not a browser: an origin
// header is a browser's claim about itself, and curl has no such claim to check.
const LOOPBACK = '127.0.0.1';
const HOST = flag('--host', LOOPBACK);
const REPLAY = flag('--replay');
// Recording is a runtime action now rather than a path on the command line: a
// take is a file, start opens one and stop closes it, so `--record` only says
// whether the first take should arm itself as soon as the sensor says hello.
const RECORD = has('--record');
// The capture node this library reconciles against, if any. A node is an ordinary
// instance of this server with no `--node` of its own - it never learns it is
// being read - so the link is one-directional and always initiated from here.
const NODE_URL = flag('--node');
const NODE_NAME = flag('--node-name', 'node');
const HERE_NAME = flag('--name', NODE_URL ? 'mac' : 'node');
// No fallback on purpose. Which depth processors exist is a property of the
// libfreenect2 this grabber was built against - macOS has OpenCL and no OpenGL,
// the Pi's V3D the reverse - and the grabber already picks the fastest one its
// own build contains. Defaulting to 'cl' here would hand the Pi a processor that
// is not compiled in, which the grabber now rejects rather than silently falling
// back, so the capture node would never start.
const PIPELINE = flag('--pipeline');
const NO_COLOR = has('--no-color');

// A browser that falls behind must never build a queue - a stale point cloud
// reads as "the Kinect is slow". Drop frames instead.
const MAX_BUFFERED = 4 * 1024 * 1024;

// What a monitor is allowed to ask for. The divisor's ceiling is the frame API's,
// because they are one mechanism and a divisor the socket accepts and the gallery
// refuses would be two. The stride's ceiling is one frame per second at 30fps,
// past which a monitor has stopped being a monitor.
const MAX_DIVISOR = 16;
const MAX_STRIDE = 30;

// What a monitor costs the take, and the setting at which it stops costing it.
//
// **This is a refusal at the record boundary and never a cap on a running stream**,
// which is the distinction the design turns on. Line 255 of the design doc says
// decimation is set by the user, is always visible, and never downgrades itself -
// because a monitor is an instrument, and coarse depth reads as a badly placed
// subject while a dropped stride reads as a sensor losing frames. Both would be
// misattributed to the scene at exactly the moment somebody is judging framing. So
// nothing here ever changes a setting: `/record/start` refuses instead, names the
// monitors that are too fine and what they would cost, and the operator either
// coarsens them or says `acceptMonitorCost` and means it. That is the same shape as
// the low-space refusal the recorder already makes - a take that never started is a
// decision, a take that dies at eighty percent is a loss.
//
// **Loopback monitors are exempt, and that exemption is measured rather than
// assumed** - see the interleaved A/B in the commit body. The cost being refused is
// backpressure from a link that cannot carry 14.6 MB/s reaching back through the
// server's stdin pipe into the grabber, which then misses USB deadlines; a monitor
// on the same machine never touches that link. It also means every existing proof
// tool, which drives this server over localhost, is unaffected by the refusal.
const RECORDING_CAP = { divisor: 4, stride: 3 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  // The other two things an export can be. A `.mov` served as
  // `application/octet-stream` is a file the `<video>` element declines to play, and
  // a frame of a PNG sequence served the same way is a picture nothing will preview -
  // which would make "watch it back where it was made" a property of the format that
  // shipped first rather than of the exports directory.
  '.mov': 'video/quicktime',
  '.png': 'image/png',
};

const WEB_DIR = join(ROOT, 'web');
const THREE_DIR = join(ROOT, 'node_modules/three');
// The grabber binary. A flag because the one on this machine is not the only one
// that matters: a cross-built grabber lands outside the tree, and the recorder's
// own proof needs a writer it can start, stop and kill on demand without a sensor
// in the room.
// Space-separated, so the flag can carry the writer's own arguments. A real
// grabber takes its settings from the flags below; a stand-in needs to be told what
// to stream and when to die, and threading that through a second flag would be a
// second way to say one thing.
const [GRABBER_BIN, ...GRABBER_ARGS] = (flag('--grabber') ?? '').split(' ').filter(Boolean);

// Where takes live. A flag rather than a constant because a capture node and an
// editing machine are the same program, and the only way to run both on one host -
// which is how the reconciliation is tested at all - is to give them separate
// directories. On a real node and a real Mac this is the default either way.
const CAPTURES_DIR = resolve(flag('--captures', join(ROOT, 'captures')));
const EXPORTS_DIR = join(ROOT, 'exports');

// The program `POST /library/reveal/:id` starts, when it is not the platform's own.
// It substitutes the program and nothing else - the arguments stay the shape the
// platform's file manager takes - so a proof tool can point this at a script that
// records its argv and be measuring the arguments Finder would have been given,
// rather than a second code path that exists to be measured. `library-check` is the
// caller; on an operator's machine this is never passed.
const REVEAL_WITH = flag('--reveal-with', null);

// A bare startsWith would also match a sibling like `web-private`, so the
// separator has to be part of the comparison.
const isInside = (dir, candidate) => candidate === dir || candidate.startsWith(dir + sep);

/**
 * A directory as the kernel would reach it, or the path itself where there is
 * nothing there yet.
 *
 * The containment check below compares a realpathed candidate against these, and
 * both sides have to be resolved the same way or the comparison stops being about
 * the same tree: `node_modules/three` is a real directory here, but a pnpm store
 * links it, and `exports/` is exactly the sort of directory somebody points at
 * another volume when a render fills the disk. Falling back to the path is for
 * `exports/`, which does not exist until the first export finishes - and resolving
 * per request rather than once at load is so that the answer is not the lexical
 * path forever after, which would 403 every file under it the day it becomes a
 * link. Three `realpath` calls against a handler that is about to stat, open and
 * read a file is not a cost worth caching a wrong answer for.
 */
const realOrLexical = (dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

// A capture is addressed by id - its file name without the extension - resolved
// inside the captures directory. Ids arrive off the URL, so anything that could
// name a path rather than a take is rejected outright rather than normalised and
// hoped about; the leading character rules out `..` on its own. The pattern lives
// in the library module because a node's manifest is a second door ids come
// through, and one rule is the whole of the safety property.
// `--replay` may name a file anywhere, so the replayed take registers its own id.
const captureAliases = new Map();

// The node keeps its own preset library on disk, refreshed when an editing
// machine connects. It has to: the node serves its own recorder page and may well
// be shooting with nothing connected to it, and a scheme that pushed presets over
// a socket per session would leave a standalone node with an empty selector -
// which is exactly the shoot where the operator cannot go and fix it.
const PROJECTS = new DocumentStore(resolve(flag('--projects', join(ROOT, 'projects'))), 'project');
// The five looks that ship, served out of the repo beside the user's own library.
//
// A second *read* root rather than files copied into the user's directory on first
// run, and the difference shows up the second time you start the program: a copy is
// somebody's document the moment it lands, so re-grading a shipped look could never
// reach anybody who had already run the thing once, and deleting one would leave a
// hole nothing refills. Read from here, a built-in is always the current one, a save
// over its name forks it into the user's directory, and removing the fork brings the
// shipped look back. `--builtin-presets` exists so a check can point the search path
// somewhere it controls.
const PRESETS = new DocumentStore(
  resolve(flag('--presets', join(ROOT, 'presets'))),
  'preset',
  PROJECT_VERSION,
  resolve(flag('--builtin-presets', join(ROOT, 'presets-builtin'))),
);
const DELIVERABLES = new DocumentStore(resolve(flag('--deliverables', join(CAPTURES_DIR, '..', 'deliverables'))), 'deliverable', 1);
// The render queue's records. A flag for the same reason the document stores take
// one: a capture node and an editing machine are the same program, and running
// both on one host is how the two-machine behaviour gets tested at all.
const JOBS = new JobStore(resolve(flag('--jobs', join(ROOT, 'jobs'))));
const node = NODE_URL ? new NodeLink(NODE_URL, NODE_NAME) : null;

function capturePathFor(id) {
  if (captureAliases.has(id)) return captureAliases.get(id);
  return VALID_ID.test(id) ? join(CAPTURES_DIR, `${id}.knct`) : null;
}

// The frame API: the browser asks for a frame or a run, the server preads it out
// of the capture and returns the bytes unchanged. Two response shapes, because
// the two calls want different things. A single frame is the payload alone -
// byte for byte what `broadcastFrame` puts on the socket - so the pulled and the
// pushed path hand the same decoder the same input. A run is the file's own
// slice, framing included, because payloads concatenated have no boundaries left
// to parse back and the headers that supply them are already interleaved.
/**
 * Opening a capture, and the two ways it fails.
 *
 * Every reader here holds a lease for exactly as long as its handler runs - see
 * `withCapture` - which is what keeps a descriptor from being evicted underneath a
 * read in progress.
 */
/**
 * The take the recorder has open is not readable through this API until it closes.
 *
 * One rule rather than one exclusion in the manifest, and this is the stronger half
 * of it: the manifest describing the open take without scanning it stops the
 * *gallery* from re-hashing a growing file, but `GET /capture/:id/index` and
 * `GET /capture/:id/frame/0` reach the same scan by a shorter road - and a scan is a
 * full read plus sha256 against the disk the recorder is writing to. It also cannot
 * answer honestly: an index over a file that is still growing describes bytes that
 * were true when the read started, and the hash it carries names a take that no
 * longer exists a frame later.
 */
function beingRecorded(path) {
  return path !== null && path === recorder.openPath;
}

async function withOpenCapture(res, id, fn) {
  const path = capturePathFor(id);
  if (!path) {
    res.writeHead(404).end('unknown capture');
    return;
  }
  if (beingRecorded(path)) {
    sendJson(res, { error: `${id} is being recorded right now: it has no settled index or hash until the take closes` }, 409);
    return;
  }
  await withCapture(path, fn).catch((err) => {
    if (res.headersSent) return;
    if (err.code === 'ENOENT') res.writeHead(404).end('unknown capture');
    else res.writeHead(500).end(`capture unreadable: ${err.message}`);
  });
}

// The sensor's own intrinsics, as the grabber reported them when the take was
// recorded. The timeline path has no socket to hear them on, and unprojecting a take
// on the boot defaults is wrong in a way nothing on screen can show - every point
// translates together, so both arms of every comparison are wrong identically. Step
// 2's scan already recorded where the hello sits, so this is one positioned read.
const serveHello = (req, res, [id]) => withOpenCapture(res, id, async (capture) => {
  const payload = await capture.readHello();
  if (!payload) {
    res.writeHead(404).end('this capture carries no hello');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
  });
  res.end(payload);
});

const serveIndex = (req, res, [id]) => withOpenCapture(res, id, (capture) => {
  const body = Buffer.from(JSON.stringify(capture.index));
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
});

const inCapture = (capture, n) => Number.isInteger(n) && n >= 0 && n < capture.frameCount;

const serveFrame = (req, res, [id, index], query) => withOpenCapture(res, id, async (capture) => {
  const n = Number(index);
  if (!inCapture(capture, n)) {
    res.writeHead(404).end('no such frame');
    return;
  }
  // The depth divisor. A network concession and never a compute one - the node
  // sustains full rate, and this exists because a radio link cannot carry
  // 14.6 MB/s. Absent or 1 returns the payload byte for byte, so the editor's path
  // is exactly what it was; above 1 the frame comes back sampled down and still a
  // KNCT frame, which is what lets the monitor, the editor over a slow link and the
  // gallery's skim all be one mechanism rather than three.
  const divisor = Number(query.get('decimate') ?? 1);
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 16) {
    res.writeHead(400).end('decimate must be a whole number from 1 to 16');
    return;
  }
  let payload;
  try {
    payload = await capture.readFrame(n, divisor);
  } catch (err) {
    // A frame whose declared lengths do not describe the bytes it carries is
    // refused rather than sampled past - the alternative is a response whose tail
    // is this process's own recycled heap.
    res.writeHead(422).end(err.message);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
    // Said rather than left to be inferred: a decimated frame carries a different
    // grid, and a client that guessed it from the byte count would have to know the
    // divisor it asked for was honoured.
    'X-Depth-Divisor': String(divisor),
  });
  res.end(payload);
});

const serveFrameRun = (req, res, [id, from, to]) => withOpenCapture(res, id, async (capture) => {
  const a = Number(from);
  const b = Number(to);
  if (!inCapture(capture, a) || !inCapture(capture, b) || a > b) {
    res.writeHead(404).end('no such range');
    return;
  }
  const { start, end } = capture.frameRunSpan(a, b);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-cache',
  });
  // `pipeline` rather than `pipe`, because the headers are already out by the time
  // anything can go wrong. A bare pipe leaves a read error as an unhandled stream
  // event, which takes the whole process down - replay, socket fan-out and static
  // server with it - and leaves a client that walked away mid-run holding a reader
  // nobody stops. This tears down both ends either way; the response is truncated
  // against its declared length, which is the only honest signal left once a 200
  // has been sent.
  //
  // Awaited, and that is load-bearing rather than tidy: the caller holds a lease on
  // this capture for exactly as long as this function runs, and a descriptor evicted
  // while a run was still reading off it would fail inside a stream whose errors
  // nobody is positioned to catch.
  await new Promise((done) => {
    pipeline(capture.createFrameRunStream(a, b), res, (err) => {
      if (err) console.error(`[server] frame run ${id} ${a}-${b} failed: ${err.message}`);
      done();
    });
  });
});

// The whole take, streamed, for a download across the link. Streamed rather than
// read: a take is routinely past the 2 GiB that `readFileSync` refuses, and this is
// the one route whose whole purpose is to move that much.
function serveTakeFile(req, res, [id]) {
  const path = capturePathFor(id);
  // A take still being written has no length that will still be true when the
  // transfer ends, and the download on the other side verifies against a hash this
  // one cannot produce yet - so it is refused here rather than moving gigabytes that
  // will be discarded on arrival.
  if (beingRecorded(path)) {
    sendJson(res, { error: `${id} is being recorded right now: it is still growing, so there is no whole file to send` }, 409);
    return;
  }
  let stat;
  try {
    stat = statSync(path ?? '');
  } catch {
    res.writeHead(404).end('unknown capture');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  pipeline(createReadStream(path), res, (err) => {
    if (err) console.error(`[server] serving ${id} failed: ${err.message}`);
  });
}

// Marks are a sidecar beside the take rather than anything inside it, so they are
// answered without opening the capture at all - which is what lets the gallery draw
// a scrub bar for two hundred takes without holding two hundred descriptors. A take
// whose bytes have gone still has its marks.
//
// A write is an append and never a rewrite, which is what makes moving, renaming and
// deleting a mark all the same operation: a later record with the same id supersedes
// an earlier one, and a deletion is a tombstone. That is also the whole of the
// two-machine merge - concatenate and resolve - so there is one rule here rather
// than one for editing and one for syncing.
/**
 * Which capture is at a path, as an identity rather than a yes.
 *
 * **`dev` and `ino` rather than the path, because the path is what changes.** A rename
 * frees the old id, and nothing stops a later take being renamed into it - so "a take
 * is here" is true again afterwards while being a *different* take. Anything that
 * checks a path, waits, and then acts on it has to compare what it found the second
 * time against what it found the first, and only the inode says that. Two numbers off a
 * stat this code was already paying for, rather than a hash read.
 */
const takeIdentity = (path) => {
  try {
    const st = statSync(path ?? '');
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
};
const sameTake = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
const takeIsHere = (path) => {
  try {
    return takeIdentity(path) !== null;
  } catch {
    return false;
  }
};

async function serveMarks(req, res, [id], query, { log = false } = {}) {
  const path = capturePathFor(id);
  if (!takeIsHere(path)) {
    res.writeHead(404).end('unknown capture');
    return;
  }
  const entries = await readMarkLog(path);
  sendJson(res, log ? { log: entries } : { marks: resolveMarks(entries) });
}

async function serveMarkWrite(req, res, [id]) {
  const path = capturePathFor(id);
  // A take that is not here has no moments to flag. Without this the route accepted
  // any id matching `VALID_ID` and *created* the sidecar - so a caller could write
  // `nosuchtake.marks.jsonl` into the captures directory, with attacker-chosen JSON
  // up to four megabytes a request and tombstones that would delete real marks the
  // moment a take of that name ever existed. Marks hang off a take, so the take is
  // the thing that has to exist first.
  const wasThere = takeIdentity(path);
  if (wasThere === null) {
    sendJson(res, { error: `no take ${id} here, so there is nothing to mark` }, 404);
    return;
  }
  const body = await readBody(req);
  // **Asked again, and asked which take rather than whether one is there.** The check
  // above happens before this await, and this await is a body of up to four megabytes
  // arriving over a room's wifi - so the gap between deciding the take exists and
  // appending to it is however long the client takes to send, not a few microtasks. A
  // rename landing in that gap moves the sidecar to the new name and this append then
  // recreates the old one, which the renamed take never reads: the response says the
  // mark was saved and it is gone.
  //
  // Comparing the inode rather than re-asking `takeIsHere`, because a rename frees the
  // old id and a later take can be renamed into it. Presence alone is true again in
  // that case, against different footage, and the marks would attach to it - the marks
  // resolve cleanly onto frames that exist, so nothing downstream can notice. That is
  // the corruption this is actually for; the lost annotation is the milder half.
  //
  // This narrows the window rather than closing it: a rename can still land between
  // this line and the append below. That remainder is microtask-sized instead of
  // transfer-sized, and closing it properly means addressing marks by content hash the
  // way the rest of the program addresses footage, which is issue #10.
  if (!sameTake(wasThere, takeIdentity(path))) {
    sendJson(res, {
      error: `${id} changed underneath this request - it was renamed or replaced while the marks `
        + 'were being sent, and they have not been written to anything',
    }, 409);
    return;
  }
  const now = Date.now();
  const records = (body.marks ?? []).map((m) => ({
    ...m,
    // Stamped here when the caller did not, because `at` is what orders two
    // machines' edits and a record without one cannot participate in the merge at
    // all - the resolver drops it rather than guessing.
    at: Number.isFinite(m.at) ? m.at : now,
  }));
  await appendMarks(path, records);
  sendJson(res, { marks: resolveMarks(await readMarkLog(path)) });
}

// ------------------------------------------------------------------ the library

/**
 * How many file descriptors this process is holding, as the kernel sees it.
 *
 * `/dev/fd` is the calling process's own descriptor table on Darwin and Linux both,
 * so this needs no external tool and no permission. The listing itself opens one,
 * which is a constant every reading pays equally and so cancels out of a comparison.
 * Returns null where the path does not exist, so a platform that cannot answer says
 * so rather than reporting zero.
 */
function realDescriptorCount() {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

const sendJson = (res, body, status = 200) => {
  const text = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': text.length,
    'Cache-Control': 'no-cache',
  });
  res.end(text);
};

// Bounded on purpose. Every body this server accepts is a project, a preset or a
// handful of marks - tens of kilobytes of JSON - and a request that keeps sending
// is a request nobody meant.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        done({});
        return;
      }
      try {
        done(JSON.parse(text));
      } catch (err) {
        fail(new Error(`body is not JSON: ${err.message}`));
      }
    });
    req.on('error', fail);
  });
}

/**
 * This machine's own takes, which is also what a node answers when asked.
 *
 * The take being written is named on the way in so the manifest can describe it
 * without scanning it - see `describeTake`. A gallery polling a node that is
 * shooting is the ordinary case, not an unusual one.
 */
const localTakes = () => scanTakes(CAPTURES_DIR, recorder.openPath);

/**
 * The one library, spanning both machines and joined by content hash.
 *
 * A node that cannot be reached is reported as unreachable rather than as having
 * no takes. Those are different facts and conflating them would make a dropped
 * Wi-Fi link look like an operator who deleted everything - and the tile that then
 * offered a Delete on the last copy would be offering it on the wrong belief.
 */
/**
 * Whether the caller of *this request* could usefully be shown a file manager, and
 * why not when it could not.
 *
 * **Per request rather than per server, because the answer is about the socket.**
 * `POST /library/reveal/:id` opens a window on the machine running this process, which
 * is the machine the operator is standing at exactly when the browser is on it. A
 * gallery served to a laptop across the room would otherwise offer a menu item whose
 * whole effect happens somewhere nobody is looking - and the honest way to present a
 * control that cannot work is to show it saying why, not to hide it, which is the same
 * reading the disabled Open on an unopenable take already gets.
 *
 * `isLoopback` is the socket's peer as the kernel reports it, so nothing the client
 * sends can move this answer - but read its comment for what the answer is worth: a
 * browser reaching this server through the SSH tunnel `SECURITY.md` recommends arrives
 * on loopback and is offered Reveal, and the window then opens on the host rather than
 * where that operator is sitting. Deliberate, since building the tunnel is a stronger
 * act of authorisation than this program asks of anybody else.
 */
function revealAvailability(req) {
  const { supported, label } = revealSupport();
  if (!supported) {
    return { available: false, label: null, why: `no file manager is known for ${process.platform}` };
  }
  if (!isLoopback(req)) {
    return {
      available: false,
      label,
      why: `${label} would open on ${HERE_NAME}, which is not the machine this browser is on`,
    };
  }
  return { available: true, label, why: null };
}

/**
 * A signal that fires when the caller hangs up, for handing to the node.
 *
 * **Every route that awaits the node passes one, and that is the class rather than the
 * one route where it was noticed.** `node.takes` crosses the network to a machine that
 * may accept a connection and then say nothing, and a handler awaiting it holds this
 * process's socket and the outbound one for as long as that lasts - which, once the
 * gallery's listing is bounded and retries, is another pair every five seconds for as
 * long as the page is open. The gallery is only the route that made it accumulate; a
 * download, a removal and a mark sync all await the same unbounded fetch, so a rule that
 * covered the one would leave the next one added outside it. `library-check` walks the
 * source for `node.takes(` and requires a signal at every call, so a route written later
 * is asked by existing.
 *
 * `close` rather than `aborted`, because it fires for a connection that ended either way
 * and an abort after the answer has gone out costs nothing - the fetch it would cancel
 * has already settled.
 *
 * **Watched on the response and not on the request, because half these routes read a
 * body first.** An `IncomingMessage` is a stream, and it emits `close` when it *ends* -
 * so by the time `serveRemoval` and `serveMarkSync` have awaited `readBody(req)` the
 * request is already `destroyed` and a listener attached after it can never fire again.
 * Both of them built a signal that was structurally incapable of aborting anything, and
 * the source sweep could not see it: the call carried a signal, the argument was
 * spelled correctly, and only the two routes that read no body actually worked. Measured
 * directly rather than reasoned about - a listener on the consumed request does not fire
 * when the client aborts, one on the response does.
 *
 * The response is the object whose lifetime is the handler's, which is what this wanted
 * to name all along, so taking it here closes the class instead of reordering two call
 * sites and leaving the third route somebody writes next year to be found the same way.
 *
 * What that rests on, checked rather than assumed, because it is the way this trade goes
 * wrong: `close` on a response also fires when the answer finishes normally, so a route
 * that had already written one before awaiting the node would abort a fetch still in
 * flight - a signal that fires too early, which fails some of the time and is worse than
 * one that never fires at all. Every write ahead of a `node.takes` call on all four
 * routes is an early refusal that returns, so no path reaching the node has touched the
 * response. A route that wants to stream before it asks the node needs a different
 * answer, and this sentence is where it will find out.
 */
const untilCallerLeaves = (res) => {
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  return ctl.signal;
};

async function serveLibrary(req, res) {
  const here = await localTakes();
  const there = node ? await node.takes(untilCallerLeaves(res)) : null;
  const takes = reconcile(here.takes, there);
  sendJson(res, {
    here: HERE_NAME,
    node: node ? { name: node.name, url: node.url, reachable: there !== null, error: node.lastError } : null,
    takes,
    unreadable: here.unreadable,
    storage: await remaining(CAPTURES_DIR, recordingRate()),
    recording: recorder.state,
    reveal: revealAvailability(req),
  });
}

/**
 * Renaming a take, which is a label moving and never footage moving.
 *
 * **A take that is only on the node is refused rather than renamed over there.** The
 * link is deliberately one-directional about footage: this side asks for a manifest, a
 * marks log and bytes, and the one thing it may ask the node to *do* is drop a copy it
 * has verified survives here. Renaming somebody else's file on a machine nobody is
 * standing at is a different decision from renaming one here, and it is not this
 * button's. That refusal is here because only this module knows a node exists.
 *
 * **The take being recorded is refused one layer down and not here**, and that is
 * worth stating because this function had a second copy of that test for one round.
 * Both refused, in identical words - and the second copy is what made the mutation
 * that removes one of them move nothing: `library-check` ran all 317 assertions
 * against a build with the route's guard deleted and reported the refusal working,
 * because the other guard was still refusing. Two gates that agree are not defence in
 * depth when neither can be tested apart from the other; they are a rule with no
 * measurement behind it. It lives in `renameTake` because that is the function that
 * forms the path, which is where this file already puts `VALID_ID`.
 */
async function serveRename(req, res, [id]) {
  const body = await readBody(req);
  const here = await localTakes();
  const mine = here.takes.find((t) => t.id === id);
  if (!mine) {
    sendJson(res, { error: `${id} is not on this machine, so there is nothing here to rename` }, 404);
    return;
  }
  try {
    const done = await renameTake(CAPTURES_DIR, id, body.to, {
      hash: body.hash,
      recordingPath: recorder.openPath,
    });
    sendJson(res, done);
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
}

/**
 * Showing a take where it lives, in the platform's own file manager.
 *
 * **Two gates, and they answer different questions.** `requireMutation` has already
 * asked whether this request came from this program's own page - it is registered as a
 * `write` for that reason, since a route that starts a process is a route that changes
 * something even though no byte of the library moves. What is left for here is whether
 * the window would open where the person asking is: `isLoopback` reads the peer address
 * off the socket, which the client cannot dictate, and a browser across the link gets
 * the same 409 the gallery's menu item is already greyed out with.
 */
async function serveReveal(req, res, [id]) {
  if (!isLoopback(req)) {
    const { label } = revealSupport();
    sendJson(res, {
      error: `${label ?? 'the file manager'} would open on ${HERE_NAME}, which is not the machine this `
        + 'browser is on: refusing to open a window nobody is standing at',
    }, 409);
    return;
  }
  const here = await localTakes();
  const mine = here.takes.find((t) => t.id === id);
  if (!mine) {
    sendJson(res, { error: `${id} is not on this machine, so there is no file here to show` }, 404);
    return;
  }
  // **The take being recorded is refused, and this is the least obvious of the three
  // refusals in this file.** Nothing about revealing writes: it stats a file and
  // starts a window. What it hands over is the *path*, to a program whose job is to
  // size, index and preview whatever it is pointed at - against the disk the recorder
  // is writing to, which is precisely the contention `describeTake` refuses to cause
  // by not scanning the open take. The gallery greys the menu item for the same
  // reason; this is the gate, because a request does not have to come from that page.
  if (mine.recording) {
    sendJson(res, {
      error: `${id} is being recorded right now: a file manager pointed at it would stat, index and `
        + 'preview the file the recorder is writing to, which is disk the take needs',
    }, 409);
    return;
  }
  try {
    sendJson(res, await revealTake(CAPTURES_DIR, id, { program: REVEAL_WITH }));
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
}

/**
 * The two removals, which are genuinely different actions rather than one action
 * with two buttons.
 *
 * Reclaim is recoverable because a hash-verified copy exists elsewhere, and the
 * verification happens *here, now*, against the machine that is supposed to be
 * keeping the copy - not against a manifest taken some time ago. Delete is the
 * last copy and is the only irreversible action in this tool, so it refuses when a
 * second copy exists rather than quietly doing a reclaim under the wrong name.
 */
async function serveRemoval(req, res, [id], kind) {
  const body = await readBody(req);
  const here = await localTakes();
  const mine = here.takes.find((t) => t.id === id);
  // The take the recorder has open is not a candidate for either action. It has no
  // hash yet - the bytes are still arriving - so neither removal can verify anything
  // about it, and unlinking the file underneath a running write stream loses the
  // shoot in progress rather than a take somebody finished with.
  if (mine?.recording) {
    sendJson(res, { error: `${id} is being recorded right now: stop the take before removing it` }, 409);
    return;
  }
  const there = node ? await node.takes(untilCallerLeaves(res)) : null;
  const theirs = (there ?? []).find((t) => t.hash === (mine?.hash ?? body.hash));

  if (kind === 'reclaim') {
    // Reclaim removes the node's copy, which is the case the operator who just
    // filled a card actually has. The surviving copy is the local one, and it is
    // re-hashed rather than trusted: a local file truncated since the last listing
    // would otherwise be treated as the copy that makes this recoverable.
    if (!mine) {
      sendJson(res, { error: `${id} is not on this machine, so there is nothing here to keep` }, 409);
      return;
    }
    if (!theirs) {
      sendJson(res, { error: `${id} is not on ${node?.name ?? 'any node'}: there is nothing to reclaim` }, 409);
      return;
    }
    const verified = await hashFile(join(CAPTURES_DIR, mine.file));
    if (verified !== mine.hash) {
      sendJson(res, {
        error: `refusing to reclaim ${id}: the copy here hashes ${verified}, not the ${mine.hash} `
          + 'the library listed, so it is not the verified copy this reclaim rests on',
      }, 409);
      return;
    }
    try {
      const done = await node.fetchJson(`/library/delete/${encodeURIComponent(theirs.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: theirs.hash, confirm: true, verifiedElsewhere: verified }),
      });
      sendJson(res, { reclaimed: done, keptHere: verified });
    } catch (err) {
      sendJson(res, { error: `the node refused the reclaim: ${err.message}` }, 502);
    }
    return;
  }

  // Delete. The confirm is required rather than implied, and it names the hash, so
  // a request built against one listing cannot remove a take that changed since.
  if (body.confirm !== true) {
    sendJson(res, { error: 'delete needs an explicit confirm: this is the only irreversible action here' }, 400);
    return;
  }
  if (!mine) {
    sendJson(res, { error: `${id} is not on this machine` }, 404);
    return;
  }
  // `verifiedElsewhere` is what a reclaim arriving from the other machine carries,
  // and it turns this same route into the recoverable action. Without it this is a
  // delete, and a delete of something that exists in two places is refused - the
  // operator asked for the wrong one of two different actions.
  if (!body.verifiedElsewhere && theirs) {
    sendJson(res, {
      error: `${id} exists on ${node.name} as well: reclaim removes a copy, delete removes the last one`,
    }, 409);
    return;
  }
  try {
    const done = await removeTake(CAPTURES_DIR, id, {
      hash: body.hash,
      verifiedElsewhere: body.verifiedElsewhere ?? null,
    });
    sendJson(res, done);
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
}

async function serveRemoteFrame(req, res, [id, n], query) {
  if (!node || !VALID_ID.test(id) || !/^\d+$/.test(n)) {
    res.writeHead(404).end('not found');
    return;
  }
  const divisor = Number(query.get('decimate') ?? 1);
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 16) {
    res.writeHead(400).end('decimate must be a whole number from 1 to 16');
    return;
  }
  const upstream = await fetch(`${node.url}/capture/${encodeURIComponent(id)}/frame/${n}?decimate=${divisor}`);
  if (!upstream.ok) {
    res.writeHead(upstream.status).end('the node could not serve that frame');
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Depth-Divisor': String(divisor),
  });
  res.end(body);
}

async function serveDownload(req, res, [id]) {
  if (!node) {
    sendJson(res, { error: 'no capture node is linked, so there is nothing to download from' }, 409);
    return;
  }
  const there = await node.takes(untilCallerLeaves(res));
  if (there === null) {
    sendJson(res, { error: `${node.name} is unreachable: ${node.lastError}` }, 502);
    return;
  }
  const take = there.find((t) => t.id === id);
  if (!take) {
    sendJson(res, { error: `${node.name} has no take ${id}` }, 404);
    return;
  }
  // A take the node is still shooting has no hash to verify the transfer against,
  // and the download is verified or it is discarded. Refused here with the reason
  // rather than pulled and thrown away several gigabytes later.
  if (take.recording) {
    sendJson(res, { error: `${node.name} is still recording ${id}: it has no hash to check the copy against yet` }, 409);
    return;
  }
  try {
    const path = await downloadTake(node, take, CAPTURES_DIR);
    sendJson(res, { downloaded: basename(path), hash: take.hash, bytes: take.bytes });
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
}

/**
 * A store of small JSON documents - projects, and the preset library the recorder
 * and the editor share. One handler for both because they are the same storage
 * problem, and two would drift.
 */
const listDocuments = async (res, store) => sendJson(res, { [`${store.kind}s`]: await store.list() });

async function readDocument(res, store, name) {
  try {
    sendJson(res, await store.read(name));
  } catch {
    sendJson(res, { error: `no ${store.kind} named ${name}` }, 404);
  }
}

async function writeDocument(req, res, store, name) {
  if (req.method === 'DELETE') {
    try {
      sendJson(res, await store.remove(name));
    } catch {
      // Removing what is not there is a 404 rather than the uncaught ENOENT that
      // used to come back as a 500 with a path in it.
      sendJson(res, { error: `no ${store.kind} named ${name}` }, 404);
    }
    return;
  }
  try {
    sendJson(res, await store.write(name, await readBody(req)));
  } catch (err) {
    // A document this build cannot faithfully interpret is a refusal with a reason
    // rather than a 500 - see `DocumentStore.write` on why the version is checked
    // rather than restamped.
    sendJson(res, { error: err.message }, 409);
  }
}

/**
 * The library routes. Everything here is HTTP, deliberately: the frame API is
 * HTTP for the reasons step 2 settled, and a second socket would be a second
 * endpoint to keep honest for a request pattern that is one call per gesture.
 */

/**
 * Two machines can hold the same take and different marks, and the merge needs no
 * algorithm because the log is append-only and every record carries an id: pull
 * the node's log, append it, and let the resolver keep the highest `at` per id. A
 * deletion is a tombstone like any other, so it cannot be resurrected by an older
 * log arriving late.
 */
async function serveMarkSync(req, res, [id]) {
  if (!node) {
    sendJson(res, { error: 'no capture node is linked' }, 409);
    return;
  }
  const path = capturePathFor(id);
  if (!path) {
    sendJson(res, { error: `unusable take id ${id}` }, 400);
    return;
  }
  try {
    // The node's *name* for this take, resolved by hash. Asking it for the log
    // under the name this machine uses would return nothing whenever the two
    // machines named the same footage differently - which is the case the whole
    // library is built to handle, so the one place that reached for a filename
    // would be the one place the design does not hold.
    const here = (await localTakes()).takes.find((t) => t.id === id);
    const theirTakes = await node.takes(untilCallerLeaves(res));
    const match = here && (theirTakes ?? []).find((t) => t.hash === here.hash);
    if (!match) {
      sendJson(res, { merged: 0, marks: await readMarks(path), note: `${node.name} does not hold this take` });
      return;
    }
    const theirs = await node.fetchJson(`/capture/${encodeURIComponent(match.id)}/marks/log`);
    const mine = await readMarkLog(path);
    // Appended rather than rewritten. Both logs stay whole, which is what makes
    // this safe to run twice and safe to run from both machines.
    const known = new Set(mine.map((r) => `${r.id}@${r.at}`));
    const fresh = (theirs.log ?? []).filter((r) => !known.has(`${r.id}@${r.at}`));
    await appendMarks(path, fresh);
    sendJson(res, { merged: fresh.length, marks: await readMarks(path) });
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
}

/**
 * Record control.
 *
 * The spec puts this on the existing WebSocket, so that any connected client can
 * arm or stop the take it is watching and every monitor sees the state change.
 * The second half still holds - the state is broadcast to every socket below - but
 * the control itself is an HTTP call, because the socket's connection handler is
 * being changed elsewhere and two edits crossing in that region is how a security
 * fix gets buried inside a gallery commit. The property the spec cares about is
 * that a phone watching the monitor can start the take and press mark, and a POST
 * from that phone does that.
 */
/**
 * Record control.
 *
 * The spec puts this on the existing WebSocket, so that any connected client can arm
 * or stop the take it is watching and every monitor sees the state change. The
 * second half still holds - the state is broadcast to every socket below - but the
 * control itself is an HTTP call, because the socket's connection handler is being
 * changed elsewhere and two edits crossing in that region is how a security fix gets
 * buried inside a gallery commit. The property the spec cares about is that a phone
 * watching the monitor can start the take and press mark, and a POST from that phone
 * does that.
 *
 * All three are `write` entries in the table above, which is what puts them behind
 * the one gate. `GET /record/stop` used to end a shoot and disarm the node, which is
 * the silent-stop failure this design spent a round closing, reached from outside
 * the process by anything that could persuade a browser to load a URL.
 */
const shooting = (run) => async (req, res, args, query) => {
  try {
    await run(req, res, args, query);
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
};

/**
 * Every consumer whose frames cross the link and cost the take.
 *
 * Read off the live sockets rather than off anything a caller sends, because the
 * question is what is attached right now, and the answer has to be the same one
 * `broadcastFrame` is about to act on.
 *
 * **This asks about consumers rather than about monitors, and the difference is the
 * whole reason it was rewritten.** The cost being refused is backpressure: a link
 * that cannot carry what is being pushed down it reaches back through this server's
 * stdin pipe into the grabber, which then misses USB deadlines and drops depth
 * packets that never reach the file. A WebSocket monitor at ÷1 does that. So does a
 * webcam subscriber pulling ~50Mbit/s of MJPEG over the same radio, and it does it
 * through a route that has no divisor and no stride to name.
 *
 * Written as "every kind of consumer, asked the same question" rather than as
 * monitors-plus-a-webcam-clause, so the third kind is refused by being in this list
 * rather than by somebody remembering this function exists. A cost the refusal cannot
 * see is a cost it silently under-reports, and the only thing the refusal has going
 * for it is that its number is true.
 *
 * **Each kind is asked its own rule where that rule is written**, rather than having
 * it restated here. The webcam's used to be a `!s.loopback` filter on this line, which
 * left the copy in `server/webcam.js` carrying all of the reasoning and none of the
 * behaviour - so the interleaved A/B that paragraph is waiting on would have been
 * acted on in the dead one.
 */
function consumersCostingTheTake() {
  return [
    ...attachedMonitors().filter(costsTheTake)
      .map((m) => ({ kind: 'monitor', at: `÷${m.divisor} ×${m.stride}` })),
    ...webcam.subscribersCostingTheTake()
      .map(() => ({ kind: 'webcam', at: 'the colour camera at full rate' })),
  ];
}

/**
 * Every monitor attached right now, with the setting it is actually being served at.
 *
 * Served rather than only counted because the interleaved measurement segments its
 * windows by this: the node samples itself once a second and labels each sample with
 * what the server says is watching, so an arm is identified by the resource rather
 * than by what the driver on the other end of the link believed it had set. The
 * driver cannot ask across the link during a window without competing with the arm
 * it is measuring, which is the observer effect that made the first version of that
 * harness unusable.
 */
function attachedMonitors() {
  const out = [];
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const m = monitors.get(ws);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Arming a take, with the one refusal the socket can raise.
 *
 * **A refusal here rather than a cap on the stream**, for the reason the constant
 * above sets out: the design forbids decimation that changes itself, and a monitor
 * whose image silently coarsened at the moment recording started would be lying
 * about the scene to the one person who cannot check. So the cost is stated at the
 * boundary where a decision is being made anyway, in the same place and the same
 * shape as the recorder's own refusal to start a take the card cannot hold.
 *
 * `acceptMonitorCost` is the way past it, and it is spelled out rather than a bare
 * `force` so that a log line saying somebody accepted it reads as the decision it
 * was. A node on ethernet genuinely does not pay this, and the operator is the only
 * one who knows which link they are on.
 */
const serveRecordStart = shooting(async (req, res) => {
  const body = await readBody(req);
  const costly = consumersCostingTheTake();
  if (costly.length && body.acceptMonitorCost !== true) {
    const at = costly.map((c) => `${c.kind} at ${c.at}`).join(', ');
    throw new Error(
      `refusing to start a take: ${costly.length} consumer${costly.length > 1 ? 's are' : ' is'} reading over the `
      + `network (${at}), past what a recording take allows - a monitor may go no finer than `
      + `÷${RECORDING_CAP.divisor} ×${RECORDING_CAP.stride}, and the webcam has no coarser setting to offer at all. `
      + 'Backpressure from that link reaches the grabber and costs the take frames that never reach the file, so '
      + 'coarsen the monitor, detach the webcam, or start again with acceptMonitorCost',
    );
  }
  if (costly.length) {
    console.log(`[server] starting a take with ${costly.length} costly consumer(s): the operator accepted the cost`);
  }
  sendJson(res, await recorder.start(helloJson));
});
const serveRecordStop = shooting(async (req, res) => sendJson(res, { stopped: await recorder.stop() }));
const serveRecordMark = shooting(async (req, res) => {
  const body = await readBody(req);
  // The moment the operator pressed, in source milliseconds from the take's first
  // frame. Supplied by the caller when it knows - the monitor does, since it is
  // holding the frame - and taken from the take's own elapsed wall clock when it
  // does not. In the body and only in the body: this used to accept a `?sourceMs=`
  // query as well, which was a second way to say one thing and reachable at all only
  // because the route took a GET.
  const sourceMs = Number(body.sourceMs ?? NaN);
  const at = Number.isFinite(sourceMs) ? sourceMs : Date.now() - (recorder.state.startedAt ?? Date.now());
  sendJson(res, recorder.mark(at, body.label));
});

/**
 * The table, as data, for the proof tool to walk.
 *
 * Derived from `ROUTES` itself rather than restated, so there is no second list to
 * fall behind the first - which is the whole reason this exists rather than a
 * comment naming the routes that change something.
 */
function serveRoutes(req, res) {
  sendJson(res, {
    routes: ROUTES.map((r) => ({
      path: r.path,
      read: Boolean(r.read),
      // A route that changes something is a route with a write, and this is that
      // fact rather than a label beside it.
      mutates: Boolean(r.write),
      // And a route that serves what the sensor is seeing right now says so, for the
      // same reason: the origin rule applies to it, and a check that walks this table
      // can then ask every one of them rather than the ones a reviewer thought of.
      live: Boolean(r.live),
      methods: r.write?.methods ?? [],
    })),
  });
}

/**
 * How many times this process has written each store, ever.
 *
 * **Read by the proof tool, and it is a different kind of evidence from the contents.**
 * The route sweep asserts that nothing answering GET changes anything, and it did that
 * by reading the stores either side of the drive - which a handler that writes and then
 * restores inside the same request defeats by construction, because both readings are
 * taken outside it. Putting the bytes back is easy and putting the modification time
 * back is one `utimes` call. A monotonic count of writes is the one quantity a restore
 * cannot undo, so the sweep asserts on this and compares contents as the second opinion.
 *
 * The general form is the mirror of the descriptor rule beside it: there, the resource
 * was true and the bookkeeping lied; here the contents lie and the bookkeeping is the
 * only honest witness. Which one to trust is decided by what the failure can forge.
 */
const serveWriteCounts = (req, res) => sendJson(res, {
  projects: PROJECTS.writes, presets: PRESETS.writes, deliverables: DELIVERABLES.writes, marks: markWriteCount(), jobs: JOBS.writes,
});

// ---- the render queue
//
// The queue is deliberately thin. A job is a record, a worker asks for one, and
// the only judgement in here is which worker may have which job - everything
// about *rendering* lives in the browser and in `server/export.js`, where it
// already was. A second encoder path would be the one thing this design keeps
// rejecting.
/**
 * A job as anybody may read it, which is a job without its lease.
 *
 * **The lease is a capability, and serving it hands it to whoever asks.** It was
 * added so a finish report has to come from the claim that is running the job, and
 * the first version left it in the record these two routes return - so `GET
 * /jobs/<id>`, copy the lease, `POST /jobs/<id>/finish` put a forged outcome on a
 * job somebody else was rendering, and the real worker's report then lost to the
 * terminal-state guard. A secret that is published is not a secret, and the claim
 * response is the one place it belongs because that is the reply to the request
 * that earned it.
 */
const withoutLease = ({ lease, ...job }) => job;
const serveJobs = async (req, res) => sendJson(res, { jobs: (await JOBS.list()).map(withoutLease) });
const serveJob = async (req, res, args) => {
  try {
    sendJson(res, withoutLease(await JOBS.read(args[0])));
  } catch {
    sendJson(res, { error: `no job ${args[0]}` }, 404);
  }
};

const serveJobEnqueue = async (req, res) => {
  try {
    sendJson(res, await JOBS.enqueue(await readBody(req)));
  } catch (err) {
    sendJson(res, { error: err.message }, 400);
  }
};

/**
 * A worker asking for work, and the one place the renderer class is enforced.
 *
 * **An empty queue and a queue this worker may not touch are different answers**,
 * and they are reported as different answers. Collapsing them into "no work" is
 * the silent mismatch the class pinning exists to prevent, wearing an absence
 * instead of a wrong image - the operator would see an idle worker and a queue
 * that never drains, with nothing anywhere saying why.
 */
const serveJobClaim = async (req, res) => {
  try {
    const body = await readBody(req);
    const { job, blocked, queued } = await JOBS.claim({ worker: body.worker ?? null, renderer: body.renderer });
    if (job) {
      sendJson(res, { job, queued });
      return;
    }
    if (blocked.length) {
      console.log(`[jobs] ${blocked.length} queued for another renderer class, none for ${body.renderer}`);
      sendJson(res, {
        job: null,
        queued,
        blocked,
        error: `${blocked.length} job(s) are queued and every one of them is pinned to a different renderer class than ${JSON.stringify(body.renderer)}: `
          + 'this is a scheduling failure rather than an empty queue, because a re-render on a different rasteriser would not reproduce the original',
      }, 409);
      return;
    }
    sendJson(res, { job: null, queued: 0, blocked: [] });
  } catch (err) {
    sendJson(res, { error: err.message }, 400);
  }
};

const serveJobFinish = async (req, res, args) => {
  try {
    const body = await readBody(req);
    sendJson(res, await JOBS.finish(args[0], {
      state: body.state, error: body.error ?? null, output: body.output ?? null,
      frames: body.frames ?? null,
      // The lease the claim handed out. Without it, `POST /jobs/<id>/finish` with
      // `{"state":"done"}` marked a job done that nothing had ever rendered.
      lease: body.lease ?? null,
    }));
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
};

// A worker saying it is still rendering. Cheap on purpose: this is the only thing
// standing between a machine that died and a job nothing can ever reach again.
const serveJobHeartbeat = async (req, res, args) => {
  try {
    const body = await readBody(req);
    sendJson(res, withoutLease(await JOBS.heartbeat(args[0], { lease: body.lease ?? null })));
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
};

const serveJobRequeue = async (req, res, args) => {
  try {
    sendJson(res, await JOBS.requeue(args[0]));
  } catch (err) {
    sendJson(res, { error: err.message }, 404);
  }
};
const serveRemaining = async (req, res) => sendJson(res, await remaining(CAPTURES_DIR, recordingRate()));

/**
 * The downloads currently moving bytes, so a transfer that takes minutes reads as
 * one rather than as a page that has stopped responding.
 *
 * The rate is derived here rather than stored, because the only honest rate is over
 * the whole transfer so far - a rate sampled between two polls of a wifi link swings
 * by a factor of three and reads as a fault.
 */
const serveDownloads = (req, res) => sendJson(res, {
  downloading: [...downloadsInFlight.values()].map((d) => {
    const elapsed = Math.max(1, Date.now() - d.startedAt) / 1000;
    return {
      id: d.id,
      phase: d.phase,
      received: d.received,
      bytes: d.bytes,
      bytesPerSec: d.received / elapsed,
    };
  }),
});
const serveDescriptors = (req, res) => sendJson(res, { open: openCaptureCount(), real: realDescriptorCount() });

/**
 * Whether the sensor is delivering, answered without anything attaching to it.
 *
 * **The point is what it does not cost.** These numbers existed already - the health
 * interval computes them every five seconds and prints one line to a console nobody
 * is reading during a shoot - and the only way to find out whether the sensor was
 * healthy was to open a monitor over the socket. `consumersCostingTheTake` exists
 * because an attached monitor can cost the take frames, so the one instrument for
 * "is this sensor well" made it less well, which is an instrument that changes what
 * it measures. Reading it off HTTP removes the trade entirely.
 *
 * Neither `write` nor `live` in the table, and both absences are decisions. Nothing
 * here changes, so there is no mutation to guard. And this reports numbers *about*
 * the sensor rather than what the sensor is seeing - a frame count is not a picture
 * of the room - so the origin rule that covers `/camera.mjpg` has nothing to bite on.
 *
 * The window is served as its own length and its own frame count rather than only as
 * a rate, because those are the two readings that tell a gap from a slow link: five
 * seconds carrying zero frames and five seconds carrying a hundred and fifty are
 * different facts, and a rate alone reports the first as silence.
 */
const serveSensorHealth = (req, res) => sendJson(res, {
  state: sensorState,
  // The last window that carried frames, which is deliberately older than the window
  // below whenever the sensor has stopped - see the health interval.
  fps: observedFps,
  bytesPerSec: observedBytesPerSec,
  // And the last window that closed, whether or not anything arrived in it.
  window: lastWindow,
  // **Named for what it counts, which is not what a reader of a sensor-health route
  // would assume.** `stats.dropped` is incremented inside `broadcastFrame`, per socket
  // whose send buffer is over the ceiling - so it is monitors failing to keep up with
  // the output, not the sensor failing to deliver. Called `dropped` on this route it
  // reads as sensor loss and is wrong in both directions at once: a node whose sensor is
  // struggling with nobody watching reports zero, because the function returns before
  // this can move when `wss.clients.size` is zero, and one frame that two lagging
  // monitors both missed counts twice. There is no sensor-loss number here to rename it
  // to - the frames that never arrived are absent from `window.frames`, which is the
  // reading that already says so - so the honest move is to stop this one claiming to be
  // one. `dropped` is beside the recorder's own, which counts what the disk refused.
  monitorDropped: droppedTotal,
  // The first spawn is a start rather than a respawn, which is the number somebody
  // reading this is after: on a healthy node it is zero for the life of the process.
  // The restarts somebody asked for come off it for the same reason - a colour toggle
  // stops a healthy grabber, and a flapping count an operator can raise by ticking a
  // checkbox is not a health reading.
  respawns: Math.max(0, grabberSpawns - 1 - grabberRestarts),
  // Beside it rather than folded into it, because the subtraction above would otherwise
  // be lossy in the direction that hides work: a node that has restarted forty times
  // for forty colour toggles and never once for a fault reads zero respawns, and the
  // reading that says why is gone. Two numbers, two questions.
  restarts: grabberRestarts,
});
/**
 * What the recorder is doing, and what the monitors attached to it would cost.
 *
 * The monitor half is here rather than only on the socket because the refusal is an
 * HTTP one: the surface that is about to press record reads this, so the button can
 * say "this take will refuse" before it is pressed instead of after. That is the
 * positive twin of the refusal - a check built only out of 409s would pass against a
 * server that refused everything, and this is the number that says which monitors
 * are the reason.
 */
const serveRecordState = async (req, res) => {
  const costly = consumersCostingTheTake();
  sendJson(res, {
    ...recorder.state,
    // **The linked node's recorder, beside this machine's own.** The gallery polls this
    // route to decide whether the library is worth rereading, and the library it draws
    // spans both machines - so on an editing station with a `--node`, which is the
    // machine the gallery is actually used from, every fact this route reported was
    // about a recorder that station does not have. A take started and finished on the
    // node changed nothing here, and its tile went on refusing Open for as long as the
    // page stayed up. Null on the node itself, which has no `--node` of its own.
    node: node ? await node.recordState() : null,
    storage: await remaining(CAPTURES_DIR, recordingRate()),
    monitors: {
      cap: RECORDING_CAP,
      attached: wss.clients.size,
      // Each one's actual setting, which is what an interleaved measurement segments
      // its windows by. A count alone cannot tell a full-rate monitor from a coarse
      // one, and those are two different arms.
      watching: attachedMonitors().map((m) => ({ divisor: m.divisor, stride: m.stride, loopback: m.loopback })),
      costingTheTake: costly,
      wouldRefuse: costly.length > 0,
    },
    // Beside the monitors rather than inside them, because it is a different kind of
    // consumer reached through a different door - but it is in the same `costly` list
    // above, which is the number the refusal is actually made of.
    webcam: {
      subscribers: webcam.describe(),
      available: webcam.unavailable === null,
      unavailable: webcam.unavailable,
      served: webcam.served,
      dropped: webcam.dropped,
    },
  });
};

async function serveLocalTakes(req, res) {
  const here = await localTakes();
  sendJson(res, { here: HERE_NAME, ...here, storage: await remaining(CAPTURES_DIR, recordingRate()) });
}

/**
 * The HTTP surface, as one table, walked by one dispatcher.
 *
 * **The table is the dispatch, which is what stops it drifting from the behaviour.**
 * The routes used to be a ladder of `if (seg[1] === ...)` with the guard written
 * into whichever branches somebody remembered, and what that produced was six routes
 * that changed something while dispatching on the path alone - `GET /record/stop`
 * ending a shoot, `GET /library/reclaim/:id` destroying the node's copy. Fixing them
 * one at a time would leave the seventh route somebody adds next month outside
 * whatever list was written today.
 *
 * So a route is not a branch, it is an entry: a pattern, a `read` handler for GET
 * and HEAD, and a `write` handler for everything else. **Having a `write` is how a
 * route declares that it changes something**, and the dispatcher below puts every
 * `write` through `requireMutation` - method, origin and content type - in one
 * place. There is no way to add a route that mutates without either registering it
 * as a write, in which case it is guarded, or hiding the mutation inside a `read`,
 * which `library-check` probes for directly by driving every read route and
 * asserting the library did not move.
 *
 * The table is served at `/library/routes` so the check can enumerate rather than
 * name: an arm that lists the six routes a reviewer happened to poke is an arm that
 * tests those six, and an arm that walks this table tests the rule.
 */
const ROUTES = [
  // ---- a capture, read
  { path: '/capture/:id/hello', pattern: /^\/capture\/([^/]+)\/hello$/, read: serveHello },
  { path: '/capture/:id/index', pattern: /^\/capture\/([^/]+)\/index$/, read: serveIndex },
  { path: '/capture/:id/file', pattern: /^\/capture\/([^/]+)\/file$/, read: serveTakeFile },
  { path: '/capture/:id/frame/:n', pattern: /^\/capture\/([^/]+)\/frame\/(\d+)$/, read: serveFrame },
  { path: '/capture/:id/frames/:a-:b', pattern: /^\/capture\/([^/]+)\/frames\/(\d+)-(\d+)$/, read: serveFrameRun },
  { path: '/capture/:id/marks/log', pattern: /^\/capture\/([^/]+)\/marks\/log$/, read: (req, res, args, query) => serveMarks(req, res, args, query, { log: true }) },
  // ---- a capture, written
  { path: '/capture/:id/marks', pattern: /^\/capture\/([^/]+)\/marks$/, read: serveMarks, write: { methods: ['POST'], run: serveMarkWrite } },

  // ---- the library, read
  { path: '/library/takes', pattern: /^\/library\/takes$/, read: serveLocalTakes },
  { path: '/library/all', pattern: /^\/library\/all$/, read: serveLibrary },
  { path: '/library/remaining', pattern: /^\/library\/remaining$/, read: serveRemaining },
  { path: '/library/downloads', pattern: /^\/library\/downloads$/, read: serveDownloads },
  // Read by the proof tool, because the descriptor bound this build introduces has
  // to be measurable rather than asserted in a comment.
  //
  // **Two numbers, and the second one is the point.** `open` is the capture module's
  // own bookkeeping, and the bug that dropped a capture from the map while leaving
  // its descriptor open made that number *fall* while the real count rose - so an
  // arm reading only `open` would have watched a descriptor leak and recorded it as
  // a descriptor being released. `real` is what the kernel says this process holds,
  // which is the quantity the claim is actually about. The general form of that is
  // worth stating once: an assertion about a resource should read the resource, not
  // the bookkeeping that claims to track it.
  { path: '/library/descriptors', pattern: /^\/library\/descriptors$/, read: serveDescriptors },
  { path: '/library/routes', pattern: /^\/library\/routes$/, read: serveRoutes },
  { path: '/library/writes', pattern: /^\/library\/writes$/, read: serveWriteCounts },
  // A frame of a take that is only on the node, fetched through here rather than by
  // the browser reaching across. One origin for the page, and the node stays a
  // machine this server talks to rather than one every browser on the network does -
  // which is also what keeps the decimation decision on the side that knows how the
  // link is behaving.
  { path: '/library/remote-frame/:id/:n', pattern: /^\/library\/remote-frame\/([^/]+)\/([^/]+)$/, read: serveRemoteFrame },

  // ---- the library, written
  { path: '/library/download/:id', pattern: /^\/library\/download\/([^/]+)$/, write: { methods: ['POST'], run: serveDownload } },
  { path: '/library/delete/:id', pattern: /^\/library\/delete\/([^/]+)$/, write: { methods: ['POST'], run: (req, res, args) => serveRemoval(req, res, args, 'delete') } },
  { path: '/library/reclaim/:id', pattern: /^\/library\/reclaim\/([^/]+)$/, write: { methods: ['POST'], run: (req, res, args) => serveRemoval(req, res, args, 'reclaim') } },
  { path: '/library/sync-marks/:id', pattern: /^\/library\/sync-marks\/([^/]+)$/, write: { methods: ['POST'], run: serveMarkSync } },
  { path: '/library/rename/:id', pattern: /^\/library\/rename\/([^/]+)$/, write: { methods: ['POST'], run: serveRename } },
  // Registered as a `write` although no byte of the library moves, because what this
  // table's `write` slot actually declares is "this route makes something happen", and
  // a route that starts a process on the operator's machine is the clearest case of
  // that there is. Registering it as a read to reflect that the captures directory is
  // untouched would put the one process-spawning route in the program outside the
  // origin and content-type gate every other consequence stands behind.
  { path: '/library/reveal/:id', pattern: /^\/library\/reveal\/([^/]+)$/, write: { methods: ['POST'], run: serveReveal } },

  // ---- documents
  { path: '/projects', pattern: /^\/projects\/?$/, read: (req, res) => listDocuments(res, PROJECTS) },
  { path: '/presets', pattern: /^\/presets\/?$/, read: (req, res) => listDocuments(res, PRESETS) },
  {
    path: '/projects/:name',
    pattern: /^\/projects\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, PROJECTS, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args) => writeDocument(req, res, PROJECTS, args[0]) },
  },
  {
    path: '/presets/:name',
    pattern: /^\/presets\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, PRESETS, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args) => writeDocument(req, res, PRESETS, args[0]) },
  },
  { path: '/deliverables', pattern: /^\/deliverables\/?$/, read: (req, res) => listDocuments(res, DELIVERABLES) },
  {
    path: '/deliverables/:name',
    pattern: /^\/deliverables\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, DELIVERABLES, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args) => writeDocument(req, res, DELIVERABLES, args[0]) },
  },

  // ---- the webcam
  //
  // `live` rather than `write`: it changes nothing, so it is not a mutation, but it
  // hands out what the colour camera is seeing this second and the origin rule
  // applies to it for that reason alone. The dispatcher asks the rule of every entry
  // carrying this flag, so the next route that serves live sensor bytes is covered by
  // declaring itself rather than by somebody remembering - the same move the table
  // already made for mutations.
  { path: '/camera.mjpg', pattern: /^\/camera\.mjpg$/, live: true, read: (req, res) => webcam.attach(req, res) },

  // ---- the sensor
  //
  // A namespace of its own rather than a corner of `/library`, because the table's
  // existing first segments each name the subsystem the route reads from - a capture,
  // the library, the recorder, the queue - and this one reads the sensor. An entry
  // and not a branch beside the dispatcher, which is the part that matters: `/library
  // /routes` publishes this table and `library-check` sweeps what it publishes, so a
  // route answering from anywhere else is a route no sweep can see.
  { path: '/sensor/health', pattern: /^\/sensor\/health$/, read: serveSensorHealth },

  // ---- recording
  { path: '/record/state', pattern: /^\/record\/state$/, read: serveRecordState },
  { path: '/record/start', pattern: /^\/record\/start$/, write: { methods: ['POST'], run: serveRecordStart } },
  { path: '/record/stop', pattern: /^\/record\/stop$/, write: { methods: ['POST'], run: serveRecordStop } },
  { path: '/record/mark', pattern: /^\/record\/mark$/, write: { methods: ['POST'], run: serveRecordMark } },

  // ---- the render queue
  { path: '/jobs', pattern: /^\/jobs\/?$/, read: serveJobs, write: { methods: ['POST'], run: serveJobEnqueue } },
  { path: '/jobs/claim', pattern: /^\/jobs\/claim$/, write: { methods: ['POST'], run: serveJobClaim } },
  // The lookahead is why a GET of /jobs/claim answers 405 and not 404. Without it
  // `claim` matches `([^/]+)` and is read as a job id, so a route that exists and
  // takes POST reports itself as a job that does not exist - which is the wrong
  // answer twice over, and the sort of thing the route sweep drives past because
  // 404 looks like a handler having looked.
  { path: '/jobs/:id', pattern: /^\/jobs\/(?!claim$)([^/]+)$/, read: serveJob },
  { path: '/jobs/:id/finish', pattern: /^\/jobs\/([^/]+)\/finish$/, write: { methods: ['POST'], run: serveJobFinish } },
  { path: '/jobs/:id/heartbeat', pattern: /^\/jobs\/([^/]+)\/heartbeat$/, write: { methods: ['POST'], run: serveJobHeartbeat } },
  { path: '/jobs/:id/requeue', pattern: /^\/jobs\/([^/]+)\/requeue$/, write: { methods: ['POST'], run: serveJobRequeue } },
];

// The namespaces the table owns, taken from the table. Every `path` starts with a
// slash and a literal segment, so the first segment is the namespace; anything
// else in the table would be a route with no namespace to own, which is a bug in
// the entry rather than something to tolerate here.
//
// Derived once at module load rather than per request - it cannot change, and a
// `Set` lookup is what the request path pays instead of a regex.
export const OWNED_NAMESPACES = new Set(ROUTES.map((r) => {
  const first = r.path.split('/')[1];
  if (!first || first.startsWith(':')) {
    throw new Error(`route ${r.path} has no namespace segment, so nothing can own it`);
  }
  return first;
}));

/**
 * The pages, and the only URLs they answer at.
 *
 * Deliberately not entries in `ROUTES`. That table is the mutation guard: a route
 * there declares what it changes and `library-check` walks it asserting every
 * `write` checks method, content type and origin. These read a file off disk and
 * change nothing, and putting them in the table would add rows the sweep has to
 * special-case - a guard whose list contains things it does not guard is a guard
 * that teaches people to skim it.
 *
 * The map is the whole story of which URL serves which file, which is what stops a
 * page acquiring a second address. `/record` and `/edit` are one file because the
 * recorder and the editor are one page in two modes; the URL is what tells it which,
 * and `main.js` reads `?take=` to decide.
 */
const PAGES = {
  '/': 'menu.html',
  '/record': 'index.html',
  '/edit': 'index.html',
  '/gallery': 'library.html',
  // The program-out source, which OBS opens as a browser source. The same file as
  // the viewer and the editor for the same reason those two are one file: it is the
  // same renderer drawing the same scene, and a second page would be a second
  // renderer to keep in step with this one. The URL is what tells `main.js` which of
  // the three it is.
  '/program': 'index.html',
};

/**
 * One dispatcher, and the only place a mutating route is let through.
 *
 * Returns false for a path no entry claims, so the static file server downstream
 * still gets its turn. A path that exists but not in this direction - a GET of a
 * write-only route, most of all - answers 405 and names what it does take, without
 * running anything.
 */
async function serveRoute(req, res, urlPath, query) {
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const offered = new Set();
  for (const r of ROUTES) {
    const m = r.pattern.exec(urlPath);
    if (!m) continue;
    const args = m.slice(1).map((a) => decodeURIComponent(a));
    if (reading && r.read) {
      // **The second gate, and it is here for the same reason the first one is.** A
      // route marked `live` serves what the sensor is seeing right now. It mutates
      // nothing, so `requireMutation` is the wrong rule - a GET declares no content
      // type and there is no state to protect - but a page on another origin has no
      // business reading the camera, and the answer to "which page is asking" is the
      // same answer the mutating routes already get. Asked from the dispatcher rather
      // than inside the handler, so a live route added later is guarded by declaring
      // itself; `guard-check` walks the table and asks every entry carrying the flag.
      if (r.live && !originAllowed(req)) {
        sendJson(res, {
          error: `${req.headers.origin} is not this server, and this route serves what the sensor is seeing`,
        }, 403);
        return true;
      }
      await r.read(req, res, args, query);
      return true;
    }
    if (!reading && r.write) {
      // The one gate, applied here rather than inside ten handlers. A route reaches
      // its handler only by having a `write`, and a `write` reaches its handler only
      // through this line.
      if (!requireMutation(req, res, r.write.methods)) return true;
      await r.write.run(req, res, args, query);
      return true;
    }
    if (r.read) offered.add('GET');
    for (const method of r.write?.methods ?? []) offered.add(method);
  }
  if (offered.size === 0) return false;
  res.setHeader('Allow', [...offered].join(', '));
  sendJson(res, {
    error: `${req.method} is not how ${urlPath} is called: it takes ${[...offered].join(' or ')}`,
  }, 405);
  return true;
}



const httpServer = createServer((req, res) => {
  let urlPath;
  let query;
  try {
    const url = new URL(req.url, 'http://localhost');
    urlPath = decodeURIComponent(url.pathname);
    query = url.searchParams;
  } catch {
    // A malformed percent escape such as /%zz throws here, and an exception
    // thrown out of this handler ends the process - taking replay, the socket
    // fan-out and the viewer with it over a request nobody meant.
    res.writeHead(400).end('bad request');
    return;
  }

  // The table first, the file tree second. `serveRoute` answers false only for a
  // path no entry claims at all, which is what leaves the viewer, three and the
  // exports directory reachable below.
  let handledByTable = true;
  try {
    handledByTable = ROUTES.some((r) => r.pattern.test(urlPath));
  } catch {
    handledByTable = false;
  }
  if (handledByTable) {
    serveRoute(req, res, urlPath, query)
      .then((handled) => {
        if (!handled) res.writeHead(404).end('not found');
      })
      .catch((err) => {
        console.error('[server] request failed:', err.message);
        if (!res.headersSent) sendJson(res, { error: err.message }, 500);
        else res.end();
      });
    return;
  }

  // A page is reached at the URL it is named by, and `PAGES` is asked before the
  // owned-namespace refusal below because `/record` collides with the recorder's
  // namespace. Every route the table holds under `record` is anchored on a second
  // segment, so bare `/record` matches nothing and falls through - straight into a
  // check that owns the word and would 404 the recording page before the file tree
  // got a turn. Asked after the table's own dispatch rather than before it, so a
  // real route still wins over a page name if the two ever meet.
  const page = PAGES[urlPath];
  if (!page && OWNED_NAMESPACES.has(urlPath.split('/')[1])) {
    // A path under a namespace the table owns but matching no entry is a 404 rather
    // than a file lookup: without this `/library/../web/main.js` and friends would
    // fall through to the static server, and more plainly a typo'd route would answer
    // with a directory listing's 404 instead of the API's.
    //
    // The set is derived from ROUTES rather than written out, because the five names
    // it used to spell were a list somebody had to remember to extend. `jobs` is what
    // made that concrete: step 8 adds a namespace, and a literal that did not mention
    // it sends `/jobs/../web/main.js` to the static server while every other namespace
    // gets the API's 404. Fixing the instance would have left the next one outside the
    // list, which is the failure this repo already closed once for the route table's
    // own dispatch - so the namespaces are the table's first segments, and a route
    // added later is covered by existing rather than by being noticed.
    res.writeHead(404).end('not found');
    return;
  }

  let filePath;
  if (page) {
    filePath = join(WEB_DIR, page);
  } else if (urlPath.startsWith('/vendor/three/')) {
    filePath = join(THREE_DIR, urlPath.slice('/vendor/three/'.length));
  } else if (urlPath.startsWith('/exports/')) {
    // Served so a finished export can be played back where it was made, in the
    // browser, rather than only inspected with a probe. A video that decodes is
    // the last thing an export has to prove and the only one a metadata check
    // cannot make.
    filePath = join(EXPORTS_DIR, urlPath.slice('/exports/'.length));
  } else {
    // A page under `web/` has exactly one URL and it is the one in `PAGES`, so its
    // filename is not a second way in. Refused as a class rather than by naming
    // `/library.html`, because the instance fix is the shape this repo keeps having
    // to undo - the next page somebody adds would arrive with its filename reachable
    // again unless the rule is about the extension rather than about a file.
    //
    // **Lowercased, because APFS is case-insensitive and `extname` is not.** With a
    // bare `=== '.html'` comparison `/LIBRARY.HTML` falls past this, `statSync`
    // happily finds the file anyway and the gallery has a second address after all -
    // measured at 200 on this machine before the fold was added. It sits inside this
    // branch rather than above the three/exports ones so the rule stays about pages:
    // `node_modules/three` ships no HTML today, and a version bump that brought its
    // examples in should not have them refused by a rule about `web/`.
    if (extname(urlPath).toLowerCase() === '.html') {
      res.writeHead(404).end('not found');
      return;
    }
    filePath = join(WEB_DIR, urlPath);
  }

  // **Resolved through the filesystem and not only through the string.** `normalize`
  // folds `..` lexically, which is the whole of the containment argument, while
  // `statSync` and `createReadStream` two lines down follow symlinks - so a link
  // inside `web/` pointing anywhere at all passed a comparison about where its name
  // is and was then served from where it actually is. Defence in depth rather than a
  // hole being closed: nothing in this tree creates such a link, and that is a fact
  // about today's tree rather than a property of the check. A path with nothing at it
  // throws here and is the same 404 the stat below would have given.
  let resolved;
  try {
    resolved = realpathSync(normalize(filePath));
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  if (![WEB_DIR, THREE_DIR, EXPORTS_DIR].map(realOrLexical).some((root) => isInside(root, resolved))) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    // `pipeline` rather than `pipe`, for both of the reasons `serveFrameRun` gives
    // and one this path has to itself. A bare pipe unpipes when the client walks away
    // and never destroys the file stream, so an aborted page load leaks the
    // descriptor - and this is the handler every asset of every page goes through. It
    // also leaves a read error as an unhandled `error` event, which ends the process:
    // a file removed between the stat above and the first read is enough, and it
    // would take the replay, the socket fan-out and the recorder with it.
    pipeline(createReadStream(resolved), res, (err) => {
      if (err) console.error(`[server] serving ${urlPath} failed: ${err.message}`);
    });
  } catch {
    res.writeHead(404).end('not found');
  }
});

// Two sockets on one port, routed here rather than by handing each server the
// http server. `ws` aborts an upgrade whose path it does not recognise, so two
// servers attached that way would each destroy the other's handshakes - the
// second one to see the event would 400 a socket the first had already taken.
const wss = new WebSocketServer({ noServer: true });
// Compression off, said rather than inherited: an export is raw RGBA over
// loopback precisely so no CPU is spent on bytes that were never scarce, and a
// deflate negotiated by default would undo that decision silently.
const exportWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });

httpServer.on('upgrade', (req, socket, head) => {
  // The same origin rule the mutating routes stand behind, asked here because a
  // socket is the one door it did not cover. `WebSocket` is exempt from the
  // same-origin policy and sends no preflight, so any page anywhere could open one
  // against a node on the visitor's own network and drive it - and this socket is
  // not a read-only view: it carries the recorder's arm, start and stop. The
  // content-type and method halves of `requireMutation` are meaningless for an
  // upgrade, which is why `originAllowed` is exported without a `res` to write to.
  //
  // Asked before the path is routed, so a page from somewhere else gets one answer
  // rather than learning which paths exist by how they are refused.
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  let path;
  try {
    path = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  const target = path === '/export' ? exportWss : path === '/' ? wss : null;
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

exportWss.on('connection', (ws) => {
  console.log('[export] client connected');
  ws.on('error', (err) => console.error('[export] socket error:', err.message));
  handleExportSocket(ws, { outDir: EXPORTS_DIR });
});

let helloJson = null;
const stats = { frames: 0, dropped: 0, bytes: 0, since: Date.now() };
// The measured byte rate of what is actually arriving, which is what the
// remaining-time report should divide free space by. Falls back to the nominal
// 486KB at 30fps before anything has arrived, because an operator opening the
// library on a cold server still needs a number.
let observedBytesPerSec = 0;
const recordingRate = () => (observedBytesPerSec > 0 ? observedBytesPerSec : undefined);
// The frame rate over the same window, kept beside the byte rate rather than derived
// from it. A frame rate recovered by dividing bytes by a nominal frame size would be
// an estimate wearing a measurement's clothes, and the two quantities move apart for
// real reasons - a link delivering half the frames at full size and one delivering
// every frame at half size are the same MB/s and different faults.
let observedFps = 0;

// The window that closed last, empty ones included, and it is deliberately not the
// same age as the two rates above. A window with no frames in it has no rate to
// report, so the rates keep the last honest measurement across a gap - but the
// window's own length and frame count are exactly what says the sensor stopped
// delivering, and they would say nothing if they were held back with the rates.
let lastWindow = null;

// Every frame the broadcast has dropped since this process started. Accumulated as
// each window closes rather than counted in `broadcastFrame`, so the hot path is
// untouched, and monotonic because the per-window count is zeroed every five seconds
// - a number that resets cannot answer "has this link been dropping frames".
let droppedTotal = 0;

// How many grabbers this process has started. Kept at module scope because the
// supervisor's own `attempt` cannot answer the question this one is for: `attempt` is
// an index into the backoff's delay table and is deliberately zeroed on a clean
// handshake and on a colour toggle, so it says how long until the next try and
// nothing at all about how many times the sensor has already dropped. Two numbers
// because they are two questions, not one number written down twice.
let grabberSpawns = 0;

// And how many of those starts somebody asked for. A colour toggle stops a perfectly
// healthy grabber and spawns another, which is a configuration change rather than a
// sensor fault - so counting it with the rest turns "this node is flapping" into a
// number an operator produces by ticking a checkbox, and the endpoint's own claim that
// a healthy node reads zero stops being true. Counted where the exit is *consumed*
// rather than where the restart is armed: `restarting` can be set and never read - the
// exit handler's comment carries the window that does it - and an arm that never
// becomes a spawn would subtract a respawn that did happen, which is the wrong
// direction to be wrong in.
let grabberRestarts = 0;

let sensorState = 'starting';

function broadcastText(text) {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(text);
}

function setSensorState(state) {
  sensorState = state;
  broadcastText(JSON.stringify({ status: state }));
  // The webcam cannot outlive the sensor being live, and hanging it off the state
  // change rather than off each of the paths that cause one is what keeps a route
  // added later from missing a case. Only revoked here - a hello is what restores it.
  if (state !== 'live') webcam.setUnavailable(`the sensor is ${state}`);
}

// Live camera settings the viewer can change. Colour on/off has to restart the
// grabber because it decides which streams the device is told to open at all;
// low light is a command the running grabber applies in place.
const camera = { color: !NO_COLOR, lowLight: true };
let applyCamera = null; // wired up by startLive; absent in replay

/**
 * What each monitor asked for, and whether its frames cross a network to reach it.
 *
 * Held beside the socket rather than on it, so nothing about a client's settings
 * survives the socket it was negotiated on - a reconnecting browser gets the
 * default and has to ask again, which is the honest behaviour for a setting whose
 * whole purpose is to describe a link that may have changed.
 */
const monitors = new WeakMap();

// Whether this socket's frames leave the machine. `remoteAddress` is the peer as the
// kernel sees it, so it cannot be spoofed by anything the client sends - which
// matters, because this decides whether the record refusal applies.
//
// **What it answers is "this connection arrived on loopback", which is not the same
// sentence as "this browser is on this machine", and the difference is a deployment
// this project recommends.** `SECURITY.md` tells an operator crossing an untrusted
// network to use an SSH tunnel or WireGuard with the server still bound to loopback on
// the far side - and a forwarded port terminates on this host, so the request genuinely
// arrives from `127.0.0.1` while the person is somewhere else entirely. Every caller
// below therefore reads as slightly stronger than it is: a tunnelled browser is treated
// as local, gets the full monitor rate, and can open a Finder window on a machine
// nobody is standing at.
//
// That is the recommended setup working rather than a hole in it. The operator who
// builds the tunnel is the party the gate exists to identify, and they have
// authenticated to the host to build it - which is more than this program asks of a
// genuinely local browser, since it asks nothing. So the gate is left alone and the
// claim is corrected instead: **loopback here means the connection, and the operator
// decides who reaches loopback.** Anything stronger needs a credential, and this
// program deliberately has none - see `SECURITY.md` for that decision and its cost.
const isLoopback = (req) => {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

/**
 * A whole number in range, or null for anything else.
 *
 * Null rather than a clamp, because a monitor that asked for 64 and silently got 16
 * is a monitor whose displayed setting is not the setting - and the one property
 * this negotiation has to hold is that what is on screen is what is on the wire.
 */
const whole = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);

wss.on('connection', (ws, req) => {
  ws.binaryType = 'nodebuffer';
  // A loopback socket is trusted and starts at full rate: its frames never cross the
  // link the cap is about. A remote socket starts ineligible for binary frames until
  // it explicitly requests a grant, and while a take is active its ordinary initial
  // grant is the recording cap or coarser. Finer requests are refused unless the
  // client explicitly accepts the cost, and they are never silently clamped.
  const loopback = isLoopback(req);
  monitors.set(ws, loopback
    ? { divisor: 1, stride: 1, loopback: true, granted: true }
    : { divisor: RECORDING_CAP.divisor, stride: RECORDING_CAP.stride, loopback: false, granted: false });
  console.log(`[server] client connected (${wss.clients.size} total)`);
  if (helloJson) ws.send(helloJson);
  ws.send(JSON.stringify({ status: sensorState }));
  ws.send(JSON.stringify({ camera }));
  sendMonitor(ws);
  ws.on('error', (err) => console.error('[server] socket error:', err.message));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return; // a client sending junk is not the server's problem
    }
    if (!msg) return;

    // The monitor's own settings. Answered on every attempt, accepted or not, so the
    // client renders what it was granted rather than what it hoped for - a client
    // that assumed its request took effect would draw a `÷4` label over a full-rate
    // stream, which is the misattribution this whole negotiation exists to avoid.
    if (typeof msg.monitor === 'object' && msg.monitor) {
      const m = monitors.get(ws);
      if (!m) return;
      const wantDivisor = whole(msg.monitor.divisor, MAX_DIVISOR);
      const wantStride = whole(msg.monitor.stride, MAX_STRIDE);
      const bad = [];
      if (msg.monitor.divisor !== undefined && wantDivisor === null) {
        bad.push(`divisor must be a whole number from 1 to ${MAX_DIVISOR}`);
      }
      if (msg.monitor.stride !== undefined && wantStride === null) {
        bad.push(`stride must be a whole number from 1 to ${MAX_STRIDE}`);
      }
      if (bad.length) {
        sendMonitor(ws, bad.join('; '));
        return;
      }
      const nextDivisor = wantDivisor !== null ? wantDivisor : m.divisor;
      const nextStride = wantStride !== null ? wantStride : m.stride;
      // A request that would cost the take is granted only if the client explicitly
      // says so. If this monitor is already serving, a refused request leaves the
      // existing grant untouched; if it is not yet granted, the requested setting is
      // stored so the client can accept it with a later acceptMonitorCost.
      const wouldCost = !m.loopback && (nextDivisor < RECORDING_CAP.divisor || nextStride < RECORDING_CAP.stride);
      if (wouldCost && msg.monitor.acceptMonitorCost !== true) {
        if (!m.granted) {
          m.divisor = nextDivisor;
          m.stride = nextStride;
        }
        sendMonitor(ws, 'that setting would cost the take; send acceptMonitorCost: true to allow it');
        return;
      }
      m.divisor = nextDivisor;
      m.stride = nextStride;
      m.granted = true;
      sendMonitor(ws);
      return;
    }

    // What the operator's surface is telling the program-out source to draw: which
    // camera, what size, and every parameter write as it happens.
    //
    // **Relayed rather than interpreted.** The server has no opinion about what a
    // parameter means and must not acquire one - `web/main.js`'s registry is the only
    // thing that knows a parameter's range, its kind and what applying it does, and a
    // second copy of any of that here would be the drift the registry exists to
    // prevent. So this forwards the message to every other client and reads nothing
    // out of it, which also means a parameter added to the registry next year reaches
    // the program-out page without this line changing.
    //
    // To others only, never back to the sender: a surface that received its own
    // writes would apply each one twice, and in mirror mode that is a camera pose
    // fighting the hand that is dragging it.
    if (typeof msg.programOut === 'object' && msg.programOut) {
      const text = raw.toString('utf8');
      for (const other of wss.clients) {
        if (other !== ws && other.readyState === other.OPEN) other.send(text);
      }
      return;
    }

    if (typeof msg.camera !== 'object' || !msg.camera) return;
    if (!applyCamera) return;

    const next = {
      color: typeof msg.camera.color === 'boolean' ? msg.camera.color : camera.color,
      lowLight: typeof msg.camera.lowLight === 'boolean' ? msg.camera.lowLight : camera.lowLight,
    };
    applyCamera(next);
  });
});

/**
 * The setting this monitor is actually being served at, plus what it would cost a
 * take if one started now.
 *
 * `wouldRefuseRecording` is the positive half of the refusal: the record button can
 * say so before it is pressed, rather than the operator discovering it from a 409 in
 * the one second they were trying to start a shot.
 */
function sendMonitor(ws, refused = null) {
  const m = monitors.get(ws);
  if (!m || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    monitor: {
      divisor: m.divisor,
      stride: m.stride,
      granted: m.granted,
      loopback: m.loopback,
      cap: RECORDING_CAP,
      wouldRefuseRecording: costsTheTake(m),
      maxDivisor: MAX_DIVISOR,
      maxStride: MAX_STRIDE,
      ...(refused ? { refused } : {}),
    },
  }));
}

// A monitor costs the take when its frames cross the link, it has been granted, and
// it is asking for more of them than the cap allows. All three terms matter: a
// remote monitor that has not negotiated a grant is not yet on the wire, finer than
// the cap on loopback is free, and a remote monitor at or past the cap is what the
// cap is for.
const costsTheTake = (m) => !m.loopback && m.granted && (m.divisor < RECORDING_CAP.divisor || m.stride < RECORDING_CAP.stride);

// Which frame this is, for the stride. Counted over every frame the grabber
// delivered rather than per client, so two monitors at the same stride land on the
// same frames and the second one costs no extra bytes on a shared link.
let frameSeq = 0;

function broadcastFrame(payload) {
  frameSeq++;
  // `stats` is what the library divides free space by to report remaining time, so it
  // counts the frame that arrived and never the frame that went out. A monitor at ÷4
  // does not make the take smaller, and a remaining-time readout that thought so
  // would promise an hour of card that does not exist.
  stats.frames++;
  stats.bytes += payload.length;

  // The common case on a capture node mid-shoot is nobody watching, and it costs
  // nothing here rather than a map allocation per frame.
  if (wss.clients.size === 0) return;

  // Sampled at most once per divisor per frame, and only for a divisor somebody
  // actually asked for. Two monitors at ÷4 pay for one decimation; a monitor at ÷1
  // pays for none, since the payload it wants is the one already in hand.
  const byDivisor = new Map([[1, payload]]);

  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const m = monitors.get(ws);
    if (!m || !m.granted) continue;
    // Strided out, which is not the same as dropped and is not counted as one. A
    // dropped frame is a monitor that could not keep up; this is a monitor that asked
    // not to be sent it.
    if (frameSeq % m.stride !== 0) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      stats.dropped++;
      continue;
    }
    let out = byDivisor.get(m.divisor);
    if (out === undefined) {
      try {
        out = decimatePayload(payload, m.divisor, `frame ${frameSeq}`);
      } catch (err) {
        // A frame whose declared lengths do not describe it is refused rather than
        // sampled past, and one bad frame must not take the fan-out down with it -
        // the same reading the frame API takes, on the same function.
        console.error(`[server] cannot decimate for a monitor at divisor ${m.divisor}: ${err.message}`);
        out = null;
      }
      byDivisor.set(m.divisor, out);
    }
    if (out) ws.send(out);
  }
}

// Asks the grabber to start or stop encoding the colour camera. Wired up by
// `startLive` and absent in replay, for the same reason `applyCamera` is: a capture
// on a loop has no colour camera to turn on, and the webcam says so rather than
// serving frames from a recording as though they were live.
let requestHdColor = null;

// The webcam output. Created out here beside the recorder rather than inside
// `startLive`, because the route above has to answer on a machine where no grabber
// ever starts - an editing station with nothing plugged in should say why the camera
// is unavailable, not 404 as though the feature did not exist.
const webcam = new Webcam({
  request: (wanted) => requestHdColor?.(wanted),
});
if (REPLAY) {
  webcam.setUnavailable(`this server is replaying ${basename(REPLAY)}, so there is no colour camera to serve`);
}

// One take is one file, and the recorder is what holds that identity. It is
// created here rather than inside `startLive` because the HTTP routes above have
// to be able to reach it whether or not a sensor ever appears - a library on a
// machine with nothing plugged in still answers what it is recording, which is
// nothing.
const recorder = new Recorder({
  dir: CAPTURES_DIR,
  // A replay server cannot record, and refusing is the answer rather than making it
  // work. Its frames come off a file on a loop, so their stamps repeat - and one
  // take is one continuous stream with monotonic stamps, which the index, the retime
  // curve and `mixT` all rest on. What it would produce is a near-copy of a take
  // that already exists under a different name and a different hash, which is the
  // ambiguity that reconciling by content hash exists to remove. The record button
  // on the viewer disables itself off this, because it is unconditional otherwise
  // and this is one click away in the setup this repo documents.
  // Two ways to have nothing worth recording, and the second one is why this is a
  // function. A machine with no sensor is not a configuration, it is a discovery -
  // the editing station the library is documented to run on looks identical to a
  // capture node until a grabber has failed to find a device a few times over.
  cannotRecord: () => (REPLAY
    ? `this server is replaying ${basename(REPLAY)} rather than reading a sensor, and a replay loops `
      + '- its frames repeat their own timestamps, so what it wrote would not be a take'
    : sensorState === 'absent'
      ? 'no Kinect v2 on this machine, so there is nothing here to record - this is the editing '
        + 'side of the link, and takes are shot on the node'
      : null),
  // The rate the library reports, so the refusal to start a take and the
  // remaining-time readout beside it are dividing free space by the same number.
  rateOf: () => recordingRate(),
  // Every monitor sees the recording state change, which is the property the spec
  // asks record control for. The control itself arrives over HTTP; the state comes
  // back on the socket every client is already listening to.
  onChange: (state) => broadcastText(JSON.stringify({ recording: state })),
});

function handleMessage(msg) {
  if (msg.type === TYPE_HELLO) {
    helloJson = msg.payload.toString('utf8');
    console.log(`[server] sensor: ${helloJson}`);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(helloJson);
    // A take begins at a hello and nowhere else. That is what makes a restart
    // split rather than corrupt: the file that was open is already closed by the
    // time this runs, and this opens the next one.
    recorder.onHello(helloJson);
  } else if (msg.type === TYPE_FRAME) {
    // Broadcast first, then record. Both happen in this same turn either way, so
    // nothing is lost by the order - what it decides is which one a failure in the
    // other can take down. A monitor that goes dark reads as a dead sensor and sends
    // somebody to check the hardware mid-shoot, where a recorder problem already has
    // its own state, its own log line and its own place on the surface.
    broadcastFrame(msg.payload);
    // The whole message rather than the payload, so the take file carries the
    // framing the format is defined by and the recorded bytes stay identical to
    // what the grabber wrote. Every caller supplies it; the replay loop did not, and
    // one open take then turned every frame into a throw that landed in the replay
    // tick's catch - no frame reached any client, the status flapped between lost
    // and live, and `/record/state` reported a healthy recording the whole time.
    recorder.write(msg.raw);
  } else if (msg.type === TYPE_COLOR) {
    // **The webcam and nothing else. There is deliberately no `recorder.write` on
    // this branch.**
    //
    // A capture file is the wire verbatim, so a type 3 landing in one would change
    // what a `.knct` file contains - and the content hash of every take with it,
    // which is the key `library.js` joins two machines on. `capture.js`'s sidecar
    // index and frame API both walk the file assuming types 1 and 2, so a third would
    // have to be skipped correctly at both ends including for takes written before
    // today. None of that is hard and none of it has been decided, so the live-only
    // rule holds until it is: issue #9 carries what recording it would take.
    //
    // This is the `nearClip` versus `--min-depth` failure class - footage changed in
    // the one situation nobody is watching for it - so it is not left to this comment.
    // `vcam-check --mutate hd-reaches-recorder` adds the write back and has to fail.
    //
    // The payload is [u64 timestampMs][JPEG], and the JPEG goes out untouched.
    webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));
  }
}

setInterval(() => {
  // **The window closes before anything decides whether it was interesting**, and
  // that ordering is the whole of this. The reset used to sit past the early return,
  // so a five-second window in which no frame arrived was never closed at all and
  // `stats.since` carried its old value across the gap. After a sixty-second USB drop
  // the next window's frames were divided by sixty-five seconds - about a thirteenth
  // of the true rate, into the log and into `observedBytesPerSec`, which the
  // remaining-time readout divides free space by. An operator was then promised card
  // space that does not exist at the rate the sensor is actually writing.
  //
  // **Resetting `dropped` alongside the other three is safe by construction.**
  // `stats.dropped++` only ever runs inside `broadcastFrame`, on a path that has
  // already run `stats.frames++` for the same frame, so a window that ends with
  // `frames` at zero cannot have a drop in it to lose.
  const closed = { ms: Date.now() - stats.since, frames: stats.frames, dropped: stats.dropped, bytes: stats.bytes };
  Object.assign(stats, { frames: 0, dropped: 0, bytes: 0, since: Date.now() });
  lastWindow = { ms: closed.ms, frames: closed.frames };
  droppedTotal += closed.dropped;
  // **And what stays behind the return is the derived rate, deliberately left stale.**
  // A window that carried no frames has no rate in it, and computing one anyway would
  // replace the last honest measurement with a number over a window that never
  // happened. The length and the frame count above are what say the gap occurred; the
  // rates say what delivery looked like when there last was any.
  if (closed.frames === 0) return;
  const dt = closed.ms / 1000;
  const fps = (closed.frames / dt).toFixed(1);
  const mbs = (closed.bytes / dt / 1e6).toFixed(1);
  observedBytesPerSec = closed.bytes / dt;
  observedFps = closed.frames / dt;
  console.log(`[server] ${fps} fps  ${mbs} MB/s  dropped=${closed.dropped}  clients=${wss.clients.size}`);
}, 5000);

// The Kinect v2 drops off the bus under sustained load on a marginal USB link,
// so a dead grabber is an expected condition, not a fatal one. Respawn it.
const RESTART_DELAYS = [1000, 2000, 4000, 8000];

// How long to leave between attempts once the conclusion is that there is no sensor
// on this machine at all. Long, because the enumeration is never going to find one
// and the grabber's own stderr goes straight to this console - but not never, so a
// sensor plugged in later is picked up without anyone restarting the server.
const ABSENT_DELAY = 30000;

function startLive() {
  const bin = GRABBER_BIN ? resolve(GRABBER_BIN) : join(ROOT, 'native/build/grabber');
  const buildArgs = () => {
    const a = [...GRABBER_ARGS, ...(PIPELINE ? ['--pipeline', PIPELINE] : [])];
    if (!camera.color) a.push('--no-color');
    if (!camera.lowLight) a.push('--no-low-light');
    return a;
  };

  let child = null;
  let attempt = 0;
  let shuttingDown = false;
  let restarting = false;
  // Whether a sensor has ever handshaken with this process. Monotonic on purpose:
  // it separates "the link dropped" from "there is nothing plugged in here", which
  // are the same event at the exit handler and want opposite answers.
  let everLive = false;

  // How long a grabber gets to shut down cleanly before it is taken out, and how
  // long to wait afterwards before spawning its replacement. A killed grabber never
  // ran libfreenect2's teardown, so the kernel is still reclaiming the USB device
  // for a moment after the process is gone and an immediate respawn loses the race -
  // measured, as an enumeration failure and a `code=1` exit on the first attempt of
  // every toggle. The backoff recovers from it either way; the delay is so the log
  // stops carrying a failure on the ordinary path, because a log that cries wolf on
  // every colour toggle is one nobody reads during a shoot.
  const STOP_GRACE_MS = 2000;
  const RESPAWN_AFTER_KILL_MS = 1500;
  const RESPAWN_AFTER_CLEAN_MS = 250;
  let killedHard = false;

  /**
   * Ask the grabber to stop, and make sure it actually does.
   *
   * SIGTERM alone is not enough, and the failure is silent in the worst way: the
   * grabber handles the signal and leaves its loop, then blocks in libfreenect2's
   * `dev->stop()` with USB transfers still in flight and never exits. Every restart
   * runs through the `exit` handler, so a child that never exits means the respawn
   * never happens - the stream simply stops, the server stays up answering requests,
   * and nothing anywhere says why. Observed live: toggling the colour camera off left
   * the grabber sleeping for eight minutes with no frames and no `[grabber] stopped`
   * line, and only a SIGKILL from outside brought the sensor back.
   *
   * So the supervisor stops trusting the child to die. The grace period is for the
   * ordinary case, where a clean stop releases the device properly; past it, the
   * device is reclaimed by the kernel when the process goes, which is the same place
   * a crash would have left it and is recoverable either way. A shoot that has lost
   * its picture is not.
   */
  const stopGrabber = ({ holdProcessOpen = false } = {}) => {
    const dying = child;
    if (!dying) return;
    dying.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (dying.exitCode === null && dying.signalCode === null) {
        console.error('[server] grabber did not stop in time - killing it');
        killedHard = true;
        dying.kill('SIGKILL');
      }
    }, STOP_GRACE_MS);
    // On a restart the grace period must not be a reason for the process to stay up,
    // so it is unreferenced. On the way out it is the opposite: the grabber never
    // exits on its own here, so an unreferenced timer means node leaves before the
    // kill ever fires and the sensor stays claimed by a process with no parent. That
    // orphan then fails the *next* server's enumeration, which reads as a broken
    // Kinect rather than as an unclean shutdown - measured, by SIGINTing the server
    // and finding the grabber still alive with the server gone.
    if (!holdProcessOpen) timer.unref?.();
    dying.once('exit', () => clearTimeout(timer));
  };

  // The backoff itself, reached from the two ways a grabber can fail to be running: it
  // exited, or it never started. Both want the same answer - spend the short table
  // first in case this is a sensor that is merely slow to enumerate at boot, then
  // conclude the machine has none and look again rarely - and both used to be written
  // out only once, in the exit handler, which is why the second way had no backoff at
  // all. One implementation, so a change to the table cannot reach one caller and miss
  // the other.
  const scheduleRetry = () => {
    // A grabber that has *never* handshaken is not the flaky USB link this backoff
    // was written for - it is a machine with no sensor on it, which is exactly what
    // the editing station running this same library is. Told apart, because the two
    // want opposite answers: a sensor that worked and dropped keeps the short
    // backoff, since that is the bus drop the design expects to ride out, while one
    // that has never appeared is reported absent so `/record/state` stops claiming a
    // take could start here and the record button says why. The full backoff table
    // is spent first rather than concluding on the first exit, because a node whose
    // sensor is slow to enumerate at boot is the same shape for the first few
    // seconds and must not be written off as an editing machine.
    const absent = !everLive && attempt >= RESTART_DELAYS.length;
    setSensorState(absent ? 'absent' : 'lost');
    const delay = absent ? ABSENT_DELAY : RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)];
    attempt++;
    // Once absent, said once. The alternative is this line and libfreenect2's
    // enumeration every few seconds for as long as the editing station is up.
    if (!absent) console.log(`[server] restarting grabber in ${delay}ms (attempt ${attempt})`);
    else if (attempt === RESTART_DELAYS.length + 1) {
      console.log(`[server] no sensor found in ${attempt} attempts - looking again every ${ABSENT_DELAY / 1000}s`);
    }
    setTimeout(spawnGrabber, delay);
  };

  const spawnGrabber = () => {
    // Counted here rather than in the backoff, because every road to a running
    // grabber ends at this function - the exit handler's retry, the colour toggle's
    // restart, and the boot - so a path added later is counted by going through it
    // rather than by somebody remembering to add a line to it.
    grabberSpawns++;
    const grabberArgs = buildArgs();
    console.log(`[server] starting grabber: ${bin} ${grabberArgs.join(' ')}`);
    setSensorState('starting');

    const parser = new MessageParser();
    // stdin is a pipe so settings that do not need a restart can be sent to the
    // running grabber instead of costing a multi-second device reopen.
    const proc = spawn(bin, grabberArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    child = proc;
    child.stdin.on('error', () => { /* the grabber can exit mid-write */ });
    // A grabber that cannot be spawned at all - not built here, or built for
    // another architecture - arrives as an `error` event rather than an exit, and
    // an unhandled one on a ChildProcess takes the whole process down: listener,
    // library routes and every connected socket with it. The design already calls a
    // dead grabber an expected condition and backs off; a missing one is the same
    // condition arriving earlier, and it must not be the one shape that is fatal.
    // Surfaced by running this server on a machine with no sensor at all, which is
    // exactly what a library on an editing machine is.
    //
    // **And backing off is the whole of it, which this handler did not do for its
    // first life.** It logged and returned, while every retry in this file hangs off
    // `exit` - an event a failed spawn never emits, since there is no process to exit.
    // So the promise `ABSENT_DELAY` is written to keep, that a sensor appearing later
    // is picked up without anyone restarting the server, silently did not hold when
    // what appeared later was the *binary*: one line in the log at boot and then
    // nothing for the life of the process. Measured on a fresh worktree, where
    // `native/build/grabber` does not exist until it is built - the server was started
    // first, the grabber was built underneath it, and thirty-six seconds of sampling
    // caught no spawn at all because the timer had never been armed.
    //
    // Routed through the same `scheduleRetry` the exit path uses rather than a second
    // timer of its own, so a missing binary and a dropped USB link converge on one
    // backoff, one absent conclusion and one log line.
    child.on('error', (err) => {
      console.error(`[server] grabber could not start: ${err.message}`);
      if (shuttingDown) return;
      // **Only when no process was ever created.** `error` is not exclusively a spawn
      // failure - it also fires when a signal cannot be delivered to a grabber that is
      // running perfectly well - and in that case `exit` follows and schedules the
      // retry itself. Scheduling here as well would put two grabbers on a device that
      // admits one, which is the failure this whole file is arranged around and which
      // arrives as an enumeration error in the loser rather than as anything naming a
      // double spawn. `pid` is undefined only for a process that never started, so it
      // is the question actually being asked; `proc` rather than `child` because a
      // later spawn may already have reassigned it by the time this runs.
      if (proc.pid !== undefined) return;
      // Nothing to signal and no stdin to write to, so it must not look live to the
      // colour toggle or to `stopGrabber` - the latter would otherwise kill a pid that
      // does not exist and then wait out its grace period for an exit that cannot come.
      if (child === proc) child = null;
      scheduleRetry();
    });

    child.stdout.on('data', (chunk) => {
      try {
        for (const msg of parser.push(chunk)) {
          handleMessage(msg);
          if (msg.type === TYPE_HELLO) {
            attempt = 0; // a clean handshake means the link is healthy again
            everLive = true;
            setSensorState('live');
            // **A new grabber has never heard of the subscriber that is still
            // attached.** Its encoder starts off, so without this the webcam comes
            // back from a colour toggle or a USB drop as a socket that is open,
            // subscribed and permanently silent - and everything on both ends looks
            // connected while it happens.
            //
            // This is also the one place the webcam becomes available at all: a
            // handshake from a grabber with colour on is the only evidence that there
            // is a colour camera to serve, and everything else in this file can only
            // revoke it.
            if (camera.color) webcam.setAvailable();
            webcam.reassert();
          }
        }
      } catch (err) {
        // A desynced stream is unrecoverable; restarting rebuilds the framing.
        console.error('[server]', err.message);
        stopGrabber();
      }
    });

    child.on('exit', (code, signal) => {
      console.error(`[server] grabber exited (code=${code} signal=${signal})`);
      // **The reference goes with the process, the same identity test and for the same
      // reason the `error` handler above uses.** Nothing here used to clear it, so for
      // the whole respawn backoff - `RESTART_DELAYS[attempt]`, a full second on the
      // first failure, and 250ms after an ordinary colour restart - `child` was a
      // truthy `ChildProcess` that had already exited. A colour toggle landing in that
      // window passed `applyCamera`'s guard against the corpse, armed `restarting`, and
      // called `stopGrabber` on something that can neither be signalled nor exit again,
      // so nothing ever consumed the flag. What eventually read it was the *next*
      // grabber's genuine failure: it took the requested-restart branch below, returned
      // before `scheduleRetry`, and so the sensor was never reported lost and the
      // backoff table started over. An ordinary double-click on the colour checkbox is
      // enough to reach it.
      //
      // `child === proc` rather than an unconditional null, because a later spawn may
      // already own the reference by the time a slow exit arrives, and clearing it then
      // would hide the grabber that is actually running from the toggle and from
      // `stopGrabber`. With every process-specific callback clearing only its own,
      // `child` means the grabber running now - which is what makes `applyCamera`'s
      // decision correct by construction rather than by when it happens to be read.
      // At the top with the two nullings below, because every exit path matters and the
      // restart branch returns before the rest of the handler runs.
      if (child === proc) child = null;
      // **The hello goes with the grabber that sent it.** `/record/start` stamps the
      // take it opens with whatever is in here, and between a grabber exiting and the
      // next one handshaking that is the *previous* grabber's - so a take started
      // during a USB drop or a colour toggle carried a hello describing a moment
      // before it was shot, which `describeTake` then dates and sorts the whole
      // library by, and which can declare `color: true` over a take that carries no
      // JPEG at all. Nulled rather than refused: `start` with no hello arms and lets
      // the next `onHello` open the take, and refusing to record through a blip the
      // supervisor is already riding out is worse than waiting a second for the
      // sensor to come back. At the top of the handler because every exit path
      // matters - the restart branch below returns before the state is set, and that
      // branch is the colour toggle.
      helloJson = null;
      // The picture goes with the grabber too. Said as a sentence rather than left as
      // a stalled stream, because the reason is the whole value: a webcam that stops
      // mid-call and answers "the grabber is restarting" is one somebody waits three
      // seconds for, and a webcam that stops and answers nothing is one they debug.
      webcam.setUnavailable('the grabber is restarting');
      // The take ends here. One take is one continuous stream with one hello and
      // monotonic timestamps, and the index, the retime curve and `mixT` all depend
      // on it - a blend fraction across a restart seam has no meaning, and the
      // intrinsics in a second hello could legally differ from the first. Nothing
      // is discarded; the recording so far is a complete take and the next hello
      // opens the next one.
      recorder.split().catch((err) => console.error(`[recorder] ${err.message}`));
      if (shuttingDown) return;
      if (restarting) {
        // Asked for, not a failure - so it does not count toward the backoff, and for
        // the same reason it does not count toward the respawns `/sensor/health`
        // reports. This is the one place that knows the difference: `spawnGrabber`
        // sees every road to a running grabber and none of them carry why.
        restarting = false;
        const delay = killedHard ? RESPAWN_AFTER_KILL_MS : RESPAWN_AFTER_CLEAN_MS;
        killedHard = false;
        // **Counted beside the spawn it excuses rather than here, where it is learned.**
        // `respawns` is `grabberSpawns - 1 - grabberRestarts`, so incrementing on the
        // exit and leaving the matching spawn a quarter of a second to a second and a
        // half away makes that subtraction run one ahead of itself for the whole gap -
        // a node that had genuinely lost its sensor once read one respawn, then zero
        // while an operator's colour toggle was in flight, then one again. A health
        // number that dips to zero over a real earlier failure is worse than one that
        // never noticed it, because somebody looking in that second is told the node is
        // well. Both halves move in the same tick now, so the reading has no gap to
        // pass through.
        setTimeout(() => { grabberRestarts++; spawnGrabber(); }, delay);
        return;
      }
      scheduleRetry();
    });
  };

  // One line down the grabber's own stdin command channel, the same one the low-light
  // toggle uses. Refused rather than sent when colour is off, because the grabber
  // would refuse it too and the webcam should hear the reason from the side that
  // knows it rather than from a stream that never starts.
  requestHdColor = (wanted) => {
    if (!camera.color) return;
    child?.stdin.write(`hd-color ${wanted ? 'on' : 'off'}\n`);
  };

  applyCamera = (next) => {
    const needsRestart = next.color !== camera.color;
    const lowLightChanged = next.lowLight !== camera.lowLight;
    if (!needsRestart && !lowLightChanged) return;

    Object.assign(camera, next);
    broadcastText(JSON.stringify({ camera }));

    if (needsRestart) {
      // **`restarting` is a claim about an exit that is coming, so it is only armed when
      // there is a child whose exit it describes.** With none - the window between a
      // failed spawn nulling `child` and the backoff's timer firing, which on a machine
      // where the binary is missing is most of the time, and the same window after an
      // ordinary exit, which the handler above now nulls through - `stopGrabber` returns
      // on the spot, no exit is ever emitted, and the flag stays set for the life of the
      // process. What eventually reads it is the *next* grabber's exit, after a clean
      // handshake and however many minutes of good footage: that exit is a real failure,
      // and the restart branch takes it, returns before `scheduleRetry`, and so leaves
      // the sensor status reading `live` with nothing running while the backoff skips a
      // step. One toggle at the wrong moment, one silently mishandled failure later.
      //
      // Which is why this reads `child` at all rather than a flag of its own: every
      // callback that owns a process clears the reference when that process is gone, so
      // the question "is there a grabber running to restart" is the identity of what is
      // in there, and a corpse cannot answer it yes.
      //
      // Nothing is lost by not arming it. The setting itself reaches the grabber through
      // `buildArgs` on the spawn the backoff has already scheduled, which is the same
      // door it goes through on a restart. `attempt` stays where it is for a reason of
      // its own: with no child there is no requested restart to excuse, the pending
      // retry is a genuine backoff step, and zeroing it would restart the table - so a
      // sensorless editing station whose colour toggle gets touched now and then would
      // never reach `absent`, which is the one conclusion that machine needs.
      // **Turning colour off drops a live webcam, and that is allowed rather than
      // refused.** The alternative - refusing the toggle while somebody is subscribed
      // - puts the decision on the person at the keyboard, who did not necessarily
      // know a call was running; this puts a legible reason in front of whoever loses
      // the picture. It is the one place this feature makes something worse, and it
      // is a deliberate trade rather than an oversight.
      if (!camera.color) {
        webcam.setUnavailable('colour is off on this grabber, so there is no colour camera to serve');
      }
      console.log(`[server] colour camera ${camera.color ? 'on' : 'off'} - ${child ? 'restarting grabber' : 'takes effect on the next spawn'}`);
      if (child) {
        restarting = true;
        attempt = 0;
        stopGrabber();
      }
      return;
    }
    // Colour off means there is no exposure to set, but the flag is still worth
    // remembering so it takes effect when colour comes back.
    if (camera.color) {
      console.log(`[server] low light ${camera.lowLight ? 'on' : 'off'}`);
      child?.stdin.write(`low-light ${camera.lowLight ? 'on' : 'off'}\n`);
    }
  };

  // Armed at boot rather than recording at boot: the take still opens on the hello,
  // through the same door a take opened from the library goes through, so there is
  // one path into a take file rather than two. Armed *before* the grabber is
  // spawned, because arming reads the disk and a hello arriving during that read
  // would find the recorder still disarmed and start no take at all - which on a
  // node booted to record is the whole shoot.
  if (RECORD) {
    recorder.start(null).then(spawnGrabber, (err) => {
      console.error(`[recorder] ${err.message}`);
      spawnGrabber();
    });
  } else {
    spawnGrabber();
  }

  process.on('SIGINT', () => {
    shuttingDown = true;
    stopGrabber({ holdProcessOpen: true });
    // Closed and scanned before the process goes, because a take without a sidecar
    // index is a take the gallery has to rebuild - and the format is append-only,
    // so whatever landed is readable either way. This is a courtesy, not the
    // guarantee; the guarantee is that the bytes are already on disk.
    recorder.close('server stopped').finally(() => process.exit(0));
  });
}

async function startReplay() {
  let capture;
  try {
    capture = await openCapture(REPLAY);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[server] no capture at ${REPLAY} — record one first: npm run record`);
    } else {
      // Anything else is a real failure of the reader and has to say so. A
      // blanket catch here used to report every error as a missing file, which
      // is how a capture the old whole-file read simply refused to open came to
      // look like a capture nobody had recorded.
      console.error(`[server] cannot open ${REPLAY}: ${err.message}`);
    }
    return;
  }

  // Retained, because this reader outlives every request and holds no lease of its
  // own - see `Capture.retain`. A replay whose descriptor is evicted by a gallery
  // skimming a directory fails every read afterwards and reports it as a lost
  // sensor, which is the one failure mode that looks like the hardware.
  capture.retain();

  // The replayed take is reachable over the frame API under its own id even when
  // it lives outside the captures directory.
  captureAliases.set(captureIdFor(REPLAY), resolve(REPLAY));

  const stamps = capture.index.frames.stampMs;
  if (stamps.length === 0) {
    console.error('[server] replay file contains no frames');
    return;
  }

  console.log(`[server] replaying ${REPLAY}`);
  const hello = await capture.readHello();
  if (hello) handleMessage({ type: TYPE_HELLO, payload: hello, raw: encodeMessage(TYPE_HELLO, hello) });

  // Replay the recorded arrival spacing rather than a uniform 30fps. A live
  // stream is deeply irregular - measured p50 64ms against p90 222ms - and
  // pacing every frame 33ms apart hands the viewer the one cadence that never
  // happens, so interpolation tuned against replay looks right here and stutters
  // on the sensor. Frame 0 anchors the loop; the gap after the last frame reuses
  // the median so the wrap does not stall.
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((g) => g > 0 && g < 2000);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 33;
  gaps.push(median);

  console.log(
    `[server] ${stamps.length} frames indexed, median gap ${median}ms, ${capture.index.hash}`,
  );

  // A replayed take is as live as this server gets, and saying so is what gives
  // the lost state below something to mean.
  setSensorState('live');

  let i = 0;
  let failing = false;
  const schedule = () => {
    const gap = gaps[i % gaps.length];
    i++;
    setTimeout(tick, gap);
  };
  // Each frame is read at the moment it is due, so replaying a five-minute take
  // costs the same memory as replaying a nine-second one. The read is awaited
  // before the timer is set, which adds its own duration to every gap - measured
  // at 0.07 to 0.6ms against a 64ms median, so under 1% and inside the slop the
  // old in-memory loop already had.
  const tick = () => {
    capture
      .readFrame(i % stamps.length)
      .then((payload) => {
        if (failing) {
          failing = false;
          console.log('[server] replay reads recovered');
          setSensorState('live');
        }
        // A whole message, framing included, because that is what `handleMessage`
        // is documented to take and what everything downstream of it reads. The
        // replay used to hand over a bare payload with no `raw`, which nothing
        // noticed until a take was open - so the invariant is restored here rather
        // than left to the refusal above being the only thing standing between this
        // loop and a throw per frame. One header and one copy per frame, against the
        // half-megabyte read that produced the payload.
        handleMessage({ type: TYPE_FRAME, payload, raw: encodeMessage(TYPE_FRAME, payload) });
        schedule();
      })
      .catch((err) => {
        // A read that fails must not freeze the loop in silence. A viewer holding
        // its last frame looks exactly like a paused take, so the state goes to
        // lost the way it does when the grabber dies, and the loop keeps trying
        // at the recorded cadence rather than stopping - a transient failure then
        // recovers on its own. Logged on the transition only, or a take whose
        // file went away would fill the console every 64ms.
        if (!failing) {
          failing = true;
          console.error(`[server] replay read failed: ${err.message}`);
          setSensorState('lost');
        }
        schedule();
      });
  };
  tick();
}

// The captures directory is created rather than assumed. A reflashed node has none,
// which is the state step 9 provisions from - and without this it boots disarmed
// with a raw `ENOENT: no such file or directory, statfs '/...'` coming back through
// `/record/state` and `/library/all`, so the panel in the room shows an errno and
// nothing on screen says the shoot cannot start. A directory that cannot be created
// is reported and the server still comes up: the library half of this program is
// exactly what somebody would open to find out why.
try {
  mkdirSync(CAPTURES_DIR, { recursive: true });
} catch (err) {
  console.error(`[server] no captures directory at ${CAPTURES_DIR} and it could not be made: ${err.message}`);
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[server] viewer on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== LOOPBACK) {
    console.log(`[server] reachable from the network on ${HOST} - anyone who can route here can drive the recorder`);
  }
  if (REPLAY) startReplay().catch((err) => console.error(`[server] replay failed: ${err.message}`));
  else startLive();
});
