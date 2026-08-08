// The encoder end of an export: raw RGBA frames arrive over a WebSocket and go
// straight into ffmpeg's stdin.
//
// Raw is the whole point rather than a first draft. RGBA is exactly ffmpeg's
// `rawvideo` input format, so there is no encode step in the browser, no decode
// step here, and no generation loss before the codec runs. 1080p RGBA is 8.3MB a
// frame, which only looks alarming until you notice the browser and the encoder
// are always on the same machine: this is loopback, loopback sustains gigabytes a
// second, and compressing first would spend CPU - the scarce resource in a
// slower-than-realtime render - to save bandwidth that was never scarce. The
// socket is created with permessage-deflate off for the same reason, explicitly
// rather than by relying on the library's default.
//
// Flow control is an ack per frame against a small window. The browser can render
// faster than ffmpeg encodes on a cheap look, and without a window the frames
// would queue in this process's memory - eight megabytes at a time - behind a
// stdin that is not draining. The window is small because there is nothing to
// hide: a render is tens of milliseconds and a loopback round trip is tens of
// microseconds.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile, stat, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Absolute rather than resolved off PATH: this is the encoder the export was
// measured against, and a different one found on a different PATH would be a
// different result reported under the same name.
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';

// How many frames may be in flight. Four absorbs a hitch in the encoder without
// letting this process hold more than about 33MB of 1080p frames.
//
// That ceiling is a courtesy the client extends rather than a property this server
// enforces, and the difference matters the day a second client exists. Nothing
// below counts unacked frames: a browser that ignored the window could send all
// `frames` messages as fast as the socket takes them, and they would queue here
// behind a stdin that is not draining. The bound holds today because the only
// client is this server's own page, which waits. Enforcing it would mean pausing
// the socket past the window - `ws` can do it - and that is a change to make when
// something other than the page connects, not a claim to make now.
const ACK_WINDOW = 4;

// 4K RGBA is 33MB, so the ceiling is set well above the largest frame anything
// is going to ask for and below "whatever arrives".
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;

// Exported so the render queue can refuse a name at enqueue rather than three
// layers later. One rule with two callers, the same shape `originAllowed` took:
// a second copy of this regex in `server/jobs.js` would be a second rule to keep
// honest, and the one thing it decides is where a file gets written.
export const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The output a request asks for. Four, and they are a table rather than four paths:
 * the frames, the flow control, the record that lands beside the artifact and the
 * unique directory both land in are the same whichever entry is picked, and every
 * way they differ is a field here that the code below reads.
 *
 * `lossless` exists because it is the only way to prove the file contains the
 * frames the browser rendered. ffv1 in rgb24 decodes back to exactly the bytes
 * that went in, so a round trip is a byte comparison rather than an argument
 * about how much codec loss is acceptable - which makes orientation, channel
 * order, frame order and frame count one assertion instead of four proxies.
 *
 * `prores` is the QuickTime deliverable, and it holds ProRes 422 HQ rather than
 * h264 in a `.mov` because a mov is asked for by the tool an edit gets handed to
 * next: an intermediate that survives being cut and graded again, where h264 has
 * already thrown away what that tool wanted.
 *
 * `pngseq` is the entry that is not a file. It writes numbered frames into a
 * directory through ffmpeg's image2 muxer, which is what `frameExt` is for: it
 * names what one frame is called, and by being null everywhere else it is also the
 * answer to "is this artifact a directory". One field rather than a flag beside an
 * extension, because two fields can disagree about the same thing and one cannot.
 *
 * The artifact is `<name>.<ext>` for every entry including that one - `.pngseq` is
 * a directory wearing an extension - so the sidecar's name, the URL the page is
 * handed and the per-export directory stay one rule with no branch in them, and
 * what is actually at that path is a question only the two places that open it ask.
 *
 * `evenDimensions` is a property of the entry rather than a comparison against its
 * name, because yuv420p subsamples chroma by two in each direction and an odd
 * dimension has no half-pixel to carry - which is a fact about the pixel format an
 * entry names, not about the string `h264`. Measured for each entry rather than
 * inferred from the family it belongs to: libx264 refuses 641x401 outright, while
 * prores_ks in yuv422p10le encodes it and decodes back to 641x401 byte for byte, so
 * the entry that looks like it ought to need the rule does not get it for looking.
 *
 * Stated on **every** entry rather than only where it bites, and the same for
 * `frameExt`: an entry that may simply omit a field is an entry that opts out of the
 * rule by saying nothing, and a format added later would then inherit the exemption
 * silently, which is the whole failure this move exists to remove.
 *
 * Which is why the loop below exists rather than the convention being left to the
 * example. `spec.evenDimensions && ...` reads a missing field as false and a missing
 * `frameExt` reads as "not a sequence", so writing them is a habit and not a rule - a
 * fifth format added without them would inherit exactly the silent exemption the
 * paragraph above says has been removed, and the sentence would be an assertion about
 * the table rather than a property of it. At module load and throwing, because a
 * malformed entry here is a typo in a constant and not a condition to be handled: the
 * alternative is discovering it at the first odd-dimensioned export, which is the
 * class of late discovery this whole change is about. It has no falsification control
 * for the same reason the dimension rule itself has none - every entry is well formed,
 * so a mutation removing this loop changes nothing observable, and an assertion that
 * cannot fire buys confidence with a number.
 */
