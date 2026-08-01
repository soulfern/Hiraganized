const fs = require('node:fs');
const path = require('node:path');

class Logger {
  constructor(logDirectory, enabled = true) {
    this.logDirectory = logDirectory;
    this.enabled = enabled;
    this.filePath = path.join(logDirectory, 'hiraganized.log');
    this.queue = [];
    this.flushTimer = null;
    this.listeners = new Set();

  }

  setEnabled(enabled) { this.enabled = Boolean(enabled); }


  onLine(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  write(level, message, details) {
    if (!this.enabled) return;
    const timestamp = new Date().toISOString();
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    const line = `${timestamp} [${level}] ${message}${suffix}`;
    this.queue.push(line);
    for (const cb of this.listeners) {
      try { cb(line); } catch {}
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 1000);
  }

  info(message, details) { this.write('INFO', message, details); }
  warn(message, details) { this.write('WARN', message, details); }
  error(message, details) { this.write('ERROR', message, details); }

  flush() {
    this.flushTimer = null;
    if (!this.queue.length || !this.enabled) return;
    const lines = this.queue.splice(0).join('\n') + '\n';
    try {
      fs.mkdirSync(this.logDirectory, { recursive: true });
      fs.appendFileSync(this.filePath, lines, 'utf8');
    } catch {}
  }


  recent(n) {
    const lines = [];
    try {
      if (fs.existsSync(this.filePath)) {
        const disk = fs.readFileSync(this.filePath, 'utf8').split('\n');
        for (const l of disk) if (l) lines.push(l);
      }
    } catch {}
    for (const l of this.queue) lines.push(l);
    return lines.slice(-n);
  }

  close() { if (this.flushTimer) clearTimeout(this.flushTimer); this.flush(); }
}

module.exports = { Logger };
