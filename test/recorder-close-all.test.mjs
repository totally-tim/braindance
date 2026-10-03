// What the way out of a recorder waits for: every take it owns, not only the open one. A grabber
// restart leaves the take it split closing while the next one is open, and a stop in that window
// used to leave the first without its index and its marks. Called directly because a wire drive
// cannot choose which of two closes finishes first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../server/recorder.js';
import { indexPathFor } from '../server/capture.js';
import { encodeMessage, TYPE_FRAME } from '../server/protocol.js';

const HELLO = Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 }));
const frame = (n, bytes) => {
  const payload = Buffer.alloc(bytes);
  payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
  return encodeMessage(TYPE_FRAME, payload);
};

// A take carrying enough that its close outlasts the close of one holding only a hello.
function openSlowTake(recorder, label) {
  recorder.open(HELLO);
  const { path } = recorder.take;
  for (let n = 0; n < 48; n++) recorder.write(frame(n, 1 << 20));
  recorder.mark(0, label);
  return path;
}

async function markLabels(dir) {
  const marksDir = join(dir, 'marks');
  if (!existsSync(marksDir)) return '';
  const files = await readdir(marksDir);
  return (await Promise.all(files.map((file) => readFile(join(marksDir, file), 'utf8')))).join('\n');
}

async function inTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-close-all-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('close alone leaves a take a restart split still closing, which is the window closeAll shuts', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    const split = openSlowTake(recorder, 'split-take-mark');
    const splitting = recorder.split();
    recorder.open(HELLO);
    await recorder.close('stopped');
    assert.equal(existsSync(indexPathFor(split)), false, 'the split take was still closing when the open one finished');
    assert.equal(recorder.ownedTakes().length, 1, 'and the recorder still owned it');
    await splitting;
  });
});

test('closeAll waits for the take a restart split, and its index and marks are on disk when it returns', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    const split = openSlowTake(recorder, 'split-take-mark');
    recorder.split().catch(() => {});
    recorder.open(HELLO);
    const open = recorder.take.path;
    recorder.mark(0, 'open-take-mark');
    assert.equal(recorder.ownedTakes().length, 2, 'the restart left two takes owned');

    await recorder.closeAll('server stopped');

    assert.equal(recorder.ownedTakes().length, 0, 'nothing is owned afterwards');
    assert.ok(existsSync(indexPathFor(split)), 'the split take has its index');
    assert.ok(existsSync(indexPathFor(open)), 'the open take has its index');
    const marks = await markLabels(dir);
    assert.ok(marks.includes('split-take-mark'), 'the split take\'s mark is filed');
    assert.ok(marks.includes('open-take-mark'), 'the open take\'s mark is filed');
  });
});

test('closeAll reports a take that failed only after the others have finished', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    const split = openSlowTake(recorder, 'split-take-mark');
    recorder.split().catch(() => {});
    recorder.open(HELLO);
    // The scan of this one finds no file, so its close fails while the split take's is running.
    await unlink(recorder.take.path);

    await assert.rejects(recorder.closeAll('server stopped'), /ENOENT/);

    assert.ok(existsSync(indexPathFor(split)), 'the split take was left to finish before the failure was reported');
    assert.equal(recorder.ownedTakes().length, 0);
  });
});

test('closeAll with nothing recording returns', async () => {
  await inTempDir(async (dir) => {
    await new Recorder({ dir }).closeAll('server stopped');
  });
});
