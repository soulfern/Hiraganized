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

if (process.argv.includes('--uninstall')) {
  const { runUninstaller } = require('./uninstaller');
  runUninstaller();
  return;
}

const POPUP_WIDTH = 310;
const POPUP_HEIGHT = 200;
const MAIN_WINDOW_WIDTH = 520;
const MAIN_WINDOW_HEIGHT = 460;
const MAIN_WINDOW_MIN_WIDTH = 520;
const MAIN_WINDOW_MIN_HEIGHT = 460;

let tray = null;
let mainWindow = null;
let overlayWindow = null;
let popupWindow = null;

let logsWindow = null;
let activePopups = [];
let settings = {};
let configStore = null;
let dictionary = null;
let logger = null;
let isQuitting = false;
let captureInProgress = false;
let captureTimeout = null;
let trayNotifiedOnce = false;

function releaseCapture() {
  if (captureTimeout) { clearTimeout(captureTimeout); captureTimeout = null; }
  captureInProgress = false;
}
let cachedAppIcon = null;
let windowStateSaveTimer = null;
let logsUnsubscribe = null;

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
    const dir = path.join(root, 'assets');
    // Prefer the full-res icon for window/tray quality; Electron scales it.
    const p = path.join(dir, 'icon.png');
    if (fs.existsSync(p)) return (cachedAppIcon = nativeImage.createFromPath(p));
    const sizes = [64, 48, 32, 16];
    for (const size of sizes) {
      const sp = path.join(dir, `icon${size}.png`);
      if (fs.existsSync(sp)) return (cachedAppIcon = nativeImage.createFromPath(sp));
    }
    const ico = path.join(dir, 'icon.ico');
    if (fs.existsSync(ico)) return (cachedAppIcon = nativeImage.createFromPath(ico));
  } catch {}
  return nativeImage.createEmpty();
}

let captureEpoch = 0;

async function triggerCapture() {
  if (captureInProgress) return { ok: false, reason: 'busy' };
  captureInProgress = true;
  captureEpoch += 1;
  // Safety: if the overlay is shown but the user never selects or presses Esc,
  // auto-release the busy latch so the hotkey stays usable.
  captureTimeout = setTimeout(() => { captureInProgress = false; }, 60000);
  try {

    const magnifierEnabled = settings.general?.magnifier !== false;
    const framesPromise = magnifierEnabled
      ? getScreenFrames().then((frames) => frames.map((f) => ({
          dataUrl: f.dataUrl,
          displayBounds: f.displayBounds,
          thumbnailWidth: f.thumbnailWidth,
          thumbnailHeight: f.thumbnailHeight
        })))
      : Promise.resolve(null);

    createOverlayWindow();
    const frames = await framesPromise;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const send = () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay:image', { frames, magnifier: magnifierEnabled });
        }
      };
      if (overlayWindow.webContents.isLoading()) {
        overlayWindow.webContents.once('did-finish-load', send);
        // A failed overlay load must not strand the capture forever.
        overlayWindow.webContents.once('did-fail-load', () => {
          destroyOverlay();
          releaseCapture();
        });
      } else send();
    }
    return { ok: true };
  } catch (error) {

    destroyOverlay();
    releaseCapture();
    return { ok: false, error: error.message };
  }
}

async function handleSelection(bounds) {
  const epoch = captureEpoch;
  await destroyOverlay();
  if (!bounds || bounds.width < 10 || bounds.height < 10) {
    releaseCapture();
    return;
  }
  if (epoch !== captureEpoch) return;

  let tempPath = null;
  try {

    // Give the compositor time to drop the hidden overlay from the desktop
    // frame, even when the user set capture delay to 0 — otherwise the dim
    // overlay can appear inside the captured region.
    const delay = Math.max(Number(settings.general?.captureDelayMs) || 0, 50);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (epoch !== captureEpoch) return;
    const frames = await getScreenFrames({ maxWidth: 3840, preferredDisplayBounds: bounds });
    if (epoch !== captureEpoch) return;

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
    if (epoch !== captureEpoch) return;

    logger?.info(`OCR: "${text}"`);

    if (!text) {
      showWarningPopup('No text detected\nTry a tighter, higher-contrast selection.', bounds);
      return;
    }

    if (dictionary) {
      const chars = dictionary.extractKanji(text);
      const seqs = dictionary.extractSequences(text);

      const maxKanji = settings.general?.maxKanjiLimit ?? 10;
      if (chars.length > maxKanji) {
        showMainWindow();
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Too many kanji',
          message: `Selected region contains ${chars.length} kanji (max ${maxKanji}). Please select a smaller region.`
        });
        logger?.info(`Capture rejected: ${chars.length} kanji exceeds limit of ${maxKanji}`);
        return;
      }

      if (chars.length === 0) {
        showWarningPopup('No kanji detected', bounds);
        return;
      }

      const entries = [];

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
      const remaining = chars.filter((char) => !seen.has(char));
      const lookupResults = await Promise.all(remaining.map((char) => dictionary.lookup(char)));
      for (let i = 0; i < remaining.length; i++) {
        seen.add(remaining[i]);
        if (lookupResults[i]) entries.push(lookupResults[i]);
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
    releaseCapture();
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

let overlayReady = false;

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:reset');
    overlayWindow.showInactive();
    overlayWindow.focus();
    return;
  }
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

  const win = overlayWindow;
  win.once('ready-to-show', () => {
    if (overlayWindow !== win) return;
    overlayReady = true;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
    win.focus();
    win.setVisibleOnAllWorkspaces(true);
  });

  win.on('closed', () => {
    overlayReady = false;
    if (overlayWindow === win) overlayWindow = null;
  });
}

