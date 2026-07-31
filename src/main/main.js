const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell,
  screen, globalShortcut, desktopCapturer, dialog
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DictionaryService } = require('./dictionary-service');
const { ConfigStore } = require('./config-store');
const { Logger } = require('./logger');
const { cloneDefaults } = require('./defaults');
const { recognizeImage, cropRegion, saveTempPng, startOcr, stopOcr, tryCleanup, setSetupCallbacks, cancelSetup } = require('./ocr-manager');

const root = path.resolve(__dirname, '..', '..');

// --- Uninstaller mode ---
// Launched via `Hiraganized.exe --uninstall` from Windows "Installed apps".
// Runs a dedicated window and skips the normal app flow + single-instance lock.
if (process.argv.includes('--uninstall')) {
  const { runUninstaller } = require('./uninstaller');
  runUninstaller();
  return;
}

const POPUP_WIDTH = 300;
const POPUP_HEIGHT = 220;
const MAIN_WINDOW_WIDTH = 520;
const MAIN_WINDOW_HEIGHT = 460;
const MAIN_WINDOW_MIN_WIDTH = 520;
const MAIN_WINDOW_MIN_HEIGHT = 460;

let tray = null;
let mainWindow = null;
let overlayWindow = null;
let popupWindow = null; // single reusable popup window
let activePopups = [];
let settings = {};
let configStore = null;
let dictionary = null;
let logger = null;
let isQuitting = false;
let captureInProgress = false;
let trayNotifiedOnce = false;
let cachedAppIcon = null;
let windowStateSaveTimer = null;

const state = {
  popupVisible: false,
  ocrStatus: { available: null, message: '' },
  settings: null
};

function publishState() {
  const payload = { ...state, settings };
  for (const window of BrowserWindow.getAllWindows()) {
    try { if (!window.isDestroyed()) window.webContents.send('app:state', payload); } catch {}
  }
}

async function ensureOcrStarted() {
  try {
    await startOcr();
    state.ocrStatus = { available: true, message: 'manga-ocr ready' };
    logger?.info('OCR engine ready (manga-ocr)');
    publishState();
  } catch (err) {
    state.ocrStatus = { available: false, message: err.message };
    logger?.warn('OCR engine failed to start', { error: err.message });
    publishState();
  }
}

function appIcon() {
  if (cachedAppIcon) return cachedAppIcon;
  try {
    const sizes = [16, 32, 48, 64];
    const dir = path.join(root, 'assets');
    for (const size of sizes) {
      const p = path.join(dir, `icon${size}.png`);
      if (fs.existsSync(p)) return (cachedAppIcon = nativeImage.createFromPath(p));
    }
    const p = path.join(dir, 'icon.png');
    if (fs.existsSync(p)) return (cachedAppIcon = nativeImage.createFromPath(p));
    const ico = path.join(dir, 'icon.ico');
    if (fs.existsSync(ico)) return (cachedAppIcon = nativeImage.createFromPath(ico));
  } catch {}
  return nativeImage.createEmpty();
}

// --- Capture pipeline ---

async function triggerCapture() {
  if (captureInProgress) return { ok: false, reason: 'busy' };
  captureInProgress = true;
  try {
    createOverlayWindow();
    return { ok: true };
  } catch (error) {
    captureInProgress = false;
    return { ok: false, error: error.message };
  }
}

