#!/usr/bin/env node
// Proves the desktop shell: that its window shows the service's own origin and refuses every other,
// that closing the last window stops the service with exit 0 inside the bound, that a second launch
// hands over to the first and starts no service, that a held port is refused by name, and that the
// bridge answers only the window the app opened. Every refusal row has a positive twin, so a shell
// that refused everything would fail. The two dialogs a person sees are not read: the refusal is
// proved by the line the app logs beside its dialog, and the missing-Node dialog is not driven here.
//
//   node tools/desktop-check.mjs [--mutate <name>]
//
// It stages desktop/ under .desktop-check/ and runs the staged copy against the real
// server/index.js, so a mutation never touches the checkout.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, STOP_GRACE_MS, portFree } from '../desktop/service.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
const STAGE = join(REPO, '.desktop-check');

// Each names source text in the staged copy and must match exactly once. One row per claim, so a
// red row names what broke.
const MUTATIONS = {
  // Every page is the page's own again. It must redden the refusal rows for another host name and
  // another site, and leave the same-origin twin green.
  'navigation-allows-any-origin': {
    file: 'desktop/main.js',
    edits: [['    if (sameOrigin(event.url, origin)) return;', '    if (true) return;']],
    fails: 'the rows that send the window to another host name and to another site, each of which '
      + 'must stay where it was; the same-origin twin stays green, and so does the file row, '
      + 'because Chromium refuses a file: URL from an http page whatever the shell says',
  },
  // window.open opens a window of its own instead of going to the OS browser.
  'popups-open-in-the-app': {
    file: 'desktop/main.js',
    edits: [["    return { action: 'deny' };", "    return { action: 'allow' };"]],
    fails: 'the row counting windows after window.open; the row reading what the OS browser was '
      + 'handed stays green, because the handler still hands the link over',
  },
  'sandbox-off': {
    file: 'desktop/main.js',
    edits: [['      sandbox: true,', '      sandbox: false,']],
    fails: 'the web-preferences row for the sandbox',
  },
  // The bridge answers any sender.
  'bridge-skips-the-sender-check': {
    file: 'desktop/main.js',
    edits: [['    if (!senderTrusted(event, win?.webContents, origin)) {', '    if (false) {']],
    fails: 'the foreign-window row, which asks the bridge from a page that is not the service and '
      + 'must be refused; the rows asking from the service page stay green',
  },
  // A stop becomes a kill: the service never runs its own shutdown.
  'close-kills-the-service': {
    file: 'desktop/service.js',
    edits: [["      child.stdin.write('stop\\n');", "      child.kill('SIGKILL');"]],
    fails: 'the row reading the service\'s exit code after the window closes, which is a signal and '
      + 'not 0',
  },
  // A second launch is no longer handed over.
  'second-launch-takes-no-lock': {
    file: 'desktop/main.js',
    edits: [['if (!app.requestSingleInstanceLock()) {', 'if (false) {']],
    fails: 'the rows where the second launch exits and the first window comes back from minimized; '
      + 'the one-service row stays green, because the held port refuses the second start as well',
  },
  // The held-port probe is gone, so the service is started into a port something holds.
  'busy-port-is-not-checked': {
    file: 'desktop/main.js',
    edits: [['  if (!(await portFree(PORT))) {', '  if (false) {']],
    fails: 'the rows saying the app refuses by name and that no service ran, since the service now '
      + 'starts and dies on the held port',
  },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

let checked = 0;
let failed = 0;
const fired = [];
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) { failed++; fired.push(label); }
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const refuse = (why) => {
  console.log(`[desktop] DID NOT RUN - ${why}`);
  process.exit(2);
};

