// The desktop shell's service handling, called directly with a stub standing in for server/index.js.
// desktop-check drives the same code through Electron and the real server; what this holds that
// the check cannot is the 20-second bound, which the stub shortens, and the origin rules on inputs
// no page sends.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { externalUrl, sameOrigin, senderTrusted } from '../desktop/origin.js';
import { revealable, within } from '../desktop/reveal.js';
import {
  PORT, findNode, lineSplitter, parseReadyLine, portFree, rootsUnder, serviceArgs, startService,
} from '../desktop/service.js';

// The stub reads its behavior from STUB_MODE, which a spawned child inherits. It binds nothing, so
// no port is held.
const STUB = `
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
if (mode === 'deaf') {
  setInterval(() => {}, 1000);
} else {
  let seen = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    seen += chunk;
    if (/^stop$/m.test(seen)) process.exit(0);
  });
  process.stdin.on('end', () => process.exit(0));
}
`;

let dir;
let stub;
const started = [];
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'braindance-desktop-'));
  stub = join(dir, 'stub-service.mjs');
  await writeFile(stub, STUB);
});
// A stub the test lost track of, because an assertion threw first, must not outlive the run.
after(async () => {
  for (const pid of started) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await rm(dir, { recursive: true, force: true });
});

const TEST_PORT = 49321;
const run = (mode, options = {}) => {
  process.env.STUB_MODE = mode;
  const service = startService({
    node: process.execPath, entry: stub, cwd: dir, port: TEST_PORT, roots: rootsUnder(dir), ...options,
  });
  started.push(service.pid);
  return service;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the service is started on the fixed port with every root named', () => {
  assert.equal(PORT, 8480);
  const roots = rootsUnder('/data');
  const args = serviceArgs({ entry: '/app/server/index.js', port: PORT, roots });
  assert.deepEqual(args.slice(0, 4), ['/app/server/index.js', '--port', '8480', '--stop-on-stdin']);
  for (const name of ['captures', 'projects', 'presets', 'deliverables', 'effects', 'jobs', 'exports']) {
    assert.equal(args[args.indexOf(`--${name}`) + 1], `/data/${name}`, `--${name} points at its own directory`);
  }
});

test('a ready line is read for its url, and no other line is one', () => {
  assert.equal(parseReadyLine('[server] viewer on http://127.0.0.1:8480'), null);
  assert.equal(parseReadyLine('ready {"url":"http://127.0.0.1:8480"}'), null);
  const info = parseReadyLine('[server] ready {"url":"http://127.0.0.1:8480","pid":7,"roots":{}}');
  assert.equal(info.origin, 'http://127.0.0.1:8480');
  assert.equal(info.pid, 7);
  assert.throws(() => parseReadyLine('[server] ready {not json'), /not JSON/);
  assert.throws(() => parseReadyLine('[server] ready {"pid":7}'), /names no url/);
  assert.throws(() => parseReadyLine('[server] ready {"url":"http://127.0.0.1:8481"}'), /only port 8480/);
  assert.throws(() => parseReadyLine('[server] ready {"url":"https://127.0.0.1:8480"}'), /only port 8480/);
});

test('a ready line that ends in a carriage return is read, from the parser and from a child', async () => {
  const line = '[server] ready {"url":"http://127.0.0.1:8480","pid":7}';
  assert.equal(parseReadyLine(`${line}\r`).origin, 'http://127.0.0.1:8480');
  assert.equal(parseReadyLine(`${line}\r`).pid, 7);
  assert.equal(parseReadyLine('[server] viewer on http://127.0.0.1:8480\r'), null);
  const service = run('crlf', { readyTimeoutMs: 3000 });
  assert.equal((await service.ready).origin, `http://127.0.0.1:${TEST_PORT}`);
  await service.stop();
});

test('the first Node of version 26 or newer wins, and the older ones are reported', async () => {
  const versions = { '/a/node': 'v24.21.0', '/b/node': 'v26.5.0', '/c/node': 'v28.0.0' };
  const probe = async (path) => versions[path] ?? null;
  assert.deepEqual(await findNode(['/missing', '/a', '/b', '/c'], probe), {
    path: '/b/node', version: 'v26.5.0', older: [{ path: '/a/node', version: 'v24.21.0' }],
  });
  const none = await findNode(['/a', '/missing'], probe);
  assert.equal(none.path, null);
  assert.deepEqual(none.older, [{ path: '/a/node', version: 'v24.21.0' }]);
  assert.equal((await findNode([], probe)).path, null);
});

