// The service as a child of the desktop shell: which Node runs it, which port and roots it gets,
// when it is ready, and how it is stopped. Nothing here imports Electron, so the unit tests and
// the shell run the same code.
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';

// The editor's preview cache and its settings belong to the page's origin, and the origin
// includes the port. The port is fixed and never replaced by another.
export const PORT = 8480;
export const NODE_MAJOR = 26;
// Longer than the server's 15-second standby grace, so a stop that is working is never killed.
export const STOP_GRACE_MS = 20_000;
const READY_TIMEOUT_MS = 30_000;

export const ROOT_NAMES = ['captures', 'projects', 'presets', 'deliverables', 'effects', 'jobs', 'exports', 'audio'];

export const rootsUnder = (dir) => Object.fromEntries(ROOT_NAMES.map((name) => [name, join(dir, name)]));

export function serviceArgs({ entry, port, roots }) {
  return [entry, '--port', String(port), '--stop-on-stdin',
    ...ROOT_NAMES.flatMap((name) => [`--${name}`, roots[name]])];
}

// `.` does not match a carriage return, so the pattern takes the CR of a CRLF line end itself.
const READY = /^\[server\] ready (.*?)\r?$/;

/**
 * What a ready line says, or null for any other line. A ready line that cannot be read is an error,
 * because the window opens on what it names.
 */
export function parseReadyLine(line, port = PORT) {
  const match = READY.exec(line);
  if (!match) return null;
  let info;
  try {
    info = JSON.parse(match[1]);
  } catch {
    throw new Error(`the service's ready line is not JSON: ${line}`);
  }
  let url;
  try {
    url = new URL(info?.url);
  } catch {
    throw new Error(`the service's ready line names no url: ${line}`);
  }
  if (url.protocol !== 'http:' || url.port !== String(port)) {
    throw new Error(`the service says it listens on ${url.origin}, and this app opens only port ${port}`);
  }
  return { ...info, url: url.href, origin: url.origin };
}

/** Takes text in pieces of any size and calls `onLine` once for each line that is complete. */
export function lineSplitter(onLine) {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop();
    for (const line of parts) onLine(line);
  };
}

const NODE_BINARY = process.platform === 'win32' ? 'node.exe' : 'node';

// A window started from Finder has a minimal PATH, which leaves out Homebrew's.
export const nodeDirs = () => [...new Set([
  ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  '/opt/homebrew/bin',
  '/usr/local/bin',
])];

const versionOf = (path) => new Promise((resolve) => {
  execFile(path, ['--version'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
});

/** The first Node at NODE_MAJOR or newer on `dirs`, and the older ones passed on the way. */
export async function findNode(dirs, probe = versionOf) {
  const older = [];
  for (const dir of dirs) {
    const path = join(dir, NODE_BINARY);
    const version = await probe(path);
    const major = Number(/^v(\d+)\./.exec(version ?? '')?.[1]);
    if (major >= NODE_MAJOR) return { path, version, older };
    if (version) older.push({ path, version });
  }
  return { path: null, version: null, older };
}

/** Whether nothing holds this loopback port. */
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Starts the service. `ready` settles with its ready line, and rejects when it exits first or
 * says nothing for `readyTimeoutMs`. `stop` writes `stop` to its stdin and kills it only when
 * `stopGraceMs` pass without an exit.
 */
export function startService({
  node, entry, cwd, roots, port = PORT, onLine = () => {},
  readyTimeoutMs = READY_TIMEOUT_MS, stopGraceMs = STOP_GRACE_MS,
}) {
  const child = spawn(node, serviceArgs({ entry, port, roots }), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  // A service that exited has a closed stdin, and the write of `stop` then fails on it.
  child.stdin.on('error', () => {});

  const tail = [];
  let exit = null;
  const exited = new Promise((resolve) => {
    const done = (result) => {
      if (exit) return;
      exit = result;
      resolve(result);
    };
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', (error) => done({ code: null, signal: null, error }));
  });

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The shell reads a failed start from `ready`; this keeps one nobody has asked about yet from
  // surfacing as an unhandled rejection.
  ready.catch(() => {});
  const readyTimer = setTimeout(() => {
    rejectReady(new Error(`the service printed no ready line in ${readyTimeoutMs / 1000} seconds`));
    stop();
  }, readyTimeoutMs);
  ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
  exited.then(({ code, signal, error }) => rejectReady(new Error(
    `the service exited before it was ready (${error ? error.message : `code ${code ?? signal}`})`
    + (tail.length ? `\n${tail.join('\n')}` : ''),
  )));

  const lines = (stream, name) => {
    stream.setEncoding('utf8');
    stream.on('data', lineSplitter((line) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      onLine(name, line);
      if (name === 'stdout') {
        try {
          const info = parseReadyLine(line, port);
          if (info) resolveReady(info);
        } catch (err) {
          rejectReady(err);
        }
      }
    }));
  };
  lines(child.stdout, 'stdout');
  lines(child.stderr, 'stderr');

  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      if (exit) return { ...exit, forced: false };
      child.stdin.write('stop\n');
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, stopGraceMs);
      const result = await exited;
      clearTimeout(timer);
      return { ...result, forced };
    })();
    return stopping;
  }

  return { pid: child.pid, ready, exited, stop };
}
