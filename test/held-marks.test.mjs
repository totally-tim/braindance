// The copy of a take's marks the recorder keeps beside it: appended as each mark is pressed, never
// left under a name the next take is given, and filed by a start into the take that wrote it and
// no other, with every record intact and only once they read back from the take's marks log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fsp, { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { buildIndex } from '../server/capture.js';
import {
  adoptNamedMarkLogs, heldMarksPathFor, holdMarks, marksPathFor, readMarkLog, readMarks, releaseFiled, renameTake,
} from '../server/library.js';
import { encodeMessage, TYPE_FRAME, TYPE_HELLO } from '../server/protocol.js';
import { Recorder } from '../server/recorder.js';

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

// A marks log a writer died in the middle of appending to.
async function tearLog(dir, hash) {
  await mkdir(join(dir, 'marks'), { recursive: true });
  await writeFile(marksPathFor(dir, hash), '{"id":"m0","sourceMs":10,"at":0}\n{"id":"half-writ');
}

const ids = async (dir, hash) => (await readMarkLog(dir, hash)).map((rec) => rec.id).sort();
const DROP = { id: 'drop:2026-10-04-take1', at: 3, kind: 'drop', dropped: 7 };

test('a held copy moved onto a marks log that ends mid-record keeps every one of its records', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const { hash } = await buildIndex(path);
    await tearLog(dir, hash);
    await holdMarks(path, STARTED, [MARK, { ...MARK, id: 'm2', at: 2 }, DROP]);
    const [adopted] = await adoptNamedMarkLogs(dir);
    assert.equal(adopted?.records, 3);
    assert.deepEqual(await ids(dir, hash), ['drop:2026-10-04-take1', 'm0', 'm1', 'm2']);
    assert.equal(existsSync(heldMarksPathFor(path, STARTED)), false);
  });
});

test('a held copy carrying only the drop record survives the same torn log', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const { hash } = await buildIndex(path);
    await tearLog(dir, hash);
    await holdMarks(path, STARTED, [DROP]);
    await adoptNamedMarkLogs(dir);
    assert.deepEqual(await ids(dir, hash), ['drop:2026-10-04-take1', 'm0']);
    assert.equal(existsSync(heldMarksPathFor(path, STARTED)), false);
  });
});

test('a held copy that cannot be read stays where it is, and nothing is filed', async (t) => {
  if (process.getuid?.() === 0) t.skip('root reads a file whatever its mode');
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    await holdMarks(path, STARTED, [MARK]);
    const copy = heldMarksPathFor(path, STARTED);
    await chmod(copy, 0o000);
    try {
      assert.deepEqual(await adoptNamedMarkLogs(dir), []);
      assert.equal(existsSync(copy), true);
      assert.equal(existsSync(join(dir, 'marks')), false);
    } finally {
      await chmod(copy, 0o600).catch(() => {});
    }
  });
});

test('a log is removed only once every one of its records reads back from the hash log', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const { hash } = await buildIndex(path);
    await holdMarks(path, STARTED, [MARK]);
    const copy = heldMarksPathFor(path, STARTED);
    assert.equal(await releaseFiled(dir, hash, copy, [MARK]), false, 'nothing is filed yet');
    assert.equal(existsSync(copy), true);
  });
});

// The day the recorder names a take after, in local time as it reads it.
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

test('a name with a held copy beside it and no take is not given to the next take', async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, `${today()}-take1.held-123.jsonl`), `${JSON.stringify(MARK)}\n`);
    const recorder = new Recorder({ dir });
    recorder.open(Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 })));
    try {
      assert.equal(recorder.take.id, `${today()}-take2`);
    } finally {
      await recorder.closeAll('test over');
    }
  });
});

test('a mark is copied beside its take while the take is still recording', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 })));
    const { path, startedAt } = recorder.take;
    const rec = recorder.mark(40, 'pressed mid-take');
    try {
      const copy = heldMarksPathFor(path, startedAt);
      // The whole record rather than the file: the append creates the file before its bytes land.
      const expected = `${JSON.stringify(rec)}\n`;
      for (let waited = 0; await readFile(copy, 'utf8').catch(() => '') !== expected && waited < 5000; waited += 10) {
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(recorder.state.recording, true, 'the take is still open');
      assert.equal(await readFile(copy, 'utf8'), expected);
    } finally {
      await recorder.closeAll('test over');
    }
  });
});