test('a port something holds is not free, and is once released', async () => {
  const holder = createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  try {
    assert.equal(await portFree(port), false);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
  assert.equal(await portFree(port), true);
});

test('a service reports ready, takes its flags, and stops on a stop line with code 0', async () => {
  const service = run('well-behaved');
  const info = await service.ready;
  assert.equal(info.origin, `http://127.0.0.1:${TEST_PORT}`);
  assert.ok(info.argv.includes('--stop-on-stdin') && info.argv.includes('--exports'));
  assert.ok(alive(service.pid));
  const result = await service.stop();
  assert.equal(result.code, 0);
  assert.equal(result.forced, false);
  assert.equal(alive(service.pid), false);
  assert.deepEqual(await service.stop(), result, 'a second stop answers with the same exit');
});

test('a service that ignores the stop line lives out the bound and is killed after it', async () => {
  const service = run('deaf', { stopGraceMs: 700 });
  await service.ready;
  const stopping = service.stop();
  await sleep(250);
  assert.equal(alive(service.pid), true, 'it is not killed while the bound has time left');
  const result = await stopping;
  assert.equal(result.forced, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(alive(service.pid), false);
});

test('a service that exits before it is ready fails the start with its code and its last words', async () => {
  const service = run('dies-early');
  await assert.rejects(service.ready, (err) => /code 3/.test(err.message) && /EADDRINUSE/.test(err.message));
});

test('a service that never says ready fails the start and is told to stop', async () => {
  const service = run('silent', { readyTimeoutMs: 300 });
  await assert.rejects(service.ready, /no ready line/);
  const result = await service.exited;
  assert.equal(result.code, 0, 'it was asked to stop, and stopped');
});

test('a service that says another port fails the start', async () => {
  const service = run('wrong-port');
  await assert.rejects(service.ready, /only port/);
  await service.stop();
});

test('text that arrives in pieces becomes whole lines, each passed on once', () => {
  const lines = [];
  const push = lineSplitter((line) => lines.push(line));
  push('[server] ready {"url":');
  push('"http://127.0.0.1:8480"}\r');
  assert.deepEqual(lines, [], 'a line with no end yet is held');
  push('\n[server] next');
  push(' line\n\n');
  assert.deepEqual(lines, ['[server] ready {"url":"http://127.0.0.1:8480"}\r', '[server] next line', '']);
  assert.equal(parseReadyLine(lines[0]).origin, 'http://127.0.0.1:8480', 'the held pieces make a ready line');
});

test('a ready line that arrives in pieces is read once, whole, from a child', async () => {
  const seen = [];
  const service = run('split', { readyTimeoutMs: 3000, onLine: (stream, line) => seen.push({ stream, line }) });
  assert.equal((await service.ready).origin, `http://127.0.0.1:${TEST_PORT}`);
  const out = seen.filter(({ stream }) => stream === 'stdout');
  assert.equal(out.length, 1, 'three chunks made one line');
  assert.match(out[0].line, /^\[server\] ready \{.*\}$/);
  await service.stop();
});

test('the service has 30 seconds to say it is ready when nothing else is given', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = run('silent');
  let outcome = 'waiting';
  service.ready.then(() => { outcome = 'ready'; }, () => { outcome = 'refused'; });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(outcome, 'waiting', 'still waiting a millisecond before the bound');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(outcome, 'refused', 'refused at the bound');
  await assert.rejects(service.ready, /no ready line in 30 seconds/);
  assert.equal((await service.exited).code, 0, 'it was asked to stop, and stopped');
});

test('only the service origin is the page\'s own, on any path and nowhere else', () => {
  const origin = 'http://127.0.0.1:8480';
  for (const url of ['http://127.0.0.1:8480/', 'http://127.0.0.1:8480/library?take=a#b', 'blob:http://127.0.0.1:8480/1f2e']) {
    assert.equal(sameOrigin(url, origin), true, url);
  }
  for (const url of [
    'http://localhost:8480/', 'http://127.0.0.1:8481/', 'https://127.0.0.1:8480/', 'file:///etc/passwd',
    'about:blank', 'data:text/html,x', 'http://127.0.0.1:8480@evil.example/', 'http://evil.example/?http://127.0.0.1:8480',
    'not a url', '', undefined,
  ]) {
    assert.equal(sameOrigin(url, origin), false, String(url));
  }
});

test('only web links go to the OS browser', () => {
  assert.equal(externalUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(externalUrl('http://127.0.0.1:8480/program'), 'http://127.0.0.1:8480/program');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'blob:http://x/1', 'x-apple.systempreferences:', 'nope']) {
    assert.equal(externalUrl(url), null, url);
  }
});

