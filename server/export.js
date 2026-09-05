// The encoder end of an export: raw RGBA frames arrive over a WebSocket and go straight
// into ffmpeg's stdin. Raw because RGBA is ffmpeg's rawvideo format and browser and encoder
// share a loopback, so compressing would spend CPU to save bandwidth that was never scarce.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile, stat, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { audioFilter } from './audio.js';
import { AUDIO_RATE, checkAudioClip, readAudioWav } from '../web/audio-source.js';

// Absolute rather than resolved off PATH: this is the encoder the export was measured against.
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';

// How many frames may be in flight. A courtesy the client extends rather than something this
// server enforces - nothing below counts unacked frames.
const ACK_WINDOW = 4;

// 4K RGBA is 33MB, so the ceiling sits above the largest frame anything will ask for.
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;

// Exported so the render queue can refuse a name at enqueue rather than three layers later.
export const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The output a request asks for, as a table rather than four paths: every way the formats
// differ is a field here. Every entry states `evenDimensions` and `frameExt` even where they
// do not bite, so a format added later cannot inherit an exemption by saying nothing - which
// is what the loop below holds it to.
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
    // `-f image2` said rather than inferred: this is the only entry whose path is a printf
    // pattern inside a directory carrying its own extension. rgb24 because the drawing buffer
    // has no alpha, so an rgba sequence would store a constant 255 and call it transparency.
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

// Exported so the queue can validate a job before it is claimed.
export function validateExport({ name, width, height, fps, frames = null, codec }) {
  if (!VALID_NAME.test(String(name ?? ''))) {
    throw new Error(`bad output name ${JSON.stringify(name)}: it names a file in the exports directory, so it is letters, digits, dot, dash and underscore`);
  }
  const w = Number(width);
  const h = Number(height);
  const f = Number(fps);
  if (!Number.isInteger(w) || w <= 0) throw new Error(`bad output size ${width}x${height}`);
  if (!Number.isInteger(h) || h <= 0) throw new Error(`bad output size ${width}x${height}`);
  // `Object.hasOwn` rather than truthiness: `CODECS['toString']` is a function and therefore
  // truthy, so `"codec": "toString"` walked past this validator, took the enqueue and died a
  // minute later inside `begin`. Resolved here because the dimension rule below reads the entry.
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

// Distinguishes one export's scratch from another's; `-fflags +bitexact` keeps it out of the bytes.
let sequence = 0;

// Where ffmpeg is told to write: the artifact for a file, a six-digit printf pattern inside
// it for a sequence, so the frames sort in render order at any length.
function encodeTarget(spec, artifact, name) {
  if (spec.frameExt === null) return artifact;
  return join(artifact, `${name}.%06d.${spec.frameExt}`);
}

// How big the artifact is, and for a sequence whether it is all there. `stat` answers a
// directory with the inode's own size, so an empty sequence would land as a successful
// export. Nothing here opens a frame: `readFileSync` throws above 2 GiB.
async function artifactBytes(spec, artifact, frames) {
  if (spec.frameExt === null) return (await stat(artifact)).size;
  // Frames rather than entries: one `.DS_Store` would fail a sequence that is entirely correct.
  const names = (await readdir(artifact)).filter((n) => n.endsWith(`.${spec.frameExt}`));
  if (names.length !== frames) {
    throw new Error(`the sequence at ${artifact} holds ${names.length} frames and the export sent ${frames}`);
  }
  let total = 0;
  for (const name of names) total += (await stat(join(artifact, name))).size;
  return total;
}

function ffmpegArgs({ width, height, fps, codec, into, audio = null }) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    // Without it the container carries the encoder's version string and a creation time, so the
    // same frames would produce a different file every run.
    '-fflags', '+bitexact',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    ...(audio ? ['-i', audio.path, '-filter_complex', audio.filter, '-map', '0:v:0', '-map', '[audio]',
      '-c:a', codec === 'h264' ? 'aac' : 'pcm_s16le'] : []),
    // readPixels reads the drawing buffer bottom-up, which is upside down to every video format.
    '-vf', 'vflip',
    ...CODECS[codec].args,
    '-flags:v', '+bitexact',
    '-r', String(fps),
    '-y', into,
  ];
}

