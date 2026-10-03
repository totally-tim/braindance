#!/usr/bin/env node
// What `stop` and end-of-file on stdin do to the grabber, in three parts, with no sensor, no
// libfreenect2 build and no port.
//   reader: the shipped `pollCommands`, compiled and fed a real non-blocking pipe.
//   writer: the shipped `write_message`, compiled with the frame loop's thread and the encoder's on a
//           pipe the parent leaves unread, and its output read back through the shipped parser.
//   stream: the shipped grabber, `main` and all, linked against test/fixtures/fake-freenect2.cpp in
//           place of a sensor and run as a child with its stdout left unread, because a parent that
//           stopped reading is the case a stop has to survive.
// Exit 0 is a pass. Exit 1 is a failed assertion, a mutation catch or a mutation miss, so read the
// count. Exit 2 means it did not run.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HEADER_BYTES, MAGIC, MessageParser, TYPE_COLOR, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;

const EOF_BRANCH = '  if (n == 0) {\n    std::fprintf(stderr, "[grabber] stdin closed, stopping\\n");\n    g_stop = 1;\n  }\n';
const STOP_BRANCH = '    if (line == "stop") {\n';
const RETURN_ON_TIMEOUT = '      if (g_stop) return false;\n    } else if (fds[0].revents) {\n';
const CUT_CHECK = '  if (g_outputCut) return false;\n';
const CUT_SET = '    g_outputCut = true;\n';
const STOP_RELEASE = '    if (g_stop) {\n      depthListener.release(depthFrames);\n      break;\n    }\n';
const MUTATIONS = {
  'eof-never-stops': {
    section: 'reader',
    file: 'native/grabber.cpp',
    edits: [[EOF_BRANCH, EOF_BRANCH.replace('n == 0', 'n == -2')]],
    fails: 'the closed-pipe rows: end-of-file no longer sets the stop flag',
  },
  'would-block-stops': {
    section: 'reader',
    file: 'native/grabber.cpp',
    edits: [[EOF_BRANCH, EOF_BRANCH.replace('n == 0', 'n <= 0')]],
    fails: 'the open-pipe rows: -1 with EAGAIN is read as end-of-file, so a pipe with nothing in it stops the run',
  },
  'eof-drops-the-commands-it-arrives-with': {
    section: 'reader',
    file: 'native/grabber.cpp',
    edits: [[EOF_BRANCH, EOF_BRANCH.replace('    g_stop = 1;\n', '    g_stop = 1;\n    return;\n')]],
    fails: 'the same-pass row: the commands read with the end-of-file are never parsed',
  },
  'stop-line-ignored': {
    section: 'reader',
    file: 'native/grabber.cpp',
    edits: [[STOP_BRANCH, '    if (line == "stop-never-sent") {\n']],
    fails: 'the stop-line rows, while the end-of-file rows stay green',
  },
  'stop-matches-a-prefix': {
    section: 'reader',
    file: 'native/grabber.cpp',
    edits: [[STOP_BRANCH, '    if (line.compare(0, 4, "stop") == 0) {\n']],
    fails: 'the near-miss row: "stopped", "stop now" and the rest stop the run',
  },
  'cut-message-leaves-the-output-open': {
    section: 'writer',
    file: 'native/grabber.cpp',
    edits: [[CUT_CHECK, '']],
    fails: 'the queued and late rows: a write after the cut message is accepted, and its bytes follow the cut',
  },
  'cut-message-does-not-close-the-output': {
    section: 'writer',
    file: 'native/grabber.cpp',
    edits: [[CUT_SET, '']],
    fails: 'the queued and late rows: the write that gave up leaves nothing for a later write to refuse',
  },
  'stalled-write-never-gives-up': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [[RETURN_ON_TIMEOUT, '    } else if (fds[0].revents) {\n']],
    fails: 'every stalled-stop row: the stop is read and the write on a full pipe waits on regardless',
  },
  'stalled-write-ignores-stdin': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [['  bool watchStdin = (bool)whileStalled;\n', '  bool watchStdin = false;\n']],
    fails: 'the stalled-stop rows and the command-behind-a-stall row: nothing reads stdin while the write waits',
  },
  'frame-lock-ignores-stdin': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [['    if (whileStalled) whileStalled();\n    if (g_stop) return false;\n', '    if (g_stop) return false;\n']],
    fails: 'the row where the encoder holds the write lock on a full pipe: the loop waiting for the lock never reads the stop',
  },
  'stdout-left-blocking': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [['  ::fcntl(STDOUT_FILENO, F_SETFL, ::fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK);\n', '']],
    fails: 'the stalled-stop rows: a blocking write never comes back to ask',
  },
  'frame-written-after-stop': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [[STOP_RELEASE, '']],
    fails: 'the stop-before-the-first-frame rows: a frame is written after the stop was read',
  },
  'early-stop-keeps-the-depth-frame': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [[STOP_RELEASE, '    if (g_stop) break;\n']],
    fails: 'the stop-before-the-first-frame rows: the depth frame taken before the stop was read is never returned',
  },
  'stalled-write-gives-up-at-once': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [['    } else if (fds[0].revents) {\n      return true;', '    } else if (fds[0].revents) {\n      return !g_stop;']],
    fails: 'the slow-reader row: a parent still reading gets a frame cut short',
  },
  'teardown-leaves-the-encoder-writing': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [['  g_stop = 1;\n  hdEncoder.stop();', '  hdEncoder.stop();']],
    fails: 'the frame-timeout row: the encoder thread is stalled in a write and the join waits on it',
  },
  'corpus-failure-leaves-the-encoder-writing': {
    section: 'stream',
    file: 'native/grabber.cpp',
    edits: [['        g_stop = 1; // the encoder\'s destructor joins a writer that may be stalled on stdout\n', '']],
    fails: 'the corpus-failure row: the early return destroys an encoder stalled in a write',
  },
};