const CODECS = {
  h264: {
    ext: 'mp4',
    frameExt: null,
    evenDimensions: true,
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'],
  },
  lossless: {
    ext: 'mkv',
    frameExt: null,
    evenDimensions: false,
    args: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'rgb24'],
  },
  prores: {
    ext: 'mov',
    frameExt: null,
    evenDimensions: false,
    args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],
  },
  pngseq: {
    ext: 'pngseq',
    frameExt: 'png',
    evenDimensions: false,
    // **`-f image2` said rather than inferred.** ffmpeg picks the muxer off the last
    // extension of the output path and does land on image2 for this one - measured,
    // both spellings write the same three files - but this is the only entry whose
    // path is a printf pattern inside a directory that carries its own extension, so
    // the inference is being made over a name with three dots in it and the muxer
    // that decides whether this is a hundred stills or one animated file is worth a
    // word. rgb24 because the drawing buffer the frames are read out of has no alpha
    // channel (the renderer is constructed without one), so an rgba sequence would
    // store a constant 255 per pixel and call it transparency information.
    args: ['-c:v', 'png', '-f', 'image2', '-pix_fmt', 'rgb24'],
  },
};
for (const [name, spec] of Object.entries(CODECS)) {
  if (typeof spec.evenDimensions !== 'boolean') {
    throw new Error(`codec ${name} does not say whether it needs even dimensions, and a codec that says nothing about a rule is exempt from it by accident`);
  }
  if (spec.frameExt !== null && typeof spec.frameExt !== 'string') {
    throw new Error(`codec ${name} does not say whether its artifact is one file or a directory of frames, and a codec that says nothing is taken for a file`);
  }
  if (typeof spec.ext !== 'string' || !Array.isArray(spec.args)) {
    throw new Error(`codec ${name} is missing the extension or the arguments every export path dereferences`);
  }
}

