// Bridges the native Kinect grabber to the browser: spawns (or replays) the
// framed binary stream and fans it out over WebSocket, while serving the viewer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, normalize, extname, sep, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { MessageParser, encodeMessage, TYPE_HELLO, TYPE_FRAME, TYPE_COLOR, MAX_PAYLOAD_BYTES } from './protocol.js';
import { openCapture, withCapture, captureIdFor, openCaptureCount, decimatePayload, cloudExtent } from './capture.js';
import { handleExportSocket, MAX_FRAME_BYTES } from './export.js';
import { AudioStore } from './audio.js';
import {
  VALID_ID, DocumentStore, NodeLink, PROJECT_VERSION, appendMarks, downloadTake,
  downloadsInFlight, hashFile, markWriteCount, readMarkLog, readMarks, reconcile, remaining,
  removeTake, renameTake, resolveMarks, revealSupport, revealTake, scanTakes,
} from './library.js';
import { EffectStore } from './effect-store.js';
import { RESERVED_EFFECT_IDS, doorRefusal, forkRefusal } from './effect-door.js';
import { cloudSpine } from '../web/cloud-shader.js';
import { gradeSpine } from '../web/grade-shader.js';
import { moshSpine } from '../web/mosh-shader.js';
import { Recorder } from './recorder.js';
import { JobStore } from './jobs.js';
import { Webcam } from './webcam.js';
import { requireMutation, originAllowed, sameOriginBrowser } from './http-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', '8080'));
// Loopback unless somebody says otherwise, because this server has no authentication of any kind.
// The origin checks in `server/http-guard.js` are the half that answers DNS rebinding, not this
// line - the bind still matters for everything that is not a browser.
const LOOPBACK = '127.0.0.1';
const HOST = flag('--host', LOOPBACK);
const REPLAY = flag('--replay');
// Recording is a runtime action; this only says whether the first take arms itself at hello.
const RECORD = has('--record');
// A node is an ordinary instance of this server with no `--node`, so the link is one-directional.
const NODE_URL = flag('--node');
const NODE_NAME = flag('--node-name', 'node');
const HERE_NAME = flag('--name', NODE_URL ? 'mac' : 'node');
// No fallback on purpose: the grabber already picks the fastest processor its own build contains.
const PIPELINE = flag('--pipeline');
const NO_COLOR = has('--no-color');

// A browser that falls behind must never build a queue - a stale cloud reads as a slow Kinect.
const MAX_BUFFERED = 4 * 1024 * 1024;

// The divisor's ceiling is the frame API's, because they are one mechanism; the stride's is one
// frame per second at 30fps, past which a monitor has stopped being a monitor.
const MAX_DIVISOR = 16;
const MAX_STRIDE = 30;

// What a monitor costs the take: a refusal at the record boundary and never a cap on a running
// stream, because coarse depth reads as a badly placed subject. Loopback monitors are exempt,
// since the cost is backpressure from a link a local monitor never touches.
const RECORDING_CAP = { divisor: 4, stride: 3 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  // A `.mov` served as octet-stream is a file `<video>` declines to play.
  '.mov': 'video/quicktime',
  '.png': 'image/png',
};

const WEB_DIR = join(ROOT, 'web');
const THREE_DIR = join(ROOT, 'node_modules/three');
// The grabber binary, space-separated so the flag can carry the writer's own arguments.
const [GRABBER_BIN, ...GRABBER_ARGS] = (flag('--grabber') ?? '').split(' ').filter(Boolean);

// A flag, because a capture node and an editing machine are the same program and the only way to
// run both on one host is separate directories.
const CAPTURES_DIR = resolve(flag('--captures', join(ROOT, 'captures')));
const EXPORTS_DIR = join(ROOT, 'exports');

// The program `POST /library/reveal/:id` starts, substituting the program and nothing else, so a
// proof tool measures the arguments the platform's file manager would have been given.
const REVEAL_WITH = flag('--reveal-with', null);

// A bare startsWith would also match a sibling like `web-private`.
const isInside = (dir, candidate) => candidate === dir || candidate.startsWith(dir + sep);

// A directory as the kernel would reach it, or the path itself where there is nothing there yet.
// Resolved per request, or `exports/` is answered from a lexical path forever after
// it becomes a link.
const realOrLexical = (dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

// `--replay` may name a file anywhere, so the replayed take registers its own id here.
const captureAliases = new Map();

// The node keeps its own preset library on disk: it may be shooting with nothing connected, where
// a push-per-session scheme leaves a standalone node with an empty selector.
const AUDIO = new AudioStore(resolve(flag('--audio', join(ROOT, 'audio'))));
const PROJECTS = new DocumentStore(resolve(flag('--projects', join(ROOT, 'projects'))), 'project');
// A second *read* root rather than files copied on first run: a builtin is always the current one,
// a save over its name forks it, and removing the fork brings the shipped look back.
const PRESETS = new DocumentStore(
  resolve(flag('--presets', join(ROOT, 'presets'))),
  'preset',
  PROJECT_VERSION,
  resolve(flag('--builtin-presets', join(ROOT, 'presets-builtin'))),
);
// The spines every program is assembled from, named once because the install door and the
// store's own boot gate both read them.
const SPINES = { cloud: cloudSpine, grade: gradeSpine, mosh: moshSpine };
// Constructed here and *settled* in `listen`'s callback: the process that loses the bind must
// exit before it renames anything of the winner's.
const EFFECTS = new EffectStore(
  resolve(flag('--effects', join(ROOT, 'effects'))),
  resolve(flag('--builtin-effects', join(ROOT, 'effects-builtin'))),
  SPINES,
);
// Version 2 dropped `outputFps` - the rate is a property of the edit - and a version 1 document is
// refused rather than read, because it names a rate this build would ignore.
const DELIVERABLES = new DocumentStore(resolve(flag('--deliverables', join(CAPTURES_DIR, '..', 'deliverables'))), 'deliverable', 2);
const JOBS = new JobStore(resolve(flag('--jobs', join(ROOT, 'jobs'))));
const node = NODE_URL ? new NodeLink(NODE_URL, NODE_NAME) : null;

function capturePathFor(id) {
  if (captureAliases.has(id)) return captureAliases.get(id);
  return VALID_ID.test(id) ? join(CAPTURES_DIR, `${id}.knct`) : null;
}

// The frame API: a single frame is the payload alone, so the pulled and pushed paths hand the
// same decoder the same input; a run is the file's own slice, framing included, because
// concatenated payloads have no boundaries left to parse back.

// The take the recorder has open is refused through this API until it closes: a scan of a growing
// file is a full read plus sha256 against the disk being written to, and the hash it would carry
// names a take that no longer exists a frame later.
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

// The take's own intrinsics: unprojecting on the boot defaults is wrong in a way nothing on screen
// can show, because every point translates together.
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
  // A network concession and never a compute one: 1 returns the payload byte for byte.
  const divisor = Number(query.get('decimate') ?? 1);
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 16) {
    res.writeHead(400).end('decimate must be a whole number from 1 to 16');
    return;
  }
  let payload;
  try {
    payload = await capture.readFrame(n, divisor);
  } catch (err) {
    // Refused rather than sampled past, or the tail of the response is recycled heap.
    res.writeHead(422).end(err.message);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
    // Said rather than inferred: a client guessing the grid from the byte count would have to know
    // the divisor it asked for was honoured.
    'X-Depth-Divisor': String(divisor),
  });
  res.end(payload);
});

// Where a take's cloud reaches laterally, so the editor can fit the crop box to the footage. The
// cache keys on the range as well as the take, because the answer excludes points outside it.
const extentCache = new Map();
// Four numbers per entry, so the bound is about not growing with every range anybody scrubbed.
const MAX_EXTENTS = 32;

