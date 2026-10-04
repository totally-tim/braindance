// What a start does with the copy of a take's marks the recorder holds beside it while the close
// runs, which a process killed mid-close leaves behind: it files the copy into the take that wrote
// it, and into no other take given that name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptNamedMarkLogs, heldMarksPathFor, holdMarks, readMarks } from '../server/library.js';
import { encodeMessage, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';

const STARTED = 1_791_000_000_000;
const MARK = { id: 'm1', sourceMs: 40, label: 'held through a kill', at: 1 };

// A take as the recorder writes one: a hello stamped with when the take began, then frames.
async function writeTake(dir, startedAt) {
  const hello = encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212, startedAt })));
  const frames = [0, 1, 2].map((n) => {
    const payload = Buffer.alloc(64);
    payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
    return encodeMessage(TYPE_FRAME, payload);
  });
  const path = join(dir, '2026-10-04-take1.knct');
  await writeFile(path, Buffer.concat([hello, ...frames]));
  return path;
}

async function inTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-held-marks-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a held copy is filed into the take whose hello carries its start, and removed', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    await holdMarks(path, STARTED, [MARK]);
    const adopted = await adoptNamedMarkLogs(dir);
    assert.equal(adopted.length, 1, 'the copy was moved');
    assert.equal(adopted[0].records, 1);
    assert.deepEqual((await readMarks(dir, adopted[0].hash)).map((m) => m.id), ['m1']);
    assert.equal(existsSync(heldMarksPathFor(path, STARTED)), false, 'and the copy is gone');
  });
});

test('a held copy naming another start is a log a deleted take left under this name, and stays where it is', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    await holdMarks(path, STARTED - 1, [MARK]);
    assert.deepEqual(await adoptNamedMarkLogs(dir), []);
    assert.equal(existsSync(heldMarksPathFor(path, STARTED - 1)), true);
    assert.equal(existsSync(join(dir, 'marks')), false, 'nothing was filed under the take there now');
  });
});

test('a held copy beside a take whose hello never landed stays where it is, and nothing is filed under the hash every such take shares', async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, '2026-10-04-take1.knct');
    await writeFile(path, Buffer.alloc(0));
    await holdMarks(path, STARTED, [MARK]);
    assert.deepEqual(await adoptNamedMarkLogs(dir), []);
    assert.equal(existsSync(heldMarksPathFor(path, STARTED)), true);
    assert.equal(existsSync(join(dir, 'marks')), false);
  });
});
