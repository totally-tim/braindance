#!/usr/bin/env node
// Proves the desktop shell: that its window shows the service's own origin and refuses every other,
// that the bridge answers only the window the app opened and reveals only a path the user chose or
// one inside the app's data folders, that a second launch hands over to the first and starts no
// service, that a held port is refused by name, and that closing the last window of a plain launch
// stops the service with exit 0 and then ends the Electron process itself with exit 0. Every
// refusal row has a positive twin, so a shell that refused everything would fail. The two dialogs a
// person sees are not read: the refusal is proved by the line the app logs beside its dialog, and
// the missing-Node dialog is not driven here.
//
//   node tools/desktop-check.mjs [--mutate <name>]
//
// It stages desktop/ under .desktop-check/ and runs the staged copy against the real
// server/index.js, so a mutation never touches the checkout.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, STOP_GRACE_MS, portFree } from '../desktop/service.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MUTATE = argv.includes('--mutate') ? argv[argv.indexOf('--mutate') + 1] : null;
const STAGE = join(REPO, '.desktop-check');
// How long Electron has to end once its service has. The service has STOP_GRACE_MS; this is the
// app's own bound, and a process that needs a kill to end has not met it. Chromium's teardown
// after `app.exit` runs from seconds to minutes on a loaded machine, so the bound is long and the
// row reports the load average beside it.
const APP_EXIT_MS = 180_000;

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
  // The bridge reveals whatever absolute path it is handed.
  'reveal-any-absolute-path': {
    file: 'desktop/main.js',
    edits: [['    const target = await revealable(path, { picked, roots: Object.values(roots) });', '    const target = path;']],
    fails: 'the rows that ask to reveal a file nobody chose, a system file, a path that climbs out of '
      + 'a root, a link out of a root and a path that does not exist; the rows for a path the user '
      + 'chose and a path in a root stay green',
  },
  // The path is judged as written, so a link inside a root is taken for a file inside it.
  'reveal-skips-realpath': {
    file: 'desktop/reveal.js',
    edits: [
      ["import { sep } from 'node:path';", "import { resolve, sep } from 'node:path';"],
      ['  try { real = await realpath(path); } catch { return null; }', '  real = resolve(path);'],
    ],
    fails: 'the rows for the directory link and the file link that lead out of a root, and for the '
      + 'path that does not exist; the row for the climb stays green, because resolving the path '
      + 'already removes a `..`',
  },
  // A path the user chose in a dialog is forgotten at once.
  'picks-are-not-recorded': {
    file: 'desktop/main.js',
    edits: [['    if (path) picked.add(path);', '    if (path) void path;']],
    fails: 'the row that reveals the three paths the dialogs returned, and the row that reveals the '
      + 'file it first refused once the dialog has returned it; the root rows stay green',
  },
  // The app never ends: the last window closes and the service stops, and Electron stays alive.
  'app-exit-is-skipped': {
    file: 'desktop/main.js',
    edits: [['    app.exit(exitCode);', '    void exitCode;']],
    fails: 'the two rows that read the Electron process itself, which neither ends by itself nor '
      + 'ends with 0; the rows for the service and the port stay green, because the service is '
      + 'stopped before the app fails to exit',
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
// Electron started by hand, with no debugger of Playwright's attached, so its exit is its own.
function launchPlain(userData, extraArgs = []) {
  const child = spawn(ELECTRON, [APP, `--user-data-dir=${userData}`, ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Real files, because the bridge reveals only what exists. PICKS stands for what the dialogs
  // return; SECRET sits where no data folder and no dialog points.
  const FILES = join(realpathSync(STAGE), 'files');
  const PICKS = { dir: join(FILES, 'picked-dir'), file: join(FILES, 'picked.json'), out: join(FILES, 'picked-out.mp4') };
  const SECRET = join(FILES, 'outside', 'secret.txt');
  mkdirSync(join(FILES, 'outside'), { recursive: true });
  mkdirSync(PICKS.dir, { recursive: true });
  for (const file of [PICKS.file, PICKS.out, SECRET]) writeFileSync(file, 'x');
  const REAL_USERDATA = realpathSync(USERDATA);
  const inRoot = (name, ...rest) => join(REAL_USERDATA, name, ...rest);
  writeFileSync(inRoot('captures', 'take.knct'), 'x');
  symlinkSync(join(FILES, 'outside'), inRoot('captures', 'escape'));
  symlinkSync(SECRET, inRoot('exports', 'leak'));
  await main(({ dialog }, picks) => {
    const record = (name, answer) => async (...args) => {
      const options = args.at(-1);
      globalThis.desktopCheck.dialogs.push({ name, options });
      return answer(options);
    };
    dialog.showOpenDialog = record('open', (options) => ({
      canceled: false, filePaths: [options.properties.includes('openDirectory') ? picks.dir : picks.file],
    }));
    dialog.showSaveDialog = record('save', () => ({ canceled: false, filePath: picks.out }));
  }, PICKS);
  const reveal = (path) => page.evaluate((target) => window.desktop.revealPath(target).then(() => 'revealed', (e) => String(e)), path);
  const revealed = () => main(() => globalThis.desktopCheck.revealed);
  const dialogs = () => main(() => globalThis.desktopCheck.dialogs);
  const SHOWS_ONLY = /shows only an existing path chosen in this app or inside its data folders/;
  // A refusal reveals nothing; its row says the bridge refused by that rule and the list did not grow.
  const refusal = async (path) => {
    const had = (await revealed()).length;
    const answer = await reveal(path);
    return { pass: SHOWS_ONLY.test(answer) && (await revealed()).length === had, detail: answer.split('\n')[0].slice(0, 120) };
  };

  const beforePick = await refusal(PICKS.file);
  ok('revealPath refuses a file that exists but nobody chose', beforePick.pass, beforePick.detail);
  ok('chooseDirectory answers the service page with the path the dialog gave',
    (await page.evaluate(() => window.desktop.chooseDirectory())) === PICKS.dir);
  ok('and asked for a directory', (await dialogs())[0]?.options.properties.includes('openDirectory') === true);
  ok('openProjectFile answers likewise, over JSON files', (await page.evaluate(() => window.desktop.openProjectFile())) === PICKS.file
    && (await dialogs())[1]?.options.filters[0].extensions.join() === 'json');
  ok('chooseExportDestination answers with the path the save dialog gave',
    (await page.evaluate(() => window.desktop.chooseExportDestination('shot.mp4'))) === PICKS.out);
  ok('and refuses a name that is not a string', await page.evaluate(() => window.desktop.chooseExportDestination(42).then(() => false, (e) => /file name/.test(String(e)))));

  const beforePicks = (await revealed()).length;
  const answers = [await reveal(PICKS.dir), await reveal(PICKS.file), await reveal(PICKS.out)];
  const shownPicks = (await revealed()).slice(beforePicks);
  ok('revealPath shows the three paths the dialogs returned, as given',
    answers.every((answer) => answer === 'revealed') && JSON.stringify(shownPicks) === JSON.stringify(Object.values(PICKS)),
    JSON.stringify(shownPicks));
  ok('the file it refused before is shown once the dialog has returned it', answers[1] === 'revealed');
  const take = inRoot('captures', 'take.knct');
  ok('revealPath shows a file inside a data folder, by its real path',
    (await reveal(take)) === 'revealed' && (await revealed()).at(-1) === take, (await revealed()).at(-1));

  for (const [what, path] of [
    ['a file outside every data folder that nobody chose', SECRET],
    ['a system file', '/etc/hosts'],
    ['a path that climbs out of a data folder', `${inRoot('captures')}/../../files/outside/secret.txt`],
    ['a directory link inside a data folder that leads out of it', join(inRoot('captures', 'escape'), 'secret.txt')],
    ['a file link inside a data folder that leads out of it', inRoot('exports', 'leak')],
    ['a path in a data folder that does not exist', inRoot('captures', 'missing.knct')],
  ]) {
    const refused = await refusal(path);
    ok(`revealPath refuses ${what}, revealing nothing`, refused.pass, refused.detail);
  }
  const beforeRelative = (await revealed()).length;
  ok('and refuses a relative path, revealing nothing',
    (await page.evaluate(() => window.desktop.revealPath('../etc').then(() => false, (e) => /absolute/.test(String(e)))))
    && (await revealed()).length === beforeRelative);

  const dialogsBefore = (await dialogs()).length;
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
  ok('and no dialog was shown for it', (await dialogs()).length === dialogsBefore);

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

  // The attached run ends here and claims nothing about exit, because Playwright holds an exiting
  // Electron open while its debugger is attached. Its service must be gone and its port free before
  // the next launch can bind it.
  const attachedService = started[0]?.pid;
  main(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  if (attachedService) await until(() => !alive(attachedService), STOP_GRACE_MS + 10_000, 50);
  if (!(await Promise.race([gone, sleep(APP_EXIT_MS).then(() => null)]))) electron.kill('SIGKILL');
  driven = null;
  ok('the attached run left no service and a free port', services().length === 0 && (await portFree(PORT)), `${services().length} left`);

  console.log('closing the last window of a plain launch');
  // No debugger of Playwright's: the window is closed over Chromium's own debugging port, as a
  // click on its close box would, and the Electron process is then waited on as it is.
  const quitting = launchPlain(join(STAGE, 'profile-quit'), ['--remote-debugging-port=0']);
  const debugPort = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(quitting.output)?.[1], 30_000);
  const serviceLine = await until(() => /\[desktop\] service ready pid=(\d+)/.exec(quitting.output), 60_000);
  const targets = () => fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json(), () => []);
  const target = debugPort && await until(async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith(origin)), 30_000);
  if (!target) throw new Error(`the plain launch showed no window on ${origin}\n${quitting.output.split('\n').filter((l) => /\[desktop\]|\[server\]/.test(l)).slice(-6).join('\n')}`);
  const closedAt = Date.now();
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  const servicePid = Number(serviceLine?.[1]);
  const serviceGone = await until(() => !alive(servicePid), STOP_GRACE_MS + 10_000, 50);
  const took = Date.now() - closedAt;
  // The app's own bound starts when its service has ended. Only after the verdict on the exit is
  // taken may the process be killed, and a kill is the failure the row below reports.
  const serviceEndedAt = Date.now();
  const ended = await Promise.race([quitting.done, sleep(APP_EXIT_MS).then(() => null)]);
  const killed = ended === null;
  const tail = Date.now() - serviceEndedAt;
  if (killed) { quitting.child.kill('SIGKILL'); await quitting.done; }
  const exitLine = /\[desktop\] exiting with code (\d+)/.exec(quitting.output);
  ok('the service exited with code 0', /\[desktop\] service exited code=0 signal=none/.test(quitting.output), (/\[desktop\] service exited[^\n]*/.exec(quitting.output) ?? ['no exit line'])[0]);
  ok('within the bound, so it was never killed', serviceGone && took < STOP_GRACE_MS && !/was killed/.test(quitting.output), `${took} ms`);
  ok(`the app's own process ended by itself within ${APP_EXIT_MS / 1000} seconds of its service`, !killed && ended?.signal === null,
    killed ? `still running after ${APP_EXIT_MS / 1000} seconds, so the check killed it; ${exitLine ? `the app had logged "${exitLine[0]}"` : 'the app never logged its exit line'}; load average ${loadavg()[0].toFixed(0)}`
      : `${JSON.stringify(quitting.exit)} ${tail} ms after the service ended; load average ${loadavg()[0].toFixed(0)}`);
  ok('and its exit code is 0', quitting.exit?.code === 0 && quitting.exit.signal === null && !killed, JSON.stringify(quitting.exit));
  ok('no service is left', services().length === 0 && !alive(servicePid), `${services().length} left`);
  ok('and the port is free again', await portFree(PORT));

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