const serveExtent = (req, res, [id], query) => withOpenCapture(res, id, async (capture) => {
  const near = Number(query.get('near'));
  const far = Number(query.get('far'));
  // Both required, because a range picked here would be a second declaration of the clip defaults.
  if (!Number.isFinite(near) || !Number.isFinite(far) || near < 0 || far <= near) {
    res.writeHead(400).end('near and far are required, finite, and near must be below far');
    return;
  }
  const payload = await capture.readHello();
  if (!payload) {
    res.writeHead(404).end('this capture carries no hello');
    return;
  }
  const hello = JSON.parse(payload.toString('utf8'));
  // The index hash rather than the id, so a take renamed onto an existing name cannot be answered
  // with the other one's fit.
  const key = `${capture.index.hash}|${near}|${far}`;
  if (!extentCache.has(key)) {
    if (extentCache.size >= MAX_EXTENTS) extentCache.delete(extentCache.keys().next().value);
    extentCache.set(key, await cloudExtent(capture, hello, near, far));
  }
  sendJson(res, { id, near, far, ...extentCache.get(key) });
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
  // `pipeline` rather than `pipe`, because the headers are already out and a bare pipe leaves a
  // read error as an unhandled stream event. Awaited, because the lease lasts as long as this does.
  await new Promise((done) => {
    pipeline(capture.createFrameRunStream(a, b), res, (err) => {
      if (err) console.error(`[server] frame run ${id} ${a}-${b} failed: ${err.message}`);
      done();
    });
  });
});

// Streamed: a take is routinely past the 2 GiB `readFileSync` refuses.
function serveTakeFile(req, res, [id]) {
  const path = capturePathFor(id);
  // A take still being written has no length that will still be true when the transfer ends.
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

// Marks are a sidecar beside the take, and a write is an append - so moving, renaming and
// deleting a mark are one operation and the two-machine merge is concatenate-and-resolve. `dev`
// and `ino` rather than the path, because a later take renamed into a freed id is a different take.
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
  // Marks hang off a take, so the take has to exist first: without this the route created a
  // sidecar for a name nothing holds, with tombstones waiting for a real take of that name.
  const wasThere = takeIdentity(path);
  if (wasThere === null) {
    sendJson(res, { error: `no take ${id} here, so there is nothing to mark` }, 404);
    return;
  }
  const body = await readBody(req);
  // Asked again, and asked *which* take: the check above is before an await of up to four
  // megabytes over a room's wifi, and a rename landing in that gap recreates the old sidecar.
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
    // `at` is what orders two machines' edits, and the resolver drops a record without one.
    at: Number.isFinite(m.at) ? m.at : now,
  }));
  await appendMarks(path, records);
  sendJson(res, { marks: resolveMarks(await readMarkLog(path)) });
}


// `/dev/fd` is this process's own descriptor table on Darwin and Linux, so this needs no tool.
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

// Every body here is tens of kilobytes of JSON; a request that keeps sending is one nobody meant.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// How much of a page's sentence about a package it could not compile reaches the log. A driver's
// link log is whatever the driver felt like emitting, and it lands above the store's own sentence,
// which is the one that says what happened.
const MAX_REFUSAL_REASON = 400;

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

// The take being written is named on the way in, so the manifest can describe it without scanning.
const localTakes = () => scanTakes(CAPTURES_DIR, recorder.openPath);

// Per request rather than per server, because the answer is about the socket: Reveal opens a window
// on the machine running this process, which is only the operator's when the browser is on it.
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

// A signal that fires when the caller hangs up, for handing to the node - `library-check` requires
// one at every `node.takes(` call. Watched on the *response*, because an `IncomingMessage` emits
// `close` when it ends and a listener attached after `readBody` never fires.
const untilCallerLeaves = (res) => {
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  return ctl.signal;
};

async function serveLibrary(req, res) {
  // A `ServerResponse` emits `close` exactly once, so binding after an await attaches a listener
  // to an event that has already happened.
  const left = untilCallerLeaves(res);
  const here = await localTakes();
  const there = node ? await node.takes(left) : null;
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

// Renaming a take is a label moving and never footage moving; one that is only on the node is
// refused, because the link is one-directional about footage. The recording take is refused in
// `renameTake` and deliberately not here - two gates that agree cannot be tested apart.
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

// `requireMutation` has already asked whether this came from this program's page; what is left is
// whether the window would open where the person asking is, which `isLoopback`
// reads off the socket.
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
  // The take being recorded is refused: revealing hands the path to a program whose job is to
  // stat, index and preview it, against the disk the recorder is writing to.
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

// Two genuinely different actions: reclaim is recoverable because a hash-verified copy exists
// elsewhere, verified here and now, where delete is the last copy and refuses when a second exists.
async function serveRemoval(req, res, [id], kind) {
  // First, ahead of `readBody` as well as of the walk - see the note in `serveLibrary`.
  const left = untilCallerLeaves(res);
  const body = await readBody(req);
  const here = await localTakes();
  const mine = here.takes.find((t) => t.id === id);
  // The open take has no hash yet, so neither removal can verify anything about it, and
  // unlinking underneath a running write stream loses the shoot in progress.
  if (mine?.recording) {
    sendJson(res, { error: `${id} is being recorded right now: stop the take before removing it` }, 409);
    return;
  }
  const there = node ? await node.takes(left) : null;
  const theirs = (there ?? []).find((t) => t.hash === (mine?.hash ?? body.hash));

  if (kind === 'reclaim') {
    // The surviving copy is the local one, re-hashed rather than trusted: a file truncated since
    // the last listing would otherwise be treated as what makes this recoverable.
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
        // A reclaim that hangs here has already asked the node to unlink its copy, so the signal
        // ends this side waiting rather than the request.
        signal: left,
      });
      sendJson(res, { reclaimed: done, keptHere: verified });
    } catch (err) {
      sendJson(res, { error: `the node refused the reclaim: ${err.message}` }, 502);
    }
    return;
  }

  // The confirm names the hash, so a request built against one listing cannot remove a take
  // that changed since.
  if (body.confirm !== true) {
    sendJson(res, { error: 'delete needs an explicit confirm: this is the only irreversible action here' }, 400);
    return;
  }
  if (!mine) {
    sendJson(res, { error: `${id} is not on this machine` }, 404);
    return;
  }
  // `verifiedElsewhere` is what a reclaim from the other machine carries, and it turns this route
  // into the recoverable action.
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
  // Bound before the fetch: the library asks for a poster on every pointer move, and a scrub
  // across a shelf abandons dozens of these.
  let upstream;
  try {
    upstream = await fetch(`${node.url}/capture/${encodeURIComponent(id)}/frame/${n}?decimate=${divisor}`,
      { signal: untilCallerLeaves(res) });
  } catch {
    // The caller going away is the ordinary case here rather than an error.
    if (!res.writableEnded) res.writeHead(502).end('the node did not answer for that frame');
    return;
  }
  if (!upstream.ok) {
    res.writeHead(upstream.status).end('the node could not serve that frame');
    return;
  }
  // The whole reply lands in heap, so it is bounded by what the format allows a payload to be
  // rather than by what a node happens to send. A real decimated frame is under 486KB.
  const declared = Number(upstream.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
    // Cancelled, or the node goes on sending the body it declared into a connection nobody is
    // draining, and a peer answering every request this way holds one socket per refusal.
    upstream.body?.cancel().catch(() => { /* the node may already be gone */ });
    res.writeHead(502).end(`the node offered ${declared} bytes for one frame, past the ${MAX_PAYLOAD_BYTES} this format allows`);
    return;
  }
  // A chunk at a time, because the header above is a claim and this is the arithmetic:
  // `arrayBuffer()` buffers the whole reply first, so a node answering chunked walked past the
  // declared-size refusal. `cancel()` rather than a `break`, so the node is told to stop.
  let body;
  try {
    const reader = upstream.body?.getReader();
    if (!reader) {
      res.writeHead(502).end('the node answered that frame with no body at all');
      return;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAYLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        res.writeHead(502).end(`the node sent past the ${MAX_PAYLOAD_BYTES} bytes this format allows for one frame,`
          + ' and was cut off rather than buffered');
        return;
      }
      chunks.push(value);
    }
    body = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
  } catch {
    if (!res.writableEnded) res.writeHead(502).end('the frame stopped arriving from the node');
    return;
  }
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
  // A take the node is still shooting has no hash to verify the transfer against, and the
  // download is verified or discarded.
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

// One handler for projects and presets, because they are the same storage problem and
// two would drift.
const listDocuments = async (res, store) => sendJson(res, { [`${store.kind}s`]: await store.list() });

async function readDocument(res, store, name) {
  try {
    sendJson(res, await store.read(name));
  } catch {
    sendJson(res, { error: `no ${store.kind} named ${name}` }, 404);
  }
}

