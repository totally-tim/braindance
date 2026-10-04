import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appVersion, ffmpegVersion, parseFfmpegVersion, renderVersion } from '../server/render-version.js';
import { versionDifferences } from '../server/jobs.js';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'render-version-'));
  const web = join(root, 'web');
  const three = join(root, 'three');
  mkdirSync(join(web, 'nested'), { recursive: true });
  mkdirSync(join(three, 'build'), { recursive: true });
  mkdirSync(join(three, 'examples', 'jsm', 'postprocessing'), { recursive: true });
  writeFileSync(join(web, 'main.js'), 'export const a = 1;\n');
  writeFileSync(join(web, 'index.html'), '<html></html>\n');
  writeFileSync(join(web, 'nested', 'look.json'), '{}\n');
  writeFileSync(join(web, 'notes.txt'), 'not shipped\n');
  writeFileSync(join(three, 'build', 'three.module.js'), 'export const THREE = 1;\n');
  writeFileSync(join(three, 'examples', 'jsm', 'postprocessing', 'Pass.js'), 'export class Pass {}\n');
  writeFileSync(join(three, 'package.json'), '{"version":"0.185.1"}\n');
  return { web, three };
}

// A same-second rewrite keeps its mtime on coarse filesystems, so push it forward by hand.
function rewrite(path, text) {
  writeFileSync(path, text);
  const later = Date.now() / 1000 + 5;
  utimesSync(path, later, later);
}

test('the renderer version is stable across calls and changes with any shipped file', async () => {
  const { web, three } = tree();
  const first = await renderVersion(web, three);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await renderVersion(web, three), first);
  rewrite(join(web, 'main.js'), 'export const a = 2;\n');
  const second = await renderVersion(web, three);
  assert.notEqual(second, first, 'a web file');
  rewrite(join(three, 'examples', 'jsm', 'postprocessing', 'Pass.js'), 'export class Pass { render() {} }\n');
  const third = await renderVersion(web, three);
  assert.notEqual(third, second, 'a three module');
  rewrite(join(three, 'package.json'), '{"version":"0.186.0"}\n');
  const fourth = await renderVersion(web, three);
  assert.notEqual(fourth, third, 'the three version');
});

test('a change to the audio mux changes the job record and warns, and leaves the preview version alone', async () => {
  const { web, three } = tree();
  const root = dirname(web);
  const exportJs = join(root, 'server', 'export.js');
  mkdirSync(dirname(exportJs));
  copyFileSync(new URL('../server/export.js', import.meta.url), exportJs);
  const was = { app: await appVersion(root, three), effects: {}, renderer: 'gpu', ffmpeg: '9.0.2' };
  const preview = await renderVersion(web, three);
  const shipped = readFileSync(exportJs, 'utf8');
  const rule = '  const outputStart = Math.round(from * AUDIO_RATE);\n';
  assert.equal(shipped.split(rule).length, 2, 'the mux computes its output start from the program position once');
  rewrite(exportJs, shipped.replace(rule, '  const outputStart = 0;\n'));
  const now = { ...was, app: await appVersion(root, three) };
  assert.deepEqual(versionDifferences(was, now).map((d) => d.field), ['app'], 'the browser, renderer and ffmpeg are unchanged, and the app is not');
  assert.equal(await renderVersion(web, three), preview, 'the preview cache keys on the browser files alone');
});

test('a copy that preserves size and mtime still changes the version', async () => {
  const { web, three } = tree();
  const path = join(web, 'main.js');
  // A whole-millisecond mtime first, so restoring it through a Date restores it exactly.
  const kept = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  utimesSync(path, kept, kept);
  const { mtimeMs, size } = statSync(path);
  const before = await renderVersion(web, three);
  writeFileSync(path, 'export const a = 9;\n');
  utimesSync(path, kept, kept);
  const after = statSync(path);
  assert.equal(after.mtimeMs, mtimeMs, 'the rewrite kept its mtime');
  assert.equal(after.size, size, 'the rewrite kept its size');
  assert.notEqual(await renderVersion(web, three), before);
});

test('a file outside the shipped extensions does not enter the version', async () => {
  const { web, three } = tree();
  const before = await renderVersion(web, three);
  rewrite(join(web, 'notes.txt'), 'still not shipped\n');
  assert.equal(await renderVersion(web, three), before);
});

test('an unchanged tree answers from the memo without reading a file', async () => {
  const { web, three } = tree();
  const digest = await renderVersion(web, three);
  // Count the module's own readFile calls: the builtin's ESM bindings resync from the CJS object.
  const promises = createRequire(import.meta.url)('node:fs/promises');
  const original = promises.readFile;
  let reads = 0;
  promises.readFile = (...args) => { reads++; return original(...args); };
  syncBuiltinESMExports();
  try {
    assert.equal(await renderVersion(web, three), digest);
    assert.equal(reads, 0, 'an unchanged tree reads no contents');
    rewrite(join(web, 'index.html'), '<html><body></body></html>\n');
    assert.notEqual(await renderVersion(web, three), digest);
    assert.equal(reads, 6, 'a changed tree reads all six shipped files again');
  } finally {
    promises.readFile = original;
    syncBuiltinESMExports();
  }
});

test('the ffmpeg version is the token on the first line, or null for anything else', () => {
  assert.equal(parseFfmpegVersion('ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang'), '7.1.1');
  assert.equal(parseFfmpegVersion('ffmpeg version n7.0-12-gabc built from git'), 'n7.0-12-gabc');
  assert.equal(parseFfmpegVersion('zsh: command not found'), null);
  assert.equal(parseFfmpegVersion(''), null);
});

test('an ffmpeg that cannot be resolved or run is a problem sentence, never a throw', async () => {
  const unresolved = await ffmpegVersion(() => { throw new Error('no ffmpeg on PATH'); });
  assert.equal(unresolved.version, null);
  assert.match(unresolved.problem, /could not be resolved: no ffmpeg on PATH/);

  const missing = await ffmpegVersion(() => join(tmpdir(), 'no-such-ffmpeg-binary'));
  assert.equal(missing.version, null);
  assert.match(missing.problem, /did not report a version/);
});

test('the ffmpeg version comes from the binary the resolver names', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-version-'));
  const fake = join(dir, 'ffmpeg');
  writeFileSync(fake, '#!/bin/sh\necho "ffmpeg version 7.9.9 Copyright (c) the FFmpeg developers"\n');
  chmodSync(fake, 0o755);
  assert.deepEqual(await ffmpegVersion(() => fake), { version: '7.9.9', problem: null });

  const mute = join(dir, 'ffmpeg-mute');
  writeFileSync(mute, '#!/bin/sh\necho "not a version line"\n');
  chmodSync(mute, 0o755);
  const odd = await ffmpegVersion(() => mute);
  assert.equal(odd.version, null);
  assert.match(odd.problem, /not a version line/);
});