function destroyOverlay() {
  const win = overlayWindow;
  if (!win || win.isDestroyed()) {
    overlayWindow = null;
    return Promise.resolve();
  }
  win.hide();
  return Promise.resolve();
}

function popupBounds(pos, { width = POPUP_WIDTH, height = POPUP_HEIGHT } = {}) {
  const scaled = scaledPopupSize(width, height);
  width = scaled.width;
  height = scaled.height;
  const display = pos ? screen.getDisplayNearestPoint({ x: pos.x, y: pos.y }) : screen.getPrimaryDisplay();
  const area = display.workArea;

  let x, y;
  if (pos) {
    x = Math.round(pos.x - width / 2);
    y = Math.round(pos.y + 10);

    if (y + height > area.y + area.height) y = Math.round(pos.y - height - 10);
    if (x + width > area.x + area.width) x = area.x + area.width - width - 4;
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - width - 4));
    y = Math.max(area.y + 4, Math.min(y, area.y + area.height - height - 4));
  } else {
    x = area.x + Math.round((area.width - width) / 2);
    y = area.y + Math.round((area.height - height) / 2);
  }

  return { x, y, width, height };
}

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
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  popupWindow.setMenuBarVisibility(false);
  popupWindow.loadFile(path.join(__dirname, '../renderer/popup.html'));

  const win = popupWindow;
  win.on('closed', () => {
    clearAutoDismissTimer();

    if (popupWindow === win) popupWindow = null;
    activePopups = [];
    state.popupVisible = false;
    publishState();
  });

  popupWindow.webContents.once('did-finish-load', () => publishState());

  return popupWindow;
}

let autoDismissTimer = null;

function clearAutoDismissTimer() {
  if (autoDismissTimer) { clearTimeout(autoDismissTimer); autoDismissTimer = null; }
}

function armAutoDismiss() {
  clearAutoDismissTimer();
  const seconds = Number(settings.general?.autoDismissSeconds) || 0;
  if (seconds > 0) {
    autoDismissTimer = setTimeout(() => {
      autoDismissTimer = null;
      hidePopup();
    }, seconds * 1000);
  }
}

function scaledPopupSize(baseW, baseH) {
  const s = Number(settings.appearance?.fontScale) || 1;
  return { width: Math.round(baseW * s), height: Math.round(baseH * s) };
}

function sendToPopup(channel, payload, bounds, { width = POPUP_WIDTH, height = POPUP_HEIGHT } = {}) {
  // width/height are already scale-adjusted by callers (popupBounds for the
  // kanji path, scaledPopupSize for OCR/warning) — do not scale again here.
  const win = getPopupWindow(bounds, { width, height });
  const send = () => {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, payload);
    win.setOpacity(Math.max(0.3, Math.min(1, Number(settings.notifications?.opacity) / 100)));
    win.showInactive();
    win.setAlwaysOnTop(true, 'floating');

    armAutoDismiss();
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);

    win.webContents.once('did-fail-load', send);
  } else {
    send();
  }
  activePopups = [{ win }];
  state.popupVisible = true;
  publishState();
}

function showKanjiPopup(entries, position) {
  if (!entries.length) return;

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
  clearAutoDismissTimer();
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
  activePopups = [];
  state.popupVisible = false;
  publishState();
}

function showOcrPopup(text, bounds) {
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  });

  const { width: pw, height: ph } = scaledPopupSize(320, 140);

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

  const { width: pw, height: ph } = scaledPopupSize(300, 120);

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

let windowState = { width: MAIN_WINDOW_WIDTH, height: MAIN_WINDOW_HEIGHT };
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function saveWindowState() {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    windowState = { width: bounds.width, height: bounds.height };
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
      if (data && typeof data === 'object') {
        windowState.width = data.width;
        windowState.height = data.height;
      }
    }
  } catch {}

  const area = screen.getPrimaryDisplay().workArea;
  windowState.width = Math.min(area.width, Math.max(MAIN_WINDOW_MIN_WIDTH, Number(windowState.width) || MAIN_WINDOW_WIDTH));
  windowState.height = Math.min(area.height, Math.max(MAIN_WINDOW_MIN_HEIGHT, Number(windowState.height) || MAIN_WINDOW_HEIGHT));
}