// The one write that changes what the *page* is. The refusal comes before the filesystem, always:
// a package that lands and then breaks the next boot is a machine whose editor no longer opens.
async function serveEffectWrite(req, res, [id]) {
  if (req.method === 'DELETE') {
    const answer = EFFECTS.remove(id);
    if (answer.error) return sendJson(res, { error: answer.error }, answer.status);
    return sendJson(res, answer);
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, { error: err.message }, 400);
  }
  const candidate = { id, manifest: body.manifest, chunks: body.chunks ?? {} };
  // Held against the shipped package rather than the whole store, because this rule is about
  // forking specifically - see `forkRefusal`.
  const shadowed = candidate.manifest && typeof candidate.manifest === 'object' ? EFFECTS.builtin(id) : null;
  const refusal = doorRefusal(candidate, {
    beside: EFFECTS.loaded(id),
    spines: SPINES,
  }) ?? (shadowed ? forkRefusal(candidate, shadowed) : null);
  if (refusal) return sendJson(res, { error: refusal }, 409);
  try {
    return sendJson(res, EFFECTS.install(id, candidate.manifest, candidate.chunks));
  } catch (err) {
    // The door has already passed, so anything thrown here is the filesystem rather than the
    // package, and retrying the same request is the right next move.
    return sendJson(res, { error: `effect ${id} could not be written: ${err.message}` }, 500);
  }
}

// The packages a page could not compile, set aside on that page's word. This build has no GLSL
// compiler, so the door cannot refuse a package whose GLSL is merely wrong - that is a link
// failure inside the driver, and the only thing that ever learns of it is a page that tried.
// It grants no authority the caller did not have, since `PUT` and `DELETE` on the same id sit
// behind the same guard, and does strictly less: `setAside` renames within the user root. An id
// with no copy there is skipped rather than refused.
async function serveEffectRefusal(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, { error: err.message }, 400);
  }
  if (!Array.isArray(body.ids)) {
    return sendJson(res, {
      error: 'this route takes { ids: [...], reason } - a page that could not compile the installed set '
        + 'names which packages it was compiling, and a body without that list is a request about nothing',
    }, 400);
  }
  // Bounded against the store rather than a number somebody picked: the ids a page can honestly
  // name are the ids it was handed. Counted off the directory listings, not through `list()`.
  const installed = new Set([...EFFECTS.idsIn(EFFECTS.builtinDir), ...EFFECTS.idsIn(EFFECTS.dir)]).size;
  if (body.ids.length > installed) {
    return sendJson(res, {
      error: `this names ${body.ids.length} packages and the store holds ${installed} - `
        + 'the ids a page can have failed to compile are the ids it was handed, so a longer list is not about this store',
    }, 400);
  }
  // The page's own sentence, off the network: collapsed to one line so it cannot forge log lines
  // around itself, and cut, because a driver's link log can be hundreds of lines of shader source.
  const reason = typeof body.reason === 'string' && body.reason.trim().length
    ? body.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REFUSAL_REASON)
    : 'a page that adopted it could not compile the programs it assembles into, and said no more than that';
  const setAside = [];
  const skipped = [];
  // The rename and the generation bump are one call into the store: the counter is the store's
  // own history, and a route assigning to it was a third writer of a field two methods there own.
  const WHY = {
    absent: 'there is no copy of it in the user root - a builtin is what this build ships with and what an '
      + 'install falls back to, so there is nothing here that could be set aside',
    stuck: 'it could not be renamed out of the way - the server log says what the rename answered',
  };
  for (const id of body.ids) {
    if (typeof id !== 'string') {
      skipped.push({ id: String(id), why: WHY.absent });
      continue;
    }
    const outcome = EFFECTS.setAsideForClient(id, `a page that adopted it reports that it does not compile: ${reason}`);
    if (outcome === 'aside') setAside.push(id);
    else skipped.push({ id, why: WHY[outcome] });
  }
  return sendJson(res, { setAside, skipped });
}

const sendRefusal = (res, err) => sendJson(res, {
  error: err.message,
  ...(err.stale ? { stale: true, rev: err.rev } : {}),
}, 409);

async function writeDocument(req, res, store, name, query) {
  const rev = query?.get('rev') ?? '';
  if (req.method === 'DELETE') {
    try {
      sendJson(res, await store.remove(name, rev));
    } catch (err) {
      if (err?.code === 'ENOENT') sendJson(res, { error: `no ${store.kind} named ${name}` }, 404);
      else sendRefusal(res, err);
    }
    return;
  }
  try {
    sendJson(res, await store.write(name, await readBody(req), rev));
  } catch (err) {
    sendRefusal(res, err);
  }
}

async function renameDocument(req, res, store, name) {
  const body = await readBody(req);
  try {
    sendJson(res, await store.rename(name, String(body.to ?? '').trim(), body.rev));
  } catch (err) {
    sendRefusal(res, err);
  }
}

// The library routes are all HTTP: a second socket would be a second endpoint to keep honest for
// a request pattern that is one call per gesture.

// Two machines can hold the same take and different marks, and the merge needs no algorithm: the
// log is append-only and every record carries an id, so the resolver keeps the highest `at`.
async function serveMarkSync(req, res, [id]) {
  // Bound before the refusals below as well as before the walk - see `serveLibrary`. After them
  // it would be correct today and rot the moment one of them learns to await something.
  const left = untilCallerLeaves(res);
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
    // The node's *name* for this take, resolved by hash: asking under this machine's name returns
    // nothing whenever the two named the same footage differently, which is the ordinary case.
    const here = (await localTakes()).takes.find((t) => t.id === id);
    const theirTakes = await node.takes(left);
    const match = here && (theirTakes ?? []).find((t) => t.hash === here.hash);
    if (!match) {
      sendJson(res, { merged: 0, marks: await readMarks(path), note: `${node.name} does not hold this take` });
      return;
    }
    const theirs = await node.fetchJson(`/capture/${encodeURIComponent(match.id)}/marks/log`, { signal: left });
    const mine = await readMarkLog(path);
    // Appended rather than rewritten, which is what makes this safe to run twice and
    // from both machines.
    const known = new Set(mine.map((r) => `${r.id}@${r.at}`));
    const fresh = (theirs.log ?? []).filter((r) => !known.has(`${r.id}@${r.at}`));
    await appendMarks(path, fresh);
    sendJson(res, { merged: fresh.length, marks: await readMarks(path) });
  } catch (err) {
    sendJson(res, { error: err.message }, 502);
  }
}

// Record control. The state is broadcast to every socket, but the control is an HTTP call, and
// all three are `write` entries: `GET /record/stop` used to end a shoot from anything that could
// persuade a browser to load a URL.
const shooting = (run) => async (req, res, args, query) => {
  try {
    await run(req, res, args, query);
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
};

// Every consumer whose frames cross the link and cost the take, read off the live sockets so the
// answer is the one `broadcastFrame` will act on. Consumers rather than monitors: a webcam
// subscriber costs the take through a route with no divisor to name.
function consumersCostingTheTake() {
  return [
    ...attachedMonitors().filter(costsTheTake)
      .map((m) => ({ kind: 'monitor', at: `÷${m.divisor} ×${m.stride}` })),
    ...webcam.subscribersCostingTheTake()
      .map(() => ({ kind: 'webcam', at: 'the colour camera at full rate' })),
  ];
}

// With the setting each is actually being served at, because the interleaved measurement segments
// its windows by this and cannot ask across the link without competing with the arm it measures.
function attachedMonitors() {
  const out = [];
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const m = monitors.get(ws);
    if (m) out.push(m);
  }
  return out;
}

// A refusal rather than a cap on the stream: a monitor whose image silently coarsened when
// recording started would be lying to the one person who cannot check. `acceptMonitorCost` is
// spelled out rather than a bare `force`, so the log line reads as a decision.
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
  // The moment the operator pressed, supplied by the caller when it knows - the monitor does - and
  // taken from the take's elapsed wall clock when it does not. In the body and only in the body.
  const sourceMs = Number(body.sourceMs ?? NaN);
  const at = Number.isFinite(sourceMs) ? sourceMs : Date.now() - (recorder.state.startedAt ?? Date.now());
  sendJson(res, recorder.mark(at, body.label));
});

