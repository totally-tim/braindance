// `fake-grabber --hd --hd-counter` numbers its colour frames, and a reader holding one of them can
// say which. Needs ffmpeg and `captures/sample.knct`, and skips without them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageParser, TYPE_COLOR } from '../server/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = join(ROOT, 'captures', 'sample.knct');
const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const skip = !hasFfmpeg ? 'needs ffmpeg' : !existsSync(SAMPLE) ? 'needs captures/sample.knct (npm run fixtures)' : false;

// The code band's geometry, copied from `COUNTER` in the grabber rather than imported, because
// importing the grabber runs it. Asserted below: a copy that drifted decodes nothing.
const COUNTER = { cycle: 256, bits: 8, square: 64, pitch: 96, x: 576, top: 860, bottom: 956 };
// Read at the quarter size an OBS screenshot is taken at, so the squares have to survive a downscale.
const W = 480;
const H = 270;

// The counter in one frame's luma, or null where some bit's two squares do not differ clearly.
const decode = (gray) => {
  const mean = (x0, y0) => {
    let sum = 0;
    let count = 0;
    const [ax, bx] = [x0 + COUNTER.square / 4, x0 + (3 * COUNTER.square) / 4].map((v) => Math.round((v * W) / 1920));
    const [ay, by] = [y0 + COUNTER.square / 4, y0 + (3 * COUNTER.square) / 4].map((v) => Math.round((v * H) / 1080));
    for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) { sum += gray[y * W + x]; count++; }
    return sum / count;
  };
  let value = 0;
  for (let bit = 0; bit < COUNTER.bits; bit++) {
    const left = COUNTER.x + (COUNTER.bits - 1 - bit) * COUNTER.pitch;
    const top = mean(left, COUNTER.top);
    const bottom = mean(left, COUNTER.bottom);
    if (Math.abs(top - bottom) < 80) return null;
    if (top > bottom) value |= 1 << bit;
  }
  return value;
};

test('every colour frame carries its number, and the numbers count by one through the wrap', { skip }, async () => {
  const child = spawn(process.execPath, ['tools/fake-grabber.mjs', '--hd', '--hd-counter', '--fps', '120'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write('hd-color on\n');
  const parser = new MessageParser();
  const jpegs = [];
  await new Promise((resolve, reject) => {
    child.on('exit', () => reject(new Error(`the grabber exited early:\n${stderr}`)));
    child.stdout.on('data', (chunk) => {
      for (const msg of parser.push(chunk)) {
        if (msg.type === TYPE_COLOR) jpegs.push(Buffer.from(msg.payload.subarray(8)));
      }
      if (jpegs.length >= COUNTER.cycle + 24) resolve();
    });
  }).finally(() => child.kill());

  // One ffmpeg for every frame: the JPEGs back to back are an mjpeg stream.
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0',
    '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
  { input: Buffer.concat(jpegs), maxBuffer: 256 * 1024 * 1024 });
  assert.equal(raw.length, jpegs.length * W * H, 'ffmpeg decoded a different number of frames than arrived');
  const values = jpegs.map((_, i) => decode(raw.subarray(i * W * H, (i + 1) * W * H)));

  assert.equal(values.filter((v) => v === null).length, 0, `undecodable frames at ${values.flatMap((v, i) => (v === null ? [i] : [])).slice(0, 8)}`);
  const breaks = values.flatMap((v, i) => (i > 0 && v !== (values[i - 1] + 1) % COUNTER.cycle ? [`${values[i - 1]} then ${v}`] : []));
  assert.deepEqual(breaks, [], 'consecutive frames do not count by one');
  assert.ok(values.includes(COUNTER.cycle - 1) && values.includes(0), 'the run never crossed the wrap');
});