const electronDir = join(REPO, 'desktop', 'node_modules', 'electron');
if (!existsSync(join(electronDir, 'path.txt'))) {
  refuse('desktop/node_modules/electron holds no binary: run `npm ci --prefix desktop` and then `node desktop/node_modules/electron/install.js`');
}
const ELECTRON = createRequire(join(REPO, 'desktop', 'package.json'))('electron');
let electronApi;
try {
  ({ _electron: electronApi } = await import(join(REPO, 'node_modules', 'playwright', 'index.mjs')));
} catch (err) {
  refuse(`playwright is not installed at the repository root (${err.message.split('\n')[0]}): run \`npm ci\``);
}
if (!(await portFree(PORT))) {
  const holder = (() => {
    try {
      return execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
    } catch { return 'lsof names no listener'; }
  })();
  refuse(`port ${PORT} is held, and the shell uses no other:\n${holder}`);
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
// The service is the checkout's own, symlinked in: its root resolves to the repository either way.
cpSync(join(REPO, 'desktop'), join(STAGE, 'desktop'), { recursive: true, filter: (path) => !path.includes('node_modules') });
symlinkSync(join(REPO, 'server'), join(STAGE, 'server'));
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const path = join(STAGE, spec.file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      rmSync(STAGE, { recursive: true, force: true });
      refuse(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated shell`);
    }
    source = source.replace(from, () => to);
  }
  writeFileSync(path, source);
}

const APP = join(STAGE, 'desktop');
const SERVER = join(STAGE, 'server', 'index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test, ms, step = 100) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) return false;
    await sleep(step);
  }
};
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// The services this run started, read off the process table by the staged path no one else has.
const services = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  .split('\n').map((line) => line.trim())
  .filter((line) => line.includes(SERVER) && line.includes('--stop-on-stdin'))
  .map((line) => ({ pid: Number(line.split(/\s+/)[0]), command: line }));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const children = new Set();
// Electron started by hand, for the launches Playwright cannot attach to.
function launchPlain(userData) {
  const child = spawn(ELECTRON, [APP, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const run = { child, output: '', exit: null };
  const take = (chunk) => { run.output += chunk; };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  run.done = new Promise((resolve) => child.once('exit', (code, signal) => { run.exit = { code, signal }; resolve(run.exit); }));
  return run;
}

let crashed = null;
let driven = null;
try {
  const USERDATA = join(STAGE, 'profile');
  mkdirSync(USERDATA, { recursive: true });
  let output = '';
  driven = await electronApi.launch({
    executablePath: ELECTRON, args: [APP, `--user-data-dir=${USERDATA}`], env, timeout: 60_000,
  });
  const electron = driven.process();
  children.add(electron);
  const gone = new Promise((resolve) => electron.once('exit', (code, signal) => resolve({ code, signal })));
  for (const stream of [electron.stdout, electron.stderr]) stream.on('data', (chunk) => { output += chunk; });
  let page;
  try {
    page = await driven.firstWindow({ timeout: 45_000 });
  } catch (err) {
    throw new Error(`no window opened: ${err.message.split('\n')[0]}\n${output.split('\n').filter((l) => /\[desktop\]|\[server\]/.test(l)).slice(-8).join('\n')}`);
  }
  await page.waitForLoadState('load');

  const main = (fn, arg) => driven.evaluate(fn, arg);
  // The window under test, found while it is the only one, so a shell that opens others cannot
  // change which one the rows below read.
  const windowId = await main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  const ready = /\[desktop\] service ready pid=(\d+) url=(\S+)/.exec(output);
  const origin = `http://127.0.0.1:${PORT}`;

  console.log('the profile, the service and the window');
  ok('the app runs on a scratch profile, so no real library is touched',
    realpathSync(await main(({ app }) => app.getPath('userData'))) === realpathSync(USERDATA), USERDATA);
  ok('the service printed its ready line and the app logged it', Boolean(ready), ready?.[2] ?? 'no ready line in the app output');
  ok(`the window shows the service's origin, ${origin}`, new URL(page.url()).origin === origin, page.url());
  ok('and that origin is the one the ready line named', ready !== null && new URL(ready[2]).origin === new URL(page.url()).origin);
  const reply = await fetch(origin).catch(() => null);
  ok('and the service answers on it', reply?.status === 200, `status ${reply?.status}`);
  const started = services();
  ok('exactly one service is running, on the fixed port', started.length === 1 && started[0].command.includes(`--port ${PORT} `), started.map((s) => s.pid).join(','));
  const roots = ['captures', 'projects', 'presets', 'deliverables', 'effects', 'jobs', 'exports'];
  const command = started[0]?.command ?? '';
  ok('every writable root is a directory under the profile',
    roots.every((name) => command.includes(`--${name} ${join(realpathSync(USERDATA), name)}`) || command.includes(`--${name} ${join(USERDATA, name)}`))
    && roots.every((name) => existsSync(join(USERDATA, name))));

  console.log('the window\'s own settings');
  const prefs = await main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.getLastWebPreferences(), windowId);
  ok('the renderer is sandboxed', prefs.sandbox === true, `sandbox=${prefs.sandbox}`);
  ok('context isolation is on', prefs.contextIsolation === true, `contextIsolation=${prefs.contextIsolation}`);
  ok('node integration is off', prefs.nodeIntegration === false, `nodeIntegration=${prefs.nodeIntegration}`);
  ok('the page sees no require, process or module',
    (await page.evaluate(() => [typeof require, typeof process, typeof module].join())) === 'undefined,undefined,undefined');
  ok('the bridge holds the four calls and nothing else',
    (await page.evaluate(() => Object.keys(window.desktop).sort().join())) === 'chooseDirectory,chooseExportDestination,openProjectFile,revealPath');

  console.log('navigation');
  await main(({ shell }) => {
    globalThis.desktopCheck = { opened: [], dialogs: [], revealed: [] };
    shell.openExternal = async (url) => { globalThis.desktopCheck.opened.push(url); };
    shell.showItemInFolder = (path) => { globalThis.desktopCheck.revealed.push(path); };
  });
  const opened = () => main(() => globalThis.desktopCheck.opened);
  const windows = () => main(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const home = page.url();
  // A navigation that must be refused has no event to wait for, so it is given time to happen.
  // Returns where the page ended up, and brings it home, so a shell that lets one through fails
  // its own row and not every row after it.
  const attempt = async (target) => {
    await page.evaluate((to) => { location.href = to; }, target).catch(() => {});
    await sleep(1200);
    const left = page.url();
    if (left !== here) await page.goto(here);
    return left;
  };

  await page.evaluate(() => { location.href = `${location.origin}/?desktop-check=same`; });
  const moved = await until(() => page.url().includes('desktop-check=same'), 8000);
  ok('a page of the service on another path is allowed', Boolean(moved), page.url());
  ok('and goes nowhere else', (await opened()).length === 0);
  await page.waitForLoadState('load');
  const here = page.url();

  const toHost = await attempt(`http://localhost:${PORT}/`);
  ok('the same service under another host name is another origin, and is refused', toHost === here, toHost);
  ok('and that link goes to the OS browser, once', JSON.stringify(await opened()) === JSON.stringify([`http://localhost:${PORT}/`]), JSON.stringify(await opened()));
  const toSite = await attempt('https://example.invalid/page');
  ok('another site is refused', toSite === here, toSite);
  ok('and goes to the OS browser', (await opened()).includes('https://example.invalid/page'));
  const before = (await opened()).length;
  const toFile = await attempt('file:///etc/hosts');
  ok('a file is refused', toFile === here, toFile);
  ok('and is not handed to the OS browser, which opens web links only', (await opened()).length === before);

  const popup = await page.evaluate(() => [window.open('https://example.invalid/popup'), window.open('/library')].map((w) => w === null));
  await sleep(600);
  ok('window.open makes no window of its own', popup.every(Boolean) && (await windows()) === 1, `${await windows()} window(s)`);
  ok('and sends both links to the OS browser, the service\'s own page included',
    (await opened()).includes('https://example.invalid/popup') && (await opened()).includes(`${origin}/library`));
  ok('the window is where it was', page.url() === here, `${page.url()} vs ${home}`);
  // Whatever a mutated shell opened, so the rows below ask about the window under test alone.
  await main(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter((w) => w.id !== id).forEach((w) => w.destroy()), windowId);

  console.log('the bridge');
  await main(({ dialog }) => {
    const record = (name, answer) => async (...args) => {
      globalThis.desktopCheck.dialogs.push({ name, options: args.at(-1) });
      return answer;
    };
    dialog.showOpenDialog = record('open', { canceled: false, filePaths: ['/stub/chosen'] });
    dialog.showSaveDialog = record('save', { canceled: false, filePath: '/stub/out.mp4' });
  });
  ok('chooseDirectory answers the service page with the path the dialog gave',
    (await page.evaluate(() => window.desktop.chooseDirectory())) === '/stub/chosen');
  ok('and asked for a directory', (await main(() => globalThis.desktopCheck.dialogs))[0]?.options.properties.includes('openDirectory') === true);
  ok('openProjectFile answers likewise, over JSON files', (await page.evaluate(() => window.desktop.openProjectFile())) === '/stub/chosen'
    && (await main(() => globalThis.desktopCheck.dialogs))[1]?.options.filters[0].extensions.join() === 'json');
  ok('chooseExportDestination answers with the path the save dialog gave',
    (await page.evaluate(() => window.desktop.chooseExportDestination('shot.mp4'))) === '/stub/out.mp4');
  ok('and refuses a name that is not a string', await page.evaluate(() => window.desktop.chooseExportDestination(42).then(() => false, (e) => /file name/.test(String(e)))));
  await page.evaluate(() => window.desktop.revealPath('/stub/chosen'));
  ok('revealPath reveals an absolute path', JSON.stringify(await main(() => globalThis.desktopCheck.revealed)) === '["/stub/chosen"]');
  ok('and refuses a relative one, revealing nothing',
    (await page.evaluate(() => window.desktop.revealPath('../etc').then(() => false, (e) => /absolute/.test(String(e)))))
    && (await main(() => globalThis.desktopCheck.revealed)).length === 1);

  const dialogsBefore = (await main(() => globalThis.desktopCheck.dialogs)).length;
  const foreign = await main(async ({ BrowserWindow }, preload) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    try {
      await window.loadURL('data:text/html,<p>not the service</p>');
      return await window.webContents.executeJavaScript(
        'window.desktop.chooseDirectory().then((v) => ({ answered: v }), (e) => ({ refused: String(e) }))',
      );
    } finally {
      window.destroy();
    }
  }, join(APP, 'preload.cjs'));
  ok('the same call from a page that is not the service is refused, by the bridge', /answers only the Braindance window/.test(foreign.refused ?? ''), JSON.stringify(foreign));
  ok('and no dialog was shown for it', (await main(() => globalThis.desktopCheck.dialogs)).length === dialogsBefore);

  console.log('a second launch');
  await main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), windowId);
  const minimized = await until(() => main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isMinimized(), windowId), 4000);
  ok('the first window is minimized, so its return can be seen', Boolean(minimized));
  const second = launchPlain(USERDATA);
  const exit = await Promise.race([second.done, sleep(20_000).then(() => null)]);
  ok('the second launch ends by itself, with exit 0', exit?.code === 0, JSON.stringify(exit));
  const restored = await until(() => main(({ BrowserWindow }, id) => !BrowserWindow.fromId(id).isMinimized(), windowId), 5000);
  ok('and the first window is brought back', Boolean(restored));
  ok('no second service was started', services().length === 1 && services()[0].pid === started[0].pid, services().map((s) => s.pid).join(','));
  ok('and no second window', (await windows()) === 1);
  if (!exit) { second.child.kill('SIGKILL'); await second.done; }

  console.log('closing the last window');
  const pid = started[0]?.pid ?? 0;
  const closedAt = Date.now();
  main(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  // The app's own exit line, and not the process's end: Playwright holds an exiting Electron open
  // while its debugger is attached, and under load it can hold it for a minute.
  const quit = await until(() => /\[desktop\] exiting with code (\d+)/.exec(output), STOP_GRACE_MS + 10_000);
  const serviceGone = await until(() => !alive(pid), STOP_GRACE_MS + 10_000, 50);
  const took = Date.now() - closedAt;
  const end = await Promise.race([gone, sleep(5000).then(() => null)]);
  if (!end) electron.kill('SIGKILL');
  ok('the app quits', Boolean(quit), quit ? quit[0] : 'it never reached its exit');
  ok('the service exited with code 0', /\[desktop\] service exited code=0 signal=none/.test(output), (/\[desktop\] service exited[^\n]*/.exec(output) ?? ['no exit line'])[0]);
  ok('within the bound, so it was never killed', serviceGone && took < STOP_GRACE_MS && !/was killed/.test(output));
  ok('and the app exits with 0 too', quit?.[1] === '0', quit ? `exit code ${quit[1]}` : 'no exit line');
  ok('no service is left', services().length === 0 && !alive(pid), `${services().length} left`);
  ok('and the port is free again', await portFree(PORT));
  driven = null;

  console.log('a port that is held');
  const stranger = createServer((req, res) => res.end('the stranger'));
  await new Promise((resolve, reject) => { stranger.once('error', reject); stranger.listen(PORT, '127.0.0.1', resolve); });
  const refused = launchPlain(join(STAGE, 'profile-held'));
  const said = await until(() => /\[desktop\] Port \d+ is in use/.exec(refused.output), 15_000);
  ok(`the app refuses, naming port ${PORT}`, Boolean(said) && said[0].includes(String(PORT)), said ? said[0] : refused.output.split('\n').slice(-4).join(' | '));
  ok('before any service output', !/EADDRINUSE|\[server\]/.test(refused.output) && services().length === 0, `${services().length} service(s)`);
  ok('and the port is still the other program\'s',
    (await fetch(`http://127.0.0.1:${PORT}`).then((r) => r.text(), () => '')) === 'the stranger');
  refused.child.kill('SIGKILL');
  await refused.done;
  await new Promise((resolve) => stranger.close(resolve));
} catch (err) {
  // Apart from the assertions: counted as a failed one, a crash reads under --mutate as a catch.
  crashed = err;
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const { pid } of services()) {
    // Only a service whose command line is this run's staged path.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (driven) await driven.close().catch(() => {});
  rmSync(STAGE, { recursive: true, force: true });
}

if (crashed) {
  console.log(`\n[desktop] DID NOT RUN - ${crashed.message}`);
  console.log(`[desktop] ${checked} assertions ran, ${failed} failed before the crash`);
  if (fired.length) console.log(`[desktop] rows that had already fired: ${fired.join('; ')}`);
  process.exit(2);
}

console.log(`\n[desktop] ${checked} assertions, ${failed} failed`);
if (MUTATE) {
  if (MUTATIONS[MUTATE].fails) console.log(`[desktop] it should redden: ${MUTATIONS[MUTATE].fails}`);
  if (failed === 0) { console.log('[desktop] NOT CAUGHT - the check passed a shell it should have rejected'); process.exit(1); }
  console.log(`[desktop] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired: ${fired.join('; ')})`);
  process.exit(1);
}
if (failed) { console.log(`[desktop] FAIL: ${fired.join('; ')}`); process.exit(1); }
console.log('[desktop] PASS');
process.exit(0);
