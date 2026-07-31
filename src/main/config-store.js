const fs = require('node:fs');
const path = require('node:path');
const { mergeSettings } = require('./defaults');

class ConfigStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.defaults = defaults || {};
    this.settings = mergeSettings(defaults, {});
  }

  readSettings(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const saved = this.readSettings(this.filePath);
        this.settings = mergeSettings(this.defaults, saved);
      } else if (fs.existsSync(this.backupPath)) {
        this.settings = mergeSettings(this.defaults, this.readSettings(this.backupPath));
      }
    } catch (error) {
      this.lastError = error;
      try {
        if (fs.existsSync(this.backupPath)) {
          this.settings = mergeSettings(this.defaults, this.readSettings(this.backupPath));
        } else {
          this.settings = mergeSettings(this.defaults, {});
        }
      } catch (backupError) {
        this.lastError = backupError;
        this.settings = mergeSettings(this.defaults, {});
      }
    }
    return this.get();
  }

  get() {
    return JSON.parse(JSON.stringify(this.settings));
  }

  update(patch) {
    this.settings = mergeSettings(this.settings, patch);
    this._scheduleSave();
    return this.get();
  }

  _scheduleSave() {
    // Debounce: hotkey recording fires many rapid partial updates.
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 250);
  }

  save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.settings, null, 2), 'utf8');
    let movedExisting = false;
    try {
      if (fs.existsSync(this.filePath)) {
        fs.rmSync(this.backupPath, { force: true });
        fs.renameSync(this.filePath, this.backupPath);
        movedExisting = true;
      }
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        if (movedExisting && !fs.existsSync(this.filePath)) fs.renameSync(this.backupPath, this.filePath);
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
      throw error;
    }
  }

  reset() {
    this.settings = mergeSettings(this.defaults, {});
    this.save();
    return this.get();
  }
}

module.exports = { ConfigStore };
