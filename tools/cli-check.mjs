#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
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
  // `all` rather than `allSettled`: the recorder's rejection wins the race, so the process is gone
  // before the grace period ends and the grabber that ignored SIGTERM is left holding the sensor.
  'shutdown-abandons-a-stubborn-grabber': { file: 'server/index.js', edits: [[
    '    const [grabber, take] = await Promise.allSettled([',
    '    const [grabber, take] = await Promise.all([',
  ]] },
  'idle-ignores-the-recorder': { file: 'server/index.js', edits: [[
    '      && !recordingStarts && !recorder.armed && !recorder.take;', ';',
  ]] },
  'standby-from-absent': { file: 'server/idle.js', edits: [[
    "const HOLDS_NO_DEADLINE = new Set(['absent', 'standby']);",
    "const HOLDS_NO_DEADLINE = new Set(['standby']);",
  ]] },
  'mjpeg-refuses-while-waking': { file: 'server/webcam.js', edits: [[
    '    if (this.unavailable && !this.transient) {', '    if (this.unavailable) {',
  ]] },
  'camera-route-bypasses-applyCamera': { file: 'server/index.js', edits: [[
    '    const restarting = Boolean(applyCamera({ ...camera, ...body }));', '    const restarting = false; Object.assign(camera, body);',
  ]] },
  'wake-for-an-unserveable-source': { file: 'server/index.js', edits: [[
    '    if (webcam.unavailable === null || webcam.transient) wakeSensor?.();', '    wakeSensor?.();',
  ]] },
  // The refusal colour leaves behind is kept after colour returns, so the request that the colour
  // change just made servable is refused on a reason that no longer holds, and refused without
  // waking - which strands the consumer that retries.
  'colour-return-leaves-the-old-refusal': { file: 'server/index.js', edits: [[
    '      if (camera.color) setSensorState(sensorState);', '      // the refusal the colour left behind',
  ]] },
  'idle-counts-an-unservable-key': { file: 'server/index.js', edits: [[
    'keyStream.demandCount === 0', 'keyStream.count === 0',
  ]] },
  'wait-gives-up-on-a-single-lost': { file: 'bin/braindance.mjs', edits: [[
    "if (result.state === 'absent')", "if (['lost', 'absent'].includes(result.state))",
  ]] },
  'output-forgets-on-connect': { file: 'server/index.js', edits: [['  sendOutput(ws);', '  // output omitted']] },
  'preset-skips-requires': { file: 'server/output.js', edits: [[
    '      for (const requirement of doc.body.requires) {', '      for (const requirement of []) {',
  ]] },
  // The filesystem's sentence, absolute path and all, in place of the store's word for a name with
  // no file. That text is what the record page shows an operator.
  'preset-refusal-names-a-path': { file: 'server/output.js', edits: [[
    "        if (err?.code === 'ENOENT') refuse(`no preset named ${patch.preset}`, 404);",
    "        if (err?.code === 'ENOENT') refuse(err.message, 404);",
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
    for (const [name, status, text] of [['unknown', 404, 'no preset named unknown'], ['old', 409, String(PROJECT_VERSION)], ['missing', 409, 'absent-effect']]) {
      const result = await json('/output', { preset: name });
      // The refusal is the store's sentence rather than the filesystem's, and it carries no path:
      // this text is what an operator reads on the record page.
      check(result.status === status && (!text || result.body.error.includes(text))
        && !result.body.error.includes(WORK), `preset refusal: ${name}`, result.body.error);
    }
    monitor.ws.send(JSON.stringify({ programOut: { params: { exposure: 2.3 }, tags: { exposure: 'look' } } }));
    check(await until(async () => (await json('/output')).body.params.exposure === 2.3), 'operator write is remembered');
    for (const words of [['presets'], ['takes'], ['jobs']]) check((await cli(...words)).code === 0, `CLI lists ${words[0]}`);

    if (['output-forgets-on-connect', 'preset-skips-requires', 'preset-refusal-names-a-path'].includes(mutation)) return;
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
    // Two faults at once, which is what a shutdown has to survive: a take it cannot finalise and a
    // grabber that ignores the ask to stop. The take's magic is overwritten while its file is still
    // open, so the index the close builds refuses the file instead of hashing it, and `--stubborn`
    // is the grabber that takes no notice of SIGTERM, so nothing but the force kill at the end of
    // the grace ends it. A process that leaves on the recorder's failure leaves the Kinect claimed
    // by a process nobody owns, which the next server's enumeration reads as a broken sensor.
    const DEAD_GRABBER = `${process.execPath} ${join(WORK, 'tools/fake-grabber.mjs')}`
      + ` --source ${join(ROOT, 'captures/sample.knct')} --stubborn`;
    await start(['--grabber', DEAD_GRABBER], false);
    await cli('record', 'start');
    const stuckTake = await until(async () => (await json('/record/state')).body.takeId);
    const stuckFile = join(WORK, 'captures', `${stuckTake}.knct`);
    const head = openSync(stuckFile, 'r+');
    writeSync(head, Buffer.alloc(4), 0, 4, 0);
    closeSync(head);
    const dyingServer = server;
    const stubborn = pids()[0];
    const stoppedAt = Date.now();
    await stop();
    const waitedMs = Date.now() - stoppedAt;
    check(Boolean(stuckTake) && !new RegExp(`take ${stuckTake} closed`).test(log),
      'the take really could not be finalised', stuckTake ?? 'no take was open');
    const named = log.match(/\[server\] shutdown: the take did not finish:[^\n]*/);
    check(Boolean(named), 'the shutdown names the take it could not close', named?.[0] ?? 'nothing was reported');
    check(waitedMs > 12000, 'the shutdown grace runs out before the process leaves', `${waitedMs} ms`);
    let orphan = false;
    try { process.kill(Number(stubborn), 0); orphan = true; } catch {}
    check(!orphan, 'a take that cannot close still ends with its grabber force-killed',
      orphan ? `grabber ${stubborn} outlived the server` : `grabber ${stubborn} gone with the server`);
    check(dyingServer.exitCode === 1, 'a shutdown that failed half its work exits 1', String(dyingServer.exitCode));
    for (const entry of readdirSync(join(WORK, 'captures'))) {
      if (entry.startsWith(stuckTake)) rmSync(join(WORK, 'captures', entry), { force: true });
    }
    // The orphan a caught control creates is that run's to clean up.
    try { process.kill(Number(stubborn), 'SIGKILL'); } catch {}

    if (mutation === 'shutdown-abandons-a-stubborn-grabber') return;
    await start(['--replay', join(ROOT, 'captures/sample.knct')], false);
    for (const path of ['/sensor/standby', '/sensor/wake', '/sensor/camera']) {
      const result = await json(path, {});
      check(result.status === 409 && result.body.error.includes('replaying'), `replay refuses ${path}`);
    }
    check((await cli('sensor', 'standby')).code === 1, 'CLI server refusal exits 1');
    check((await cli('output', 'mode', 'camera')).code === 0, 'replay allows output writes');

  }
  // A source that can never be served is the one wake the sensor does not owe it. OBS retries a dead
  // source hard, so a request answered with a permanent 503 has to be refused without starting the
  // grabber, or the sensor spins up once per retry forever.
  await start(['--no-color', '--standby-after', '2']);
  check(await state('live'), 'colour off still starts the depth camera');
  await json('/sensor/standby', {});
  check(await state('standby', 16000), 'a colourless idle sensor stands down');
  const asleepWakes = (await health()).wakes;
  const mjpg = await fetch(`${url}/camera.mjpg`, { signal: AbortSignal.timeout(20000) });
  const refusal = (await mjpg.text()).trim();
  check(mjpg.status === 503 && refusal.includes('colour is off'), 'the webcam refuses a colour this server will never have',
    `${mjpg.status} ${refusal}`);
  await sleep(3000);
  const afterMjpg = await health();
  check(afterMjpg.wakes === asleepWakes && afterMjpg.state === 'standby', 'a request that cannot be served wakes nothing',
    `wakes ${asleepWakes} to ${afterMjpg.wakes}, state ${afterMjpg.state}`);
  // A key page is attached whether or not there is colour to key, and it keeps that socket through
  // the refusal it is owed. A socket arriving is a consumer arriving and wakes the sensor; holding
  // the sensor up forever for a picture that cannot exist is a different thing, and that is this row.
  const key = await socket();
  key.ws.send(JSON.stringify({ key: true }));
  check(await state('live', 6000), 'a socket arriving wakes the standby sensor');
  check(Boolean(await until(async () => (await health()).consumers.key === 1, 6000)), 'the key page is attached and counted',
    JSON.stringify((await health()).consumers));
  check(await state('standby', 16000), 'a key page nothing can serve does not hold the sensor awake');
  check((await health()).consumers.key === 1, 'and it stays attached through a standby it is not the reason for');
  if (['wake-for-an-unserveable-source', 'idle-counts-an-unservable-key'].includes(mutation)) return;
  // Turning colour back on is the one change that makes a refused source servable while nothing is
  // running: there is no grabber to tell, so the refusal the colour left behind has to follow the
  // setting. A stale refusal reads as permanent, and a permanent refusal is refused without waking,
  // which strands the consumer that retries - the one this route exists for.
  const colourBack = await cli('camera', 'color', 'on');
  check(colourBack.code === 0, 'colour turns back on with the sensor standing down',
    colourBack.err || colourBack.out || String(colourBack.code));
  const revivedWakes = (await health()).wakes;
  const revived = await fetch(`${url}/camera.mjpg`, { signal: AbortSignal.timeout(20000) });
  const revivedFirst = revived.status === 200
    ? await Promise.race([revived.body.getReader().read(), sleep(12000).then(() => ({ done: true }))])
    : { done: true, note: (await revived.text()).trim() };
  const served = revived.status === 200 && !revivedFirst.done
    && Buffer.from(revivedFirst.value).includes(Buffer.from('image/jpeg'));
  const revivedHealth = await health();
  check(served, 'the request colour just made servable is served rather than refused on the old reason',
    `${revived.status} ${revivedFirst.note ?? 'jpeg bytes'}`);
  check(revivedHealth.state === 'live' && revivedHealth.wakes > revivedWakes,
    'and that request is what woke the sensor', `state ${revivedHealth.state}, wakes ${revivedWakes} to ${revivedHealth.wakes}`);

  if (mutation === 'colour-return-leaves-the-old-refusal') return;
  await start(['--grabber', '/missing-braindance-grabber', '--standby-after', '20'], false);
  check(await state('lost'), 'failed spawn enters retry');
  await json('/sensor/standby', {});
  await json('/sensor/wake', {});
  check(await state('lost', 500), 'wake cancels pending retry and attempts immediately');
  if (mutation === 'standby-leaves-the-retry-timer') return;
  // `lost` is one sample and not a verdict: the server has another attempt queued, so a wait that
  // reads a single `lost` reports a failed wake on a machine that is still waking.
  const waiting = spawn(process.execPath, [join(WORK, 'bin/braindance.mjs'), '--url', url, '--json',
    'sensor', 'wake', '--wait'], { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
  let waitingDone = false;
  waiting.once('exit', () => { waitingDone = true; });
  await sleep(1400);
  check(!waitingDone, 'sensor wake --wait polls through a lost sample while a retry is queued');
  waiting.kill('SIGKILL');
  await until(async () => waitingDone, 3000);
  if (mutation === 'wait-gives-up-on-a-single-lost') return;
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