function createMainWindow() {
  restoreWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width || MAIN_WINDOW_WIDTH,
    height: windowState.height || MAIN_WINDOW_HEIGHT,
    center: true,
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
    if (startHidden) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
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

function createLogsWindow() {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.show();
    logsWindow.focus();
    return;
  }
  logsWindow = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 480,
    minHeight: 300,
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
  logsWindow.setMenuBarVisibility(false);
  logsWindow.loadFile(path.join(__dirname, '../renderer/logs.html'));

  logsWindow.once('ready-to-show', () => {
    if (logsWindow && !logsWindow.isDestroyed()) logsWindow.show();
  });

  logsWindow.webContents.once('did-finish-load', () => publishState());

  const win = logsWindow;
  win.on('closed', () => {

    if (logsWindow === win) logsWindow = null;
    if (logsUnsubscribe) { logsUnsubscribe(); logsUnsubscribe = null; }
    if (settings.debug?.showLogs) {
      settings = configStore.update({ debug: { showLogs: false } });
      publishState();
    }
  });

  logsUnsubscribe = logger.onLine((line) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('logs:line', line);
    }
  });
  const recentLines = logger.recent(200);
  const sendRecent = () => {
    if (win && !win.isDestroyed()) {
      for (const line of recentLines) win.webContents.send('logs:line', line);
    }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', sendRecent);
  else sendRecent();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  trayNotifiedOnce = false;

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  refreshTrayMenu();
}

function showTrayBackgroundNotification() {
  if (trayNotifiedOnce) return;

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

function startedFromStartup() {
  return process.argv.includes('--hidden');
}

function setupIpc() {
  ipcMain.handle('app:update-settings', (event, patch) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
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
    if (Object.prototype.hasOwnProperty.call(patch.notifications || {}, 'opacity')) {

      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.setOpacity(Math.max(0.3, Math.min(1, Number(settings.notifications?.opacity) / 100)));
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch.debug || {}, 'showLogs')) {
      if (settings.debug.showLogs) createLogsWindow();
      else if (logsWindow && !logsWindow.isDestroyed()) logsWindow.close();
    }
    refreshTrayMenu();
    publishState();
    return { ok: true };
  });
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:reset-settings', () => {
    settings = configStore.reset();

    if (logsWindow && !logsWindow.isDestroyed()) logsWindow.close();
    applyLoginItemSettings();
    registerShortcuts();
    refreshTrayMenu();
    publishState();
    return { ok: true };
  });
  ipcMain.handle('dictionary:clear-cache', () => {
    dictionary?.clearCache();
    logger?.info('Dictionary cache cleared');
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

    if (!/^https?:\/\//i.test(url)) return;

    try { await shell.openExternal(url); } catch {}
  });
  ipcMain.on('selection:commit', (event, bounds) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return;
    const origin = overlayWindow.getBounds();
    const globalBounds = bounds && {
      x: Number(bounds.x) + origin.x,
      y: Number(bounds.y) + origin.y,
      width: Number(bounds.width),
      height: Number(bounds.height)
    };
    handleSelection(globalBounds);
  });
  ipcMain.on('selection:cancel', (event) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return;
    releaseCapture();
    destroyOverlay();
  });
  ipcMain.on('app:close-logs', (event) => {
    if (!logsWindow || logsWindow.isDestroyed() || event.sender !== logsWindow.webContents) return;
    logsWindow.close();
  });
  ipcMain.on('popup:resize', (event, height) => {
    if (!popupWindow || popupWindow.isDestroyed() || event.sender !== popupWindow.webContents) return;
    const h = Math.max(60, Math.min(600, Math.round(Number(height) || 0)));
    const b = popupWindow.getBounds();
    popupWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
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
  configStore?.save();

  dictionary?.flush();

  logger?.info('Application shutting down');
  logger?.close();
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => showMainWindow());

app.whenReady().then(async () => {
  app.setAppUserModelId('Hiraganized');
  configStore = new ConfigStore(path.join(app.getPath('userData'), 'settings.json'), cloneDefaults());
  settings = configStore.load();

  if (settings.debug?.showLogs) {
    settings = configStore.update({ debug: { showLogs: false } });
  }
  logger = new Logger(app.getPath('logs'), settings.advanced?.logging !== false);
  dictionary = new DictionaryService(path.join(app.getPath('userData'), 'dictionary-cache.json')).load();

  applyLoginItemSettings();

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

app.on('window-all-closed', () => {
  if (!isQuitting) quitApp();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