// The route table as data, for the proof tool to walk. Derived from `ROUTES` itself, so there is
// no second list to fall behind the first.
function serveRoutes(req, res) {
  sendJson(res, {
    routes: ROUTES.map((r) => ({
      path: r.path,
      read: Boolean(r.read),
      // A route that changes something is a route with a write, and this is that fact.
      mutates: Boolean(r.write),
      // And one serving what the sensor sees right now says so, so a check that walks this table
      // asks every one of them rather than the ones a reviewer thought of.
      live: Boolean(r.live),
      methods: r.write?.methods ?? [],
      contentType: r.write?.contentType ?? 'application/json',
    })),
  });
}

// The route sweep read the stores either side of the drive, which a handler that writes and
// restores inside one request defeats - a monotonic count is what a restore cannot undo.
const serveWriteCounts = (req, res) => sendJson(res, {
  projects: PROJECTS.writes, presets: PRESETS.writes, deliverables: DELIVERABLES.writes, marks: markWriteCount(), jobs: JOBS.writes, audio: AUDIO.writes,
});

// ---- the render queue
//
// A job as anybody may read it, which is a job without its lease. The lease is a capability: left
// in the record these routes return, `GET /jobs/<id>` handed anyone what `finish` needs to forge.
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

// The one place the renderer class is enforced. An empty queue and a queue this worker may not
// touch are different answers: collapsing them leaves an idle worker and a queue that never drains.
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
      // Without it, `POST /jobs/<id>/finish` with `{"state":"done"}` marked a job done that
      // nothing had ever rendered.
      lease: body.lease ?? null,
    }));
  } catch (err) {
    sendJson(res, { error: err.message }, 409);
  }
};

// A worker saying it is still rendering. Cheap on purpose: it is the only thing between a machine
// that died and a job nothing can reach again.
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

// The downloads currently moving bytes, so a transfer that takes minutes reads as one. The rate
// is over the whole transfer, because a rate sampled between two polls of wifi swings by three.
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

// Whether the sensor is delivering, answered without anything attaching to it: the only way to ask
// used to be opening a monitor, which can itself cost the take frames. Neither `write` nor `live`,
// because it reports numbers *about* the sensor rather than what the sensor sees.
const serveSensorHealth = (req, res) => sendJson(res, {
  state: sensorState,
  // The last window that carried frames, deliberately older than the window below when the
  // sensor has stopped.
  fps: observedFps,
  bytesPerSec: observedBytesPerSec,
  // And the last window that closed, whether or not anything arrived in it.
  window: lastWindow,
  // Named for what it counts: `stats.dropped` moves per socket whose send buffer is over the
  // ceiling, so it is monitors failing to keep up rather than the sensor failing to deliver.
  monitorDropped: droppedTotal,
  // The first spawn is a start rather than a respawn, and restarts somebody asked for come off it:
  // a flapping count an operator can raise by ticking a checkbox is not a health reading.
  respawns: Math.max(0, grabberSpawns - 1 - grabberRestarts),
  // Beside it rather than folded in, or a node that restarted forty times for forty colour toggles
  // reads zero respawns and the reading that says why is gone.
  restarts: grabberRestarts,
});
// The monitor half is here so the button can say "this take will refuse" before it is pressed: a
// check built only out of 409s would pass against a server that refused everything.
const serveRecordState = async (req, res) => {
  const costly = consumersCostingTheTake();
  sendJson(res, {
    ...recorder.state,
    // The library page spans both machines, so on an editing station every fact this route
    // reported was about a recorder that station does not have. Null on the node itself.
    node: node ? await node.recordState() : null,
    storage: await remaining(CAPTURES_DIR, recordingRate()),
    monitors: {
      cap: RECORDING_CAP,
      attached: wss.clients.size,
      // Each one's actual setting: a count alone cannot tell a full-rate monitor from a coarse
      // one, and those are two different arms.
      watching: attachedMonitors().map((m) => ({ divisor: m.divisor, stride: m.stride, loopback: m.loopback })),
      costingTheTake: costly,
      wouldRefuse: costly.length > 0,
    },
    // Beside the monitors because it is a different kind of consumer through a different door -
    // but it is in the same `costly` list, which is what the refusal is made of.
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

// The HTTP surface as one table, walked by one dispatcher - the table *is* the dispatch, which is
// what stops it drifting from the behaviour. Having a `write` is how a route declares that it
// changes something, and the dispatcher puts every one through `requireMutation` in one place. The
// table is served at `/library/routes`, so a check can enumerate rather than name.
const ROUTES = [
  { path: '/audio', pattern: /^\/audio$/, write: { methods: ['POST'], contentType: 'application/octet-stream', run: async (req, res) => {
    try { sendJson(res, await AUDIO.import(req)); }
    catch (err) { sendJson(res, { error: err.message }, 400); }
  } } },
  { path: '/audio/:hash', pattern: /^\/audio\/([0-9a-f]{64})$/, read: async (req, res, [hash]) => {
    const bytes = await AUDIO.read(`sha256:${hash}`);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } },
  // ---- a capture, read
  { path: '/capture/:id/hello', pattern: /^\/capture\/([^/]+)\/hello$/, read: serveHello },
  { path: '/capture/:id/index', pattern: /^\/capture\/([^/]+)\/index$/, read: serveIndex },
  { path: '/capture/:id/extent', pattern: /^\/capture\/([^/]+)\/extent$/, read: serveExtent },
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
  // Two numbers, and the second is the point: the bug that dropped a capture from the map while
  // leaving its descriptor open made `open` fall while the real count rose.
  { path: '/library/descriptors', pattern: /^\/library\/descriptors$/, read: serveDescriptors },
  { path: '/library/routes', pattern: /^\/library\/routes$/, read: serveRoutes },
  { path: '/library/writes', pattern: /^\/library\/writes$/, read: serveWriteCounts },
  // A frame of a node-only take, fetched through here rather than by the browser reaching across:
  // one origin for the page, and the decimation decision stays on the side that knows the link.
  { path: '/library/remote-frame/:id/:n', pattern: /^\/library\/remote-frame\/([^/]+)\/([^/]+)$/, read: serveRemoteFrame },

  // ---- the library, written
  { path: '/library/download/:id', pattern: /^\/library\/download\/([^/]+)$/, write: { methods: ['POST'], run: serveDownload } },
  { path: '/library/delete/:id', pattern: /^\/library\/delete\/([^/]+)$/, write: { methods: ['POST'], run: (req, res, args) => serveRemoval(req, res, args, 'delete') } },
  { path: '/library/reclaim/:id', pattern: /^\/library\/reclaim\/([^/]+)$/, write: { methods: ['POST'], run: (req, res, args) => serveRemoval(req, res, args, 'reclaim') } },
  { path: '/library/sync-marks/:id', pattern: /^\/library\/sync-marks\/([^/]+)$/, write: { methods: ['POST'], run: serveMarkSync } },
  { path: '/library/rename/:id', pattern: /^\/library\/rename\/([^/]+)$/, write: { methods: ['POST'], run: serveRename } },
  // A `write` although no byte of the library moves, because the slot declares "this route makes
  // something happen" and this is the one route in the program that starts a process.
  { path: '/library/reveal/:id', pattern: /^\/library\/reveal\/([^/]+)$/, write: { methods: ['POST'], run: serveReveal } },

  // ---- documents
  { path: '/presets', pattern: /^\/presets\/?$/, read: (req, res) => listDocuments(res, PRESETS) },
  // The chunk route serves text/plain because what the tools anchor and the client compiles is the
  // file's own bytes. The write is on the same entry as the read, which puts it behind
  // `requireMutation` by existing. `generation` beside the list, because a revision cannot say
  // whether the store moved.
  { path: '/effects', pattern: /^\/effects\/?$/, read: (req, res) => sendJson(res, { effects: EFFECTS.list(), generation: EFFECTS.generation }) },
  {
    path: '/effects/:id',
    pattern: /^\/effects\/([^/]+)$/,
    read: (req, res, args) => {
      const pkg = EFFECTS.read(args[0]);
      if (!pkg) return sendJson(res, { error: `no effect ${args[0]} here - GET /effects lists what is installed` }, 404);
      return sendJson(res, pkg);
    },
    write: { methods: ['PUT', 'DELETE'], run: serveEffectWrite },
  },
  {
    path: '/effects/:id/file/:name',
    pattern: /^\/effects\/([^/]+)\/file\/([^/]+)$/,
    read: (req, res, args) => {
      const bytes = EFFECTS.file(args[0], args[1]);
      if (!bytes) return sendJson(res, { error: `effect ${args[0]} has no file ${args[1]} - GET /effects/${args[0]} lists its files` }, 404);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': bytes.length });
      return res.end(bytes);
    },
  },

  // ---- the packages a page could not compile
  //
  // A namespace of its own, and being outside `/effects/` is the whole reason: this was
  // `POST /effects/refuse` first, and a literal there outranks the `:id` read beside it, so a
  // package directory called `refuse` was listed and then answered 405. Reserving the word missed
  // that an effect id is a directory name and `mkdir` is all it takes.
  { path: '/effect-refusals', pattern: /^\/effect-refusals\/?$/, write: { methods: ['POST'], run: serveEffectRefusal } },

  { path: '/projects/all', pattern: /^\/projects\/all$/, read: (req, res) => listDocuments(res, PROJECTS) },
  // The lookahead reserves the name `all` from documents.
  {
    path: '/projects/:name',
    pattern: /^\/projects\/(?!all$)([^/]+)$/,
    read: (req, res, args) => readDocument(res, PROJECTS, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args, query) => writeDocument(req, res, PROJECTS, args[0], query) },
  },
  {
    path: '/projects/:name/rename',
    pattern: /^\/projects\/([^/]+)\/rename$/,
    write: { methods: ['POST'], run: (req, res, args) => renameDocument(req, res, PROJECTS, args[0]) },
  },
  {
    path: '/presets/:name',
    pattern: /^\/presets\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, PRESETS, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args, query) => writeDocument(req, res, PRESETS, args[0], query) },
  },
  { path: '/deliverables', pattern: /^\/deliverables\/?$/, read: (req, res) => listDocuments(res, DELIVERABLES) },
  {
    path: '/deliverables/:name',
    pattern: /^\/deliverables\/([^/]+)$/,
    read: (req, res, args) => readDocument(res, DELIVERABLES, args[0]),
    write: { methods: ['PUT', 'POST', 'DELETE'], run: (req, res, args, query) => writeDocument(req, res, DELIVERABLES, args[0], query) },
  },

  // ---- the webcam
  //
  // `live` rather than `write`: it changes nothing, but it hands out what the colour camera sees
  // this second. `embeddable`, and the one route that is, because a media source and a plain
  // `<img>` in somebody's overlay are documented uses.
  { path: '/camera.mjpg', pattern: /^\/camera\.mjpg$/, live: true, embeddable: true, read: (req, res) => webcam.attach(req, res) },

  // ---- the sensor
  //
  // A namespace of its own, because the table's first segments each name a subsystem. An entry and
  // not a branch beside the dispatcher: a route answering from anywhere else is one no sweep sees.
  { path: '/sensor/health', pattern: /^\/sensor\/health$/, read: serveSensorHealth },

  // ---- recording
  { path: '/record/state', pattern: /^\/record\/state$/, read: serveRecordState },
  { path: '/record/start', pattern: /^\/record\/start$/, write: { methods: ['POST'], run: serveRecordStart } },
  { path: '/record/stop', pattern: /^\/record\/stop$/, write: { methods: ['POST'], run: serveRecordStop } },
  { path: '/record/mark', pattern: /^\/record\/mark$/, write: { methods: ['POST'], run: serveRecordMark } },

  // ---- the render queue
  { path: '/jobs', pattern: /^\/jobs\/?$/, read: serveJobs, write: { methods: ['POST'], run: serveJobEnqueue } },
  { path: '/jobs/claim', pattern: /^\/jobs\/claim$/, write: { methods: ['POST'], run: serveJobClaim } },
  // The lookahead is why a GET of /jobs/claim answers 405 and not 404: without it `claim` matches
  // `([^/]+)` and is read as a job id, so a route that exists reports itself as one that does not.
  { path: '/jobs/:id', pattern: /^\/jobs\/(?!claim$)([^/]+)$/, read: serveJob },
  { path: '/jobs/:id/finish', pattern: /^\/jobs\/([^/]+)\/finish$/, write: { methods: ['POST'], run: serveJobFinish } },
  { path: '/jobs/:id/heartbeat', pattern: /^\/jobs\/([^/]+)\/heartbeat$/, write: { methods: ['POST'], run: serveJobHeartbeat } },
  { path: '/jobs/:id/requeue', pattern: /^\/jobs\/([^/]+)\/requeue$/, write: { methods: ['POST'], run: serveJobRequeue } },
];

