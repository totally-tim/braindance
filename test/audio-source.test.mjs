import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_RATE, AUDIO_SECONDS, AUDIO_UPLOAD_BYTES, analyseAudio, checkAudioClip, defaultConditioning,
  audioSpectrum, modulatedValue, readAudioWav, signalAt,
} from '../web/audio-source.js';
import { audioFilter, AudioStore } from '../server/audio.js';
import { requireMutation } from '../server/http-guard.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { handleExportSocket } from '../server/export.js';

const tone = (hz, amplitude = 0.2) => {
  const samples = Float32Array.from({ length: AUDIO_RATE }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / AUDIO_RATE));
  return { samples: [samples], duration: 1, rate: AUDIO_RATE };
};
const settings = () => {
  const defaults = defaultConditioning();
  return { ...defaults, gain: 0, floor: -96, ceiling: 0, attack: 0, release: 0 };
};
const clip = () => ({
  kind: 'audio-file', hash: `sha256:${'0'.repeat(64)}`, name: 'tone.wav', start: 2, duration: 1,
  conditioning: settings(), target: { clip: 'c1', param: 'glitch.amount', depth: 0.5 },
});

test('flat EQ preserves RMS and stereo analysis does not cancel opposite phases', () => {
  const pcm = tone(100);
  const flat = analyseAudio(pcm, settings());
  const floor = 10 ** (-96 / 20);
  const expected = (0.2 / Math.sqrt(2) - floor) / (1 - floor);
  assert.ok(Math.abs(signalAt(flat, 0.5) - expected) < 1e-7);
  const stereo = { ...pcm, samples: [pcm.samples[0], pcm.samples[0].map((v) => -v)] };
  assert.equal(signalAt(analyseAudio(stereo, settings()), 0.5), signalAt(flat, 0.5));
});

test('the low and high EQ controls distinguish bass from treble', () => {
  const bass = tone(50); const treble = tone(8000);
  const lowOnly = { ...settings(), mid: -60, high: -60 };
  const highOnly = { ...settings(), low: -60, mid: -60 };
  assert.ok(signalAt(analyseAudio(bass, lowOnly), 0.5) > signalAt(analyseAudio(treble, lowOnly), 0.5) * 20);
  assert.ok(signalAt(analyseAudio(treble, highOnly), 0.5) > signalAt(analyseAudio(bass, highOnly), 0.5) * 20);
});

test('frequency display distinguishes tones and shows the actual EQ response', () => {
  const pcm = tone(1000);
  const flat = audioSpectrum(pcm, 0.5, settings());
  const loudest = flat.reduce((a, b) => a.input > b.input ? a : b);
  assert.ok(loudest.hz > 800 && loudest.hz < 1200);
  assert.ok(flat.every((bin) => Math.abs(bin.input - bin.output) < 1e-7));
  const cut = audioSpectrum(pcm, 0.5, { ...settings(), low: -12, mid: -12, high: -12 });
  assert.ok(cut.every((bin, i) => flat[i].input < -72 || Math.abs(bin.output - flat[i].output + 12) < 1e-7));
  assert.ok(audioSpectrum(pcm, 2, settings()).every((bin) => bin.input === -120 && bin.output === -120));
  assert.deepEqual(audioSpectrum(pcm, 0.5, settings()), flat);
});

test('silence, threshold, gain and ceiling bound the signal', () => {
  const silence = analyseAudio(tone(100, 0), settings());
  assert.ok(silence.values.every((v) => v === 0));
  const gated = analyseAudio(tone(100, 0.01), { ...settings(), floor: -20 });
  assert.ok(gated.values.every((v) => v === 0));
  const hot = analyseAudio(tone(100), { ...settings(), gain: 48 });
  assert.equal(signalAt(hot, 0.5), 1);
});

test('attack and release are computed once and random reads cannot change them', () => {
  const pcm = tone(100);
  pcm.samples[0].fill(0, AUDIO_RATE / 2);
  const smooth = analyseAudio(pcm, { ...settings(), attack: 100, release: 200 });
  const fast = analyseAudio(pcm, settings());
  assert.ok(signalAt(smooth, 0.02) < signalAt(fast, 0.02));
  assert.ok(signalAt(smooth, 0.6) > 0.03);
  assert.equal(signalAt(fast, 0.6), 0);
  const expected = signalAt(smooth, 0.35);
  for (const at of [0.9, 0.01, 0.7, -1, 10, NaN]) signalAt(smooth, at);
  assert.equal(signalAt(smooth, 0.35), expected);
  assert.equal(signalAt(smooth, -0.01), 0);
  assert.equal(signalAt(smooth, 1), 0);
});

test('modulation adds signed depth to the base and clamps to the parameter range', () => {
  assert.equal(modulatedValue(0.3, 0.4, 0.5, 0, 1), 0.5);
  assert.equal(modulatedValue(0.3, -0.4, 0.5, 0, 1), 0.09999999999999998);
  assert.equal(modulatedValue(0.8, 1, 1, 0, 1), 1);
  assert.equal(modulatedValue(0.2, -1, 1, 0, 1), 0);
});

