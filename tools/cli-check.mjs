#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { VERBS, MUTATION_EXEMPTIONS } from '../bin/verbs.js';
import { PROJECT_VERSION } from '../web/format.js';

const MUTATIONS = {
  'partial-preset-retains-old-look': { file: 'web/main.js', edits: [[
    '      params.apply(Object.fromEntries(presetValueNames().map((name) => [name, PARAMS[name].def])));',
    '      // The mutation keeps the discarded overrides.',
  ]] },
  'standby-is-a-bare-kill': { file: 'server/index.js', edits: [[
    '    standby = true;\n    clearTimeout(spawnTimer);', '    standby = false;\n    clearTimeout(spawnTimer);',
  ]] },
  'standby-leaves-the-retry-timer': { file: 'server/index.js', edits: [[
    '    standby = true;\n    clearTimeout(spawnTimer);\n    spawnTimer = null;', '    standby = true;',
  ]] },
  'wake-reads-as-a-respawn': { file: 'server/index.js', edits: [['    grabberWakes++;', '    // wake omitted']] },
  'idle-ignores-the-recorder': { file: 'server/index.js', edits: [[
    '      && !recordingStarts && !recorder.armed && !recorder.take;', ';',
  ]] },
  'standby-from-absent': { file: 'server/index.js', edits: [[
    "    if (sensorState !== 'live' && sensorState !== 'lost')", "    if (sensorState !== 'live' && sensorState !== 'lost' && sensorState !== 'absent')",
  ]] },
  'mjpeg-refuses-while-waking': { file: 'server/webcam.js', edits: [[
    '    if (this.unavailable && !this.transient) {', '    if (this.unavailable) {',
  ]] },
  'camera-route-bypasses-applyCamera': { file: 'server/index.js', edits: [[
    '    const restarting = Boolean(applyCamera({ ...camera, ...body }));', '    const restarting = false; Object.assign(camera, body);',
  ]] },
  'output-forgets-on-connect': { file: 'server/index.js', edits: [['  sendOutput(ws);', '  // output omitted']] },
  'preset-skips-requires': { file: 'server/output.js', edits: [[
    '      for (const requirement of doc.body.requires) {', '      for (const requirement of []) {',
  ]] },
  'verb-without-a-route': { file: 'bin/verbs.js', edits: [["route: '/sensor/standby'", "route: '/sensor/missing'"]] },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.cli-check');
const args = process.argv.slice(2);
const mutation = args.includes('--mutate') ? args[args.indexOf('--mutate') + 1] : null;
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8401);
const url = `http://127.0.0.1:${PORT}`;
let passed = 0;
let failed = 0;
let server;
let log = '';
let browser;
let ownsStage = false;
const sockets = new Set();
const check = (condition, label, detail = '') => {
  if (condition) passed++; else failed++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
};
const json = async (path, body) => {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(20000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
const health = async () => (await json('/sensor/health')).body;
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await sleep(50); } while (Date.now() < end);
  return null;
}
const state = (name, ms) => until(async () => (await health()).state === name, ms);
const pids = () => { try { return execFileSync('pgrep', ['-P', String(server.pid)], { encoding: 'utf8' }).trim().split('\n'); } catch { return []; } };
async function stop() {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  const exit = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await exit;
  server = null;
}
async function start(extra = [], grabber = true) {
  await stop();
  log = '';
  server = spawn(process.execPath, [join(WORK, 'server/index.js'), '--port', String(PORT),
    '--standby-after', extra.includes('--standby-after') ? extra[extra.indexOf('--standby-after') + 1] : '0', '--captures', join(WORK, 'captures'),
    ...(grabber ? ['--grabber', `${process.execPath} ${join(WORK, 'tools/fake-grabber.mjs')} --source ${join(ROOT, 'captures/sample.knct')} --hd --key`] : []), ...extra],
  { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (data) => { log += data; });
  server.stderr.on('data', (data) => { log += data; });
  const up = await until(async () => { try { return (await health()).state; } catch { return null; } });
  if (!up) throw new Error(`server did not start: ${log}`);
}
async function cli(...words) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(WORK, 'bin/braindance.mjs'), '--url', url, '--json', ...words]);
    let out = '', err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });
    child.on('exit', (code) => { let body; try { body = JSON.parse(out); } catch {} done({ code, body, err }); });
  });
}
async function socket() {
  const ws = new WebSocket(url.replace('http:', 'ws:'));
  sockets.add(ws);
  const messages = [];
  ws.on('message', (raw, binary) => { if (!binary) messages.push(JSON.parse(raw.toString())); });
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  return { ws, messages };
}
async function main() {
  if (mutation && !MUTATIONS[mutation]) throw new Error(`unknown mutation ${mutation}`);
  await new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', () => fail(new Error(`port ${PORT} is held; DID NOT RUN`)));
    probe.listen(PORT, '127.0.0.1', () => probe.close(done));
  });
  if (!existsSync(join(ROOT, 'captures/sample.knct'))) throw new Error('run npm run fixtures first');
  if (existsSync(WORK)) throw new Error(`remove the previous staged tree ${WORK} before running`);
  mkdirSync(WORK);
  ownsStage = true;
  for (const name of ['server', 'web', 'bin', 'tools', 'effects-builtin', 'presets-builtin']) cpSync(join(ROOT, name), join(WORK, name), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(WORK, 'package.json'));
  symlinkSync(join(ROOT, 'node_modules'), join(WORK, 'node_modules'));
  mkdirSync(join(WORK, 'presets'));
  if (mutation) {
    const entry = MUTATIONS[mutation];
    const path = join(WORK, entry.file);
    let source = readFileSync(path, 'utf8');
    for (const [from, to] of entry.edits) {
      if (source.split(from).length !== 2) throw new Error(`stale anchor: ${mutation}`);
      source = source.replace(from, to);
    }
    writeFileSync(path, source);
  }
  if (!['standby-leaves-the-retry-timer', 'standby-from-absent'].includes(mutation)) {
    await start();
    check(await state('live'), 'fake sensor becomes live');
    const stagedVerbs = (await import(`${pathToFileURL(join(WORK, 'bin/verbs.js')).href}?v=${Date.now()}`)).VERBS;
    const routes = (await json('/library/routes')).body.routes;
    for (const verb of stagedVerbs) check(routes.some((route) => route.path === verb.route
      && (verb.method === 'GET' ? route.read : route.methods.includes(verb.method))), `verb has route: ${verb.verb}`);
    for (const route of routes.filter((row) => row.mutates)) check(MUTATION_EXEMPTIONS.includes(route.path)
      || VERBS.some((verb) => verb.route === route.path && route.methods.includes(verb.method)), `mutation route has verb or exemption: ${route.path}`);
    if (mutation === 'verb-without-a-route') return;
    const before = await health();
    const oldPid = pids()[0];
    check(Boolean(oldPid), 'live grabber has a child PID');
    const standby = await cli('sensor', 'standby');
    check(standby.code === 0 && standby.body?.state === 'standby', 'CLI standby reads settled state', standby.err);
    check(pids().length === 0, 'standby removes child');
    await sleep(2600);
    check(pids().length === 0 && (await health()).state === 'standby', 'standby stays asleep through retry delay');
    check(/grabber exited \(code=0 signal=null\)/.test(log) && !log.includes('signal=SIGKILL'), 'standby exits cleanly');
    check((await health()).fps === 0 && (await health()).respawns === before.respawns, 'standby zeroes rate without respawn');
    const waking = await json('/sensor/wake', {});
    check(waking.body.state === 'starting', 'wake immediately reports starting');
    check(await state('live'), 'wake returns to live');
    check(pids().length === 1 && pids()[0] !== oldPid, 'wake starts exactly one new child');
    check((await health()).wakes === 1 && (await health()).respawns === before.respawns, 'wake has its own counter');
    const live = await health();
    await json('/sensor/wake', {});
    check((await health()).wakes === live.wakes, 'wake while live is idempotent');
    if (['standby-is-a-bare-kill', 'wake-reads-as-a-respawn'].includes(mutation)) return;
    check((await cli('status')).body?.output?.mode === 'camera', 'CLI status includes output');
    check((await cli('camera', 'color', 'invalid')).code === 2, 'CLI malformed arguments exit 2');

    const monitor = await socket();
    const camera = await cli('camera', 'low-light', 'off');
    check(camera.code === 0 && camera.body?.camera.lowLight === false, 'CLI camera reads merged state');
    check(await until(() => monitor.messages.some((msg) => msg.camera?.lowLight === false)), 'camera route broadcasts through applyCamera');
    const color = await json('/sensor/camera', { color: false });
    check(color.body.restarting === true, 'color change reports restart');
    check(await until(async () => (await health()).restarts === 1 && (await health()).state === 'live'), 'color restart counted');
    check((await json('/sensor/camera', { color: 'off' })).status === 400, 'non-boolean camera refused');
    if (mutation === 'camera-route-bypasses-applyCamera') return;
    await json('/sensor/camera', { color: true });
    await until(async () => (await health()).restarts === 2 && (await health()).state === 'live');
    await cli('record', 'start');
    check((await json('/sensor/standby', {})).status === 409, 'armed/running recorder refuses standby');
    check((await cli('record', 'mark')).code === 0, 'CLI marks a take');
    check((await cli('record', 'stop')).code === 0, 'CLI stops and reads state');

    const preset = { version: PROJECT_VERSION, requires: [], values: { exposure: 1.7 } };
    for (const [name, body] of Object.entries({ cli: preset, old: { ...preset, version: -1 }, missing: { ...preset, requires: [{ id: 'absent-effect' }] } })) {
      writeFileSync(join(WORK, 'presets', `${name}.json`), JSON.stringify(body));
    }
    check((await cli('output', 'mode', 'mirror')).body?.mode === 'mirror', 'CLI changes output mode');
    check((await cli('output', 'size', '1280x720')).body?.size.w === 1280, 'CLI changes output size');
    check((await cli('output', 'set', 'exposure=2', 'left=-2')).body?.params.exposure === 2, 'CLI merges output values');
    const presetResult = await cli('output', 'preset', 'cli');
    check(presetResult.code === 0 && presetResult.body.params.left === -2 && !('exposure' in presetResult.body.params), 'preset preserves framing and clears look edits');
    const fresh = await socket();
    await until(() => fresh.messages.filter((msg) => msg.programOut).length >= 3);
    check(JSON.stringify(fresh.messages.filter((msg) => msg.programOut).slice(0, 3).map((msg) => Object.keys(msg.programOut)))
      === JSON.stringify([['mode', 'size'], ['preset'], ['params']]), 'connect restores output in three ordered messages');
    for (const [name, status, text] of [['unknown', 404, null], ['old', 409, String(PROJECT_VERSION)], ['missing', 409, 'absent-effect']]) {
      const result = await json('/output', { preset: name });
      check(result.status === status && (!text || result.body.error.includes(text)), `preset refusal: ${name}`);
    }
    monitor.ws.send(JSON.stringify({ programOut: { params: { exposure: 2.3 }, tags: { exposure: 'look' } } }));
    check(await until(async () => (await json('/output')).body.params.exposure === 2.3), 'operator write is remembered');
    for (const words of [['presets'], ['takes'], ['jobs']]) check((await cli(...words)).code === 0, `CLI lists ${words[0]}`);

    if (['output-forgets-on-connect', 'preset-skips-requires'].includes(mutation)) return;
    if (!args.includes('--no-browser') && (!mutation || mutation === 'partial-preset-retains-old-look')) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true, args: ['--use-angle=metal'] });
      const source = await browser.newPage();
      const operator = await browser.newPage();
      const errors = [];
      for (const page of [source, operator]) page.on('pageerror', (err) => errors.push(err.message));
      await source.goto(url + '/program');
      await source.waitForFunction(() => window.__kinect?.params.get('exposure') === 2.3);
      check(await source.evaluate(() => window.__kinect.params.get('left') === -2), 'headless source adopts output composition');
      await operator.goto(url + '/record');
      await operator.waitForFunction(() => window.__kinect?.params.get('exposure') === 2.3);
      check(await operator.locator('#progMode').inputValue() === 'mirror', 'record boot adopts output mode');
      check(await operator.locator('#progSize').inputValue() === '1280x720', 'record boot adopts output size');
      await operator.locator('#sensorStandby').click();
      check(await state('standby'), 'record button enters standby with tabs open');
      await operator.getByRole('button', { name: 'Wake sensor', exact: true }).click();
      check(await state('live'), 'record button wakes sensor');
      await cli('output', 'set', 'pointSize=4.2');
      await source.waitForFunction(() => window.__kinect.params.get('pointSize') === 4.2);
      await cli('output', 'preset', 'cli');
      await source.waitForFunction(() => window.__kinect.params.get('exposure') === 1.7);
      check(await operator.evaluate(() => window.__kinect.params.get('exposure') === 1.7), 'preset reaches both operator and source');
      const reconnected = await browser.newPage();
      await reconnected.goto(url + '/program');
      await reconnected.waitForFunction(() => window.__kinect?.params.get('exposure') === 1.7);
      check(await source.evaluate(() => window.__kinect.params.get('pointSize'))
        === await reconnected.evaluate(() => window.__kinect.params.get('pointSize')),
      'partial output preset gives existing and fresh sources the same look');
      await reconnected.close();

      await cli('output', 'set', 'thermal.amount=0.8');
      await source.waitForFunction(() => window.__kinect.params.get('thermal.amount') === 0.8);
      await cli('output', 'preset', 'rgb');
      await source.waitForFunction(() => window.__kinect.params.get('thermal.amount') === 0);
      check(await source.evaluate(() => window.__kinect.params.get('left') === -2), 'whole-look preset resets unnamed effects and keeps crop');
      const dimensions = await source.evaluate(() => {
        const canvas = window.__kinect.renderer.domElement;
        return [canvas.width, canvas.height];
      });
      check(dimensions[0] === 1280 && dimensions[1] === 720, 'source renders at the stored output dimensions');
      check(errors.length === 0, 'browser has no page errors', errors.join('; '));
      await browser.close(); browser = null;
    }
    if (mutation === 'partial-preset-retains-old-look') return;
    await stop();
    // The first occurrence is used by the flag parser.
    await start(['--standby-after', '2']);
    check(await state('standby', 16000), 'idle sensor enters automatic standby');
    const controller = new AbortController();
    const mjpeg = await fetch(url + '/camera.mjpg', { signal: controller.signal });
    check(mjpeg.status === 200, 'waking MJPEG holds with 200 headers');
    const reader = mjpeg.body.getReader();
    const chunk = await Promise.race([reader.read(), sleep(10000).then(() => ({ done: true }))]);
    check(!chunk.done && Buffer.from(chunk.value).includes(Buffer.from('image/jpeg')), 'held MJPEG receives first JPEG');
    controller.abort();
    await reader.cancel().catch(() => {});
    check(await state('standby', 16000), 'last consumer leaving allows standby');
    const demand = await socket();
    check(await state('live'), 'monitor arrival wakes sensor');
    demand.ws.close();
    await state('standby', 16000);
    check((await cli('record', 'start')).code === 0 && await until(async () => (await json('/record/state')).body.takeId), 'record start wakes and opens at hello');
    await sleep(11000);
    check((await health()).state === 'live' && !log.includes('cannot enter standby'), 'recorder prevents automatic standby attempts');
    await cli('record', 'stop');

    if (['idle-ignores-the-recorder', 'mjpeg-refuses-while-waking'].includes(mutation)) return;
    await cli('record', 'start');
    const closingTake = (await json('/record/state')).body.takeId;
    const closingPid = pids()[0];
    await stop();
    check(Boolean(closingTake) && existsSync(join(WORK, 'captures', `${closingTake}.idx`)), 'SIGTERM finalizes the open take sidecar');
    let alive = false;
    try { process.kill(Number(closingPid), 0); alive = true; } catch {}
    check(!alive, 'SIGTERM waits for the owned grabber to exit');
    await start(['--replay', join(ROOT, 'captures/sample.knct')], false);
    for (const path of ['/sensor/standby', '/sensor/wake', '/sensor/camera']) {
      const result = await json(path, {});
      check(result.status === 409 && result.body.error.includes('replaying'), `replay refuses ${path}`);
    }
    check((await cli('sensor', 'standby')).code === 1, 'CLI server refusal exits 1');
    check((await cli('output', 'mode', 'camera')).code === 0, 'replay allows output writes');

  }
  await start(['--grabber', '/missing-braindance-grabber', '--standby-after', '20'], false);
  check(await state('lost'), 'failed spawn enters retry');
  await json('/sensor/standby', {});
  await json('/sensor/wake', {});
  check(await state('lost', 500), 'wake cancels pending retry and attempts immediately');
  if (mutation === 'standby-leaves-the-retry-timer') return;
  check(await state('absent', 22000), 'failed enumeration becomes absent');
  await sleep(31000);
  check((await health()).state === 'absent', 'automatic standby excludes absent');
  await stop();
  check((await cli('status')).code === 2, 'CLI unavailable server exits 2');
}
try {
  await main();
} catch (err) {
  console.error(`DID NOT FINISH: ${err.stack}\n${log.slice(-3000)}`);
  process.exitCode = 2;
} finally {
  await browser?.close();
  await stop();
  if (ownsStage) rmSync(WORK, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed${mutation ? `; mutation ${mutation}: ${process.exitCode === 2 ? 'UNPROVEN (crash)' : failed ? 'CAUGHT' : 'NOT CAUGHT'}` : ''}`);
if (!process.exitCode) process.exitCode = failed || mutation ? 1 : 0;