// Exported so the queue can validate a job before it is claimed. One rule with two
// callers, the same shape `originAllowed` took: a second copy of this code in
// `server/jobs.js` would be a second rule to keep honest.
export function validateExport({ name, width, height, fps, frames = null, codec }) {
  if (!VALID_NAME.test(String(name ?? ''))) {
    throw new Error(`bad output name ${JSON.stringify(name)}: it names a file in the exports directory, so it is letters, digits, dot, dash and underscore`);
  }
  const w = Number(width);
  const h = Number(height);
  const f = Number(fps);
  if (!Number.isInteger(w) || w <= 0) throw new Error(`bad output size ${width}x${height}`);
  if (!Number.isInteger(h) || h <= 0) throw new Error(`bad output size ${width}x${height}`);
  // **`Object.hasOwn` rather than truthiness, because a plain object answers for its
  // prototype.** `CODECS['toString']` is a function and therefore truthy, so
  // `"codec": "toString"` - and `constructor`, `valueOf`, `__proto__` - walked past
  // this validator, took the enqueue, reserved an output name, and then died a minute
  // later inside `begin` with `CODECS[codec].args is not iterable`, which is the exact
  // place `server/jobs.js` calls out as where an unknown codec must never first be
  // discovered. Nothing an attacker chose ever reached ffmpeg's argv - `.args` is
  // undefined for every inherited key - so what this costs is a job admitted and a
  // worker's minute, not an injection.
  //
  // Resolved here rather than at the bottom because the dimension rule below reads the
  // entry: the lookup has to happen before anything can ask the entry a question.
  const spec = Object.hasOwn(CODECS, codec) ? CODECS[codec] : null;
  if (!spec) throw new Error(`unknown codec ${codec}`);
  if (spec.evenDimensions && (w % 2 || h % 2)) {
    throw new Error(`${codec} needs even dimensions, got ${w}x${h}`);
  }
  if (!Number.isFinite(f) || f <= 0) throw new Error(`bad output rate ${fps}`);
  if (frames !== null) {
    const fc = Math.trunc(frames);
    if (!Number.isInteger(fc) || fc <= 0) throw new Error(`an export of ${frames} frames has nothing to encode`);
  }
  const frameBytes = w * h * 4;
  if (frameBytes > MAX_FRAME_BYTES) {
    throw new Error(`a ${w}x${h} frame is ${frameBytes} bytes, past the ${MAX_FRAME_BYTES} ceiling`);
  }
  return { width: w, height: h, fps: f, frames: frames !== null ? Math.trunc(frames) : null, codec };
}

// Distinguishes one export's scratch file from another's within this process. The
// name never reaches the file's bytes - `-fflags +bitexact` is what makes that
// true, and the determinism claim, which runs two exports through two sockets and
// compares the finished files, is what keeps it true.
let sequence = 0;

/**
 * Where ffmpeg is told to write, given the artifact this export is building.
 *
 * A single-file format writes the artifact itself. A sequence writes numbered frames
 * *inside* it, so the artifact is a directory and the target is a printf pattern under
 * it - six digits, which runs to nine hours at 30fps and widens rather than wrapping
 * past that, so the numbers sort in the order the frames were rendered at any length.
 * The export's name is repeated in every frame because a sequence is the one artifact
 * that gets taken apart: the frames are dragged into a compositor by the handful, and
 * a directory of `000001.png` says nothing about which render they came out of.
 */
function encodeTarget(spec, artifact, name) {
  if (spec.frameExt === null) return artifact;
  return join(artifact, `${name}.%06d.${spec.frameExt}`);
}

/**
 * How big the thing this export produced is - and, for a sequence, whether it is all
 * there.
 *
 * `stat` is the size and the existence check at once for a single file, and it is
 * neither for a directory: it answers with the inode's own size, so a sequence that
 * wrote nothing at all would report a plausible few hundred bytes and land as a
 * successful export of an empty directory. So the frames are added up, which is the
 * same walk that can count them - and the count is worth asserting because it is the
 * one thing a video file cannot be asked cheaply: image2 writes exactly one file per
 * frame it is given, so a directory holding a different number is an encoder that
 * dropped or overwrote frames rather than a deliverable. It throws before the sidecar
 * is written and before the rename, so a short sequence reaches `fail` and is removed
 * with the rest of the scratch.
 *
 * The sizes are read one `stat` at a time and the bytes are never opened. Nothing here
 * may read a frame, let alone a capture - `readFileSync` throws above 2 GiB and a
 * sequence is exactly the artifact that gets there.
 */
async function artifactBytes(spec, artifact, frames) {
  if (spec.frameExt === null) return (await stat(artifact)).size;
  // Frames rather than entries, because the message this throws blames the encoder and
  // an entry is not always one: `exports/` is a directory people open in a file
  // manager, and one `.DS_Store` dropped in by a look around would fail a sequence that
  // is entirely correct, under a sentence saying the encoder lost a frame.
  const names = (await readdir(artifact)).filter((n) => n.endsWith(`.${spec.frameExt}`));
  if (names.length !== frames) {
    throw new Error(`the sequence at ${artifact} holds ${names.length} frames and the export sent ${frames}`);
  }
  let total = 0;
  for (const name of names) total += (await stat(join(artifact, name))).size;
  return total;
}

