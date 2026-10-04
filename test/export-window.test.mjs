// The export socket's acknowledgement window, against an encoder that never reads its input, so
// no frame is ever acknowledged. A file of its own because `FFMPEG` is read once, at import.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'export-window-'));
const encoder = join(work, 'ffmpeg-that-never-reads');
writeFileSync(encoder, '#!/bin/sh\nexec sleep 30\n');
chmodSync(encoder, 0o755);
process.env.FFMPEG = encoder;
const { ACK_WINDOW, handleExportSocket } = await import('../server/export.js');
after(() => rmSync(work, { recursive: true, force: true }));

test('a frame past the acknowledgement window is refused', { skip: process.platform === 'win32' && 'the stand-in encoder is a shell script' }, async () => {
  const sent = [];
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, readyState: 1, send(text) { sent.push(JSON.parse(text)); }, close() {} });
  handleExportSocket(ws, { outDir: join(work, 'exports'), log() {} });
  const message = ws.listeners('message')[0];
  const [width, height] = [256, 256];
  await message(Buffer.from(JSON.stringify({ begin: { name: 'windowed', width, height, fps: 30, frames: 10, codec: 'lossless' } })), false);
  assert.ok(sent.at(-1)?.ready, JSON.stringify(sent.at(-1)));
  assert.equal(sent.at(-1).ready.window, ACK_WINDOW);
  // A frame larger than the pipe, so the stand-in's stdin never drains and nothing is acknowledged.
  for (let n = 0; n <= ACK_WINDOW; n++) await message(Buffer.alloc(width * height * 4, n), true);
  assert.equal(sent.filter((m) => m.ack).length, 0, 'no frame was acknowledged');
  assert.match(sent.at(-1)?.error ?? '', new RegExp(`frame ${ACK_WINDOW} arrived with ${ACK_WINDOW} unacknowledged, past the window of ${ACK_WINDOW}`));
  ws.emit('close');
});