async function handleSelection(bounds) {
  await destroyOverlay();
  if (!bounds || bounds.width < 10 || bounds.height < 10) {
    captureInProgress = false;
    return;
  }

  let tempPath = null;
  try {
    // Give the compositor time to remove the selection overlay from the desktop frame.
    await new Promise((resolve) => setTimeout(resolve, 75));
    const frames = await getScreenFrames({ maxWidth: 2400, preferredDisplayBounds: bounds });

    const cursor = screen.getDisplayNearestPoint({
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2)
    });

    const frame = frames.find(
      (f) => f.displayBounds.x === cursor.bounds.x && f.displayBounds.y === cursor.bounds.y
    ) || frames[0];

    if (!frame || !frame.dataUrl) {
      logger?.warn('No screen frame captured');
      showWarningPopup('Capture error\nNo display image was available.', bounds);
      return;
    }

    const pngBuffer = cropRegion(frame.dataUrl, bounds, frame.displayBounds, frame.thumbnailWidth, frame.thumbnailHeight);

    if (!pngBuffer) {
      logger?.warn('Failed to crop region');
      showWarningPopup('Capture error\nThe selected region could not be cropped.', bounds);
      return;
    }

    tempPath = saveTempPng(pngBuffer);

    let text;
    try {
      text = await recognizeImage(tempPath);
    } catch (ocrErr) {
      logger?.error('OCR failed', { error: ocrErr.message });
      showWarningPopup(`OCR error\n${ocrErr.message}`, bounds);
      return;
    }

    logger?.info(`OCR: "${text}"`);

    if (!text) {
      showWarningPopup('No text detected\nTry a tighter, higher-contrast selection.', bounds);
      return;
    }

    if (dictionary) {
      const chars = dictionary.extractKanji(text);
      const seqs = dictionary.extractSequences(text);

      if (chars.length > 10) {
        showMainWindow();
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Too many kanji',
          message: `Selected region contains ${chars.length} kanji (max 10). Please select a smaller region.`
        });
        logger?.info(`Capture rejected: ${chars.length} kanji exceeds limit of 10`);
        return;
      }

      if (chars.length === 0) {
        showOcrPopup(text, bounds);
        return;
      }

      const entries = [];

      // A raw kanji run may fuse several real words (e.g. 毎日日本語 = 毎日 + 日本語).
      // Segment each run into genuine dictionary compounds; only those become
      // compound entries (with per-character children). Non-compound kanji fall
      // through to the individual-character loop below.
      for (const seq of seqs) {
        if (seq.length < 2) continue;
        const pieces = await dictionary.segmentSequence(seq);
        for (const piece of pieces) {
          if (piece.length < 2) continue;
          const result = await dictionary.lookupCompound(piece);
          if (result) {
            if (settings.general?.showCompoundCharacters !== false) {
              const childChars = dictionary.extractKanji(piece);
              result._children = (await Promise.all(childChars.map((ch) => dictionary.lookup(ch)))).filter(Boolean);
            }
            entries.push(result);
          }
        }
      }

      const seen = new Set(entries.map((e) => e.character));
      for (const entry of entries) {
        for (const char of dictionary.extractKanji(entry.character)) seen.add(char);
        if (entry._children) {
          for (const child of entry._children) {
            seen.add(child.character);
          }
        }
      }
      for (const char of chars) {
        if (seen.has(char)) continue;
        seen.add(char);
        const result = await dictionary.lookup(char);
        if (result) entries.push(result);
      }

      if (entries.length > 0) {
        const pos = { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + bounds.height };
        showKanjiPopup(entries, pos);
        return;
      }
    }

    showOcrPopup(text, bounds);
  } catch (error) {
    logger?.error('Capture pipeline failed', { error: error.message });
    showWarningPopup(`Capture error\n${error.message}`, bounds);
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
    captureInProgress = false;
  }
}

async function getScreenFrames(options = {}) {
  const maxWidth = Math.max(640, Math.min(Number(options?.maxWidth) || 1920, 1920));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: Math.round(maxWidth * 0.68) },
    fetchWindowIcons: false
  });
  const displays = screen.getAllDisplays();
  // Only keep the display nearest the selection point (perf: skip full-screen captures of other monitors).
  const preferred = options?.preferredDisplayBounds
    ? screen.getDisplayNearestPoint({
        x: options.preferredDisplayBounds.x + Math.round(options.preferredDisplayBounds.width / 2),
        y: options.preferredDisplayBounds.y + Math.round(options.preferredDisplayBounds.height / 2)
      })
    : null;

  const result = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const d = displays.find((display) => String(display.id) === String(s.display_id)) || displays[i];
    if (!d || s.thumbnail.isEmpty()) continue;
    if (preferred && (d.bounds.x !== preferred.bounds.x || d.bounds.y !== preferred.bounds.y)) continue;
    const size = s.thumbnail.getSize();
    result.push({
      displayId: s.display_id,
      displayName: s.name,
      dataUrl: s.thumbnail.toDataURL(),
      displayBounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      thumbnailWidth: size.width,
      thumbnailHeight: size.height
    });
  }
  return result;
}

// --- Overlay window ---