test('a mark pressed as its take closes is copied beside the take once', async () => {
  await inTempDir(async (dir) => {
    // A file where the marks directory goes, so the close cannot file the marks and the copy stays.
    await writeFile(join(dir, 'marks'), 'not a directory');
    const recorder = new Recorder({ dir });
    recorder.open(Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 })));
    const { path, startedAt } = recorder.take;
    recorder.mark(40, 'pressed as the take closes');
    const error = console.error;
    console.error = () => {};
    try {
      await assert.rejects(recorder.closeAll('test over'), /could not write its marks/);
    } finally {
      console.error = error;
    }
    const lines = (await readFile(heldMarksPathFor(path, startedAt), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, lines.join(' | '));
  });
});

// A copy named as another process on this host or another host would name it.
const HOST = hostname().replace(/[^A-Za-z0-9-]/g, '-');
const copyBy = (path, host, pid) => `${path.replace(/\.knct$/, '')}.held-${STARTED}.${host}.${pid}.jsonl`;

test('a copy whose writer is alive on this host, or on another host, is left to its writer', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const copies = [copyBy(path, HOST, process.ppid), copyBy(path, 'another-host', 12345)];
    for (const copy of copies) await writeFile(copy, `${JSON.stringify(MARK)}\n`);
    const log = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(await adoptNamedMarkLogs(dir), []);
    } finally {
      console.log = log;
    }
    for (const copy of copies) assert.equal(existsSync(copy), true);
    assert.equal(existsSync(join(dir, 'marks')), false, 'and the growing take was not filed under');
  });
});

test('a copy whose writer on this host is gone is filed', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const gone = spawn(process.execPath, ['-e', '']);
    await once(gone, 'exit');
    await writeFile(copyBy(path, HOST, gone.pid), `${JSON.stringify(MARK)}\n`);
    const [adopted] = await adoptNamedMarkLogs(dir);
    assert.equal(adopted?.records, 1);
  });
});

test('a take is not renamed onto a name a copy of marks is held under', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const { hash } = await buildIndex(path);
    await writeFile(copyBy(join(dir, 'other.knct'), HOST, 99999), `${JSON.stringify(MARK)}\n`);
    await assert.rejects(renameTake(dir, '2026-10-04-take1', 'other', { hash }), /holds marks under that name/);
    assert.equal(existsSync(path), true);
  });
});

test('a record a copy carries twice is filed once', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    const two = { ...MARK, id: 'm2', at: 2 };
    await holdMarks(path, STARTED, [MARK, two, MARK]);
    const [adopted] = await adoptNamedMarkLogs(dir);
    assert.deepEqual((await readMarkLog(dir, adopted.hash)).map((rec) => rec.id), ['m1', 'm2']);
  });
});

// Appends to a marks log under `marks/` report success and write nothing, so a caller that removes
// a copy without reading its records back loses them.
async function withMarksLogWritesLost(run) {
  const { appendFile } = fsp;
  fsp.appendFile = async (path, ...rest) => (String(path).includes(`${sep}marks${sep}`) ? undefined : appendFile(path, ...rest));
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    fsp.appendFile = appendFile;
    syncBuiltinESMExports();
  }
}

test('adoption keeps a copy whose records do not read back from the marks log', async () => {
  await inTempDir(async (dir) => {
    const path = await writeTake(dir, STARTED);
    await holdMarks(path, STARTED, [MARK]);
    const error = console.error;
    console.error = () => {};
    try {
      await withMarksLogWritesLost(async () => assert.deepEqual(await adoptNamedMarkLogs(dir), []));
    } finally {
      console.error = error;
    }
    assert.equal(existsSync(heldMarksPathFor(path, STARTED)), true);
  });
});

test('a close keeps the copy when its marks do not read back from the marks log', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 })));
    const { path, startedAt } = recorder.take;
    recorder.mark(40, 'filed nowhere');
    const error = console.error;
    console.error = () => {};
    try {
      await withMarksLogWritesLost(() => recorder.closeAll('test over'));
    } finally {
      console.error = error;
    }
    assert.equal(existsSync(heldMarksPathFor(path, startedAt)), true);
  });
});