// The namespaces the table owns, taken from the table: every `path` starts with a literal segment,
// and anything else would be a route with no namespace to own. Derived once at module load.
export const OWNED_NAMESPACES = new Set(ROUTES.map((r) => {
  const first = r.path.split('/')[1];
  if (!first || first.startsWith(':')) {
    throw new Error(`route ${r.path} has no namespace segment, so nothing can own it`);
  }
  return first;
}));

// The ids this table takes away from the effect store, derived from the table and held against the
// door's copy. Empty today, because registering a literal under `/effects/` would take that id
// away from every package there will ever be. Held equal rather than imported, since the door is a
// pure module bare node runs and importing this file would import a server that binds a port.
const RESERVED_BY_ROUTES = [...new Set(
  ROUTES.map((r) => r.path.match(/^\/effects\/([^/:]+)$/)?.[1]).filter((seg) => seg !== undefined),
)].sort();
if (RESERVED_BY_ROUTES.join(',') !== [...RESERVED_EFFECT_IDS].sort().join(',')) {
  throw new Error(`the route table claims the effect ids ${RESERVED_BY_ROUTES.join(', ') || '(none)'} and `
    + `RESERVED_EFFECT_IDS names ${[...RESERVED_EFFECT_IDS].sort().join(', ') || '(none)'} - the install door reads `
    + 'the second one, so the two disagreeing is a door reserving a name this table has not claimed or, worse, '
    + 'leaving one it has: a package under a claimed id is listed by GET /effects and refused when the page '
    + 'fetches it, which is a page that does not boot');
}

// A literal route beside `/:name` reserves its segment from documents.
const DOCUMENT_STORES = new Map([['projects', PROJECTS], ['presets', PRESETS], ['deliverables', DELIVERABLES]]);
for (const entry of ROUTES) {
  const namespace = entry.path.match(/^\/([a-z-]+)\/:name$/)?.[1];
  if (namespace === undefined) continue;
  const store = DOCUMENT_STORES.get(namespace);
  if (!store) {
    throw new Error(`/${namespace}/:name files documents by name and no store here owns ${namespace}, so `
      + 'nothing would take the names this table has already claimed under it away from the documents');
  }
  const taken = ROUTES.map((r) => r.path.match(new RegExp(`^/${namespace}/([^/:]+)$`))?.[1])
    .filter((segment) => segment !== undefined)
    .map((segment) => [segment, `/${namespace}/${segment}`]);
  store.reserve(taken);
  for (const [segment] of taken) {
    if (entry.pattern.test(`/${namespace}/${segment}`)) {
      throw new Error(`${entry.path} matches /${namespace}/${segment}, which is a route beside it: the `
        + `${store.kind} store refuses that name, but this entry answering it first is what decides `
        + 'whether the refusal is ever reached');
    }
  }
}

// The pages, and the only URLs they answer at. Deliberately not entries in `ROUTES`: a guard whose
// list contains things it does not guard teaches people to skim it. `/record` and `/edit` are one
// file because the recorder and the editor are one page in two modes.
const PAGES = {
  '/': 'menu.html',
  '/record': 'index.html',
  '/edit': 'index.html',
  '/library': 'library.html',
  '/projects': 'projects.html',
  // The program-out source, which OBS opens as a browser source: the same renderer drawing the
  // same scene, so a second page would be a second renderer to keep in step.
  '/program': 'index.html',
};

