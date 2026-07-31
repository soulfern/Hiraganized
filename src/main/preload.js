const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hiraganized', {
  updateSettings: (patch) => ipcRenderer.invoke('app:update-settings', patch),
  hideWindow: () => ipcRenderer.invoke('app:hide-window'),
  minimizeWindow: () => ipcRenderer.invoke('app:minimize-window'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onState: (callback) => ipcRenderer.on('app:state', (_event, state) => callback(state)),
  onOcrSetupStart: (callback) => ipcRenderer.on('ocr:setup-start', () => callback()),
  onOcrSetupProgress: (callback) => ipcRenderer.on('ocr:setup-progress', (_event, data) => callback(data)),
  onOcrSetupDone: (callback) => ipcRenderer.on('ocr:setup-done', () => callback()),
  cancelOcrSetup: () => ipcRenderer.invoke('ocr:cancel'),
  onOcrResult: (callback) => ipcRenderer.on('popup:ocr-result', (_event, text) => callback(text)),
  onPopupPayload: (callback) => ipcRenderer.on('popup:payload', (_event, data) => callback(data)),
  onPopupWarning: (callback) => ipcRenderer.on('popup:warning', (_event, message) => callback(message)),
  commitSelection: (bounds) => ipcRenderer.send('selection:commit', bounds),
  cancelSelection: () => ipcRenderer.send('selection:cancel')
});
