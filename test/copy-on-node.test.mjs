// Which of the node's takes is the copy of one here, called directly. The marks sync refuses the
// take being recorded before it asks, so no wire drive reaches the rule for a take with no hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { copyOnNode, NodeLink, renameTake, scanTakes } from '../server/library.js';
import { encodeMessage, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';

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
