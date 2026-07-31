const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const https = require('https');

let logFile;
function log(...args) {
  if (!logFile) return;
  const msg = args.join(' ');
  try { fs.appendFileSync(logFile, msg + '\n', 'utf8'); } catch (_) {}
  console.log(msg);
}

let setupWindow;
let cancelled = false;
let activeProcess = null;
let activeRequest = null;

function createWindow() {
  setupWindow = new BrowserWindow({
    width: 680,
    height: 520,
    frame: false,
    resizable: false,
    backgroundColor: '#080808',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  logFile = path.join(app.getPath('temp'), 'hiraganized-install.log');
  try { fs.writeFileSync(logFile, `=== Install log ${new Date().toISOString()} ===\n`, 'utf8'); } catch (_) {}
  createWindow();
});

app.on('window-all-closed', () => app.quit());

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// IPC: select install directory
ipcMain.handle('install:select-dir', async () => {
  const def = 'C:\\Program Files\\Hiraganized';
  const result = await dialog.showOpenDialog(setupWindow, {
    title: 'Select Installation Directory',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: def,
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: run installation
ipcMain.handle('install:run', async (_event, installDir) => {
  cancelled = false;
  const win = setupWindow;
  const previousNoAsar = process.noAsar;

  function send(ev, data) {
    if (!cancelled && !win.isDestroyed()) win.webContents.send(ev, data);
  }

  function progress(step, pct, label, detail) {
    send('install:progress', { step, pct, label, detail });
  }

  try {
    process.noAsar = true;

    // Step 0 - Copy app files
    log('=== Install starting ===');
    log('installDir:', installDir);
    progress(0, 0, 'Copying application files', 'Preparing files');

    const sourceDir = path.dirname(app.getPath('exe'));
    log('sourceDir:', sourceDir);

    if (fs.existsSync(installDir)) {
      log('Target exists - removing old install');
      try {
        fs.rmSync(installDir, { recursive: true, force: true });
      } catch (e) {
        log('Old install cleanup warning:', e.code, e.message);
      }
    }
    fs.mkdirSync(installDir, { recursive: true });

    const entries = fs.readdirSync(sourceDir);
    log('sourceDir entries:', entries.join(', '));
    const total = entries.length;

    for (let i = 0; i < entries.length; i++) {
      if (cancelled) return { cancelled: true };
      const name = entries[i];
      if (name === 'Hiraganized Installer.exe') {
        // Skip - copy main app's exe below
      } else {
        copyRecursiveSync(path.join(sourceDir, name), path.join(installDir, name));
      }
      progress(0, Math.round(((i + 1) / total) * 100), 'Copying application files', name);
    }

    const bundledExe = path.join(process.resourcesPath, 'bundled-app', 'Hiraganized.exe');
    const targetExe = path.join(installDir, 'Hiraganized.exe');
    log('bundledExe:', bundledExe, 'exists:', fs.existsSync(bundledExe));
    if (!fs.existsSync(bundledExe)) throw new Error('Bundled Hiraganized.exe is missing');
    fs.copyFileSync(bundledExe, targetExe);
    log('Copied bundled exe');

    // Copy bundled app asar
    const bundledAsar = path.join(process.resourcesPath, 'bundled-app', 'app.asar');
    const targetAsar = path.join(installDir, 'resources', 'app.asar');
    if (!fs.existsSync(bundledAsar)) throw new Error('Bundled app.asar is missing');
    fs.mkdirSync(path.join(installDir, 'resources'), { recursive: true });
    if (fs.existsSync(targetAsar)) fs.rmSync(targetAsar, { recursive: true, force: true });
    fs.copyFileSync(bundledAsar, targetAsar);
    fs.rmSync(path.join(installDir, 'resources', 'bundled-app'), { recursive: true, force: true });
    log('Copied bundled app.asar and removed staging payload');

    progress(0, 100, 'Application files copied', '');

    // Step 1 - Python
    const pythonExe = await ensurePython(progress);

    // Step 2 - manga-ocr
    await installMangaOcr(pythonExe, progress);

    // Step 3 - Shortcuts
    createShortcuts(installDir, progress);

    log('=== Install completed successfully ===');
    return { success: true, installDir };
  } catch (error) {
    log('Install failed:', error.message);
    return { success: false, error: error.message, cancelled: false };
  } finally {
    activeProcess = null;
    activeRequest = null;
    process.noAsar = previousNoAsar;
  }
});

// IPC: cancel
ipcMain.handle('install:cancel', () => {
  cancelled = true;
  if (activeRequest) activeRequest.destroy(new Error('Installation cancelled'));
  if (activeProcess) {
    try { activeProcess.kill(); } catch (_) {}
  }
  log('Installation cancelled');
  return { ok: true };
});

// IPC: launch app
ipcMain.handle('install:launch-app', (_event, installDir) => {
  const exe = path.join(installDir, 'Hiraganized.exe');
  if (fs.existsSync(exe)) {
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  }
  app.quit();
});

// --- File helpers ---

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRecursiveSync(src, dest) {
  let stat;
  try { stat = fs.lstatSync(src); } catch (error) {
    throw new Error(`Cannot inspect ${src}: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    log('Skipping symlink:', src);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    copyFileSync(src, dest);
  } else {
    log('Skipping special file:', src);
  }
}

function pythonExePath() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total && onProgress) onProgress(Math.round((downloaded / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => { activeRequest = null; file.close(); resolve(); });
    });
    activeRequest = request;
    request.on('timeout', () => request.destroy(new Error('Download timed out')));
    request.on('error', (err) => {
      activeRequest = null;
      file.close();
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

async function ensurePython(progress) {
  const existing = pythonExePath();
  if (existing) {
    progress(1, 100, 'Python found', existing);
    return existing;
  }

  progress(1, 5, 'Downloading Python 3.12.9', 'Connecting');

  const url = 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe';
  const tmp = path.join(app.getPath('temp'), 'python-3.12.9-amd64.exe');

  await downloadFile(url, tmp, (pct) => {
    progress(1, Math.round(pct * 0.7), 'Downloading Python 3.12.9', `${pct}%`);
  });

  progress(1, 75, 'Installing Python', 'Running installer');

  const targetDir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312');

  await new Promise((resolve, reject) => {
    const proc = spawn(tmp, [
      '/quiet',
      'InstallAllUsers=0',
      'PrependPath=1',
      'Include_pip=1',
      `TargetDir=${targetDir}`,
    ], { stdio: 'ignore', timeout: 120000 });
    activeProcess = proc;
    proc.on('close', (code) => {
      activeProcess = null;
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (code === 0) resolve();
      else reject(new Error(`Python installer exited with code ${code}`));
    });
    proc.on('error', reject);
  });

  progress(1, 100, 'Python installed', targetDir);

  const installed = path.join(targetDir, 'python.exe');
  return installed;
}

async function installMangaOcr(pythonExe, progress) {
  log('Python:', pythonExe);
  try {
    const info = execFileSync(pythonExe, ['-c', 'import sys, pip; print(sys.version); print("pip", pip.__version__)'], {
      windowsHide: true, encoding: 'utf8', timeout: 15000
    }).trim();
    log(info.replace(/\r?\n/g, ' | '));
  } catch (error) {
    throw new Error(`Python does not have working pip: ${error.message}`);
  }

  try {
    execFileSync(pythonExe, ['-c', 'from importlib.metadata import version; [version(p) for p in ("manga-ocr", "torch", "transformers", "Pillow")]'], {
      windowsHide: true, stdio: 'pipe', timeout: 15000
    });
    progress(2, 100, 'manga-ocr ready', 'Existing installation verified');
    log('Existing manga-ocr installation verified');
    return;
  } catch (_) {}

  progress(2, 0, 'Installing manga-ocr', 'Starting');

  await new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'manga-ocr==0.1.16'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1800000,
    });
    activeProcess = proc;

    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
      log(data.toString().trim());
      const lines = output.split('\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      progress(2, -1, 'Installing manga-ocr', last.substring(0, 100));
    });
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      output = (output + text).slice(-12000);
      log(text.trim());
      progress(2, -1, 'Installing manga-ocr', text.substring(0, 100));
    });

    proc.on('close', (code) => {
      activeProcess = null;
      if (code === 0) resolve();
      else {
        const detail = output.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`pip install failed (exit ${code})${detail ? `:\n${detail}` : ''}`));
      }
    });
    proc.on('error', reject);
  });

  progress(2, 100, 'manga-ocr installed', '');
}

function createShortcuts(installDir, progress) {
  const exe = path.join(installDir, 'Hiraganized.exe');
  const desktopLnk = path.join(process.env.USERPROFILE || '', 'Desktop', 'Hiraganized.lnk');
  const startMenuLnk = path.join(
    process.env.APPDATA || '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hiraganized.lnk'
  );

  const ps1 = path.join(app.getPath('temp'), 'hiraganized-shortcuts.ps1');
  const code = `
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut('${psEscape(desktopLnk)}')
    $s.TargetPath = '${psEscape(exe)}'
    $s.Description = 'Hiraganized - Instant kanji context for Windows'
    $s.Save()
    $s2 = $ws.CreateShortcut('${psEscape(startMenuLnk)}')
    $s2.TargetPath = '${psEscape(exe)}'
    $s2.Description = 'Hiraganized - Instant kanji context for Windows'
    $s2.Save()
  `.trim();

  progress(3, 30, 'Creating shortcuts', 'Desktop');
  try {
    fs.writeFileSync(ps1, code, 'utf8');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { timeout: 15000 });
    fs.unlinkSync(ps1);
  } catch (_) {
    try { fs.unlinkSync(ps1); } catch (_) {}
  }
  progress(3, 100, 'Shortcuts created', '');
}

function psEscape(s) {
  return String(s).replace(/'/g, "''");
}