class DidNotRun extends Error {}
const fail = (reason) => { throw new DidNotRun(reason); };

const sections = MUTATE ? [MUTATIONS[MUTATE]?.section] : ['reader', 'writer', 'stream'];
let checked = 0;
let failed = 0;
const row = (pass, name, detail) => {
  checked++;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass && detail) console.log(`       ${detail.replace(/\n/g, '\n       ')}`);
};

const cxx = process.env.CXX || 'c++';

const reader = (source, scratch) => {
  const start = source.indexOf('// Low light on lets');
  const end = source.indexOf('/**\n * Reads a flag given in metres', start);
  if (start < 0 || end < 0) fail('pollCommands extraction anchors moved');
  writeFileSync(join(scratch, 'poll-under-test.h'), source.slice(start, end));
  const binary = join(scratch, 'reader');
  const build = spawnSync(cxx, ['-std=c++11', '-O1', `-I${scratch}`,
    join(REPO, 'test/fixtures/grabber-stdin.cpp'), '-o', binary], { encoding: 'utf8' });
  if (build.status !== 0) fail(`a C++ compiler is required: ${build.error?.message ?? build.stderr}`);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(run.stdout ?? '');
  const summary = /the reader: (\d+) assertions, (\d+) failed/.exec(run.stdout ?? '');
  if (!summary || run.error || run.signal || run.status === 2) fail(run.error?.message ?? `the reader run did not finish (${run.status}, ${run.signal})`);
  checked += Number(summary[1]);
  failed += Number(summary[2]);
};

// The same minimal header for every build: what this fake needs of libfreenect2's generated one.
const CONFIG_H = '#define LIBFREENECT2_API\n#define LIBFREENECT2_WITH_TURBOJPEG_SUPPORT\n'
  + '#define LIBFREENECT2_THREADING_STDLIB\n#define LIBFREENECT2_WITH_CXX11_SUPPORT\n';

