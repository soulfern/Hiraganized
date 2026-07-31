const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uninstaller', {
  getPaths: () => ipcRenderer.invoke('uninstall:get-paths'),
  execute: (options) => ipcRenderer.invoke('uninstall:execute', options),
  close: () => window.close(),
});
