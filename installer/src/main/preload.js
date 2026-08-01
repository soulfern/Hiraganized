const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  selectDir: () => ipcRenderer.invoke('install:select-dir'),
  run: (dir) => ipcRenderer.invoke('install:run', dir),
  cancel: () => ipcRenderer.invoke('install:cancel'),
  launchApp: (dir) => ipcRenderer.invoke('install:launch-app', dir),
  minimize: () => ipcRenderer.invoke('install:minimize'),
  onProgress: (cb) => {
    const handler = (_ev, data) => cb(data);
    ipcRenderer.on('install:progress', handler);
    return () => ipcRenderer.removeListener('install:progress', handler);
  },
});