// One dispatcher, and the only place a mutating route is let through. Returns false for a path no
// entry claims, so the static file server downstream still gets its turn.
async function serveRoute(req, res, urlPath, query) {
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const offered = new Set();
  for (const r of ROUTES) {
    const m = r.pattern.exec(urlPath);
    if (!m) continue;
    const args = m.slice(1).map((a) => decodeURIComponent(a));
    if (reading && r.read) {
      // A `live` route mutates nothing, so `requireMutation` is the wrong rule - but a page on
      // another origin has no business reading the camera. Asked from the dispatcher, so a live
      // route added later is guarded by declaring itself.
      if (r.live && !originAllowed(req)) {
        sendJson(res, {
          error: `${req.headers.origin} is not this server, and this route serves what the sensor is seeing`,
        }, 403);
        return true;
      }
      // The third gate covers the reads the first two cannot see: `originAllowed` passes a request
      // with no origin, correctly for the peer node - and so does an `<img>` from another page,
      // against a `/capture/:id/file` that streams gigabytes under a guessable id. Default-refused
      // rather than marked route by route, and `sec-fetch-site` absent still passes.
      if (!r.embeddable && !sameOriginBrowser(req)) {
        sendJson(res, {
          error: `this route is not answered to a page on another origin (sec-fetch-site: ${req.headers['sec-fetch-site']})`,
        }, 403);
        return true;
      }
      await r.read(req, res, args, query);
      return true;
    }
    if (!reading && r.write) {
      // The one gate, applied here rather than inside ten handlers: a `write` reaches its handler
      // only through this line.
      if (!requireMutation(req, res, r.write.methods, r.write.contentType)) return true;
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
    // A malformed percent escape such as /%zz throws here, and an exception out of this handler
    // ends the process.
    res.writeHead(400).end('bad request');
    return;
  }

  // The table first, the file tree second: `serveRoute` answers false only for a path no entry
  // claims at all, which is what leaves the viewer, three and the exports directory
  // reachable below.
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

  // `PAGES` is asked before the owned-namespace refusal below, because bare `/record` matches no
  // route and would otherwise 404 the recording page. After the table's own dispatch, so a real
  // route still wins if the two ever meet.
  const page = PAGES[urlPath];
  if (!page && OWNED_NAMESPACES.has(urlPath.split('/')[1])) {
    // A path under a namespace the table owns but matching no entry is a 404 rather than a file
    // lookup, or `/library/../web/main.js` falls through to the static server. Derived from ROUTES,
    // because the five names it used to spell were a list somebody had to extend.
    res.writeHead(404).end('not found');
    return;
  }

  let filePath;
  if (page) {
    filePath = join(WEB_DIR, page);
  } else if (urlPath.startsWith('/vendor/three/')) {
    filePath = join(THREE_DIR, urlPath.slice('/vendor/three/'.length));
  } else if (urlPath.startsWith('/exports/')) {
    // Served so a finished export can be played back in the browser: a video that decodes is the
    // last thing an export has to prove and the only one a metadata check cannot make.
    filePath = join(EXPORTS_DIR, urlPath.slice('/exports/'.length));
  } else {
    // A page under `web/` has exactly one URL and its filename is not a second way in, refused as a
    // class. Lowercased, because APFS is case-insensitive and `extname` is not - `/LIBRARY.HTML`
    // was measured answering 200 before the fold.
    if (extname(urlPath).toLowerCase() === '.html') {
      res.writeHead(404).end('not found');
      return;
    }
    filePath = join(WEB_DIR, urlPath);
  }

  // Resolved through the filesystem and not only through the string: `normalize` folds `..`
  // lexically while `statSync` follows symlinks, so a link inside `web/` passed a comparison about
  // where its name is and was served from where it actually is.
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
    // `pipeline` rather than `pipe`: a bare pipe unpipes when the client walks away and never
    // destroys the file stream, so an aborted page load leaks the descriptor - and this handler
    // serves every asset of every page.
    pipeline(createReadStream(resolved), res, (err) => {
      if (err) console.error(`[server] serving ${urlPath} failed: ${err.message}`);
    });
  } catch {
    res.writeHead(404).end('not found');
  }
});

// Two sockets on one port, routed here rather than by handing each server the http server: `ws`
// aborts an upgrade whose path it does not recognise, so two would destroy each other's handshakes.
const wss = new WebSocketServer({ noServer: true });
// Compression off, said rather than inherited: an export is raw RGBA over loopback precisely so no
// CPU is spent on bytes that were never scarce.
const exportWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });

httpServer.on('upgrade', (req, socket, head) => {
  // The same origin rule the mutating routes stand behind, asked here because a socket is the door
  // it did not cover: `WebSocket` is exempt from the same-origin policy and this one carries the
  // recorder's arm, start and stop. Before the path is routed, so a page from somewhere else does
  // not learn which paths exist by how they are refused.
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
  handleExportSocket(ws, { outDir: EXPORTS_DIR, audioStore: AUDIO });
});

let helloJson = null;
const stats = { frames: 0, dropped: 0, bytes: 0, since: Date.now() };
// The measured byte rate of what is actually arriving, which is what the remaining-time report
// divides free space by. Falls back to the nominal 486KB at 30fps before anything has arrived.
let observedBytesPerSec = 0;
const recordingRate = () => (observedBytesPerSec > 0 ? observedBytesPerSec : undefined);
// Kept beside the byte rate rather than derived from it: a link delivering half the frames at full
// size and one delivering every frame at half size are the same MB/s and different faults.
let observedFps = 0;

// Empty windows included, and deliberately not the same age as the rates above: a window with no
// frames has no rate, but its length and frame count are what say the sensor stopped delivering.
let lastWindow = null;

// Accumulated as each window closes so the hot path is untouched, and monotonic because a number
// that resets cannot answer "has this link been dropping frames".
let droppedTotal = 0;

// How many grabbers this process has started. At module scope because the supervisor's `attempt`
// cannot answer it: `attempt` indexes the backoff table and is zeroed on a clean handshake, so it
// says how long until the next try and nothing about how often the sensor has dropped.
let grabberSpawns = 0;

// And how many of those starts somebody asked for, because counting a colour toggle with the rest
// turns "this node is flapping" into a number a checkbox produces. Counted where the exit is
// *consumed*, or an arm that never becomes a spawn subtracts a respawn that did happen.
let grabberRestarts = 0;

let sensorState = 'starting';

function broadcastText(text) {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(text);
}

function setSensorState(state) {
  sensorState = state;
  broadcastText(JSON.stringify({ status: state }));
  // The webcam cannot outlive the sensor being live, and hanging it off the state change rather
  // than off each path that causes one keeps a route added later from missing a case.
  if (state !== 'live') webcam.setUnavailable(`the sensor is ${state}`);
}

// Colour on/off has to restart the grabber because it decides which streams the device is told to
// open; low light is a command the running grabber applies in place.
const camera = { color: !NO_COLOR, lowLight: true };
let applyCamera = null; // wired up by startLive; absent in replay

// What each monitor asked for, and whether its frames cross a network. Held beside the socket, so
// nothing about a client's settings survives the socket it was negotiated on.
const monitors = new WeakMap();

// Whether this socket's frames leave the machine. What it answers is "this connection arrived on
// loopback", which is not "this browser is on this machine": a forwarded port terminates here, so a
// tunnelled browser reads as local. That is the setup `SECURITY.md` recommends working, because
// the operator who built the tunnel authenticated to the host.
const isLoopback = (req) => {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

// A whole number in range, or null. Null rather than a clamp, because a monitor that asked for 64
// and silently got 16 is one whose displayed setting is not the setting.
const whole = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);

