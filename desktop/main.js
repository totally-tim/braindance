// The desktop shell: starts the service, opens one window on its origin, and stops the service
// when the last window closes. The service is the program; this file owns its process and the
// window, and the editor in the window is the same page a browser would get.
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { externalUrl, sameOrigin, senderTrusted } from './origin.js';
import { NODE_MAJOR, PORT, STOP_GRACE_MS, findNode, nodeDirs, portFree, rootsUnder, startService } from './service.js';

const here = dirname(fileURLToPath(import.meta.url));
// The service is the checkout's own server.
const repo = join(here, '..');

const log = (line) => console.log(`[desktop] ${line}`);

let service = null;
let origin = null;
let win = null;
let stopped = null;
let exitCode = 0;

/** Says why the app cannot run, over a dialog and in the log, then quits. */
async function refuse(message, detail) {
  console.error(`[desktop] ${message}: ${detail}`);
  exitCode = 1;
  // Not showErrorBox: that one blocks the main process, and a quit waits behind it.
  await dialog.showMessageBox({ type: 'error', message, detail, buttons: ['Quit'] });
  app.quit();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openExternally(url) {
  const safe = externalUrl(url);
  if (safe) shell.openExternal(safe);
}

function openWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = win.webContents;
  const guard = (event) => {
    if (sameOrigin(event.url, origin)) return;
    event.preventDefault();
    if (event.isMainFrame) openExternally(event.url);
  };
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
  // One window per app: every window.open goes to the OS browser.
  contents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  win.loadURL(url);
}

// Each call answers only the top frame of the window this app opened, while it shows the service.
function registerBridge() {
  const handle = (name, fn) => ipcMain.handle(`desktop:${name}`, (event, ...args) => {
    if (!senderTrusted(event, win?.webContents, origin)) {
      throw new Error(`${name} answers only the Braindance window`);
    }
    return fn(...args);
  });
  const chosen = (result) => (result.canceled ? null : result.filePaths[0]);

  handle('chooseDirectory', async () => chosen(await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  })));
  handle('openProjectFile', async () => chosen(await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Braindance project', extensions: ['json'] }],
  })));
  handle('chooseExportDestination', async (defaultName) => {
    if (typeof defaultName !== 'string') throw new Error('chooseExportDestination takes a file name');
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    return result.canceled ? null : result.filePath;
  });
  handle('revealPath', (path) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('revealPath takes an absolute path');
    shell.showItemInFolder(path);
  });
}

async function boot() {
  const node = await findNode(nodeDirs());
  if (!node.path) {
    const found = node.older.map(({ path, version }) => `${version} at ${path}`).join(', ');
    return refuse(`Braindance needs Node ${NODE_MAJOR} or newer`,
      found ? `Only ${found} was found.` : 'No node program was found on this machine.');
  }
  if (!(await portFree(PORT))) {
    return refuse(`Port ${PORT} is in use`,
      `Braindance serves its editor on port ${PORT} and no other. Close the program that holds it and start Braindance again.`);
  }

  const roots = rootsUnder(app.getPath('userData'));
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  service = startService({
    node: node.path,
    entry: join(repo, 'server', 'index.js'),
    cwd: repo,
    roots,
    onLine: (stream, line) => (stream === 'stderr' ? console.error : console.log)(line),
  });
  service.exited.then(({ code, signal }) => {
    log(`service exited code=${code} signal=${signal ?? 'none'}`);
    // Before `origin` is set, `ready` rejects and `boot` refuses.
    if (origin && !stopped) refuse('The Braindance service stopped', `It exited with code ${code ?? signal}. Start Braindance again.`);
  });

  let ready;
  try {
    ready = await service.ready;
  } catch (err) {
    return refuse('Braindance could not start its service', err.message);
  }
  log(`service ready pid=${ready.pid} url=${ready.url}`);
  origin = ready.origin;
  registerBridge();
  openWindow(ready.url);
}

// Closing the last window is Quit. The service gets `stop` and STOP_GRACE_MS to finish its take
// and its grabber, and the app exits with what the service exited with.
function stopThenExit(event) {
  event.preventDefault();
  if (stopped) return;
  for (const window of BrowserWindow.getAllWindows()) window.hide();
  stopped = (service?.stop() ?? Promise.resolve({ code: 0 })).then((result) => {
    if (result.forced) log(`service did not exit in ${STOP_GRACE_MS / 1000} seconds and was killed`);
    if (result.code !== 0) exitCode = 1;
  }).finally(() => {
    log(`exiting with code ${exitCode}`);
    app.exit(exitCode);
  });
}

if (!app.requestSingleInstanceLock()) {
  log('Braindance is already running, so this launch hands over to it');
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', stopThenExit);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
  app.whenReady().then(boot).catch((err) => refuse('Braindance could not start', err.message));
}