function createOverlayWindow() {
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((d) => d.bounds.x));
  const top = Math.min(...displays.map((d) => d.bounds.y));
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const totalBounds = { x: left, y: top, w: right - left, h: bottom - top };

  overlayWindow = new BrowserWindow({
    x: totalBounds.x,
    y: totalBounds.y,
    width: totalBounds.w,
    height: totalBounds.h,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.showInactive();
    overlayWindow.focus();
    overlayWindow.setVisibleOnAllWorkspaces(true);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function destroyOverlay() {
  const win = overlayWindow;
  if (!win || win.isDestroyed()) {
    overlayWindow = null;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    win.once('closed', resolve);
    win.close();
  });
}

// --- Popup system ---

function popupBounds(pos) {
  const display = pos ? screen.getDisplayNearestPoint({ x: pos.x, y: pos.y }) : screen.getPrimaryDisplay();
  const area = display.workArea;

  let x, y;
  if (pos) {
    x = Math.round(pos.x - POPUP_WIDTH / 2);
    y = Math.round(pos.y + 10);
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - POPUP_WIDTH - 4));
    y = Math.max(area.y + 4, Math.min(y, area.y + area.height - POPUP_HEIGHT - 4));
  } else {
    x = area.x + Math.round((area.width - POPUP_WIDTH) / 2);
    y = area.y + Math.round((area.height - POPUP_HEIGHT) / 2);
  }

  return { x, y, width: POPUP_WIDTH, height: POPUP_HEIGHT };
}

/** Single reusable popup window: created once, re-targeted per payload. */
function getPopupWindow(bounds, { width = POPUP_WIDTH, height = POPUP_HEIGHT } = {}) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setBounds({ ...bounds, width, height });
    return popupWindow;
  }

  popupWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  popupWindow.setMenuBarVisibility(false);
  popupWindow.loadFile(path.join(__dirname, '../renderer/popup.html'));

  popupWindow.on('closed', () => {
    popupWindow = null;
    activePopups = [];
    state.popupVisible = false;
    publishState();
  });

  return popupWindow;
}

function sendToPopup(channel, payload, bounds, { width = POPUP_WIDTH, height = POPUP_HEIGHT } = {}) {
  const win = getPopupWindow(bounds, { width, height });
  const send = () => {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, payload);
    win.setOpacity(Math.max(0.55, Math.min(1, Number(settings.notifications?.opacity) / 100)));
    win.showInactive();
    win.setAlwaysOnTop(true, 'floating');
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
  activePopups = [{ win }];
  state.popupVisible = true;
  publishState();
}

function showKanjiPopup(entries, position) {
  if (!entries.length) return;

  // Respect the "show compound characters" setting: when disabled, a compound
  // appears as a single entry rather than being expanded into its characters.
  const showCompoundChars = settings.general?.showCompoundCharacters !== false;

  const flatEntries = [];
  for (const entry of entries) {
    flatEntries.push(entry);
    if (showCompoundChars && entry._children) {
      flatEntries.push(...entry._children);
    }
  }

  const bounds = popupBounds(position);
  sendToPopup('popup:payload', { entries: flatEntries }, bounds);
}

function hidePopup() {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close();
  activePopups = [];
  state.popupVisible = false;
  publishState();
}

function showOcrPopup(text, bounds) {
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  });

  const pw = 320;
  const ph = 140;

  let px = Math.round(bounds.x + (bounds.width - pw) / 2);
  let py = Math.round(bounds.y + bounds.height + 20);
  if (py + ph > display.workArea.y + display.workArea.height) {
    py = Math.round(bounds.y - ph - 20);
  }
  if (px + pw > display.workArea.x + display.workArea.width) {
    px = display.workArea.x + display.workArea.width - pw - 10;
  }
  if (px < display.workArea.x) px = display.workArea.x + 10;

  sendToPopup('popup:ocr-result', text, { x: px, y: py }, { width: pw, height: ph });
}