function ffmpegArgs({ width, height, fps, codec, into }) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    // Bit-exact on both sides of the muxer: without it the container carries the
    // encoder's version string and a creation time, so the same frames would
    // produce a different file every run and "the same export twice" could not be
    // asked about the file at all.
    '-fflags', '+bitexact',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    // readPixels reads the drawing buffer bottom-up, which is upside down to every
    // video format. Flipping here rather than in the browser keeps the CPU cost on
    // the side of the pipe that is not also rendering.
    '-vf', 'vflip',
    ...CODECS[codec].args,
    '-flags:v', '+bitexact',
    '-r', String(fps),
    '-y', into,
  ];
}

/**
 * One export, from the begin message to the file.
 *
 * Everything is validated against what the browser said it would send rather than
 * accepted as it arrives. A frame of the wrong length is the failure this has to
 * catch loudly - ffmpeg's rawvideo demuxer would happily read a short frame as
 * the head of the next one and produce a file that plays, scrolls diagonally, and
 * says nothing about why.
 */
export function handleExportSocket(ws, { outDir, log = console.log }) {
  let job = null;
  let child = null;
  let received = 0;
  let bytes = 0;
  let ended = false;
  let finished = false;
  const frameHashes = [];
  const streamHash = createHash('sha256');
  const stderr = [];
  let queue = Promise.resolve();

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const fail = async (message) => {
    if (finished) return;
    finished = true;
    log(`[export] ${message}`);
    send({ error: message });
    if (child && child.exitCode === null) child.kill('SIGKILL');
    // A killed encoder leaves a file that opens and is not a video, so it goes -
    // but the only files this run may remove are the ones in its own scratch
    // directory. Reaching for `job.output` here was a real bug with an ordinary
    // path into it: the export name defaults to the take's id, so "tweak the look
    // and export again" reuses it, and a second run that died after a frame deleted
    // the good file from the first while leaving that run's sidecar behind - a job
    // record asserting a successful export of a path with nothing at it. It did not
    // need the encode to fail either: an ffmpeg that never spawned took the same
    // branch and deleted a file this run had not written a byte of. The scratch now
    // lives in a per-export temp directory, so the whole directory is removed and
    // nothing outside it is touched.
    if (job) await rm(job.temp, { recursive: true, force: true }).catch(() => {});
    ws.close();
  };

  const begin = async (msg) => {
    const { width, height, fps, frames, codec } = validateExport({
      name: msg.name, width: msg.width, height: msg.height, fps: msg.fps,
      frames: msg.frames, codec: msg.codec ?? 'h264',
    });

    const spec = CODECS[codec];
    const ext = spec.ext;
    // A unique directory per export makes `rename(temp, final)` target a fresh
    // path, so the video and its sidecar land together without replacing any
    // existing artifact. The requested name is the base for both the directory
    // and the artifact inside it, whichever format was asked for: `<name>.<ext>`
    // is where the deliverable is, and whether that is a file or a directory of
    // numbered frames is what the entry's `frameExt` says rather than something
    // any of this arithmetic has to know.
    const dirName = `${msg.name}.${process.pid}-${++sequence}`;
    const outputDir = join(outDir, dirName);
    const output = join(outputDir, `${msg.name}.${ext}`);
    const frameBytes = width * height * 4;
    const temp = join(outDir, `${dirName}.part`);
    const scratchArtifact = join(temp, `${msg.name}.${ext}`);
    // What ffmpeg is handed, which is the artifact for a file and a pattern inside it
    // for a sequence. Nothing below reads it except the spawn and the directory that
    // has to exist first.
    const target = encodeTarget(spec, scratchArtifact, msg.name);
    // The same file as a URL. `output` is an absolute path on this machine, which is
    // the right thing for a log line and useless to the page that asked for the
    // render - it cannot fetch it, so it could not offer to save a copy of it
    // anywhere. The static handler already serves this prefix out of the exports
    // directory behind an `isInside` check, and both segments come from a name
    // `validateExport` has already held to letters, digits, dot, dash and underscore.
    const href = `/exports/${dirName}/${msg.name}.${ext}`;
    // **Assigned before the first await, because `job` is what says an export is
    // already running.** The message handler refuses a second `begin` by finding
    // this non-null, and it used to be set after the directory was made - so two
    // begins in one tick both reached that test with nothing there, both passed, and
    // the second overwrote the first's record. The first ffmpeg then had no reader
    // for its stdin and nothing that could name its scratch directory: unreachable,
    // blocked forever on a stream nobody closes, with `fail` pointed at the second
    // export's paths. Everything above is arithmetic on validated values, so there is
    // nothing to wait for before claiming the socket.
    job = {
      width, height, fps, frames, codec, frameBytes, output, outputDir, temp, scratchArtifact, href, name: msg.name, began: Date.now(),
      project: msg.project ?? null,
      capture: msg.capture ?? null,
      renderer: msg.renderer ?? null,
    };

    // Recursive, so this makes the exports directory as well as the scratch inside
    // it - one call, on the path this run is actually going to write. The directory
    // the *target* is in rather than the scratch directory, which is the same thing
    // for a single file and one level deeper for a sequence: the image2 muxer opens
    // each frame by name and creates nothing, so a sequence whose directory is only
    // made by the rename at the end dies on its first frame with an errno nobody
    // reading `[export] ffmpeg exited 1` would connect to a missing directory.
    await mkdir(dirname(target), { recursive: true });
    const args = ffmpegArgs({ width, height, fps, codec, into: target });
    log(`[export] ${FFMPEG} ${args.join(' ')}`);
    child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
    child.on('error', (err) => fail(`ffmpeg could not start: ${err.message}`));
    child.stdin.on('error', () => { /* reported through the exit code instead */ });
    child.on('exit', (code, signal) => {
      if (finished) return;
      // Before the end message means it died mid-encode, and the stderr it wrote
      // is the only useful thing anyone will get.
      if (!ended || code !== 0) {
        fail(`ffmpeg exited ${code ?? signal}${stderr.length ? `: ${stderr.join('').trim()}` : ''}`);
        return;
      }
      finish().catch((err) => fail(String(err.message ?? err)));
    });

    // `frameExt` travels to the page for the same reason it exists here: `href` is a
    // URL the page can fetch to save a copy of the render, and for a sequence it names
    // a directory, which the static handler answers with a 404 because it serves files.
    // A page told only the path would discover that by failing at the save button; a
    // page told the field knows before it offers one.
    send({ ready: { output, href, codec, frameExt: spec.frameExt, width, height, fps, frames, window: ACK_WINDOW } });
  };

  const frame = (data) => {
    if (!job) throw new Error('a frame arrived before the export was described');
    if (ended) throw new Error('a frame arrived after the export ended');
    if (data.length !== job.frameBytes) {
      throw new Error(
        `frame ${received} is ${data.length} bytes, not the ${job.frameBytes} a `
        + `${job.width}x${job.height} RGBA frame is`,
      );
    }
    // **Only when a count was declared.** `frames` is optional - `validateExport`
    // admits null and skips its checks - and a bare `received >= job.frames` coerces
    // null to zero, so the very first frame of a legal open-ended export was refused
    // for being more than the nothing it declared. The validator and the consumer
    // have to agree about what null means, and the validator's answer is "no count
    // was given", so this is the one that moves.
    if (job.frames !== null && received >= job.frames) {
      throw new Error(`more frames arrived than the ${job.frames} this export declared`);
    }
    received++;
    bytes += data.length;
    streamHash.update(data);
    // Per frame as well as over the stream, because "the exported frame is the
    // frame the editor showed" is a claim about one frame at one program time and
    // a rolling hash cannot answer it. Cheap next to the encode, and it is the
    // only view anything downstream has of what actually left the browser.
    frameHashes.push(createHash('sha256').update(data).digest('hex'));

    const n = received;
    // Serialised behind the previous write so backpressure is honoured in order:
    // an ack out of order would let the browser run past the window.
    queue = queue.then(() => new Promise((resolve, reject) => {
      if (finished) {
        resolve();
        return;
      }
      const ok = child.stdin.write(data, (err) => (err ? reject(err) : null));
      const done = () => {
        send({ ack: n });
        resolve();
      };
      if (ok) done();
      else child.stdin.once('drain', done);
    })).catch((err) => fail(`writing frame ${n} to ffmpeg failed: ${err.message}`));
  };

  const end = async () => {
    if (!job) throw new Error('an export ended before it was described');
    // Same reading as the frame guard above: an export that declared no count cannot
    // have sent the wrong number of frames, and comparing against null would refuse
    // every one of them.
    if (job.frames !== null && received !== job.frames) {
      throw new Error(`the export declared ${job.frames} frames and sent ${received}`);
    }
    ended = true;
    await queue;
    child.stdin.end();
  };

  const finish = async () => {
    if (finished) return;
    const spec = CODECS[job.codec];
    const size = await artifactBytes(spec, job.scratchArtifact, received);
    // The renderer class travels with the job from the very first one. There is a
    // single render machine today so the field constrains nothing - but a job
    // record without it cannot be retrofitted once old jobs exist, and provenance
    // is exactly what is wanted on the day two workers disagree about an image.
    const record = {
      project: job.project ?? null,
      capture: job.capture ?? null,
      renderer: job.renderer ?? null,
      output: job.output,
      width: job.width,
      height: job.height,
      fps: job.fps,
      frames: job.frames,
      codec: job.codec,
      created: new Date(job.began).toISOString(),
    };
    // The sidecar is written inside the scratch directory, and then the whole
    // directory is renamed to the final unique directory. A directory rename is
    // one syscall on the same filesystem, so the video and its record land
    // together; there is no window in which one exists and the other does not.
    // Because the final directory is unique per export, the rename never replaces
    // an existing artifact, and a failed run still reaches `fail` which removes
    // only the scratch directory.
    const sidecar = join(job.temp, `${job.name}.${spec.ext}.job.json`);
    await writeFile(sidecar, `${JSON.stringify(record, null, 2)}\n`);
    // Past this line nothing may remove the scratch directory, because the next
    // statement is what turns it into the output. Before it, a throw in the stat
    // or the write still reaches `fail`, which cleans the scratch directory up
    // and tells the browser.
    finished = true;
    try {
      await rename(job.temp, job.outputDir);
    } catch (err) {
      // **And it comes back down if the rename is the thing that failed**, because
      // then this run has not finished at all. `fail` reads the flag as "this export
      // has already been answered" and returns immediately, so a rename that threw -
      // a full disk, a scratch directory removed underneath - ended in silence: no
      // done, no error, the browser waiting on a socket nobody closes, and the
      // scratch still on disk. Lowering it here hands the failure back to the one
      // place that cleans up and speaks.
      finished = false;
      throw err;
    }
    const elapsed = Date.now() - job.began;
    log(`[export] ${job.output} ${job.frames} frames ${(size / 1e6).toFixed(1)}MB in ${(elapsed / 1000).toFixed(1)}s`);
    send({
      done: {
        output: job.output,
        href: job.href,
        frameExt: spec.frameExt,
        bytes: size,
        frames: received,
        rawBytes: bytes,
        elapsedMs: elapsed,
        streamHash: `sha256:${streamHash.digest('hex')}`,
        frameHashes,
      },
    });
    ws.close();
  };

  ws.on('message', (data, isBinary) => {
    const run = async () => {
      if (isBinary) {
        frame(data);
        return;
      }
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.begin) {
        if (job) throw new Error('this socket already has an export running');
        await begin(msg.begin);
      } else if (msg.end) {
        await end();
      } else {
        throw new Error(`unknown export message ${Object.keys(msg).join(',')}`);
      }
    };
    run().catch((err) => fail(String(err.message ?? err)));
  });

  ws.on('close', () => {
    if (finished) return;
    fail(`the browser closed the export socket after ${received} of ${job?.frames ?? '?'} frames`);
  });
  ws.on('error', (err) => fail(`export socket error: ${err.message}`));
}
