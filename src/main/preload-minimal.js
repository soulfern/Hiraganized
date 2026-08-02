const { contextBridge, ipcRenderer } = require('electron');

// Minimal, sandboxed preload for the popup, overlay, and logs windows.
// Exposes only display / resize / dismiss-related messaging and receives app
// state — deliberately no updateSettings / resetSettings / clearDictionaryCache
// / openExternal (those live in the main window's preload only).
contextBridge.exposeInMainWorld('hiraganized', {
  onState: (callback) => ipcRenderer.on('app:state', (_event, state) => callback(state)),
  onOcrResult: (callback) => ipcRenderer.on('popup:ocr-result', (_event, text) => callback(text)),
  onPopupPayload: (callback) => ipcRenderer.on('popup:payload', (_event, data) => callback(data)),
  onPopupWarning: (callback) => ipcRenderer.on('popup:warning', (_event, message) => callback(message)),
  resizePopup: (height) => ipcRenderer.send('popup:resize', height),
  commitSelection: (bounds) => ipcRenderer.send('selection:commit', bounds),
  cancelSelection: () => ipcRenderer.send('selection:cancel'),
  onOverlayImage: (callback) => ipcRenderer.on('overlay:image', (_event, frames) => callback(frames)),
  onOverlayReset: (callback) => ipcRenderer.on('overlay:reset', () => callback()),
  onLogLine: (callback) => ipcRenderer.on('logs:line', (_event, line) => callback(line)),
  closeWindow: () => ipcRenderer.send('app:close-logs'),
  minimizeLogs: () => ipcRenderer.invoke('app:minimize-logs'),
  maximizeLogs: () => ipcRenderer.invoke('app:maximize-logs'),
  onLogsMaximized: (callback) => ipcRenderer.on('logs:maximized', (_event, maximized) => callback(maximized))
});