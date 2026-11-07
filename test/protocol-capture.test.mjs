// Direct checks on the wire parser, the capture index validator, the FileHandle cache race,
// depth-only payload decimation, and non-finite focal lengths in cloudExtent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp, { mkdtemp, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeMessage, HEADER_BYTES, MAGIC, MAX_PAYLOAD_BYTES, MessageParser, TYPE_FRAME, TYPE_HELLO,
} from '../server/protocol.js';
import {
  cachedIndex, cloudExtent, decimatePayload, forgetCapture, indexPathFor, openCapture, readHelloCached,
} from '../server/capture.js';
import { scanTakes } from '../server/library.js';
import { CAPTURE_FORMAT, DEPTH_H, DEPTH_W } from '../web/format.js';

function makeFramePayload({ colour = Buffer.from([0xff, 0xd8, 0xff, 0xd9]), ts = 1000n, fill = 1200 } = {}) {
  const depthBytes = DEPTH_W * DEPTH_H * 2;
  const payload = Buffer.alloc(16 + depthBytes + colour.length);
  payload.writeUInt32LE(depthBytes, 0);
  payload.writeUInt32LE(colour.length, 4);
  payload.writeBigUInt64LE(ts, 8);
  for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
    payload.writeUInt16LE((fill + (i % 97)) & 0xffff, 16 + i * 2);
  }
  colour.copy(payload, 16 + depthBytes);
  return payload;
}

function makeCaptureBytes(frames = 2) {
  const hello = encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({
    fx: 366, fy: 366, cx: 256, cy: 212,
  })));
  const parts = [hello];
  for (let i = 0; i < frames; i++) {
    parts.push(encodeMessage(TYPE_FRAME, makeFramePayload({ ts: BigInt(1000 + i * 33), fill: 1000 + i * 10 })));
  }
  return Buffer.concat(parts);
}

test('MessageParser parses split headers and releases oversized input slabs once messages drain', () => {
  const seen = [];
  const parser = new MessageParser();
  const first = encodeMessage(TYPE_HELLO, Buffer.from('{"fx":366}'));
  const second = encodeMessage(TYPE_FRAME, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

  for (let i = 0; i < first.length; i++) seen.push(...parser.push(first.subarray(i, i + 1)));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, TYPE_HELLO);
  assert.equal(seen[0].payload.toString('utf8'), '{"fx":366}');

  // A 2 MiB pipe slab carrying one complete message plus 5 trailing bytes of the next header must
  // not stay pinned by a subarray view inside the parser.
  const slab = Buffer.allocUnsafe(2 * 1024 * 1024);
  second.copy(slab, 0);
  const partialNext = encodeMessage(TYPE_HELLO, Buffer.from('{"ok":true}'));
  partialNext.copy(slab, second.length, 0, 5);
  seen.push(...parser.push(slab.subarray(0, second.length + 5)));
  assert.equal(seen.length, 2);

  let retainedBytes = 0;
  for (const chunk of parser.chunks ?? (parser.buf ? [parser.buf] : [])) {
    retainedBytes += chunk.buffer.byteLength;
  }
  assert.ok(retainedBytes <= 64 * 1024, `parser retained a ${retainedBytes}-byte ArrayBuffer slab for 5 trailing bytes`);

  seen.push(...parser.push(partialNext.subarray(5)));
  assert.equal(seen.length, 3);
  assert.equal(seen[2].payload.toString('utf8'), '{"ok":true}');
});

test('MessageParser rejects bad magic and oversized lengths as soon as the 12-byte header arrives', () => {
  const badMagic = Buffer.alloc(HEADER_BYTES);
  badMagic.writeUInt32LE(0xdeadbeef, 0);
  const p1 = new MessageParser();
  p1.push(badMagic.subarray(0, 5));
  assert.throws(() => p1.push(badMagic.subarray(5)), /expected magic KNCT/);

  const tooBig = Buffer.alloc(HEADER_BYTES);
  tooBig.writeUInt32LE(MAGIC, 0);
  tooBig.writeUInt32LE(TYPE_FRAME, 4);
  tooBig.writeUInt32LE(MAX_PAYLOAD_BYTES + 1, 8);
  const p2 = new MessageParser();
  p2.push(tooBig.subarray(0, 7));
  assert.throws(() => p2.push(tooBig.subarray(7)), /past the \d+ this format allows/);
});