const turbojpegFlags = () => {
  try {
    return execFileSync('pkg-config', ['--cflags', '--libs', 'libturbojpeg'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
  } catch {
    const prefix = ['/opt/homebrew/opt/jpeg-turbo', '/usr/local/opt/jpeg-turbo'].find((p) => existsSync(join(p, 'include/turbojpeg.h')));
    return prefix ? [`-I${prefix}/include`, `-L${prefix}/lib`, '-lturbojpeg'] : ['-lturbojpeg'];
  }
};

const buildGrabber = (source, scratch) => {
  mkdirSync(join(scratch, 'include/libfreenect2'), { recursive: true });
  writeFileSync(join(scratch, 'include/libfreenect2/config.h'), CONFIG_H);
  writeFileSync(join(scratch, 'grabber.cpp'), source);
  const binary = join(scratch, 'grabber');
  const build = spawnSync(cxx, ['-std=c++11', '-O1', '-pthread', `-I${join(scratch, 'include')}`,
    `-I${join(REPO, 'third_party/libfreenect2/include')}`, join(scratch, 'grabber.cpp'),
    join(REPO, 'test/fixtures/fake-freenect2.cpp'), ...turbojpegFlags(), '-o', binary], { encoding: 'utf8' });
  if (build.status !== 0) fail(`the grabber did not build against the fake sensor (a C++ compiler and TurboJPEG are required): ${build.error?.message ?? build.stderr.slice(0, 3000)}`);
  return binary;
};

const PAYLOAD = 512 * 1024;
const filled = (bytes, value) => bytes.every((b) => b === value);

// A stream through the shipped parser, fed up to the first message's declared end and then the rest,
// as a parent reading in chunks sees it. A second header inside the first message's payload is not
// visible to it, so a torn message followed by more bytes shows up as a message carrying both
// writers' bytes, or as the desync after it.
const shipped = (stream) => {
  const parser = new MessageParser();
  const first = stream.length >= HEADER_BYTES ? Math.min(stream.length, HEADER_BYTES + stream.readUInt32LE(8)) : stream.length;
  const messages = [];
  let error = null;
  try {
    for (const chunk of [stream.subarray(0, first), stream.subarray(first)]) if (chunk.length) messages.push(...parser.push(chunk));
  } catch (e) { error = e.message; }
  return { messages, error, buffered: parser.buf.length };
};

// Three interleavings of the frame loop's writer and the encoder's on a pipe nobody reads: no stop; a
// stop with the encoder queued behind the frame; a stop with the encoder arriving after the frame gave
// up. The last takes the lock without failing a try, so the stop check in the lock wait never sees it.
const writer = (source, scratch) => {
  const start = source.indexOf('// How long a write waits on a full pipe');
  const end = source.indexOf('static uint64_t now_ms()', start);
  if (start < 0 || end < 0) fail('write_message extraction anchors moved');
  writeFileSync(join(scratch, 'write-under-test.h'), source.slice(start, end));
  const binary = join(scratch, 'writer');
  const build = spawnSync(cxx, ['-std=c++11', '-O1', '-pthread', `-I${scratch}`,
    join(REPO, 'test/fixtures/grabber-write.cpp'), '-o', binary], { encoding: 'utf8' });
  if (build.status !== 0) fail(`a C++ compiler is required: ${build.error?.message ?? build.stderr}`);
  const play = (scenario) => {
    const file = join(scratch, `writer-${scenario}.bin`);
    const run = spawnSync(binary, [scenario, file], { encoding: 'utf8', timeout: 30000 });
    const said = /^frame=(-?\d+) colour=(-?\d+) bytes=\d+$/m.exec(run.stdout ?? '');
    if (!said || run.error || run.signal || run.status !== 0) fail(run.error?.message ?? `the ${scenario} run did not finish (${run.status}, ${run.signal}) ${run.stderr}`);
    return { frame: said[1] === '1', colour: said[2] === '1', stream: readFileSync(file) };
  };

  console.log('\ntwo writers and no stop');
  {
    const { frame, colour, stream } = play('free');
    const seen = shipped(stream);
    const [a, b] = seen.messages;
    row(frame && colour, 'free: both messages are written', `frame=${frame} colour=${colour}`);
    row(!seen.error && seen.buffered === 0 && seen.messages.length === 2
      && a.type === FRAME && a.payload.length === PAYLOAD && filled(a.payload, 0x11)
      && b.type === COLOUR && b.payload.length === PAYLOAD && filled(b.payload, 0x22),
    'free: the shipped parser reads two whole messages, each carrying only its own writer\'s bytes',
    JSON.stringify({ error: seen.error, buffered: seen.buffered, messages: seen.messages.map((m) => m.type) }));
  }

  for (const [scenario, what] of [
    ['queued', 'a second message queued behind a frame the stop cuts short'],
    ['late', 'a second message that reaches the lock after the frame gave up'],
  ]) {
    console.log(`\n${what}`);
    const { frame, colour, stream } = play(scenario);
    const seen = shipped(stream);
    row(!frame, `${scenario}: the frame the stop cuts short is abandoned`, `frame=${frame}`);
    row(!colour, `${scenario}: the second message is refused`, `colour=${colour}`);
    row(stream.length > HEADER_BYTES && stream.length < HEADER_BYTES + PAYLOAD
      && stream.readUInt32LE(0) === MAGIC && stream.readUInt32LE(4) === FRAME && stream.readUInt32LE(8) === PAYLOAD
      && filled(stream.subarray(HEADER_BYTES), 0x11),
    `${scenario}: what the parent reads is the cut frame and ends there`, `${stream.length} bytes, ${stream.includes(0x22) ? 'with' : 'without'} the second writer's bytes`);
    row(!seen.error && seen.messages.length === 0 && seen.buffered === stream.length,
      `${scenario}: the shipped parser holds it as one unfinished message and meets no second header`,
      JSON.stringify({ error: seen.error, buffered: seen.buffered, messages: seen.messages.map((m) => m.type) }));
  }
};

// How long a stop may take from the request to the end of the run. A healthy one takes about
// one write-wait interval, so this is the margin for a loaded machine, not an expectation.
const BOUND_MS = 4000;
const [HELLO, FRAME, COLOUR] = [TYPE_HELLO, TYPE_FRAME, TYPE_COLOR];

// The messages in a stream, and whether it stops on a message boundary. `rest` is the bytes after
// the last whole message, which a cut-off frame leaves.
const parse = (buffer) => {
  const types = [];
  let at = 0;
  let desync = false;
  while (at + 12 <= buffer.length) {
    if (buffer.readUInt32LE(at) !== MAGIC) { desync = true; break; }
    const size = buffer.readUInt32LE(at + 8);
    if (at + 12 + size > buffer.length) break;
    types.push(buffer.readUInt32LE(at + 4));
    at += 12 + size;
  }
  return { types, rest: buffer.length - at, desync, whole: !desync && at === buffer.length };
};

// Every child a row launched, so a throw part-way through cannot leave one running.
const runs = [];

const stream = async (binary, scratch) => {
  const ARGS = ['--pipeline', 'cpu', '--color-decoder', 'turbojpeg'];

  // A grabber with its stdout held back: chunks are kept but not read until `drain`.
  const launch = (args, env = {}) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const run = { child, err: '', chunks: [], exit: null, draining: false, pace: 0 };
    runs.push(run);
    child.on('error', (e) => { run.err += `spawn: ${e.message}\n`; run.exit = { code: null, signal: 'ERROR' }; });
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8').on('data', (d) => { run.err += d; });
    child.stdout.on('data', (d) => {
      run.chunks.push(d);
      if (run.until?.(seen(run))) { run.until = null; hold(run); run.held(); return; }
      if (run.draining && run.pace) {
        child.stdout.pause();
        setTimeout(() => { if (run.draining) child.stdout.resume(); }, run.pace);
      }
    });
    child.stdout.pause();
    run.exited = new Promise((resolve) => child.on('exit', (code, signal) => { run.exit = { code, signal }; resolve(); }));
    run.closed = new Promise((resolve) => child.on('close', resolve));
    run.errEnded = new Promise((resolve) => child.stderr.on('end', resolve));
    return run;
  };
  const drain = (run, pace = 0) => { run.draining = true; run.pace = pace; run.child.stdout.resume(); };
  const hold = (run) => { run.draining = false; run.child.stdout.pause(); };
  // Reads until `until` holds of the stream so far, and stops reading in the same chunk: a check on
  // a timer lets the reader take whatever the grabber writes next in the gap.
  const drainUntil = (run, until, ms = 8000) => new Promise((resolve) => {
    run.until = until;
    run.held = () => resolve(true);
    drain(run);
    setTimeout(() => { if (run.until) { run.until = null; resolve(false); } }, ms);
  });
  const seen = (run) => parse(Buffer.concat(run.chunks));
  const handouts = (run) => (run.err.match(/\[fake\] depth frame \d+ handed out/g) ?? []).length;
  const waitFor = async (test, ms = 8000) => {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(20)) if (test()) return true;
    return false;
  };
  // Taking no new frame for 450 ms is the grabber stuck in a write: depth arrives every 10 ms.
  const stalled = async (run) => {
    let last = -1;
    let since = Date.now();
    for (const until = Date.now() + 6000; Date.now() < until; await sleep(50)) {
      const n = handouts(run);
      if (n !== last) { last = n; since = Date.now(); } else if (n > 0 && Date.now() - since >= 450) return true;
    }
    return false;
  };
  const whenDone = async (run, ms) => {
    const finished = await Promise.race([run.exited.then(() => true), sleep(ms).then(() => false)]);
    if (!finished) { run.child.kill('SIGKILL'); await run.exited; }
    return !finished;
  };
  // The request, then up to BOUND_MS for the run to end. A run still going is killed, so a
  // grabber that hangs costs the bound and not the check.
  const request = async (run, how) => {
    if (how === 'stop') run.child.stdin.write('stop\n'); else run.child.stdin.end();
    const hung = await whenDone(run, BOUND_MS);
    // The exit event can come before the last of the child's stderr has been read.
    await Promise.race([run.errEnded, sleep(1000)]);
    return { hung };
  };
  const collect = async (run) => {
    run.draining = true; run.pace = 0; run.child.stdout.resume();
    await Promise.race([run.closed, sleep(3000)]);
    return seen(run);
  };
  const tail = (run) => `exit ${JSON.stringify(run.exit)}\n${run.err.trimEnd().split('\n').slice(-6).join('\n')}`;
  const ends = (name, run, hung) => row(!hung, `${name}: the run ends within ${BOUND_MS} ms of the request`, hung && tail(run));
  // What the fake sensor says at its close: the frames the grabber took and the frames it gave back.
  const frames = (run) => {
    const m = /\[fake\] device closed: depth (\d+) taken, (\d+) returned; colour (\d+) taken, (\d+) returned/.exec(run.err);
    return m && { depthTaken: +m[1], depthReturned: +m[2], colourTaken: +m[3], colourReturned: +m[4] };
  };
  const clean = (name, run, hung) => {
    const f = frames(run);
    row(!hung && run.exit.code === 0 && /\[grabber\] stopped after/.test(run.err)
      && f && f.depthTaken === f.depthReturned && f.colourTaken === f.colourReturned,
    `${name}: it ends through its ordinary teardown with exit 0, every frame it took returned`, tail(run));
  };

  console.log('\na stop or an end-of-file behind a write the parent is not reading');
  for (const how of ['stop', 'eof']) {
    const name = how === 'stop' ? 'a stop line' : 'end-of-file';
    const run = launch([...ARGS, '--no-color']);
    row(await stalled(run), `${name}: the grabber is stuck writing its first frame to an unread pipe`, tail(run));
    const { hung } = await request(run, how);
    ends(name, run, hung);
    clean(name, run, hung);
    if (how === 'eof') row(/stdin closed, stopping/.test(run.err), `${name}: the end-of-file is what stopped it`, tail(run));
  }

  console.log('\nthe encoder thread holds the write lock on a full pipe');
  {
    // A new colour frame with every depth frame, and 300 ms in registration, so the encoder has its
    // message ready and reaches the write lock well before the frame loop does.
    const run = launch(ARGS, { FAKE_REGISTER_MS: '300', FAKE_COLOUR_EVERY: '1' });
    const name = 'a stop line behind the encoder';
    run.child.stdin.write('hd-color on\n');
    row(await drainUntil(run, (s) => s.types.includes(FRAME) && s.types.includes(COLOUR)),
      `${name}: frames and the encoder's colour messages flow while the parent reads`, tail(run));
    row(await stalled(run), `${name}: then the parent stops reading and the grabber stalls`, tail(run));
    const { hung } = await request(run, 'stop');
    ends(name, run, hung);
    clean(name, run, hung);
  }

  console.log('\na command behind a stalled write');
  {
    const run = launch(ARGS);
    const name = 'a stop line after a command';
    row(await stalled(run), `${name}: the grabber is stuck writing its first frame to an unread pipe`, tail(run));
    run.child.stdin.write('low-light off\n');
    row(await waitFor(() => /\[grabber\] low light off/.test(run.err), 3000),
      `${name}: a command written while the write is stalled is read and applied at once`, tail(run));
    row(run.exit === null, `${name}: and it does not stop the run`, tail(run));
    drain(run, 5);
    row(await waitFor(() => seen(run).types.filter((t) => t === FRAME).length >= 3),
      `${name}: the stalled frame completes and the run goes on streaming`, tail(run));
    const { hung } = await request(run, 'stop');
    ends(name, run, hung);
    clean(name, run, hung);
    const out = await collect(run);
    row(out.whole && out.types[0] === HELLO, `${name}: every message in the stream is whole`, JSON.stringify({ ...out, types: out.types.length }));
  }

  console.log('\na stop while the parent is still reading');
  {
    const run = launch(ARGS);
    const name = 'a stop line to a parent still reading';
    run.child.stdin.write('hd-color on\n');
    drain(run, 5);
    row(await waitFor(() => seen(run).types.filter((t) => t === FRAME).length >= 3),
      `${name}: frames and colour messages flow, the reader pausing between chunks so a write is nearly always waiting`, tail(run));
    const { hung } = await request(run, 'stop');
    ends(name, run, hung);
    clean(name, run, hung);
    const out = await collect(run);
    row(out.whole && out.types[0] === HELLO, `${name}: the stream it leaves ends on a message boundary, so no frame is cut short`,
      JSON.stringify({ ...out, types: out.types.length }));
  }

  console.log('\na stop or an end-of-file already waiting when the first frame arrives');
  for (const how of ['stop', 'eof']) {
    const name = how === 'stop' ? 'a stop line already waiting' : 'end-of-file already waiting';
    const run = launch([...ARGS, '--no-color'], { FAKE_DEPTH_MS: '300' });
    const { hung } = await request(run, how);
    ends(name, run, hung);
    clean(name, run, hung);
    const f = frames(run);
    row(f && f.depthTaken === 1 && f.depthReturned === 1,
      `${name}: the depth frame taken before the stop was read is returned`, tail(run));
    const out = await collect(run);
    row(out.whole && out.types.length === 1 && out.types[0] === HELLO,
      `${name}: nothing is written after the hello`, JSON.stringify({ ...out, types: out.types }));
  }

  // The two ways out of the loop that do not set the stop flag, each with the encoder stalled in a
  // write: the sensor going quiet, and a corpus file that will not open.
  console.log('\nan exit that no stop requested, with the encoder stalled in a write');
  const stalledEncoder = async (name, env, args = ARGS) => {
    const run = launch(args, { FAKE_DEPTH_MS: '300', ...env });
    run.child.stdin.write('hd-color on\n');
    row(await drainUntil(run, (s) => s.types.includes(FRAME)), `${name}: the first frame arrives while the parent reads`, tail(run));
    row(!seen(run).types.includes(COLOUR), `${name}: the encoder's colour message is still to come, so it stalls on the held reader`,
      JSON.stringify(seen(run).types));
    return run;
  };
  const corpus = join(scratch, 'corpus');
  mkdirSync(join(corpus, 'frame-0001.bin'), { recursive: true });
  const [quiet, refused] = await Promise.all([
    (async () => {
      const run = await stalledEncoder('a sensor gone quiet', { FAKE_MAX_FRAMES: '1' });
      const hung = await whenDone(run, 10000 + BOUND_MS);
      return { run, hung };
    })(),
    (async () => {
      const run = await stalledEncoder('a corpus failure', {}, [...ARGS, '--dump-corpus', corpus, '--dump-every', '1']);
      const hung = await whenDone(run, BOUND_MS + 2000);
      return { run, hung };
    })(),
  ]);
  row(/timeout waiting for frame/.test(quiet.run.err), 'a sensor gone quiet: the loop left on its frame timeout, not on a stop', tail(quiet.run));
  ends('a sensor gone quiet', quiet.run, quiet.hung);
  clean('a sensor gone quiet', quiet.run, quiet.hung);
  row(/cannot open .*frame-0001\.bin/.test(refused.run.err), 'a corpus file that will not open: the loop left on the write, not on a stop', tail(refused.run));
  ends('a corpus failure', refused.run, refused.hung);
  row(!refused.hung && refused.run.exit.code === 1, 'a corpus failure: it exits 1', tail(refused.run));

};

