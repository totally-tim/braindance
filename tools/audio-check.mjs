#!/usr/bin/env node
// Drives audio import, conditioning, mapping, persistence and a real mux in an isolated editor.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FFMPEG } from '../server/export.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, fallback = null) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const PORT = Number(flag('--port', '8196'));
const AUDIO = flag('--audio');
const SOURCE = flag('--source');
const SHOTS = flag('--shots');
const MUTATE = flag('--mutate');
const MUTATIONS = {
  'signal-disconnected': {
    file: 'web/main.js', edits: [['    applyAudio(t);', '    /* audio deliberately disconnected */']],
    fails: 'the rendered frame and the displayed result no longer change with modulation depth',
  },
  'mux-ignores-start': {
    file: 'server/export.js', edits: [['audioFilter(audioClip, msg.programStart, frames, fps)', 'audioFilter(audioClip, 0, frames, fps)']],
    fails: 'the exported PCM does not match the source samples at the requested program position',
  },
  'added-effect-hidden': {
    file: 'web/main.js', edits: [['return look.effects.has(effect) || effectParamNames(effect)', 'return effectParamNames(effect)']],
    fails: 'an effect added at its defaults is absent from the audio destination list',
  },
  'space-keeps-control-focus': {
    file: 'web/main.js', edits: [['  if (e.repeat) return;\n  ui.play.click();', '  if (e.repeat || controlKeeps(e.target, e.key)) return;\n  ui.play.click();']],
    fails: 'Space cannot start the transport while a slider, selector, or numeric field holds focus',
  },
  'text-field-loses-space': {
    file: 'web/main.js', edits: [["  if (takesText(e.target) && e.target.type !== 'number') return;\n", '']],
    fails: 'a space typed into a text field starts the transport instead of reaching the field',
  },
  'delete-edits-target-in-place': {
    file: 'web/main.js', edits: [['replaceAudio({ ...audioClip, target: null }); audioPanel?.paint(); }', 'audioClip.target = null; audioPanel?.paint(); }']],
    fails: 'an audio edit waiting on its analysis restores a mapping onto the clip deleted meanwhile',
  },
  'audio-hashed-in-the-page': {
    file: 'web/audio-session.js', edits: [['    const pcm = readAudioWav(new Uint8Array(await response.arrayBuffer()));',
      "    const bytes = new Uint8Array(await response.arrayBuffer());\n    await crypto.subtle.digest('SHA-256', bytes);\n    const pcm = readAudioWav(bytes);"]],
    fails: 'a project with audio cannot open on a plain-HTTP origin, which has no crypto.subtle',
  },
  'reset-retains-before-refusal': {
    file: 'web/main.js', edits: [["    if (refuseEdit(`resetting ${name}`)) return;\n", '']],
    fails: 'a reset pressed during an export adds its effect to the document and commits an undo step',
  },
  'undo-leaves-spectrum-empty': {
    file: 'web/audio-session.js', edits: [['if (!inspection && inspectionFailure !== clip.hash)', 'if (false && !inspection && inspectionFailure !== clip.hash)']],
    fails: 'undoing a replacement cannot restore the earlier audio spectrum while paused',
  },
};
let count = 0; let failed = 0; let browser; let server; let work;
const check = (ok, label, detail = '') => {
  count++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
};
const command = (bin, args) => {
  const out = spawnSync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`${bin}: ${out.error?.message ?? out.stderr.toString()}`);
  return out.stdout;
};
async function main() {
  if (MUTATE && !MUTATIONS[MUTATE]) throw new Error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  const reservation = createServer();
  await new Promise((yes, no) => { reservation.once('error', no); reservation.listen(PORT, '127.0.0.1', yes); });
  await new Promise((yes) => reservation.close(yes));
  work = mkdtempSync(join(tmpdir(), 'audio-check-'));
  const app = join(work, 'app'); mkdirSync(app);
  for (const name of ['web', 'server', 'effects-builtin', 'presets-builtin', 'package.json']) cpSync(join(ROOT, name), join(app, name), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'));
  if (MUTATE) {
    const m = MUTATIONS[MUTATE]; const file = join(app, m.file); let text = readFileSync(file, 'utf8');
    for (const [from, to] of m.edits) {
      if (text.split(from).length !== 2) throw new Error(`mutation anchor must match once: ${from}`);
      text = text.replace(from, to);
    }
    writeFileSync(file, text); console.log(`MUTATION ${MUTATE}: ${m.fails}`);
  }
  const captures = join(work, 'captures'); mkdirSync(captures);
  if (SOURCE) symlinkSync(resolve(SOURCE), join(captures, 'audioprobe.knct'));
  else command(process.execPath, [join(ROOT, 'tools/make-sample.mjs'), join(captures, 'audioprobe.knct'), '--frames', '120']);
  const tone = join(work, 'tone.wav');
  command(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=125:sample_rate=48000:duration=4', '-ac', '2', tone]);
  const replacement = join(work, 'replacement.wav');
  command(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=8000:sample_rate=48000:duration=2', '-ac', '2', replacement]);
  const origin = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [join(app, 'server/index.js'), '--port', String(PORT), '--captures', captures,
    '--grabber', join(work, 'no-grabber')], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => { log = (log + data).slice(-8000); });
  for (let i = 0; ; i++) {
    if (server.exitCode !== null || i > 100) throw new Error(`server did not start: ${log}`);
    try { if ((await fetch(`${origin}/library`)).ok) break; } catch { /* Wait for this server's listener. */ }
    await new Promise((yes) => setTimeout(yes, 100));
  }
  for (const [body, headers, status, label] of [
    ['', { 'Content-Type': 'application/octet-stream' }, 400, 'empty upload refused'],
    ['bad audio', { 'Content-Type': 'application/octet-stream' }, 400, 'malformed upload refused'],
    ['x', { 'Content-Type': 'text/plain' }, 415, 'simple content type refused'],
    ['x', { 'Content-Type': 'application/octet-stream', Origin: 'http://evil.invalid' }, 403, 'foreign origin refused'],
  ]) { const r = await fetch(`${origin}/audio`, { method: 'POST', headers, body }); check(r.status === status, label, String(r.status)); }
  // A `.local` name is a LAN editor's origin: the server accepts it and the browser gives it no secure context.
  browser = await chromium.launch({ headless: !process.argv.includes('--headed'),
    args: ['--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP braindance.local 127.0.0.1'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(45000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/edit?new=audioprobe`);
  await page.waitForFunction(() => globalThis.__kinect?.timeline.transport()?.duration > 1);
  await page.evaluate(async () => {
    const k = __kinect;
    k.params.set('glitch.amount', 0.05); k.params.set('fade', 0); k.params.set('trails', 0);
    k.keyframes.undo.commit(); await k.timeline.settled();
  });
  await page.locator('#panelTabLook').click();
  await page.locator('#effectRackOpen').click();
  await page.locator('[data-effect-add="noise"]').click();
  await page.locator('#effectRackClose').click();
  await page.locator('#panelTabAudio').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#tAddAudio').click()]);
  const upload = async (path) => {
    await page.locator('#audioFile').setInputFiles(path);
    await page.waitForFunction(() => !document.getElementById('audioImport').disabled && __kinect.audio.clip());
    const note = await page.locator('#audioNote').textContent(); if (note) throw new Error(note);
  };
  await chooser.setFiles(AUDIO ? resolve(AUDIO) : tone);
  await page.waitForFunction(() => !document.getElementById('audioImport').disabled && __kinect.audio.clip());
  const imported = await page.evaluate(() => __kinect.audio.clip());
  check(imported.kind === 'audio-file' && imported.hash.startsWith('sha256:'), 'real file chooser imported an audio asset', imported.name);
  const change = async (selector, value) => {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).dispatchEvent('change');
    await page.waitForFunction(() => !document.getElementById('audioImport').disabled);
    const note = await page.locator('#audioNote').textContent(); if (note) throw new Error(note);
  };
  await page.locator('#audioMappingTitle').click();
  await page.locator('#audioEffect').selectOption('glitch');
  await page.waitForFunction(() => !document.getElementById('audioImport').disabled);
  await page.locator('#audioTarget').selectOption('glitch.amount');
  await page.waitForFunction(() => !document.getElementById('audioImport').disabled);
  const effects = await page.locator('#audioEffect option').evaluateAll((items) => items.map((o) => o.value));
  check(effects.includes('noise'), 'effect added at defaults immediately appears as an audio destination');
  check(effects.every((id) => !id || ['noise', 'glitch'].includes(id)), 'destination excludes unapplied effects');
  const single = await page.evaluate(() => {
    const k = __kinect; const original = k.library.serialiseProjectBody(); const two = structuredClone(original);
    const other = structuredClone(two.clips[0]); other.id = 'c2'; other.effects = []; other.tracks = {};
    for (const name of Object.keys(other.params)) other.params[name] = k.params.spec(name).default;
    two.clips.push(other); k.library.restoreProject(two); return original;
  });
  await page.locator('#audioOwner').selectOption(JSON.stringify('c2'));
  await page.waitForFunction(() => !document.getElementById('audioImport').disabled);
  check(await page.locator('#audioEffect').isDisabled(), 'another clip does not inherit the first clip\'s added effect');
  await page.evaluate((original) => { __kinect.library.restoreProject(original); __kinect.keyframes.undo.begin(); document.getElementById('panelTabAudio').click(); }, single);
  await change('#audioDepth', 0.7);
  const frame = () => page.evaluate(async () => {
    const k = __kinect; const t = k.timeline.transport(); await t.seek(1);
    const bytes = k.drive.readPixels();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
    return { hash, base: k.params.get('glitch.amount'), value: k.audio.value('glitch.amount', 1, 'c1'), signal: k.audio.signal(1),
      shown: document.getElementById('audioResult').value, spectrum: document.querySelector('[data-spectrum=output]').getAttribute('points') };
  });
  const driven = await frame();
  check(driven.base === 0.05 && driven.value > driven.base, 'audio adds to the base without changing the registry', `base=${driven.base}, result=${driven.value}, signal=${driven.signal}`);
  check(Math.abs(Number(driven.shown) - driven.value) < 0.001 && driven.spectrum?.split(' ').length === 64, 'visible spectrum and result read the current signal');
  await change('#audioDepth', 0);
  const flat = await frame();
  check(flat.hash !== driven.hash, 'modulation depth changes the rendered frame');
  await change('#audioDepth', 0.7);
  const again = await frame();
  check(again.hash === driven.hash, 'random seeks reproduce the modulated frame');
  const playedHash = await page.evaluate(async () => {
    const k = __kinect; const t = k.timeline.transport(); await t.seek(0.5); await t.runTo(30);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', k.drive.readPixels()))].map((v) => v.toString(16).padStart(2, '0')).join('');
  });
  check(playedHash === driven.hash, 'stepped playback and a seek produce the same modulated frame');
  await page.locator('.audio-advanced summary').click();
  const conditioning = { low: -9, mid: -15, high: -21, gain: 3, floor: -60, ceiling: -3, attack: 40, release: 250 };
  for (const [name, value] of Object.entries(conditioning)) await change(`#audio-${name}`, value);
  check(await page.evaluate((expected) => Object.entries(expected).every(([name, value]) => __kinect.audio.clip().conditioning[name] === value), conditioning), 'every conditioning control reaches the saved audio settings');
  const defaults = { low: 0, mid: 0, high: 0, gain: 0, floor: -48, ceiling: -6, attack: 10, release: 180 };
  for (const [name, value] of Object.entries(defaults)) await change(`#audio-${name}`, value);
  await page.locator('.audio-advanced summary').click();
  await change('#audio-gain', -24);
  const quiet = await frame();
  check(quiet.signal < driven.signal && quiet.spectrum !== driven.spectrum, 'EQ gain changes both the control signal and the displayed spectrum');
  await change('#audio-gain', 0);
  await page.locator('#tPlay').click();
  await page.waitForFunction(() => __kinect.timeline.transport().programSec > 1.3);
  await page.locator('#tPlay').click();
  check(await page.evaluate(() => !__kinect.timeline.transport().playing), 'real transport starts and pauses with audio loaded');
  await page.locator('#panelTabLook').click();
  await page.locator('#effectRackOpen').click();
  await page.locator('#effectRackSearch').fill('');
  await page.locator('#effectRackSearch').pressSequentially('film stock');
  const typed = await page.evaluate(() => ({
    value: document.getElementById('effectRackSearch').value,
    playing: __kinect.timeline.transport().playing || __kinect.timeline.transport().pendingPlay,
  }));
  check(typed.value === 'film stock' && !typed.playing, 'a text field keeps Space', JSON.stringify(typed));
  if (typed.playing) await page.locator('#tPlay').click();
  await page.locator('#effectRackSearch').fill('');
  await page.locator('#effectRackClose').click();
  await page.locator('#panelTabAudio').click();
  for (const selector of ['#audio-low', '#audioEffect', '#audioDepth', '#audioImport']) {
    await page.locator(selector).focus();
    await page.keyboard.press('Space');
    const playing = await page.waitForFunction(() => __kinect.timeline.transport().playing, null, { timeout: 3000 }).then(() => true, () => false);
    check(playing, `Space starts playback with ${selector} focused`);
    if (playing) {
      await page.keyboard.press('Space');
      check(await page.evaluate(() => !__kinect.timeline.transport().playing), `Space pauses playback with ${selector} focused`);
    }
  }
  if (SHOTS) {
    await change('#audio-mid', -12); await change('#audio-high', -24);
    await page.evaluate(async () => { await __kinect.timeline.transport().seek(1); document.getElementById('panelBody').scrollTop = 0; });
    mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'audio-panel.png') });
    await change('#audio-mid', 0); await change('#audio-high', 0);
  }
  await change('#audioStart', 0.5);
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => __kinect.audio.clip().start === 0);
  check(await page.locator('#audioStart').inputValue() === '0', 'undo restores audio placement and the control');
  await change('#audioStart', 0.25);
  const expected = await page.evaluate(() => __kinect.audio.clip());
  await page.waitForFunction(async () => {
    const name = new URL(location.href).searchParams.get('project'); if (!name) return false;
    const saved = await (await fetch(`/projects/${name}`)).json();
    return saved.body.audio?.start === 0.25;
  });
  await page.reload();
  await page.waitForFunction(() => globalThis.__kinect?.audio.clip()?.start === 0.25);
  check(JSON.stringify(await page.evaluate(() => __kinect.audio.clip())) === JSON.stringify(expected), 'reload preserves the asset, EQ, mapping and placement');
  check(await page.evaluate(() => __kinect.library.serialiseProjectBody().clips[0].effects.includes('noise')), 'an effect added at defaults survives project reload');
  const missing = await page.evaluate(async () => {
    const before = __kinect.library.serialiseProjectBody(); const broken = structuredClone(before);
    broken.audio.hash = 'sha256:' + '0'.repeat(64);
    const put = await fetch('/projects/missing-audio?rev=absent', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(broken) });
    if (!put.ok) throw new Error(`could not stage missing audio: ${put.status}`);
    let error = ''; try { await __kinect.library.loadProject('missing-audio'); } catch (e) { error = e.message; }
    return { error, same: JSON.stringify(before) === JSON.stringify(__kinect.library.serialiseProjectBody()) };
  });
  check(missing.error.includes('unavailable') && missing.same, 'missing audio refuses the whole project before changing the open edit');
  const lan = await browser.newPage();
  const lanErrors = []; lan.on('pageerror', (e) => lanErrors.push(e.message));
  await lan.goto(`http://braindance.local:${PORT}/edit?project=${new URL(page.url()).searchParams.get('project')}`);
  const plain = await lan.waitForFunction(() => globalThis.__kinect?.audio.clip(), null, { timeout: 20000 })
    .then(() => lan.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle, hash: __kinect.audio.clip().hash, signal: __kinect.audio.signal(1) })),
      () => lan.evaluate(() => ({ note: document.getElementById('tNote')?.textContent ?? '' })));
  check(plain.secure === false && plain.subtle === 'undefined' && plain.hash === expected.hash && plain.signal > 0 && !lanErrors.length,
    'a project with audio opens on a plain-HTTP LAN origin', JSON.stringify({ ...plain, errors: lanErrors }));
  await lan.close();
  const reset = await page.evaluate(async () => {
    const k = __kinect; const name = 'halation.amount';
    k.params.set(name, k.params.spec(name).max);
    k.keyframes.undo.commit();
    await new Promise((done) => requestAnimationFrame(done));
    const effects = () => { const body = k.library.serialiseProjectBody(); return [...(body.look.effects ?? []), ...body.clips.flatMap((c) => c.effects ?? [])].sort(); };
    const state = () => ({ effects: effects(), depth: k.keyframes.undo.depth(), edits: k.export.editsDuringExport(), value: k.params.get(name) });
    const button = document.querySelector(`[data-reset="${name}"]`);
    const before = state();
    const run = k.export.run({ width: 320, height: 180, fps: 30, from: 0, to: 3, name: 'reset-during-export', codec: 'lossless' });
    const running = k.export.running();
    const enabled = Boolean(button) && !button.disabled;
    button?.click();
    await run;
    const after = state();
    k.params.set(name, k.params.spec(name).default);
    k.keyframes.undo.commit();
    return { enabled, running, before, after };
  });
  check(reset.enabled && reset.running && !reset.before.effects.includes('halation')
    && JSON.stringify(reset.after) === JSON.stringify(reset.before),
  'a reset pressed during an export changes neither the effects, the value, nor undo', JSON.stringify(reset));
  await page.locator('#panelTabAudio').click();
  const exportOptions = { width: 320, height: 180, fps: 30, from: 15, to: 29, name: 'audio-proof', codec: 'lossless' };
  const done = await page.evaluate((options) => __kinect.export.run(options), exportOptions);
  const actual = command(FFMPEG, ['-v', 'error', '-i', done.output, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', '-']);
  const asset = join(app, 'audio', `${expected.hash.slice(7)}.wav`);
  const source = command(FFMPEG, ['-v', 'error', '-i', asset, '-af', 'atrim=start_sample=12000:end_sample=36000,asetpts=PTS-STARTPTS', '-f', 's16le', '-c:a', 'pcm_s16le', '-']);
  check(actual.equals(source) && actual.length === 96000, 'mux carries the exact source PCM at the exported program position', `${actual.length} bytes; 24000 stereo samples`);
  const record = JSON.parse(readFileSync(`${done.output}.job.json`, 'utf8'));
  check(record.programStart === 0.5 && record.project.audio.hash === expected.hash, 'export record retains audio identity and program start');
  const lead = await page.evaluate((options) => __kinect.export.run({ ...options, from: 0, to: 14, name: 'audio-leading-silence' }), exportOptions);
  const leadPcm = command(FFMPEG, ['-v', 'error', '-i', lead.output, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', '-']);
  const firstPcm = command(FFMPEG, ['-v', 'error', '-i', asset, '-af', 'atrim=end_sample=12000', '-f', 's16le', '-c:a', 'pcm_s16le', '-']);
  check(leadPcm.equals(Buffer.concat([Buffer.alloc(48000), firstPcm])), 'mux inserts silence before an audio clip starts');
  if (process.argv.includes('--queue')) {
    const queued = await page.evaluate(async () => {
      const project = __kinect.library.serialiseProjectBody();
      const response = await fetch('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        project, captures: project.clips.map((clip) => clip.take.hash), output: 'queued-audio', width: 320, height: 180, fps: 30, codec: 'lossless',
        deliverable: { version: 2, in: 0.5, out: 29 / 30, outputSize: '320x180', codec: 'lossless', name: 'queued-audio' },
      }) });
      const job = await response.json(); if (!response.ok) throw new Error(job.error); return job;
    });
    command(process.execPath, [join(ROOT, 'tools/render-worker.mjs'), '--url', origin, '--once', '--name', 'audio-proof']);
    const job = await (await fetch(`${origin}/jobs/${queued.id}`)).json();
    const queuedPcm = job.state === 'done' ? command(FFMPEG, ['-v', 'error', '-i', job.artifactPath, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', '-']) : Buffer.alloc(0);
    check(job.state === 'done' && queuedPcm.equals(source), 'the real render worker preserves the same source audio and offset', job.error ?? job.state);
  }
  const png = await page.evaluate(async () => { try { await __kinect.export.run({ width: 320, height: 180, fps: 30, from: 0, to: 1, name: 'audio-png', codec: 'pngseq' }); return ''; } catch (e) { return e.message; } });
  check(png.includes('cannot carry audio'), 'PNG export refuses silent loss of the audio');
  if (SHOTS) {
    const video = await page.evaluate((options) => __kinect.export.run({ ...options, name: 'audio-preview', codec: 'h264' }), { ...exportOptions, from: 0, to: 89 });
    cpSync(video.output, join(SHOTS, 'audio-preview.mp4'));
  }
  const raced = await page.evaluate(async () => {
    const k = __kinect; const before = k.library.serialiseProjectBody(); const two = structuredClone(before);
    const other = structuredClone(two.clips[0]); other.id = 'c2'; two.clips.push(other);
    k.library.restoreProject(two); k.keyframes.undo.commit();
    k.editor.selectClipRow(before.audio.target.clip);
    const gain = document.getElementById('audio-gain'); gain.value = '6'; gain.dispatchEvent(new Event('change'));
    document.getElementById('tDeleteClip').click();
    return { before, target: before.audio.target.clip };
  });
  await page.waitForFunction(() => !document.getElementById('audioImport').disabled);
  const afterRace = await page.evaluate((target) => {
    const k = __kinect; const body = k.library.serialiseProjectBody(); let reopen = '';
    try { k.library.restoreProject(body); } catch (e) { reopen = e.message; }
    return { target: k.audio.clip().target, clips: body.clips.map((c) => c.id), reopen, deleted: target };
  }, raced.target);
  check(afterRace.target === null && !afterRace.clips.includes(afterRace.deleted) && !afterRace.reopen,
    'an audio edit pending while its target clip is deleted leaves no mapping onto that clip', JSON.stringify(afterRace));
  await page.evaluate((before) => { __kinect.library.restoreProject(before); __kinect.keyframes.undo.commit(); }, raced.before);
  await page.locator('#audioRemove').click();
  check(await page.evaluate(() => __kinect.audio.clip() === null && !document.querySelector('.taudio')), 'Remove clears the audio source and lane');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => __kinect.audio.clip());
  check(await page.evaluate((hash) => __kinect.audio.clip().hash === hash, expected.hash), 'Undo restores removed audio');
  await page.evaluate(async () => { await __kinect.timeline.transport().seek(1); });
  const priorSpectrum = await page.locator('[data-spectrum=output]').getAttribute('points');
  await upload(replacement);
  await page.keyboard.press('Meta+z');
  await page.waitForFunction((hash) => __kinect.audio.clip()?.hash === hash, expected.hash);
  await page.evaluate(async () => { await __kinect.timeline.transport().seek(1); });
  const restoredSpectrum = await page.waitForFunction((points) => document.querySelector('[data-spectrum=output]').getAttribute('points') === points,
    priorSpectrum, { timeout: 5000 }).then(() => true, () => false);
  check(restoredSpectrum, 'Undo after replacing the audio restores its paused frequency display');
  check(errors.length === 0, 'browser has no uncaught errors', errors.join('; '));
}
try { await main(); }
catch (error) { console.error(`DID NOT FINISH: ${error.stack}`); process.exitCode = 2; }
finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((yes) => server.once('exit', yes)); }
  if (work) rmSync(work, { recursive: true, force: true });
  console.log(`[audio] ${count} assertions, ${failed} failed`);
  if (MUTATE) console.log(failed ? 'mutation caught; read the failed assertions above' : 'NOT CAUGHT');
  if (!process.exitCode) process.exitCode = failed || MUTATE ? 1 : 0;
}
