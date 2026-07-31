const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { nativeImage } = require('electron');

const PYTHON_VERSION = '3.12.9';
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`;
const PYTHON_INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Python', 'Python312');
const PYTHON_EXE = path.join(PYTHON_INSTALL_DIR, 'python.exe');
const OCR_LOG_PATH = path.join(os.tmpdir(), 'hiraganized-ocr.log');

const PYTHON_SCRIPT = `
import sys, json, signal, traceback
def main():
    _sys = sys; _json = json; _signal = signal
    _sys.stdout.reconfigure(line_buffering=True)
    shutting_down = False
    def _handler(s, f):
        nonlocal shutting_down; shutting_down = True; _sys.exit(0)
    _signal.signal(_signal.SIGTERM, _handler)
    _signal.signal(_signal.SIGINT, _handler)
    try:
        from manga_ocr import MangaOcr
        mocr = MangaOcr()
        _sys.stdout.write(_json.dumps({"status": "ready"}) + "\\n")
        _sys.stdout.flush()
        for _line in _sys.stdin:
            if shutting_down: break
            _line = _line.strip()
            if not _line: continue
            try:
                _req = _json.loads(_line)
                _path = _req.get("path")
                if not _path:
                    _sys.stdout.write(_json.dumps({"ok": False, "error": "No path provided"}) + "\\n")
                    _sys.stdout.flush()
                    continue
                _text = mocr(_path)
                _sys.stdout.write(_json.dumps({"ok": True, "text": _text or ""}) + "\\n")
                _sys.stdout.flush()
            except Exception as _e:
                _sys.stdout.write(_json.dumps({"ok": False, "error": str(_e)}) + "\\n")
                _sys.stdout.flush()
    except Exception as _e:
        _sys.stdout.write(_json.dumps({"status": "error", "error": type(_e).__name__ + ": " + str(_e)}) + "\\n")
        _sys.stdout.flush()
        traceback.print_exc(file=_sys.stderr)
if __name__ == "__main__":
    main()