test('openCapture rebuilds a sidecar index whose frame offsets leave no room for 12-byte headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-idx-overlap-'));
  try {
    const path = join(dir, 'overlap.knct');
    const bytes = makeCaptureBytes(2);
    await writeFile(path, bytes);
    const first = await openCapture(path);
    const realOffsets = [...first.index.frames.offset];
    const realLengths = [...first.index.frames.length];
    forgetCapture(path);

    // Corrupt frame 1 so its payload offset overlaps frame 0's payload + 12-byte header.
    const idx = JSON.parse(await readFile(indexPathFor(path), 'utf8'));
    idx.frames.offset[1] = realOffsets[0] + realLengths[0] + 4;
    await writeFile(indexPathFor(path), JSON.stringify(idx));

    const reopened = await openCapture(path);
    try {
      assert.deepEqual(reopened.index.frames.offset, realOffsets, 'sidecar with overlapping frame header was rebuilt');
    } finally {
      forgetCapture(path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed openCapture never evicts a newer openCapture placed after forgetCapture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-open-race-'));
  try {
    const path = join(dir, 'race.knct');
    const replacement = join(dir, 'good.knct');
    // 6 MiB of valid frames followed by bad magic so buildIndex yields across stream chunks while
    // forgetCapture + atomic replacement install a new pending entry in openCaptures.
    await writeFile(path, Buffer.concat([makeCaptureBytes(20), Buffer.alloc(16, 0xee)]));
    await writeFile(replacement, makeCaptureBytes(1));

    const failing = openCapture(path);
    await new Promise((r) => setTimeout(r, 2));
    forgetCapture(path);
    await rename(replacement, path);
    const livePending = openCapture(path);
    await assert.rejects(failing, /expected magic KNCT/);
    const live = await livePending;

    const second = await openCapture(path);
    try {
      assert.equal(second, live, 'the failed open deleted the replacement Capture from openCaptures');
    } finally {
      forgetCapture(path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a scan forgotten as it opens files no sidecar and leaves nothing in the cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-forgotten-scan-'));
  try {
    const path = join(dir, 'take.knct');
    await writeFile(path, makeCaptureBytes(2));
    const st = await stat(path);

    const opening = openCapture(path);
    forgetCapture(path);
    const capture = await opening;
    assert.equal(capture.frameCount, 2, 'the open itself still finishes, for whoever was waiting on it');
    assert.equal(existsSync(indexPathFor(path)), false, 'the forgotten scan filed a sidecar');

    await unlink(path);
    await assert.rejects(cachedIndex(path, null, st), { code: 'ENOENT' }, 'the forgotten scan filled the cache');
  } finally {
    forgetCapture(join(dir, 'take.knct'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a scan of the old take that finishes after its replacement does not overwrite it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-replaced-scan-'));
  const realOpen = fsp.open;
  t.after(() => {
    fsp.open = realOpen;
    syncBuiltinESMExports();
  });
  // Holds the old scan on the old descriptor until its replacement is filed, so no timer decides
  // which of the two finishes last.
  let opened;
  const descriptorHeld = new Promise((done) => { opened = done; });
  let release;
  const replacementFiled = new Promise((done) => { release = done; });
  fsp.open = async (...args) => {
    fsp.open = realOpen;
    syncBuiltinESMExports();
    const handle = await realOpen(...args);
    opened();
    await replacementFiled;
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const path = join(dir, 'take.knct');
    await writeFile(path, makeCaptureBytes(3));
    const openingOld = openCapture(path);
    await descriptorHeld;

    await unlink(path);
    await writeFile(path, makeCaptureBytes(1));
    forgetCapture(path);
    const replacement = await cachedIndex(path);
    release();

    const old = (await openingOld).index;
    assert.notEqual(old.hash, replacement.hash);
    assert.equal(JSON.parse(await readFile(indexPathFor(path), 'utf8')).hash, replacement.hash, 'the sidecar is the old take');
    const stale = { size: old.bytes, mtimeMs: old.mtimeMs };
    assert.equal((await cachedIndex(path, null, stale)).hash, replacement.hash, 'the cache is the old take');
  } finally {
    forgetCapture(join(dir, 'take.knct'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a forget landing during the sidecar rename takes the sidecar back out', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-rename-forget-'));
  const path = join(dir, 'take.knct');
  const realRename = fsp.rename;
  t.after(() => {
    fsp.rename = realRename;
    syncBuiltinESMExports();
  });
  fsp.rename = async (from, to) => {
    await realRename(from, to);
    if (to === indexPathFor(path)) forgetCapture(path);
  };
  syncBuiltinESMExports();
  try {
    await writeFile(path, makeCaptureBytes(2));
    await cachedIndex(path);
    assert.equal(existsSync(indexPathFor(path)), false, 'the sidecar outlived the forget');
  } finally {
    forgetCapture(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a forget landing during the scratch write leaves the sidecar the name already has', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-write-forget-'));
  const path = join(dir, 'take.knct');
  const realWrite = fsp.writeFile;
  t.after(() => {
    fsp.writeFile = realWrite;
    syncBuiltinESMExports();
  });
  fsp.writeFile = async (to, data) => {
    await realWrite(to, data);
    if (String(to).endsWith('.tmp')) forgetCapture(path);
  };
  syncBuiltinESMExports();
  try {
    await realWrite(path, makeCaptureBytes(2));
    await realWrite(indexPathFor(path), 'the replacement take\'s sidecar');
    await cachedIndex(path);
    assert.equal(await readFile(indexPathFor(path), 'utf8'), 'the replacement take\'s sidecar');
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [], 'the scratch stayed behind');
  } finally {
    forgetCapture(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a scan forgotten during its stat is not the one the next caller waits on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-stat-forget-'));
  try {
    const path = join(dir, 'take.knct');
    await writeFile(path, makeCaptureBytes(2));
    const forgottenRead = cachedIndex(path);
    forgetCapture(path);
    await Promise.all([forgottenRead, cachedIndex(path)]);
    assert.equal(existsSync(indexPathFor(path)), true, 'the second caller waited on the forgotten scan and filed nothing');
  } finally {
    forgetCapture(join(dir, 'take.knct'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a listing that stats a take just before its forget files nothing for it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-listing-forget-'));
  const path = join(dir, 'take.knct');
  const realStat = fsp.stat;
  t.after(() => {
    fsp.stat = realStat;
    syncBuiltinESMExports();
  });
  // The listing's own stat only: the scan stats the name again, and a forget there is another test.
  fsp.stat = async (at, ...rest) => {
    const st = await realStat(at, ...rest);
    if (at === path) {
      fsp.stat = realStat;
      syncBuiltinESMExports();
      forgetCapture(path);
    }
    return st;
  };
  syncBuiltinESMExports();
  try {
    await writeFile(path, Buffer.concat([
      encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212, format: CAPTURE_FORMAT }))),
      encodeMessage(TYPE_FRAME, makeFramePayload()),
    ]));
    const { takes } = await scanTakes(dir);
    assert.equal(takes.length, 1);
    assert.equal(existsSync(indexPathFor(path)), false, 'the listing filed a sidecar past the forget');
  } finally {
    forgetCapture(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hello read forgotten in flight is not remembered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-forgotten-hello-'));
  try {
    const path = join(dir, 'take.knct');
    const helloSaying = (cx) => encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({ cx })));
    await writeFile(path, helloSaying(100));
    const index = await cachedIndex(path);
    const st = await stat(path);

    const reading = readHelloCached(path, index, st);
    forgetCapture(path);
    assert.equal((await reading).cx, 100);

    // Same length, same mtime: only the memo can answer with the old bytes now.
    await writeFile(path, helloSaying(200));
    await utimes(path, st.atime, st.mtime);
    assert.equal((await readHelloCached(path, index, st)).cx, 200, 'the forgotten read was remembered');
  } finally {
    forgetCapture(join(dir, 'take.knct'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('decimatePayload supports stripColour at divisor 1 and divisor 4, including unaligned slices', () => {
  const colour = Buffer.alloc(512, 0xab);
  const full = makeFramePayload({ colour, ts: 4321n, fill: 900 });
  // Place a copy at an odd byteOffset so aligned Uint16Array fast paths cannot crash on odd slices.
  const backing = Buffer.alloc(full.length + 3);
  full.copy(backing, 1);
  const oddSlice = backing.subarray(1, 1 + full.length);

  const stripped1 = decimatePayload(oddSlice, 1, 'frame', { stripColour: true });
  assert.equal(stripped1.readUInt32LE(0), DEPTH_W * DEPTH_H * 2);
  assert.equal(stripped1.readUInt32LE(4), 0);
  assert.equal(stripped1.length, 16 + DEPTH_W * DEPTH_H * 2);

  const withColour4 = decimatePayload(oddSlice, 4, 'frame');
  const stripped4 = decimatePayload(oddSlice, 4, 'frame', { stripColour: true });
  const expectedDepthBytes = Math.ceil(DEPTH_W / 4) * Math.ceil(DEPTH_H / 4) * 2;
  assert.equal(stripped4.readUInt32LE(0), expectedDepthBytes);
  assert.equal(stripped4.readUInt32LE(4), 0);
  assert.equal(stripped4.readBigUInt64LE(8), 4321n);
  assert.equal(stripped4.length, 16 + expectedDepthBytes);
  assert.deepEqual(
    stripped4.subarray(16, 16 + expectedDepthBytes),
    withColour4.subarray(16, 16 + expectedDepthBytes),
    'depth samples match the colour-preserving decimation bit for bit',
  );
});

test('cloudExtent ignores non-finite projections when intrinsics carry zero focal length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-extent-zero-fx-'));
  try {
    const path = join(dir, 'zero-fx.knct');
    await writeFile(path, makeCaptureBytes(1));
    const cap = await openCapture(path);
    try {
      const extent = await cloudExtent(cap, { fx: 0, fy: 366, cx: 256, cy: 212 }, 0.5, 4.0);
      assert.equal(extent.samples, 0);
      assert.equal(extent.x, null);
      assert.equal(extent.y, null);
    } finally {
      forgetCapture(path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fake-grabber reads captures whose frames straddle the 4 MiB read buffer with > 1 MiB retained', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-fake-grabber-slab-'));
  try {
    const path = join(dir, 'straddle.knct');
    const hello = encodeMessage(TYPE_HELLO, Buffer.from(JSON.stringify({
      fx: 366, fy: 366, cx: 256, cy: 212,
    })));
    const normalFrame = encodeMessage(TYPE_FRAME, makeFramePayload({ ts: 1000n, fill: 1100 }));
    const largeColour = Buffer.alloc(1536 * 1024, 0x7f);
    const largeFrame = encodeMessage(TYPE_FRAME, makeFramePayload({ colour: largeColour, ts: 2000n, fill: 1200 }));
    // Six normal frames (~2.6 MiB) place `largeFrame` (~1.95 MiB) across the 4 MiB read boundary with
    // > 1.2 MiB buffered in `MessageParser.chunks`, followed by eight normal frames (~3.4 MiB) so the
    // second 4 MiB read covers the offset where `largeFrame`'s retained tail begins.
    const parts = [hello];
    for (let i = 0; i < 6; i++) parts.push(normalFrame);
    parts.push(largeFrame);
    for (let i = 0; i < 8; i++) parts.push(normalFrame);
    await writeFile(path, Buffer.concat(parts));

    const out = execFileSync(process.execPath, [
      'tools/fake-grabber.mjs', '--source', path, '--burst', '1', '--frames', '1', '--die-after', '1',
    ], { maxBuffer: 16 * 1024 * 1024 });
    const parsed = new MessageParser().push(out);
    assert.equal(parsed.filter((m) => m.type === TYPE_FRAME).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
