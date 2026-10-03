// Which ffmpeg an export spawns: the one FFMPEG names, else the first on PATH, else a refusal that
// says where it looked. Stand-ins are shell scripts, so a Windows run has nothing to stage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ffmpegBinary } from '../server/export.js';

const noShell = process.platform !== 'win32' ? false : 'the stand-in encoders are shell scripts';

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'braindance-ffmpeg-'));
  const runnable = (name) => {
    mkdirSync(join(dir, name));
    const file = join(dir, name, 'ffmpeg');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
    return { directory: join(dir, name), file };
  };
  return { dir, runnable, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the FFMPEG name is used as given, even with another ffmpeg on PATH', { skip: noShell }, () => {
  const { runnable, cleanup } = stage();
  try {
    const onPath = runnable('on-path');
    assert.equal(ffmpegBinary({ named: '/opt/encoders/ffmpeg-custom', searchPath: onPath.directory }), '/opt/encoders/ffmpeg-custom');
  } finally {
    cleanup();
  }
});

test('with FFMPEG unset, the first runnable ffmpeg on PATH is the one', { skip: noShell }, () => {
  const { dir, runnable, cleanup } = stage();
  try {
    // Ahead of the real one: a directory that is not a program, a file that is not executable, and
    // a directory that does not exist.
    mkdirSync(join(dir, 'a-directory', 'ffmpeg'), { recursive: true });
    mkdirSync(join(dir, 'not-executable'));
    writeFileSync(join(dir, 'not-executable', 'ffmpeg'), 'not a program');
    const first = runnable('first');
    const second = runnable('second');
    const searchPath = [join(dir, 'a-directory'), join(dir, 'not-executable'), join(dir, 'missing'), first.directory, second.directory].join(delimiter);
    assert.equal(ffmpegBinary({ named: null, searchPath }), first.file);
  } finally {
    cleanup();
  }
});

test('an empty FFMPEG is unset', () => {
  assert.throws(() => ffmpegBinary({ named: '', searchPath: '' }), /no ffmpeg to export with/);
});

test('with neither, the refusal names the variable and every directory it searched', () => {
  const searchPath = ['/nowhere/bin', '/also/nowhere'].join(delimiter);
  assert.throws(() => ffmpegBinary({ named: null, searchPath }), (err) => {
    assert.match(err.message, /no ffmpeg to export with/);
    assert.match(err.message, /FFMPEG environment variable is not set/);
    assert.match(err.message, /\/nowhere\/bin, \/also\/nowhere/);
    return true;
  });
});

test('with neither and an empty PATH, the refusal says PATH is empty', () => {
  assert.throws(() => ffmpegBinary({ named: null, searchPath: '' }), /PATH, which is empty/);
});