wss.on('connection', (ws, req) => {
  ws.binaryType = 'nodebuffer';
  // A loopback socket starts at full rate, its frames never crossing the link the cap is about. A
  // remote one is ineligible until it asks, and finer than the cap is refused rather than clamped.
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

    // Answered on every attempt, accepted or not, so the client renders what it was granted: one
    // that assumed its request took effect would draw a `÷4` label over a full-rate stream.
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
      // A refused request leaves an existing grant untouched; on a monitor with no grant yet the
      // requested setting is stored, so a later acceptMonitorCost can take it.
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

    // Relayed rather than interpreted: `web/main.js`'s registry is the only thing that knows what a
    // parameter means, so one added next year reaches the program-out page without this changing.
    // To others only, or a surface applies its own writes twice and mirror mode fights the hand.
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

// `wouldRefuseRecording` is the positive half of the refusal: the record button can say so before
// it is pressed rather than the operator meeting a 409 mid-shot.
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

// All three terms matter: an ungranted remote monitor is not yet on the wire, and finer than the
// cap on loopback is free.
const costsTheTake = (m) => !m.loopback && m.granted && (m.divisor < RECORDING_CAP.divisor || m.stride < RECORDING_CAP.stride);

// Which frame this is, for the stride. Counted over every frame the grabber delivered rather than
// per client, so two monitors at one stride land on the same frames and cost one link's bytes.
let frameSeq = 0;

function broadcastFrame(payload) {
  frameSeq++;
  // `stats` is what the library divides free space by, so it counts the frame that arrived and
  // never the frame that went out - a monitor at ÷4 does not make the take smaller.
  stats.frames++;
  stats.bytes += payload.length;

  // The common case on a node mid-shoot is nobody watching, and it costs nothing here.
  if (wss.clients.size === 0) return;

  // Sampled at most once per divisor per frame, and only for a divisor somebody asked for.
  const byDivisor = new Map([[1, payload]]);

  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const m = monitors.get(ws);
    if (!m || !m.granted) continue;
    // Strided out, which is not dropped: a dropped frame is a monitor that could not keep up, this
    // is one that asked not to be sent it.
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
        // A frame whose declared lengths do not describe it is refused rather than sampled past,
        // and one bad frame must not take the fan-out down with it.
        console.error(`[server] cannot decimate for a monitor at divisor ${m.divisor}: ${err.message}`);
        out = null;
      }
      byDivisor.set(m.divisor, out);
    }
    if (out) ws.send(out);
  }
}

// Asks the grabber to start or stop encoding the colour camera. Absent in replay, because a capture
// on a loop has no colour camera and the webcam says so rather than serving recorded frames.
let requestHdColor = null;

// Created out here rather than inside `startLive`, because the route has to answer on a machine
// where no grabber ever starts: an editing station should say why the camera is unavailable.
const webcam = new Webcam({
  request: (wanted) => requestHdColor?.(wanted),
});
if (REPLAY) {
  webcam.setUnavailable(`this server is replaying ${basename(REPLAY)}, so there is no colour camera to serve`);
}

// One take is one file, and the recorder holds that identity. Created here rather than inside
// `startLive`, so the routes reach it whether or not a sensor ever appears.
const recorder = new Recorder({
  dir: CAPTURES_DIR,
  // Two ways to have nothing worth recording, and the second is why this is a function: a machine
  // with no sensor is a discovery rather than a configuration. A replay loops, so
  // its frames repeat.
  cannotRecord: () => (REPLAY
    ? `this server is replaying ${basename(REPLAY)} rather than reading a sensor, and a replay loops `
      + '- its frames repeat their own timestamps, so what it wrote would not be a take'
    : sensorState === 'absent'
      ? 'no Kinect v2 on this machine, so there is nothing here to record - this is the editing '
        + 'side of the link, and takes are shot on the node'
      : null),
  // So the refusal to start a take and the remaining-time readout divide by the same number.
  rateOf: () => recordingRate(),
  // Every monitor sees the recording state change: the control arrives over HTTP, the state comes
  // back on the socket every client is already listening to.
  onChange: (state) => broadcastText(JSON.stringify({ recording: state })),
});

function handleMessage(msg) {
  if (msg.type === TYPE_HELLO) {
    helloJson = msg.payload.toString('utf8');
    console.log(`[server] sensor: ${helloJson}`);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(helloJson);
    // A take begins at a hello and nowhere else, which is what makes a restart split rather than
    // corrupt: the file that was open is already closed by the time this runs.
    recorder.onHello(helloJson);
  } else if (msg.type === TYPE_FRAME) {
    // Broadcast first, then record: both happen in this turn either way, and what the order decides
    // is which one a failure in the other can take down.
    broadcastFrame(msg.payload);
    // The whole message rather than the payload, so the take carries the framing the format is
    // defined by. The replay loop did not supply it and every frame became a throw in its catch.
    recorder.write(msg.raw);
  } else if (msg.type === TYPE_COLOR) {
    // The webcam and nothing else: there is deliberately no `recorder.write` here. A capture file
    // is the wire verbatim, so a type 3 in one would move the content hash of every take - the key
    // the library joins two machines on. Issue #9 carries what it would take, and
    // `vcam-check --mutate hd-reaches-recorder` adds the write back and has to fail.
    //
    // The payload is [u64 timestampMs][JPEG], and the JPEG goes out untouched.
    webcam.offer(Buffer.from(msg.payload.subarray(8)), Number(msg.payload.readBigUInt64LE(0)));
  }
}

setInterval(() => {
  // The window closes before anything decides whether it was interesting: with the reset past the
  // early return, an empty window was never closed and after a sixty-second drop the next window's
  // frames were divided by sixty-five seconds, into the readout that promises card space.
  const closed = { ms: Date.now() - stats.since, frames: stats.frames, dropped: stats.dropped, bytes: stats.bytes };
  Object.assign(stats, { frames: 0, dropped: 0, bytes: 0, since: Date.now() });
  lastWindow = { ms: closed.ms, frames: closed.frames };
  droppedTotal += closed.dropped;
  // What stays behind the return is the derived rate, deliberately left stale: a window that
  // carried no frames has no rate in it, and the length and frame count above are what say so.
  if (closed.frames === 0) return;
  const dt = closed.ms / 1000;
  const fps = (closed.frames / dt).toFixed(1);
  const mbs = (closed.bytes / dt / 1e6).toFixed(1);
  observedBytesPerSec = closed.bytes / dt;
  observedFps = closed.frames / dt;
  console.log(`[server] ${fps} fps  ${mbs} MB/s  dropped=${closed.dropped}  clients=${wss.clients.size}`);
}, 5000);

// The Kinect v2 drops off the bus under sustained load on a marginal USB link, so a dead grabber
// is an expected condition rather than a fatal one.
const RESTART_DELAYS = [1000, 2000, 4000, 8000];