test('a message is trusted only from the top frame of the window, while it shows the service', () => {
  const origin = 'http://127.0.0.1:8480';
  const main = { url: 'http://127.0.0.1:8480/library' };
  const contents = { mainFrame: main };
  const from = (sender, senderFrame) => ({ sender, senderFrame });
  assert.equal(senderTrusted(from(contents, main), contents, origin), true);
  assert.equal(senderTrusted(from({ mainFrame: main }, main), contents, origin), false, 'another window');
  assert.equal(senderTrusted(from(contents, { url: main.url }), contents, origin), false, 'a subframe');
  assert.equal(senderTrusted(from(contents, Object.assign(main, { url: 'http://evil.example/' })), contents, origin), false, 'another origin');
  assert.equal(senderTrusted(from(contents, main), null, origin), false, 'no window');
});

test('a path is revealed when the user chose it, or when its real path is inside a data folder', async () => {
  // The temp directory is itself a symlink on macOS, so the roots below are reached through one.
  const base = join(dir, 'reveal');
  const root = join(base, 'data');
  for (const folder of ['data/nested', 'data-sibling', 'outside', 'picked-dir']) await mkdir(join(base, folder), { recursive: true });
  for (const file of ['data/take.knct', 'data/nested/clip.mp4', 'data-sibling/file.txt', 'outside/secret.txt', 'picked.txt', 'picked-dir/inside.txt']) {
    await writeFile(join(base, file), file);
  }
  await symlink(join(base, 'outside'), join(root, 'escape'));
  await symlink(join(base, 'outside', 'secret.txt'), join(root, 'secret-link'));
  await symlink(join(root, 'take.knct'), join(root, 'alias'));
  const picked = new Set([join(base, 'picked.txt'), join(base, 'picked-dir'), join(base, 'export-not-yet-written.mp4')]);
  const ask = (path) => revealable(path, { picked, roots: [root, join(base, 'no-such-root')] });
  const real = (path) => realpath(join(base, path));

  assert.equal(await ask(join(root, 'take.knct')), await real('data/take.knct'), 'a file in a root');
  assert.equal(await ask(join(root, 'nested', 'clip.mp4')), await real('data/nested/clip.mp4'), 'a file deeper in it');
  assert.equal(await ask(root), await realpath(root), 'the root itself');
  assert.equal(await ask(join(root, 'alias')), await real('data/take.knct'), 'a link that stays inside shows its target');
  assert.equal(await ask(join(base, 'picked.txt')), join(base, 'picked.txt'), 'a file the user chose, outside every root');
  assert.equal(await ask(join(base, 'export-not-yet-written.mp4')), join(base, 'export-not-yet-written.mp4'),
    'a chosen save destination, before the export has written it');
  assert.equal(await ask(join(base, 'picked-dir')), join(base, 'picked-dir'), 'a directory the user chose');

  for (const [why, path] of [
    ['inside a directory the user chose, which was not itself chosen', join(base, 'picked-dir', 'inside.txt')],
    ['an unrelated file', join(base, 'outside', 'secret.txt')],
    ['a system file', '/etc/hosts'],
    ['the filesystem root', '/'],
    ['the folder that holds a root', base],
    ['a climb out of a root', join(root, '..', 'outside', 'secret.txt')],
    ['a directory link out of a root', join(root, 'escape', 'secret.txt')],
    ['a file link out of a root', join(root, 'secret-link')],
    ['a folder whose name starts with a root\'s', join(base, 'data-sibling', 'file.txt')],
    ['a path in a root that does not exist', join(root, 'nothing.txt')],
  ]) {
    assert.equal(await ask(path), null, why);
  }
});

test('a path is inside a folder when it is the folder or begins with it and a separator, as written', () => {
  const root = join(sep, 'data', 'captures');
  assert.equal(within(root, root), true, 'the folder itself');
  assert.equal(within(root, join(root, 'a', 'b.knct')), true, 'a file below it');
  assert.equal(within(sep, join(sep, 'etc')), true, 'a folder that is the filesystem root');
  assert.equal(within(root, `${root}-old`), false, 'a sibling whose name begins with the same letters');
  assert.equal(within(root, join(sep, 'data', 'CAPTURES', 'a')), false, 'the same letters in another case');
  assert.equal(within(root, join(sep, 'data')), false, 'the folder that holds it');
});