`.trim();

let proc = null;
let ready = false;
let pending = null;
let stdoutBuf = '';
let scriptPath = null;
let starting = false;
let startError = null;
let cancelled = false;
let installProc = null;
let pythonInstallerProc = null;
let startupWaiter = null;

function logOcr(message) {
  try { fs.appendFileSync(OCR_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, 'utf8'); } catch {}
}

// ── Status callbacks (wired to main window IPC in main.js) ──

let onSetupStart = null;
let onSetupProgress = null;
let onSetupDone = null;

function setSetupCallbacks(cbs) {
  if (cbs.onStart) onSetupStart = cbs.onStart;
  if (cbs.onProgress) onSetupProgress = cbs.onProgress;
  if (cbs.onDone) onSetupDone = cbs.onDone;
}

function showSetupWin(onReady) {
  onSetupStart?.();
  onReady?.();
}

function closeSetupWin() {
  onSetupDone?.();
}

function updateSetup(step, subtitle, progress, detail) {
  onSetupProgress?.({ step, subtitle, progress, detail });
}

// ── Python detection + install ──

function execFileAsync(exe, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function checkPythonExists() {
  const candidates = [];
  if (fs.existsSync(PYTHON_EXE)) candidates.push(PYTHON_EXE);

  try {
    const py312 = (await execFileAsync('py', ['-3.12', '-c', 'import sys; print(sys.executable)'], {
      timeout: 5000, windowsHide: true, encoding: 'utf-8'
    })).trim();
    if (py312) candidates.push(py312);
  } catch {}

  for (const exe of ['python']) {
    try {
      const r = (await execFileAsync(exe, ['-c', 'import sys; print(sys.executable)'], {
        timeout: 5000, windowsHide: true, encoding: 'utf-8'
      })).trim();
      if (r) candidates.push(r);
    } catch {}
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const details = (await execFileAsync(candidate, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}"); import pip; print(pip.__version__)'], {
        timeout: 10000, windowsHide: true, encoding: 'utf-8'
      })).trim();
      if (!details.startsWith('3.12\n') && !details.startsWith('3.12\r\n')) {
        logOcr(`Rejected unsupported Python: ${candidate} (${details.split(/\r?\n/)[0] || 'unknown'})`);
        continue;
      }
      logOcr(`Using Python: ${candidate} (${details.replace(/\r?\n/g, ', pip ')})`);
      return candidate;
    } catch (err) {
      logOcr(`Rejected Python without working pip: ${candidate} (${err.message})`);
    }
  }
  return null;
}

async function checkMangaOcrInstalled(pythonExe) {
  try {
    await execFileAsync(pythonExe, ['-c', 'from importlib.metadata import version; [version(p) for p in ("manga-ocr", "torch", "transformers", "Pillow")]'], {
      timeout: 15000, windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let done = 0;
      res.on('data', (chunk) => {
        done += chunk.length;
        if (total) onProgress(done / total);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('timeout', () => request.destroy(new Error('Download timed out')));
    request.on('error', (err) => { try { file.close(); } catch {} try { fs.unlinkSync(dest); } catch {} reject(err); });
  });
}

async function downloadAndInstallPython() {
  updateSetup('Downloading Python...', `${PYTHON_VERSION} (~30 MB)`, 0);

  const installerPath = path.join(os.tmpdir(), `python-${PYTHON_VERSION}-amd64.exe`);
  try {
    await downloadFile(PYTHON_URL, installerPath, (pct) => {
      updateSetup('Downloading Python...', `${PYTHON_VERSION} (~30 MB)`, pct);
    });
  } catch (err) {
    throw new Error(`Failed to download Python: ${err.message}`);
  }

  updateSetup('Installing Python...', 'This may take a minute', null);

  await new Promise((resolve, reject) => {
    const p = spawn(installerPath, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', `TargetDir=${PYTHON_INSTALL_DIR}`], {
      windowsHide: true, stdio: 'pipe'
    });
    pythonInstallerProc = p;
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => {
      pythonInstallerProc = null;
      try { fs.unlinkSync(installerPath); } catch {}
      if (cancelled) { reject(new Error('cancelled')); return; }
      if (code === 0) resolve();
      else reject(new Error(`Installer exited with code ${code}. ${stderr.slice(0, 200)}`));
    });
  });

  updateSetup('Python installed', 'Starting OCR setup...', 1);
}

async function installMangaOcr(pythonExe) {
  updateSetup('Installing manga-ocr...', 'Downloading ~2 GB (may take 10-20 min)', 0.02);

  await new Promise((resolve, reject) => {
    const p = spawn(pythonExe, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'manga-ocr==0.1.16'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    installProc = p;
    let output = '';
    logOcr(`Installing manga-ocr with ${pythonExe}`);
    p.stdout.on('data', (d) => {
      const text = d.toString();
      output = (output + text).slice(-12000);
      logOcr(text.trim());
      const last = text.trim().split('\n').pop() || '';
      updateSetup('Installing manga-ocr...', 'Downloading packages...', null, last);
    });
    p.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (text) {
        output = (output + '\n' + text).slice(-12000);
        logOcr(text);
        updateSetup('Installing manga-ocr...', 'Downloading packages...', null, text.split('\n').pop());
      }
    });
    p.on('error', reject);
    p.on('exit', (code) => {
      installProc = null;
      if (cancelled) { reject(new Error('cancelled')); return; }
      if (code === 0) {
        updateSetup('manga-ocr installed!', 'Starting OCR engine...', 1);
        resolve();
      } else {
        const detail = output.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`manga-ocr installation failed (pip exit ${code}).${detail ? `\n${detail}` : ''}\nLog: ${OCR_LOG_PATH}`));
      }
    });
  });
}

/** Abort any in-flight OCR setup (Python download/install, pip install). */
function cancelSetup() {
  cancelled = true;
  if (pythonInstallerProc) {
    try { pythonInstallerProc.kill(); } catch {}
    pythonInstallerProc = null;
  }
  if (installProc) {
    try { installProc.kill(); } catch {}
    installProc = null;
  }
  if (proc && !ready) {
    // Kill the OCR server if it's still starting (model download/load phase).
    try { proc.kill(); } catch {}
    proc = null;
  }
  // Allow a later startOcr() to retry from scratch.
  startError = null;
  starting = false;
}

async function ensureSetup() {
  const existing = await checkPythonExists();
  if (existing) return existing;

  showSetupWin();
  try {
    await downloadAndInstallPython();
    if (!fs.existsSync(PYTHON_EXE)) throw new Error('Python install path not found');
    updateSetup('Verifying installation...', '', 0.95);
    return PYTHON_EXE;
  } catch (err) {
    closeSetupWin();
    throw err;
  }
}

// ── OCR Server ──

function ensureScriptFile() {
  if (scriptPath) return scriptPath;
  scriptPath = path.join(os.tmpdir(), 'hiraganized-ocr-server.py');
  fs.writeFileSync(scriptPath, PYTHON_SCRIPT, 'utf-8');
  return scriptPath;
}

function tryCleanup() {
  if (scriptPath) {
    try { fs.unlinkSync(scriptPath); } catch {}
    scriptPath = null;
  }
}

async function startOcr() {
  if (proc && ready) return;
  if (starting) {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (ready) { clearInterval(check); resolve(); }
        else if (!starting && !ready) { clearInterval(check); reject(startError || new Error('OCR setup aborted')); }
      }, 100);
    });
  }
  starting = true;
  startError = null;
  cancelled = false;

  try {
    showSetupWin();
    updateSetup('Setting up OCR engine...', '', 0);
    const pythonExe = await ensureSetup();
    updateSetup('Checking manga-ocr...', '', 0.3);

    if (!(await checkMangaOcrInstalled(pythonExe))) {
      await installMangaOcr(pythonExe);
    }
    updateSetup('Starting OCR server...', 'First launch may download the OCR model (~450 MB)', 0.85);

    const sp = ensureScriptFile();
    proc = spawn(pythonExe, [sp], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true
    });
    stdoutBuf = '';

    setupResponseHandler();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        startupWaiter = null;
        reject(new Error(`OCR startup timed out. Log: ${OCR_LOG_PATH}`));
      }, 600000);
      startupWaiter = {
        resolve: () => { clearTimeout(timer); startupWaiter = null; resolve(); },
        reject: (err) => { clearTimeout(timer); startupWaiter = null; reject(err); }
      };
      proc.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) {
          logOcr(text);
          const last = text.split('\n').pop().slice(0, 120);
          updateSetup('Loading OCR model...', 'This may take a few minutes on first launch', null, last);
        }
      });
    });

    ready = true;
    starting = false;
    closeSetupWin();
  } catch (err) {
    startError = err;
    starting = false;
    closeSetupWin();
    if (proc) { try { proc.kill(); } catch {} proc = null; }
    throw err;
  }
}

function setupResponseHandler() {
  if (!proc) return;
  const worker = proc;
  worker.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.status === 'ready') {
          startupWaiter?.resolve();
        } else if (msg.status === 'error') {
          startupWaiter?.reject(new Error(`${msg.error || 'OCR initialization failed'}. Log: ${OCR_LOG_PATH}`));
        }
        if (msg.ok !== undefined && pending) {
          if (pending.timer) clearTimeout(pending.timer);
          if (msg.ok) pending.resolve(msg.text || '');
          else pending.reject(new Error(msg.error || 'OCR failed'));
          pending = null;
        }
      } catch {}
    }
  });
  worker.on('exit', (code) => {
    if (proc !== worker) return;
    ready = false; proc = null;
    startupWaiter?.reject(new Error(`OCR process exited with code ${code}. Log: ${OCR_LOG_PATH}`));
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('OCR process exited')); pending = null; }
  });
  worker.on('error', (err) => {
    if (proc !== worker) return;
    proc = null; ready = false;
    startupWaiter?.reject(err);
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('OCR process error')); pending = null; }
  });
}

function stopOcr() {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    proc = null;
  }
  ready = false; starting = false;
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error('OCR stopped')); pending = null; }
  closeSetupWin();
}

async function recognizeImage(imagePath) {
  if (!ready) await startOcr();
  if (!proc || !proc.stdin) throw new Error('OCR process not available');
  return new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('OCR is already processing an image'));
      return;
    }
    const timer = setTimeout(() => {
      if (pending) { pending.reject(new Error('OCR timed out')); pending = null; }
    }, 60000);
    pending = { resolve, reject, timer };
    try {
      proc.stdin.write(JSON.stringify({ path: imagePath }) + '\n');
    } catch (err) {
      clearTimeout(timer); pending = null; reject(err);
    }
  });
}

function cropRegion(dataUrl, bounds, displayBounds, thumbnailWidth, thumbnailHeight) {
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return null;
  const scaleX = thumbnailWidth / displayBounds.width;
  const scaleY = thumbnailHeight / displayBounds.height;
  const x = Math.max(0, Math.round((bounds.x - displayBounds.x) * scaleX));
  const y = Math.max(0, Math.round((bounds.y - displayBounds.y) * scaleY));
  const cropRect = {
    x,
    y,
    width: Math.min(thumbnailWidth - x, Math.max(1, Math.round(bounds.width * scaleX))),
    height: Math.min(thumbnailHeight - y, Math.max(1, Math.round(bounds.height * scaleY)))
  };
  if (cropRect.width < 1 || cropRect.height < 1) return null;
  const cropped = img.crop(cropRect);
  return cropped.isEmpty() ? null : cropped.toPNG();
}

function saveTempPng(pngBuffer) {
  const fp = path.join(os.tmpdir(), `hiraganized-capture-${crypto.randomUUID()}.png`);
  fs.writeFileSync(fp, pngBuffer);
  return fp;
}

module.exports = { recognizeImage, cropRegion, saveTempPng, startOcr, stopOcr, tryCleanup, setSetupCallbacks, cancelSetup };