function showWarningPopup(message, bounds) {
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  });

  const pw = 300;
  const ph = 120;

  let px = Math.round(bounds.x + (bounds.width - pw) / 2);
  let py = Math.round(bounds.y + bounds.height + 20);
  if (py + ph > display.workArea.y + display.workArea.height) {
    py = Math.round(bounds.y - ph - 20);
  }
  if (px + pw > display.workArea.x + display.workArea.width) {
    px = display.workArea.x + display.workArea.width - pw - 10;
  }
  if (px < display.workArea.x) px = display.workArea.x + 10;

  sendToPopup('popup:warning', message, { x: px, y: py }, { width: pw, height: ph });
}

let windowState = { x: undefined, y: undefined, width: MAIN_WINDOW_WIDTH, height: MAIN_WINDOW_HEIGHT, maximized: false };
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function saveWindowState() {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    windowState = {
      x: bounds.x, y: bounds.y,
      width: bounds.width, height: bounds.height,
      maximized: mainWindow.isMaximized()
    };
    fs.writeFileSync(windowStatePath, JSON.stringify(windowState));
  } catch {}
}

function scheduleWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(saveWindowState, 250);
}

function restoreWindowState() {
  try {
    if (fs.existsSync(windowStatePath)) {
      const data = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
      if (data && typeof data === 'object') Object.assign(windowState, data);
    }
  } catch {}

  const display = Number.isFinite(windowState.x) && Number.isFinite(windowState.y)
    ? screen.getDisplayNearestPoint({ x: windowState.x, y: windowState.y })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  windowState.width = Math.min(area.width, Math.max(MAIN_WINDOW_MIN_WIDTH, Number(windowState.width) || MAIN_WINDOW_WIDTH));
  windowState.height = Math.min(area.height, Math.max(MAIN_WINDOW_MIN_HEIGHT, Number(windowState.height) || MAIN_WINDOW_HEIGHT));
  if (Number.isFinite(windowState.x)) {
    windowState.x = Math.max(area.x, Math.min(windowState.x, area.x + area.width - windowState.width));
  }
  if (Number.isFinite(windowState.y)) {
    windowState.y = Math.max(area.y, Math.min(windowState.y, area.y + area.height - windowState.height));
  }
}

function createMainWindow() {
  restoreWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width || MAIN_WINDOW_WIDTH,
    height: windowState.height || MAIN_WINDOW_HEIGHT,
    x: windowState.x,
    y: windowState.y,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    icon: appIcon(),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    const startHidden =
      settings.general.minimizeToTray ||
      (settings.general.startMinimized === true && startedFromStartup());
    if (!startHidden) mainWindow.show();
    publishState();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.general.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      showTrayBackgroundNotification();
    } else {
      saveWindowState();
    }
  });

  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('maximize', () => { scheduleWindowStateSave(); publishState(); });
  mainWindow.on('unmaximize', () => { scheduleWindowStateSave(); publishState(); });
  mainWindow.on('closed', () => { saveWindowState(); mainWindow = null; });
  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  trayNotifiedOnce = false; // allow next hide-to-tray to notify again
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  refreshTrayMenu();
}

function showTrayBackgroundNotification() {
  if (trayNotifiedOnce) return;
  // Reset the gate when the window is shown again, so re-hiding notifies each session.
  trayNotifiedOnce = true;
  try {
    const ico = appIcon();
    if (tray && tray.displayBalloon) {
      tray.displayBalloon({
        title: 'Hiraganized',
        content: 'Hiraganized is still running in the background.\nRight-click the tray icon to quit.',
        icon: ico.isEmpty() ? undefined : ico
      });
    } else if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Hiraganized',
        body: 'Hiraganized is still running in the background. Right-click the tray icon to quit.',
        silent: true
      });
      n.on('click', () => showMainWindow());
      n.show();
    }
  } catch (err) {
    logger?.warn('Failed to show tray notification', { error: err.message });
  }
}

// --- Tray ---

function buildTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('Hiraganized');
  tray.on('double-click', showMainWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const isVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: isVisible ? 'Hide Hiraganized' : 'Show Hiraganized',
      click: () => { isVisible ? mainWindow?.hide() : showMainWindow(); }
    },
    { type: 'separator' },
    { label: 'Exit Hiraganized', click: quitApp }
  ]));
}

// --- Shortcuts ---