// One export, from the begin message to the file. Everything is validated against what the
// browser said it would send: ffmpeg's rawvideo demuxer reads a short frame as the head of
// the next one and produces a file that plays and scrolls diagonally.
export function handleExportSocket(ws, { outDir, audioStore = null, log = console.log }) {
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
    // Only the files in this run's own scratch directory. Reaching for `job.output` here deleted
    // the previous good export of the same name, because the name defaults to the take's id.
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
    // A unique directory per export makes `rename(temp, final)` target a fresh path, so nothing
    // existing is replaced.
    const dirName = `${msg.name}.${process.pid}-${++sequence}`;
    const outputDir = join(outDir, dirName);
    const output = join(outputDir, `${msg.name}.${ext}`);
    const frameBytes = width * height * 4;
    const temp = join(outDir, `${dirName}.part`);
    const scratchArtifact = join(temp, `${msg.name}.${ext}`);
    const target = encodeTarget(spec, scratchArtifact, msg.name);
    // The same file as a URL: `output` is an absolute path the page cannot fetch.
    const href = `/exports/${dirName}/${msg.name}.${ext}`;
    // Assigned before the first await, because `job` is what says an export is already running:
    // two begins in one tick both found it null and the second overwrote the first's record.
    job = {
      width, height, fps, frames, codec, frameBytes, output, outputDir, temp, scratchArtifact, href, name: msg.name, began: Date.now(),
      project: msg.project ?? null,
      programStart: msg.programStart ?? null,
      captures: Array.isArray(msg.captures) ? msg.captures.slice() : null,
      renderer: msg.renderer ?? null,
    };

    // The directory the target is in rather than the scratch directory - one level deeper for a
    // sequence, because the image2 muxer opens each frame by name and creates nothing.
    await mkdir(dirname(target), { recursive: true });
    if (finished) { await rm(temp, { recursive: true, force: true }); return; }
    const audioClip = checkAudioClip(msg.project?.audio);
    let audio = null;
    if (audioClip) {
      if (codec === 'pngseq') throw new Error('PNG sequences cannot carry audio; select MP4 or MOV');
      if (!audioStore) throw new Error('this server has no audio store');
      if (!Number.isFinite(msg.programStart) || msg.programStart < 0 || msg.programStart > 86400
        || frames === null) throw new Error('audio export needs a program start and frame count');
      const wav = await audioStore.read(audioClip.hash);
      if (finished) return;
      const { duration } = readAudioWav(wav);
      if (Math.abs(duration - audioClip.duration) > 0.5 / AUDIO_RATE) throw new Error('audio duration does not match its asset');
      const audioPath = join(temp, 'audio-input.wav');
      await writeFile(audioPath, wav, { flag: 'wx' });
      if (finished) { await rm(temp, { recursive: true, force: true }); return; }
      audio = { path: audioPath, filter: audioFilter(audioClip, msg.programStart, frames, fps) };
    }
    const args = ffmpegArgs({ width, height, fps, codec, into: target, audio });
    log(`[export] ${FFMPEG} ${args.join(' ')}`);
    child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
    child.on('error', (err) => fail(`ffmpeg could not start: ${err.message}`));
    child.stdin.on('error', () => { /* reported through the exit code instead */ });
    child.on('exit', (code, signal) => {
      if (finished) return;
      if (!ended || code !== 0) {
        fail(`ffmpeg exited ${code ?? signal}${stderr.length ? `: ${stderr.join('').trim()}` : ''}`);
        return;
      }
      finish().catch((err) => fail(String(err.message ?? err)));
    });

    // `frameExt` travels to the page because `href` names a directory for a sequence, which the
    // static handler answers with a 404.
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
    // Only when a count was declared: `frames` is optional, and a bare `received >= job.frames`
    // coerces null to zero and refuses the first frame of a legal open-ended export.
    if (job.frames !== null && received >= job.frames) {
      throw new Error(`more frames arrived than the ${job.frames} this export declared`);
    }
    received++;
    bytes += data.length;
    streamHash.update(data);
    // Per frame as well as over the stream: one frame at one program time is a claim a rolling
    // hash cannot answer.
    frameHashes.push(createHash('sha256').update(data).digest('hex'));

    const n = received;
    // Serialised behind the previous write, so an ack out of order cannot let the browser run
    // past the window.
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
    // Same reading as the frame guard: an export that declared no count cannot have sent
    // the wrong number.
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
    // The renderer class travels from the first job, because it cannot be retrofitted
    // once old jobs exist.
    const record = {
      project: job.project ?? null,
      programStart: job.programStart,
      captures: job.captures ?? null,
      renderer: job.renderer ?? null,
      output: job.output,
      width: job.width,
      height: job.height,
      fps: job.fps,
      frames: job.frames,
      codec: job.codec,
      created: new Date(job.began).toISOString(),
    };
    // The sidecar is written inside the scratch and the whole directory renamed - one syscall,
    // so the video and its record land together with no window in which one exists alone.
    const sidecar = join(job.temp, `${job.name}.${spec.ext}.job.json`);
    await writeFile(sidecar, `${JSON.stringify(record, null, 2)}\n`);
    // Past this line nothing may remove the scratch, because the next statement turns it
    // into the output.
    finished = true;
    try {
      await rm(join(job.temp, 'audio-input.wav'), { force: true });
      await rename(job.temp, job.outputDir);
    } catch (err) {
      // And it comes back down if the rename is what failed: `fail` reads the flag as "already
      // answered" and returns, which ended a failed rename in silence with the socket still open.
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
    return run().catch((err) => fail(String(err.message ?? err)));
  });

  ws.on('close', () => {
    if (finished) return;
    fail(`the browser closed the export socket after ${received} of ${job?.frames ?? '?'} frames`);
  });
  ws.on('error', (err) => fail(`export socket error: ${err.message}`));
}