// How long to leave between attempts once the conclusion is that there is no sensor here. Long,
// because the enumeration will not find one - but not never, so a sensor plugged in
// later is picked up.
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
  // Whether a sensor has ever handshaken with this process. Monotonic on purpose: it separates
  // "the link dropped" from "nothing is plugged in here", which are one event at the exit handler.
  let everLive = false;

  // A killed grabber never ran libfreenect2's teardown, so the kernel is still reclaiming the USB
  // device and an immediate respawn loses the race - measured, on the first attempt
  // of every toggle.
  const STOP_GRACE_MS = 2000;
  const RESPAWN_AFTER_KILL_MS = 1500;
  const RESPAWN_AFTER_CLEAN_MS = 250;
  let killedHard = false;

  // SIGTERM alone is not enough and the failure is silent: the grabber leaves its loop and blocks
  // in libfreenect2's `dev->stop()` with transfers in flight, and every restart runs through the
  // `exit` handler, so the respawn never happens. Observed as eight minutes with no frames.
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
    // On a restart the grace period must not hold the process up, so it is unreferenced. On the way
    // out it is the opposite: the sensor would stay claimed by an orphan, which fails the *next*
    // server's enumeration as a broken Kinect.
    if (!holdProcessOpen) timer.unref?.();
    dying.once('exit', () => clearTimeout(timer));
  };

  // Reached from the two ways a grabber can fail to be running: it exited, or it never started.
  // Written out only in the exit handler before, which is why the second way had no backoff.
  const scheduleRetry = () => {
    // A grabber that has *never* handshaken is a machine with no sensor rather than the flaky USB
    // link this backoff is for. The full table is spent first, because a node whose sensor is slow
    // to enumerate at boot is the same shape for a few seconds.
    const absent = !everLive && attempt >= RESTART_DELAYS.length;
    setSensorState(absent ? 'absent' : 'lost');
    const delay = absent ? ABSENT_DELAY : RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)];
    attempt++;
    // Once absent, said once, or this line and libfreenect2's enumeration run every few seconds
    // for as long as the editing station is up.
    if (!absent) console.log(`[server] restarting grabber in ${delay}ms (attempt ${attempt})`);
    else if (attempt === RESTART_DELAYS.length + 1) {
      console.log(`[server] no sensor found in ${attempt} attempts - looking again every ${ABSENT_DELAY / 1000}s`);
    }
    setTimeout(spawnGrabber, delay);
  };

  const spawnGrabber = () => {
    // Counted here rather than in the backoff, because every road to a running grabber ends at
    // this function, so a path added later is counted by going through it.
    grabberSpawns++;
    const grabberArgs = buildArgs();
    console.log(`[server] starting grabber: ${bin} ${grabberArgs.join(' ')}`);
    setSensorState('starting');

    const parser = new MessageParser();
    // stdin is a pipe, so settings that need no restart reach the running grabber.
    const proc = spawn(bin, grabberArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    child = proc;
    child.stdin.on('error', () => { /* the grabber can exit mid-write */ });
    // A grabber that cannot be spawned at all arrives as an `error` rather than an exit, and an
    // unhandled one takes the whole process down. Backing off is the rest of it: every retry here
    // hangs off `exit`, which a failed spawn never emits, so a server started before its binary was
    // built never spawned again. Routed through the same `scheduleRetry` the exit path uses.
    child.on('error', (err) => {
      console.error(`[server] grabber could not start: ${err.message}`);
      if (shuttingDown) return;
      // Only when no process was ever created: `error` also fires when a signal cannot be delivered
      // to a grabber running perfectly well, and `exit` then schedules the retry itself. `proc`
      // rather than `child`, because a later spawn may already have reassigned it.
      if (proc.pid !== undefined) return;
      // Nothing to signal and no stdin to write to, so it must not look live to the colour toggle
      // or to `stopGrabber`, which would kill a pid that does not exist and wait out its grace.
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
            // A new grabber has never heard of the subscriber still attached and its encoder starts
            // off, so without this the webcam comes back open, subscribed and permanently silent.
            // This is also the one place it becomes available at all.
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
      // The reference goes with the process, on the same identity test the `error` handler uses:
      // nothing cleared it before, so for the whole backoff `child` was a truthy corpse and a
      // colour toggle landing in that window armed `restarting` against something that could
      // neither be signalled nor exit again. `child === proc` rather than an unconditional null,
      // because a later spawn may already own the reference.
      if (child === proc) child = null;
      // The hello goes with the grabber that sent it: `/record/start` stamps a take with whatever
      // is in here, so a take started during a drop carried a hello describing a moment before it
      // was shot. Nulled rather than refused, so the next `onHello` opens the take.
      helloJson = null;
      // The picture goes with the grabber too, said as a sentence: a webcam that answers "the
      // grabber is restarting" is one somebody waits three seconds for rather than debugs.
      webcam.setUnavailable('the grabber is restarting');
      // The take ends here. One take is one continuous stream with one hello and monotonic stamps,
      // and a blend fraction across a restart seam has no meaning. Nothing is discarded.
      recorder.split().catch((err) => console.error(`[recorder] ${err.message}`));
      if (shuttingDown) return;
      if (restarting) {
        // Asked for, not a failure, so it counts toward neither the backoff nor the respawns
        // `/sensor/health` reports. This is the one place that knows the difference.
        restarting = false;
        const delay = killedHard ? RESPAWN_AFTER_KILL_MS : RESPAWN_AFTER_CLEAN_MS;
        killedHard = false;
        // Counted beside the spawn it excuses: `respawns` is `grabberSpawns - 1 - grabberRestarts`,
        // so incrementing on the exit makes that subtraction run one ahead of itself for the gap.
        setTimeout(() => { grabberRestarts++; spawnGrabber(); }, delay);
        return;
      }
      scheduleRetry();
    });
  };

  // One line down the grabber's own stdin command channel. Refused rather than sent when colour is
  // off, so the webcam hears the reason from the side that knows it.
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
      // `restarting` is a claim about an exit that is coming, so it is only armed when there is a
      // child whose exit it describes: with none, `stopGrabber` returns on the spot and the flag
      // stays set until the *next* grabber's real failure takes the restart branch. Which is why
      // this reads `child` rather than a flag of its own. Nothing is lost, because the setting
      // reaches the grabber through `buildArgs` on the spawn already scheduled.
      //
      // Turning colour off drops a live webcam, allowed rather than refused: this puts a legible
      // reason in front of whoever loses the picture.
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
    // Colour off means there is no exposure to set, but the flag is remembered for when it returns.
    if (camera.color) {
      console.log(`[server] low light ${camera.lowLight ? 'on' : 'off'}`);
      child?.stdin.write(`low-light ${camera.lowLight ? 'on' : 'off'}\n`);
    }
  };

  // Armed at boot rather than recording at boot, so there is one path into a take file. Armed
  // *before* the grabber is spawned, because a hello arriving during that disk read would find the
  // recorder disarmed and start no take at all.
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
    // Closed and scanned before the process goes, because a take without a sidecar is one the
    // library has to rebuild. A courtesy: the guarantee is that the bytes are already on disk.
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
      // Anything else is a real failure of the reader. A blanket catch here reported every error
      // as a missing file, which is how a capture the reader refused looked like one nobody shot.
      console.error(`[server] cannot open ${REPLAY}: ${err.message}`);
    }
    return;
  }

  // Retained, because this reader outlives every request and holds no lease of its own. A replay
  // whose descriptor is evicted reports every read afterwards as a lost sensor.
  capture.retain();

  // The replayed take is reachable over the frame API under its own id even from outside the
  // captures directory.
  captureAliases.set(captureIdFor(REPLAY), resolve(REPLAY));

  const stamps = capture.index.frames.stampMs;
  if (stamps.length === 0) {
    console.error('[server] replay file contains no frames');
    return;
  }

  console.log(`[server] replaying ${REPLAY}`);
  const hello = await capture.readHello();
  if (hello) handleMessage({ type: TYPE_HELLO, payload: hello, raw: encodeMessage(TYPE_HELLO, hello) });

  // The recorded arrival spacing rather than a uniform 30fps: a live stream is deeply irregular -
  // measured p50 64ms against p90 222ms - so interpolation tuned against a uniform replay stutters.
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((g) => g > 0 && g < 2000);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 33;
  gaps.push(median);

  console.log(
    `[server] ${stamps.length} frames indexed, median gap ${median}ms, ${capture.index.hash}`,
  );

  // A replayed take is as live as this server gets, which is what gives `lost` something to mean.
  setSensorState('live');

  let i = 0;
  let failing = false;
  const schedule = () => {
    const gap = gaps[i % gaps.length];
    i++;
    setTimeout(tick, gap);
  };
  // Each frame is read when it is due, so a five-minute take costs what a nine-second one does.
  // The read is awaited before the timer is set, measured at 0.07-0.6ms against a 64ms median.
  const tick = () => {
    capture
      .readFrame(i % stamps.length)
      .then((payload) => {
        if (failing) {
          failing = false;
          console.log('[server] replay reads recovered');
          setSensorState('live');
        }
        // A whole message, framing included, because that is what `handleMessage` takes. The replay
        // handed over a bare payload with no `raw`, unnoticed until a take was open.
        handleMessage({ type: TYPE_FRAME, payload, raw: encodeMessage(TYPE_FRAME, payload) });
        schedule();
      })
      .catch((err) => {
        // A read that fails must not freeze the loop in silence: a viewer holding its last frame
        // looks exactly like a paused take. Logged on the transition only.
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

// Created rather than assumed: a reflashed node has none, and without this it boots disarmed with
// a raw ENOENT coming back through `/record/state`. A directory that cannot be created is reported
// and the server still comes up, because the library is what somebody would open to find out why.
try {
  mkdirSync(CAPTURES_DIR, { recursive: true });
} catch (err) {
  console.error(`[server] no captures directory at ${CAPTURES_DIR} and it could not be made: ${err.message}`);
}

httpServer.listen(PORT, HOST, () => {
  // First thing inside the bind and before the line announcing it: the boot gate renames
  // directories under the effects root, and the port is what says this process is entitled to.
  // Ahead of the log line, because `effect-check` asserts on this stream.
  EFFECTS.claimUserRoot();
  console.log(`[server] viewer on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== LOOPBACK) {
    console.log(`[server] reachable from the network on ${HOST} - anyone who can route here can drive the recorder`);
  }
  if (REPLAY) startReplay().catch((err) => console.error(`[server] replay failed: ${err.message}`));
  else startLive();
});
