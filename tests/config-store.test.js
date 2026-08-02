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
  assert.equal(reloaded.notifications.opacity, 100);
});

test('config store persists the selected font family', () => {
  const { store } = createTestStore();
  store.update({ appearance: { fontFamily: 'nunito' } });
  store.save();
  const reloaded = new ConfigStore(store.filePath, cloneDefaults()).load();
  assert.equal(reloaded.appearance.fontFamily, 'nunito');
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

test('new general settings persist and preserve their dependency', () => {
  const { store } = createTestStore();
  let result = store.update({
    general: {
      launchOnStartup: true,
      startMinimized: true,
      showCompoundCharacters: false
    }
  });
  assert.equal(result.general.launchOnStartup, true);
  assert.equal(result.general.startMinimized, true);
  assert.equal(result.general.showCompoundCharacters, false);

  result = store.update({ general: { launchOnStartup: false } });
  assert.equal(result.general.launchOnStartup, false);
  assert.equal(result.general.startMinimized, false);
  assert.equal(result.general.showCompoundCharacters, false);
});