const main = async () => {
  if (MUTATE && !MUTATIONS[MUTATE]) fail(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  let source = readFileSync(join(REPO, 'native/grabber.cpp'), 'utf8');
  if (MUTATE) for (const [from, to] of MUTATIONS[MUTATE].edits) {
    if (source.split(from).length !== 2) fail(`mutation anchor does not match once: ${from}`);
    source = source.replace(from, to);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'grabber-stdin-'));
  try {
    if (sections.includes('reader')) { console.log('the reader, against a real pipe'); reader(source, scratch); }
    if (sections.includes('writer')) writer(source, scratch);
    if (sections.includes('stream')) await stream(buildGrabber(source, scratch), scratch);
  } finally {
    for (const run of runs) run.child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n[grabber-stdin] ${checked} assertions, ${failed} failed`);
  if (MUTATE) {
    console.log(`[grabber-stdin] should fail: ${MUTATIONS[MUTATE].fails}`);
    console.log(failed ? `[grabber-stdin] caught (${failed} failed assertions)` : '[grabber-stdin] NOT CAUGHT');
    process.exitCode = 1;
  } else process.exitCode = failed ? 1 : 0;
};

main().catch((e) => {
  if (!(e instanceof DidNotRun)) throw e;
  console.error(`[grabber-stdin] DID NOT RUN: ${e.message}`);
  process.exitCode = 2;
});
