// The export socket's limits on what a client may send, against stand-in encoders: one that never
// reads its input, so no frame is acknowledged, and one that reads and discards it. A file of its
// own because `FFMPEG` is read once, when `server/export.js` is evaluated.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'export-window-'));
after(() => rmSync(work, { recursive: true, force: true }));
const exportWith = async (name, script) => {
  const path = join(work, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  process.env.FFMPEG = path;
  return import(`../server/export.js?${name}`);
};
const neverReads = await exportWith('encoder-that-never-reads', 'exec sleep 30');
const discards = await exportWith('encoder-that-discards', 'exec cat > /dev/null');
const skip = process.platform === 'win32' && 'the stand-in encoders are shell scripts';

/** One export socket on a fake WebSocket, and what the server sent back over it. */
function socket(handleExportSocket) {
  const said = { acks: 0, last: null };
  const ws = new EventEmitter();
  Object.assign(ws, {
    OPEN: 1,
    readyState: 1,
    send(text) {
      const msg = JSON.parse(text);
      if (msg.ack) said.acks++;
      else said.last = msg;
    },
    close() {},
  });
  handleExportSocket(ws, { outDir: join(work, 'exports'), log() {} });
  return { ws, said, message: ws.listeners('message')[0] };
}

test('a frame past the acknowledgement window is refused', { skip }, async () => {
  const { ACK_WINDOW, handleExportSocket } = neverReads;
  const { ws, said, message } = socket(handleExportSocket);
  const [width, height] = [256, 256];
  await message(Buffer.from(JSON.stringify({ begin: { name: 'windowed', width, height, fps: 30, frames: 10, codec: 'lossless' } })), false);
  assert.equal(said.last?.ready?.window, ACK_WINDOW, JSON.stringify(said.last));
  // A frame larger than the pipe, so the stand-in's stdin never drains and nothing is acknowledged.
  try {
    for (let n = 0; n <= ACK_WINDOW; n++) await message(Buffer.alloc(width * height * 4, n), true);
    assert.equal(said.acks, 0, 'no frame was acknowledged');
    assert.match(said.last?.error ?? '', new RegExp(`frame ${ACK_WINDOW} arrived with ${ACK_WINDOW} unacknowledged, past the window of ${ACK_WINDOW}`));
  } finally {
    ws.emit('close');
  }
});

test('an export that declares no frame count is refused at the four-hour ceiling', { skip, timeout: 120_000 }, async () => {
  const { ACK_WINDOW, MAX_EXPORT_SECONDS, handleExportSocket } = discards;
  const { ws, said, message } = socket(handleExportSocket);
  const fps = 24;
  await message(Buffer.from(JSON.stringify({ begin: { name: 'uncounted', width: 2, height: 2, fps, codec: 'lossless' } })), false);
  assert.ok(said.last?.ready, JSON.stringify(said.last));
  const ceiling = MAX_EXPORT_SECONDS * fps;
  const frame = Buffer.alloc(16);
  try {
    for (let n = 0; n <= ceiling && !said.last?.error; n++) {
      // Paced the way the editor's sink is, so only the ceiling can refuse.
      while (n - said.acks >= ACK_WINDOW) await new Promise((done) => { setImmediate(done); });
      await message(frame, true);
      if (n === ceiling - 1) assert.equal(said.last?.error, undefined, `the ${ceiling} frames four hours holds are taken`);
    }
    assert.match(said.last?.error ?? '', new RegExp(`stops at ${ceiling} frames, the ${MAX_EXPORT_SECONDS}-second ceiling`));
  } finally {
    ws.emit('close');
  }
});
