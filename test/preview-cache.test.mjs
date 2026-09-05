import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewImages, previewIdentity, previewRanges } from '../web/preview-cache.js';

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
