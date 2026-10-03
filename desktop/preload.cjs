// A sandboxed preload cannot be an ES module, so this file is CommonJS. It hands the page four
// calls and nothing else; `main.js` answers each one only for the window it opened.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(`desktop:${name}`, ...args);

contextBridge.exposeInMainWorld('desktop', {
  chooseDirectory: call('chooseDirectory'),
  openProjectFile: call('openProjectFile'),
  chooseExportDestination: call('chooseExportDestination'),
  revealPath: call('revealPath'),
});
