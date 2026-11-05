// Which of the node's takes is the copy of one here, called directly. The marks sync refuses the
// take being recorded before it asks, so no wire drive reaches the rule for a take with no hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { copyOnNode, NodeLink, renameTake, scanTakes } from '../server/library.js';
import { encodeMessage, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';
import { CAPTURE_FORMAT } from '../web/format.js';

const node = { name: 'pi', lastError: null };
const HASH = `sha256:${'a'.repeat(64)}`;
const open = { id: '2026-09-18-take2', hash: null, recording: true };
const finished = { id: '2026-09-18-take1', hash: HASH, recording: false };

test('a take with no hash is the copy of nothing on the node, not even of its open take', () => {
  assert.equal(copyOnNode(node, [open, finished], null), null);
  assert.equal(copyOnNode(node, [open, finished], undefined), null);
});

test('and a hashed take still finds its copy by hash, so the rule above is not a join switched off', () => {
  assert.equal(copyOnNode(node, [open, finished], HASH), finished);
});

test('NodeLink surfaces JSON error messages on non-2xx replies and recovers after a buildRefusal clears', async () => {
  let healthyRecordState = false;
  const srv = createServer((req, res) => {
    if (req.url === '/record/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthyRecordState
        ? { armed: false, recording: false, takeId: null, frames: 0, bytes: 0, dropped: 0, buffered: 0, cannotRecord: null, writingIds: [] }
        : { recording: false, takeId: null }));
      return;
    }
    if (req.url === '/library/takes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        takes: [{
          id: 't1', file: 't1.knct', bytes: 100, hash: HASH, frames: 3, durationSec: 1,
          capturedAt: 1000, dateSource: 'hello', truncated: false, dropped: 0,
          hasHello: true, format: 1, hello: { fx: 366, fy: 366, cx: 256, cy: 212 },
          openRefusals: [], openable: true, recording: false, marks: [],
        }],
      }));
      return;
    }
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'take t1 is still being recorded' }));
  });
  await new Promise((done) => srv.listen(0, '127.0.0.1', done));
  try {
    const link = new NodeLink(`http://127.0.0.1:${srv.address().port}`, 'pi');
    await assert.rejects(() => link.fetchJson('/library/remove-take/t1', { method: 'POST' }), /still being recorded/);
    await link.recordState();
    assert.ok(link.buildRefusal);
    assert.equal(await link.takes(), null);
    assert.match(link.lastError, /recorder state carries no/);
    // Remote node upgrades its recorder state; the very next takes() call recovers without waiting
    // on an out-of-band recordState() poll.
    healthyRecordState = true;
    const takes = await link.takes();
    assert.equal(link.buildRefusal, null);
    assert.equal(takes?.length, 1);
  } finally {
    await new Promise((done) => srv.close(done));
  }
});

test('renameTake allows a case-only rename on the same take file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-rename-case-'));
  try {
    const hello = encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 })));
    const payload = Buffer.alloc(20);
    payload.writeBigUInt64LE(1000n, 8);
    await writeFile(join(dir, 'clip.knct'), Buffer.concat([hello, encodeMessage(TYPE_FRAME, payload)]));
    const initial = await scanTakes(dir);
    const result = await renameTake(dir, 'clip', 'Clip', { hash: initial.takes[0].hash });
    assert.equal(result.id, 'Clip');
    const after = await scanTakes(dir);
    assert.deepEqual(after.takes.map((t) => t.id), ['Clip']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/library/rename and /library/reveal resolve takes stored with an uppercase .KNCT extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-upper-knct-'));
  let child = null;
  try {
    const hello = encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({
      fx: 366, fy: 366, cx: 256, cy: 212, format: CAPTURE_FORMAT, startedAt: 1700000000000,
    })));
    const f1 = Buffer.alloc(20);
    f1.writeBigUInt64LE(1000n, 8);
    const f2 = Buffer.alloc(20);
    f2.writeBigUInt64LE(1033n, 8);
    const captures = join(dir, 'captures');
    await mkdir(captures);
    const noop = join(dir, 'noop.mjs');
    await writeFile(noop, '');
    await writeFile(join(captures, 'clip.KNCT'), Buffer.concat([
      hello, encodeMessage(TYPE_FRAME, f1), encodeMessage(TYPE_FRAME, f2),
    ]));

    const roots = ['projects', 'presets', 'deliverables', 'effects', 'jobs', 'exports', 'audio']
      .flatMap((name) => [`--${name}`, join(dir, name)]);
    child = spawn(process.execPath, [
      'server/index.js', '--port', '0', '--standby-after', '0', '--captures', captures,
      '--reveal-with', `${process.execPath} ${noop}`, ...roots,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not print ready line: ${stderr}`)), 10000);
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('[server] ready ')) return;
        const msg = JSON.parse(line.slice('[server] ready '.length));
        clearTimeout(timer);
        resolve(msg.url);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early with ${code}: ${stderr}`));
      });
    });

    const listed = await (await fetch(`${origin}/library/takes`)).json();
    assert.equal(listed.takes.length, 1);
    assert.equal(listed.takes[0].id, 'clip');
    assert.equal(listed.takes[0].file, 'clip.KNCT');

    const revealed = await fetch(`${origin}/library/reveal/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(revealed.status, 200);

    const renamed = await fetch(`${origin}/library/rename/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: listed.takes[0].hash, to: 'renamed' }),
    });
    assert.equal(renamed.status, 200);
    const body = await renamed.json();
    assert.equal(body.id, 'renamed');
  } finally {
    child?.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
