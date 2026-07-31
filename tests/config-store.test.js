const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/main/config-store');
const { cloneDefaults } = require('../src/main/defaults');

function createTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraganized-config-'));
  const filePath = path.join(dir, 'settings.json');
  const store = new ConfigStore(filePath, cloneDefaults());
  return { store, filePath, dir };
}

test('config store persists partial updates without dropping other preferences', () => {
  const { store } = createTestStore();
  store.update({ shortcuts: { triggerCapture: 'Ctrl+Alt+J' } });
  store.save();
  const reloaded = new ConfigStore(store.filePath, cloneDefaults()).load();
  assert.equal(reloaded.shortcuts.triggerCapture, 'Ctrl+Alt+J');
  assert.equal(reloaded.notifications.opacity, 96);
});

test('config store merges saved sections with defaults', () => {
  const { store } = createTestStore();
  store.update({ notifications: { opacity: 80 }, advanced: { logging: false } });
  store.save();
  const saved = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(saved.notifications.opacity, 80);
  assert.equal(saved.advanced.logging, false);
  assert.equal(saved.shortcuts.triggerCapture, 'CommandOrControl+Shift+K');
});

test('config store ignores unknown keys and clamps unsafe values', () => {
  const { store } = createTestStore();
  const result = store.update({ notifications: { opacity: 999 }, unknown: { key: 1 } });
  assert.equal(result.notifications.opacity, 100);
  assert.equal(result.unknown, undefined);
});
