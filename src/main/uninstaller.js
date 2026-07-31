const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

let uninstallWindow = null;

/** Resolve every path the uninstaller may touch. */
function getPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const home = process.env.USERPROFILE || os.homedir();
  return {
    // Where Hiraganized.exe actually lives (e.g. C:\Program Files\Hiraganized).
    installDir: path.dirname(process.execPath),
    userData: app.getPath('userData'),
    desktopLnk: path.join(home, 'Desktop', 'Hiraganized.lnk'),
    startMenuLnk: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hiraganized.lnk'),
    python: path.join(localAppData, 'Programs', 'Python', 'Python312'),
    modelCache: path.join(home, '.cache', 'huggingface', 'hub', 'models--kha-white--manga-ocr-base'),
    regKey: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hiraganized'
  };
}

function iconPath() {
  const p = path.resolve(__dirname, '..', '..', 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function psEscape(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Build the elevated cleanup script. It runs AFTER this process quits: it waits
 * for Hiraganized to exit, force-kills any stragglers (so file/registry locks
 * release), then removes the chosen targets and finally deletes itself.
 */
function buildCleanupScript(p, options) {
  const L = [];
  L.push('$ErrorActionPreference = "SilentlyContinue"');
  // Wait up to ~15s for Hiraganized processes to exit on their own.
  L.push('for ($i=0; $i -lt 30; $i++) { if (-not (Get-Process -Name "Hiraganized" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }');
  L.push('taskkill /F /IM "Hiraganized.exe" 2>$null | Out-Null');
  L.push('Start-Sleep -Milliseconds 800');
  // App files (retry: the exe lock can linger briefly after exit).
  L.push(`$app = '${psEscape(p.installDir)}'`);
  L.push('for ($i=0; $i -lt 10; $i++) { if (-not (Test-Path -LiteralPath $app)) { break }; Remove-Item -LiteralPath $app -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }');
  // Shortcuts.
  L.push(`Remove-Item -LiteralPath '${psEscape(p.desktopLnk)}' -Force -ErrorAction SilentlyContinue`);
  L.push(`Remove-Item -LiteralPath '${psEscape(p.startMenuLnk)}' -Force -ErrorAction SilentlyContinue`);
  // Registry entry (removes it from "Installed apps").
  L.push(`Remove-Item -Path '${psEscape(p.regKey)}' -Recurse -Force -ErrorAction SilentlyContinue`);
  if (options.settings) {
    L.push(`Remove-Item -LiteralPath '${psEscape(p.userData)}' -Recurse -Force -ErrorAction SilentlyContinue`);
  }
  if (options.ocr) {
    L.push(`Remove-Item -LiteralPath '${psEscape(p.python)}' -Recurse -Force -ErrorAction SilentlyContinue`);
    L.push(`Remove-Item -LiteralPath '${psEscape(p.modelCache)}' -Recurse -Force -ErrorAction SilentlyContinue`);
  }
  // Self-delete the cleanup script.
  L.push('Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue');
  return L.join('\r\n');
}

function createUninstallWindow() {
  uninstallWindow = new BrowserWindow({
    width: 520,
    height: 420,
    frame: false,
    resizable: false,
    backgroundColor: '#1e1e1e',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'uninstall-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  uninstallWindow.loadFile(path.join(__dirname, '..', 'renderer', 'uninstall.html'));
  uninstallWindow.on('closed', () => {
    uninstallWindow = null;
  });
}

async function executeUninstall(options) {
  const p = getPaths();
  const scriptContent = buildCleanupScript(p, options);
  const scriptPath = path.join(require('os').tmpdir(), `hiraganized-uninstall-${Date.now()}.ps1`);

  try {
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  } catch (error) {
    return { success: false, error: `Failed to write cleanup script: ${error.message}` };
  }

  // Launch the elevated cleanup script detached (it waits for us to exit, then cleans up).
  // Use Start-Process with -Verb RunAs for elevation; -WindowStyle Hidden keeps it quiet.
  const launchPs1 = `Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${psEscape(scriptPath)}') -Verb RunAs -WindowStyle Hidden`;
  const launchScriptPath = path.join(require('os').tmpdir(), `hiraganized-launch-${Date.now()}.ps1`);

  try {
    fs.writeFileSync(launchScriptPath, launchPs1, 'utf8');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    // Give it a moment to spawn, then quit so the cleanup script can proceed.
    setTimeout(() => app.quit(), 800);
    return { success: true };
  } catch (error) {
    try { fs.unlinkSync(scriptPath); } catch (_) {}
    try { fs.unlinkSync(launchScriptPath); } catch (_) {}
    return { success: false, error: `Failed to launch cleanup: ${error.message}` };
  }
}

function setupUninstallIpc() {
  ipcMain.handle('uninstall:get-paths', () => {
    const p = getPaths();
    const sizes = {};
    try {
      const getSize = (dir) => {
        if (!fs.existsSync(dir)) return 0;
        let total = 0;
        const walk = (d) => {
          const entries = fs.readdirSync(d, { withFileTypes: true });
          for (const e of entries) {
            const fullPath = path.join(d, e.name);
            if (e.isDirectory()) walk(fullPath);
            else if (e.isFile()) {
              try { total += fs.statSync(fullPath).size; } catch (_) {}
            }
          }
        };
        walk(dir);
        return total;
      };
      sizes.app = getSize(p.installDir);
      sizes.userData = getSize(p.userData);
      sizes.python = getSize(p.python);
      sizes.modelCache = getSize(p.modelCache);
    } catch (_) {}
    return { paths: p, sizes };
  });

  ipcMain.handle('uninstall:execute', async (_event, options) => {
    return executeUninstall(options);
  });
}

function runUninstaller() {
  // Skip single-instance lock for uninstaller mode.
  app.whenReady().then(() => {
    createUninstallWindow();
    setupUninstallIpc();
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { runUninstaller };