function registerShortcuts() {
  globalShortcut.unregisterAll();

  const captureKey = settings.shortcuts?.triggerCapture || 'CommandOrControl+Shift+K';
  try {
    const registered = globalShortcut.register(captureKey, () => {
      triggerCapture();
    });
    if (!registered) logger?.warn('Failed to register capture hotkey', { key: captureKey });
  } catch {
    logger?.warn('Failed to register capture hotkey', { key: captureKey });
  }
}

// --- IPC handlers ---

/**
 * Sync the "Launch on startup" OS login item with the setting. When enabled the
 * app is added to Windows startup (HKCU Run key) and launched with `--hidden`
 * so the "Start minimized" setting can suppress the window on boot.
 */
function applyLoginItemSettings() {
  try {
    const enabled = settings.general?.launchOnStartup === true;
    app.setLoginItemSettings(enabled
      ? { openAtLogin: true, args: ['--hidden'] }
      : { openAtLogin: false });
  } catch (err) {
    logger?.warn('Failed to update login item', { error: err.message });
  }
}

/** True when this launch was an automatic startup with the --hidden flag. */
function startedFromStartup() {
  return process.argv.includes('--hidden');
}

function setupIpc() {
  ipcMain.handle('app:update-settings', (_event, patch) => {
    if (typeof patch !== 'object' || !patch) return { ok: false };
    settings = configStore.update(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'advanced') && Object.prototype.hasOwnProperty.call(patch.advanced, 'logging')) {
      logger?.setEnabled(settings.advanced.logging);
    }
    if (Object.prototype.hasOwnProperty.call(patch.general || {}, 'launchOnStartup')) {
      applyLoginItemSettings();
    }
    if (Object.prototype.hasOwnProperty.call(patch.shortcuts || {}, 'triggerCapture')) {
      registerShortcuts();
    }
    refreshTrayMenu();
    publishState();
    return { ok: true };
  });
  ipcMain.handle('app:hide-window', () => { mainWindow?.hide(); showTrayBackgroundNotification(); refreshTrayMenu(); });
  ipcMain.handle('app:minimize-window', () => mainWindow?.minimize());
  ipcMain.handle('ocr:cancel', () => {
    cancelSetup();
    state.ocrStatus = { available: false, message: 'OCR setup cancelled' };
    publishState();
    return { ok: true };
  });
  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url !== 'string') return;
    // Only allow http(s) — never file:, shell:, etc.
    if (!/^https?:\/\//i.test(url)) return;
    try { await shell.openExternal(url); } catch {}
  });
  ipcMain.on('selection:commit', (_event, bounds) => {
    const origin = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : { x: 0, y: 0 };
    const globalBounds = bounds && {
      x: Number(bounds.x) + origin.x,
      y: Number(bounds.y) + origin.y,
      width: Number(bounds.width),
      height: Number(bounds.height)
    };
    handleSelection(globalBounds);
  });
  ipcMain.on('selection:cancel', () => {
    captureInProgress = false;
    destroyOverlay();
  });
}

function quitApp() {
  isQuitting = true;
  saveWindowState();
  hidePopup();
  destroyOverlay();
  globalShortcut.unregisterAll();
  stopOcr();
  tryCleanup();
  configStore?.save(); // flush debounced settings
  dictionary?.flush(); // flush debounced dictionary cache
  logger?.info('Application shutting down');
  logger?.close();
  app.quit();
}

// --- Single instance ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => showMainWindow());

// --- App lifecycle ---

app.whenReady().then(async () => {
  app.setAppUserModelId('Hiraganized');
  configStore = new ConfigStore(path.join(app.getPath('userData'), 'settings.json'), cloneDefaults());
  settings = configStore.load();
  logger = new Logger(app.getPath('logs'), settings.advanced?.logging !== false);
  dictionary = new DictionaryService(path.join(app.getPath('userData'), 'dictionary-cache.json')).load();

  applyLoginItemSettings(); // sync the OS startup entry with the saved setting

  createMainWindow();

  setSetupCallbacks({
    onStart: () => {
      mainWindow?.webContents.send('ocr:setup-start');
    },
    onProgress: (data) => {
      mainWindow?.webContents.send('ocr:setup-progress', data);
    },
    onDone: () => {
      mainWindow?.webContents.send('ocr:setup-done');
    }
  });

  buildTray();
  registerShortcuts();
  setupIpc();

  mainWindow.webContents.once('did-finish-load', () => ensureOcrStarted());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