test('audio document validation rejects malformed and unsupported sources before adoption', () => {
  const good = clip();
  assert.deepEqual(checkAudioClip(good), good);
  assert.equal(checkAudioClip(null), null);
  for (const patch of [
    { kind: 'live-midi' }, { hash: '../outside' }, { start: NaN }, { duration: 0 },
    { duration: AUDIO_SECONDS + 1 }, { target: {} }, { target: { ...good.target, depth: Infinity } },
    { conditioning: { ...good.conditioning, floor: -6, ceiling: -12 } },
    { conditioning: { ...good.conditioning, attack: -1 } },
  ]) assert.throws(() => checkAudioClip({ ...good, ...patch }));
});

function wav() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(AUDIO_RATE, 24);
  b.writeUInt32LE(AUDIO_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(4, 40); b.writeInt16LE(-32768, 44); b.writeInt16LE(16384, 46);
  return b;
}

test('WAV reader checks chunk bounds, sample format and complete PCM frames', () => {
  const bytes = wav();
  assert.deepEqual([...readAudioWav(bytes).samples[0]], [-1, 0.5]);
  for (const [at, value] of [[4, 200], [16, 100], [24, 44100], [40, 3]]) {
    const broken = Buffer.from(bytes); broken.writeUInt32LE(value, at);
    assert.throws(() => readAudioWav(broken));
  }
  assert.throws(() => readAudioWav(Buffer.alloc(0)));
});

test('audio store refuses missing, changed and symlinked assets without leaving imports behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audio-store-'));
  try {
    const store = new AudioStore(root);
    const bytes = wav();
    const hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const path = join(root, `${hash.slice(7)}.wav`);
    await assert.rejects(store.read(hash));
    await writeFile(path, bytes);
    assert.deepEqual(await store.read(hash), bytes);
    await writeFile(path, Buffer.alloc(48));
    await assert.rejects(store.read(hash), /hash/);
    await rm(path);
    await writeFile(join(root, 'outside'), bytes);
    await symlink(join(root, 'outside'), path);
    await assert.rejects(store.read(hash));
    await assert.rejects(store.import(Readable.from([])), /empty/);
    const chunk = Buffer.alloc(1024 * 1024);
    const chunks = [...Array(AUDIO_UPLOAD_BYTES / chunk.length).fill(chunk), Buffer.alloc(1)];
    await assert.rejects(store.import(Readable.from(chunks)), /exceeds/);
    assert.equal(store.importing, false);
    assert.equal(store.writes, 0);
    assert.ok((await readdir(root)).every((name) => !name.startsWith('.import-')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('audio mux derives a trimmed source and silence from program positions', () => {
  const source = { start: 2, duration: 1 };
  const filter = audioFilter(source, 1, 90, 30);
  assert.match(filter, /atrim=end_sample=48000\[lead\]/);
  assert.match(filter, /start_sample=0:end_sample=48000/);
  assert.match(filter, /atrim=end_sample=48000\[tail\]/);
  assert.match(audioFilter(source, 2.5, 15, 30), /start_sample=24000:end_sample=48000/);
  assert.match(audioFilter(source, 1000, 30, 30), /anullsrc.*end_sample=48000\[audio\]/);
});

test('binary uploads retain method, origin and non-simple content-type gates', () => {
  const run = (patch = {}, contentType = 'application/octet-stream') => {
    let status = 200;
    const req = { method: 'POST', headers: { host: '127.0.0.1:8176', 'content-type': contentType }, ...patch };
    const res = { setHeader() {}, writeHead(n) { status = n; }, end() {} };
    return { ok: requireMutation(req, res, ['POST'], 'application/octet-stream'), status };
  };
  assert.deepEqual(run(), { ok: true, status: 200 });
  assert.equal(run({ method: 'GET' }).status, 405);
  for (const type of ['text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded', 'application/json']) {
    assert.equal(run({}, type).status, 415);
  }
  assert.equal(run({ headers: { host: '127.0.0.1:8176', origin: 'http://evil.invalid', 'content-type': 'application/octet-stream' } }).status, 403);
});

test('closing an export during setup stops it before the audio asset is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audio-export-cancel-'));
  let reads = 0;
  let closed;
  const close = new Promise((resolve) => { closed = resolve; });
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, readyState: 1, send() {}, close: closed });
  handleExportSocket(ws, { outDir: root, log() {}, audioStore: { async read() { reads++; throw new Error('read after close'); } } });
  const message = ws.listeners('message')[0];
  const pending = message(Buffer.from(JSON.stringify({ begin: {
    name: 'canceled', width: 320, height: 180, fps: 30, frames: 1, codec: 'lossless',
    programStart: 0, project: { audio: clip() },
  } })), false);
  ws.readyState = 3;
  ws.emit('close');
  try { await Promise.all([pending, close]); assert.equal(reads, 0); }
  finally { await rm(root, { recursive: true, force: true }); }
});
