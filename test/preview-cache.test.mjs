import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PreviewImages, previewIdentity, previewRanges, sha256Hex } from '../web/preview-cache.js';

const snapshot = () => ({
  version: 'renderer-a', renderer: 'gpu-a', effects: 'rain revision-a', width: 640, height: 360,
  camera: { kind: 'program', pose: null }, cropOutside: [0],
  project: {
    version: 8, aspect: [16, 9], outputFps: 30,
    look: { params: { trails: .8 }, tracks: { trails: [{ t: 0, value: .8 }, { t: 4, value: .4 }] } },
    composition: { camera: [] },
    clips: [{
      id: 'c1', take: { id: 'take-a', hash: 'sha256-a' }, start: 0, length: 4, sourceStart: 1,
      speed: 1, appliedPreset: 'look-a', params: { fade: 100, wake: 500 },
      tracks: { fade: [{ t: 0, value: 100 }, { t: 3, value: 1000 }] },
    }],
  },
});

test('preview identity ignores evaluated values, labels, and object insertion order', () => {
  const before = snapshot();
  const after = snapshot();
  after.project.look.params.trails = .55;
  after.project.clips[0].params.fade = 750;
  after.project.clips[0].take.id = 'renamed';
  after.project.clips[0].appliedPreset = 'renamed-look';
  after.camera = { pose: null, kind: 'program' };
  assert.equal(previewIdentity(before), previewIdentity(after));
  assert.equal(after.project.clips[0].params.fade, 750, 'computing the identity does not modify the edit');
});

test('every input that changes the picture changes the preview identity', () => {
  const changes = {
    renderer: (s) => { s.renderer = 'gpu-b'; },
    code: (s) => { s.version = 'renderer-b'; },
    effects: (s) => { s.effects = 'rain revision-b'; },
    width: (s) => { s.width++; },
    height: (s) => { s.height++; },
    frameRate: (s) => { s.project.outputFps = 60; },
    aspect: (s) => { s.project.aspect = [1, 1]; },
    source: (s) => { s.project.clips[0].take.hash = 'sha256-b'; },
    start: (s) => { s.project.clips[0].start++; },
    trim: (s) => { s.project.clips[0].length--; },
    inPoint: (s) => { s.project.clips[0].sourceStart++; },
    speed: (s) => { s.project.clips[0].speed = 2; },
    look: (s) => { s.project.clips[0].params.wake++; },
    clipKey: (s) => { s.project.clips[0].tracks.fade[1].value++; },
    effectKey: (s) => { s.project.look.tracks.trails[1].t++; },
    cameraKey: (s) => { s.project.composition.camera.push({ t: 1, value: { fov: 60 } }); },
    cameraView: (s) => { s.camera.kind = 'free'; },
    cameraPose: (s) => { s.camera.pose = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: 50 }; },
    cropPreview: (s) => { s.cropOutside[0] = .14; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const altered = snapshot();
    change(altered);
    assert.notEqual(previewIdentity(snapshot()), previewIdentity(altered), name);
  }
});

test('the identity is a SHA-256 digest, so a storage key stays 64 characters however large the edit', () => {
  const vectors = {
    '': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    abc: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  };
  for (const [input, digest] of Object.entries(vectors)) assert.equal(sha256Hex(input), digest, JSON.stringify(input));
  // The padding boundaries and a multi-byte input, against the reference implementation.
  for (const input of ['x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'ünïcödé 日本語 '.repeat(40), 'y'.repeat(5000)]) {
    assert.equal(sha256Hex(input), createHash('sha256').update(input).digest('hex'), `${input.length} characters`);
  }
  const big = snapshot();
  big.project.clips = Array.from({ length: 40 }, (_, at) => ({ ...structuredClone(big.project.clips[0]), id: `c${at}` }));
  assert.match(previewIdentity(big), /^[0-9a-f]{64}$/);
});

test('coverage preserves holes and includes both ends of each completed run', () => {
  assert.deepEqual(previewRanges([]), []);
  assert.deepEqual(previewRanges([5, 2, 3, 1, 9, 9]), [[1, 3], [5, 5], [9, 9]]);
});

test('decoded images obey the byte budget and close on eviction, replacement, and clear', () => {
  const closed = [];
  const image = (name, width = 2) => ({ width, height: 2, close: () => closed.push(name) });
  const cache = new PreviewImages(32);
  assert.equal(cache.put(1, image('one')), true);
  cache.put(2, image('two'));
  cache.get(1);
  cache.put(3, image('three'));
  assert.deepEqual(closed, ['two']);
  assert.equal(cache.get(2), null);
  cache.put(1, image('replacement'));
  assert.deepEqual(closed, ['two', 'one']);
  assert.equal(cache.put(4, image('oversize', 10)), false);
  assert.equal(cache.bytes, 32);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.deepEqual(closed, ['two', 'one', 'oversize', 'three', 'replacement']);
  cache.clear();
  assert.equal(closed.length, 5);
});

test('the decoded budget includes the top-down depth samples', () => {
  let closed = false;
  const cache = new PreviewImages(16);
  assert.equal(cache.put(0, { width: 2, height: 2, close: () => { closed = true; } }, {
    c1: new Uint16Array(1),
  }), false);
  assert.equal(closed, true);
  assert.equal(cache.bytes, 0);
});
