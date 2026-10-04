// What the way out of a recorder waits for: every take it owns, not only the open one. A grabber
// restart leaves the take it split closing while the next one is open, and a stop in that window
// used to leave the first without its index and its marks. Called directly because a wire drive
// cannot choose which of two closes finishes first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../server/recorder.js';
import { indexPathFor } from '../server/capture.js';
import { heldMarksPathFor } from '../server/library.js';
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
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
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

// A regular file where the marks directory goes, so the write of the marks fails and nothing else does.
async function blockMarks(dir) {
  await writeFile(join(dir, 'marks'), 'not a directory');
}

test('closeAll rejects naming the take whose marks could not be written, once the take is indexed', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    const { id, path } = recorder.take;
    recorder.mark(0, 'lost-mark');
    await blockMarks(dir);

    await assert.rejects(recorder.closeAll('server stopped'), (err) => {
      assert.ok(err.message.startsWith(`take ${id}: could not write its marks:`), err.message);
      return true;
    });

    assert.ok(existsSync(indexPathFor(path)), 'the take has its index whatever became of its marks');
    assert.equal(recorder.ownedTakes().length, 0, 'and the recorder owns nothing afterwards');
  });
});

test('stop rejects the same way, so a route that stops a take can say the marks were lost', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    recorder.mark(0, 'lost-mark');
    await blockMarks(dir);
    await assert.rejects(recorder.stop(), /could not write its marks/);
    assert.equal(recorder.state.recording, false);
  });
});

test('a close that fails and marks that cannot be written reject with the close, and the marks are said', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    recorder.mark(0, 'lost-mark');
    await blockMarks(dir);
    // A stream destroyed with an error fails the close, and the scan that files the marks still runs.
    const said = [];
    const error = console.error;
    console.error = (line) => said.push(line);
    try {
      recorder.take.stream.destroy(new Error('the card was pulled'));
      await assert.rejects(recorder.closeAll('server stopped'), /the card was pulled/);
    } finally {
      console.error = error;
    }
    assert.ok(said.some((line) => /could not write its marks/.test(line)), `the marks failure was logged: ${said.join(' | ')}`);
  });
});

test('a take that fails mid-write says its marks were lost, and nothing is left unhandled', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    recorder.mark(0, 'lost-mark');
    await blockMarks(dir);
    const said = [];
    const error = console.error;
    console.error = (line) => said.push(line);
    try {
      recorder.take.stream.destroy(new Error('the card was pulled'));
      for (let waited = 0; !said.some((line) => /could not write its marks/.test(line)) && waited < 5000; waited += 10) {
        await new Promise((done) => setTimeout(done, 10));
      }
    } finally {
      console.error = error;
    }
    assert.ok(said.some((line) => /failed mid-write/.test(line)), 'the write failure was said');
    assert.ok(said.some((line) => /could not write its marks/.test(line)), `the marks failure was said: ${said.join(' | ')}`);
    assert.equal(recorder.take, null);
  });
});

test('closeAll waits for a take that failed mid-write until its index and marks are filed', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    const { path, stream } = recorder.take;
    recorder.write(frame(0, 1024));
    recorder.mark(0, 'failed-take-mark');
    // The hello has to land, or the marks are refused as belonging to a take no hash tells apart.
    for (let waited = 0; stream.writableLength > 0 && waited < 5000; waited += 5) {
      await new Promise((done) => setTimeout(done, 5));
    }
    const error = console.error;
    console.error = () => {};
    try {
      stream.destroy(new Error('the card was pulled'));
      await once(stream, 'error');
      await recorder.closeAll('server stopped');
    } finally {
      console.error = error;
    }
    assert.ok(existsSync(indexPathFor(path)), 'the failed take has its index when closeAll returns');
    assert.ok((await markLabels(dir)).includes('failed-take-mark'), 'and its mark is filed');
    assert.equal(recorder.ownedTakes().length, 0);
  });
});

// A take that fails mid-write while its copy and its scan fail too, so its filing has already failed
// before any stop arrives: a directory where the copy goes, and a take file nobody may read.
async function failUnfiled(recorder) {
  recorder.open(HELLO);
  const { path, stream, startedAt } = recorder.take;
  recorder.write(frame(0, 1024));
  for (let waited = 0; stream.writableLength > 0 && waited < 5000; waited += 5) {
    await new Promise((done) => setTimeout(done, 5));
  }
  const copy = heldMarksPathFor(path, startedAt);
  await mkdir(copy);
  await chmod(path, 0o000);
  recorder.mark(0, 'unfiled-mark');
  stream.destroy(new Error('the card was pulled'));
  await once(stream, 'error');
  for (let waited = 0; recorder.ownedTakes().length > 0 && waited < 5000; waited += 5) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(recorder.ownedTakes().length, 0, 'the failed filing has settled before the stop');
  return { path, copy };
}

test('a stop after a failed take\'s filing has already failed tries it again and rejects naming the take', async (t) => {
  if (process.getuid?.() === 0) t.skip('root reads a file whatever its mode');
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    const error = console.error;
    console.error = () => {};
    let path;
    try {
      ({ path } = await failUnfiled(recorder));
      await assert.rejects(recorder.closeAll('server stopped'), /no hash to be filed under/);
    } finally {
      console.error = error;
      if (path) await chmod(path, 0o644);
    }
  });
});

test('a stop after a failed take\'s filing has already failed files its marks once the cause has cleared', async (t) => {
  if (process.getuid?.() === 0) t.skip('root reads a file whatever its mode');
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    const error = console.error;
    console.error = () => {};
    try {
      const { path, copy } = await failUnfiled(recorder);
      await rmdir(copy);
      await chmod(path, 0o644);
      await recorder.closeAll('server stopped');
      assert.ok(existsSync(indexPathFor(path)), 'the take has its index');
      assert.ok((await markLabels(dir)).includes('unfiled-mark'), 'and its mark is filed');
      assert.equal(existsSync(copy), false, 'and the copy is gone');
    } finally {
      console.error = error;
    }
  });
});

test('a stop whose close could not file its marks leaves them for the next stop, which files them once the cause has cleared', async () => {
  await inTempDir(async (dir) => {
    const recorder = new Recorder({ dir });
    recorder.open(HELLO);
    const { path, startedAt } = recorder.take;
    // Both places the marks can go fail: a directory where the copy goes, a file where the log goes.
    const copy = heldMarksPathFor(path, startedAt);
    await mkdir(copy);
    await blockMarks(dir);
    recorder.mark(0, 'close-unfiled-mark');
    const error = console.error;
    console.error = () => {};
    try {
      await assert.rejects(recorder.stop(), /could not write its marks/);
      await rmdir(copy);
      await unlink(join(dir, 'marks'));
      await recorder.closeAll('server stopped');
    } finally {
      console.error = error;
    }
    assert.ok((await markLabels(dir)).includes('close-unfiled-mark'), 'the next stop filed the mark');
    assert.ok(existsSync(indexPathFor(path)));
  });
});
