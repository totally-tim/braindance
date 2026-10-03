// A stand-in for server/index.js that the desktop tests start through desktop/service.js, and the
// rule that ends it: whatever ends a test, the stub's process ends with it.

import assert from 'node:assert/strict';
import { rootsUnder, startService } from '../desktop/service.js';

export const TEST_PORT = 49321;
// How long a test's teardown waits for a stop, and again for a kill, before it reports the child.
export const REAP_MS = 5000;

// The stub reads its behavior from STUB_MODE, which a spawned child inherits. It binds nothing, so
// no port is held. Every mode exits when its stdin ends, because a parent that dies closes the
// pipe and an orphan that ignored that would live on. `deaf` ignores only the stop line.
export const STUB = `
const args = process.argv.slice(2);
const at = (name) => args[args.indexOf(name) + 1];
const mode = process.env.STUB_MODE;
const readyText = (port) => '[server] ready ' + JSON.stringify({
  url: 'http://127.0.0.1:' + port + '/', pid: process.pid, argv: args,
});
if (mode === 'dies-early') {
  console.error('listen EADDRINUSE: address already in use');
  process.exit(3);
}
if (mode === 'crlf') {
  process.stdout.write(readyText(at('--port')) + '\\r\\n');
} else if (mode === 'split') {
  // Three writes a tenth of a second apart arrive as three chunks.
  const line = readyText(at('--port')) + '\\n';
  const cuts = [0, 12, 40, line.length];
  for (let i = 0; i < 3; i++) setTimeout(() => process.stdout.write(line.slice(cuts[i], cuts[i + 1])), i * 100);
} else if (mode !== 'silent') {
  console.log('[server] a line that is not the ready line');
  console.log(readyText(mode === 'wrong-port' ? 9999 : at('--port')));
}
let seen = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  seen += chunk;
  if (mode !== 'deaf' && /^stop$/m.test(seen)) process.exit(0);
});
process.stdin.on('end', () => process.exit(0));
// A wedged service is held up by more than its stdin, so only the handler above can end it.
if (mode === 'deaf') setInterval(() => {}, 1000);
`;

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A bound that is not worth keeping the process alive for when the thing it bounds finishes first.
const bound = (ms, value) => new Promise((resolve) => setTimeout(resolve, ms, value).unref());

/**
 * Starts the stub as the service, and ends it when `t` ends, whether the test passed, threw or
 * timed out: a stop line, a kill when that does not end it in REAP_MS, and an assertion that the
 * child is gone. `where` holds the directory and the stub's path.
 */
export function startStub(t, where, mode, options = {}) {
  process.env.STUB_MODE = mode;
  const service = startService({
    node: process.execPath, entry: where.stub, cwd: where.dir, port: TEST_PORT, roots: rootsUnder(where.dir), ...options,
  });
  let gone = false;
  service.exited.then(() => { gone = true; });
  t.after(async () => {
    const outcome = await Promise.race([service.stop().then(() => 'stopped'), bound(REAP_MS, 'late')]);
    if (outcome === 'late' && !gone) {
      try { process.kill(service.pid, 'SIGKILL'); } catch { /* it exited between the check and the kill */ }
      await Promise.race([service.exited, bound(REAP_MS)]);
    }
    assert.ok(gone && !alive(service.pid), `the service (pid ${service.pid}) was still running when its test ended`);
  });
  return service;
}
