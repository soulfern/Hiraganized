const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

let uninstallWindow = null;

function getPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const home = process.env.USERPROFILE || os.homedir();
  return {


    installDir: path.dirname(process.execPath),
    userData: app.getPath('userData'),
    desktopLnk: path.join(home, 'Desktop', 'Hiraganized.lnk'),
    startMenuLnk: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hiraganized.lnk'),
    python: path.join(localAppData, 'Programs', 'Python', 'Python312'),
    modelCache: path.join(home, '.cache', 'huggingface', 'hub', 'models--kha-white--manga-ocr-base'),
    regKey: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hiraganized',
    markerPath: path.join(require('os').tmpdir(), `hiraganized-uninstall-${crypto.randomUUID()}.marker`)
  };
}

function iconPath() {
  const p = path.resolve(__dirname, '..', '..', 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function psEscape(s) {
  return String(s).replace(/'/g, "''");
}


function buildCleanupScript(p, options) {
  const L = [];
  L.push('$ErrorActionPreference = "SilentlyContinue"');

  L.push('for ($i=0; $i -lt 30; $i++) { if (-not (Get-Process -Name "Hiraganized" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }');
  L.push('taskkill /F /IM "Hiraganized.exe" 2>$null | Out-Null');
  L.push('Start-Sleep -Milliseconds 800');

  L.push(`$app = '${psEscape(p.installDir)}'`);
  L.push('for ($i=0; $i -lt 10; $i++) { if (-not (Test-Path -LiteralPath $app)) { break }; Remove-Item -LiteralPath $app -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }');

  L.push(`Remove-Item -LiteralPath '${psEscape(p.desktopLnk)}' -Force -ErrorAction SilentlyContinue`);
  L.push(`Remove-Item -LiteralPath '${psEscape(p.startMenuLnk)}' -Force -ErrorAction SilentlyContinue`);

  L.push(`Remove-Item -Path '${psEscape(p.regKey)}' -Recurse -Force -ErrorAction SilentlyContinue`);
  if (options.settings) {
    L.push(`Remove-Item -LiteralPath '${psEscape(p.userData)}' -Recurse -Force -ErrorAction SilentlyContinue`);
  }
  if (options.ocr) {
    L.push(`Remove-Item -LiteralPath '${psEscape(p.python)}' -Recurse -Force -ErrorAction SilentlyContinue`);
    L.push(`Remove-Item -LiteralPath '${psEscape(p.modelCache)}' -Recurse -Force -ErrorAction SilentlyContinue`);
  }


  L.push(`New-Item -ItemType File -Path '${psEscape(p.markerPath)}' -Force | Out-Null`);

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




  const workDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hiraganized-uninstall-'));
  const scriptPath = path.join(workDir, 'cleanup.ps1');
  const launchScriptPath = path.join(workDir, 'launch.ps1');

  try {
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: `Failed to write cleanup script: ${error.message}` };
  }



  const launchPs1 = `Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${psEscape(scriptPath)}') -Verb RunAs -WindowStyle Hidden`;
  fs.writeFileSync(launchScriptPath, launchPs1, 'utf8');

  try {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (error) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: `Failed to launch cleanup: ${error.message}` };
  }




  let started = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (fs.existsSync(p.markerPath)) { started = true; break; }
    if (i === 59) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      return { success: false, error: 'Elevation declined. Uninstall was not started.' };
    }
  }

  if (!started) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: 'Elevation declined. Uninstall was not started.' };
  }

  // Clean up our temp artifacts (marker + workDir incl. launch.ps1).
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.unlinkSync(p.markerPath); } catch (_) {}

  setTimeout(() => app.quit(), 800);
  return { success: true };
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
  // Silent path (QuietUninstallString: --uninstall --quiet): run cleanup with
  // default options (keep settings + OCR) and exit without a window.
  if (process.argv.includes('--quiet')) {
    app.whenReady().then(async () => {
      const result = await executeUninstall({ settings: false, ocr: false });
      app.exit(result?.success ? 0 : 1);
    });
    return;
  }

  app.whenReady().then(() => {
    createUninstallWindow();
    setupUninstallIpc();
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { runUninstaller };
