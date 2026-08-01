const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, THEME_KEYS, cloneDefaults, mergeSettings } = require('../src/main/defaults');

test('defaults include the new customization keys', () => {
  const d = cloneDefaults();
  assert.equal(d.general.maxKanjiLimit, 20);
  assert.equal(d.general.captureDelayMs, 100);
  assert.equal(d.general.magnifier, false);
  assert.equal(d.general.autoDismissSeconds, 0);
  assert.equal(d.general.showCompoundCharacters, false);
  assert.equal(d.general.launchOnStartup, false);
  assert.equal(d.general.startMinimized, false);
  assert.equal(d.shortcuts.triggerCapture, 'CommandOrControl+Shift+K');
  assert.equal(d.notifications.opacity, 100);
  assert.equal(d.appearance.theme, 'midnight');
  assert.equal(d.appearance.fontScale, 1);
  assert.equal(d.debug.showLogs, false);
});

test('new general limits are clamped to their ranges', () => {
  assert.equal(mergeSettings(cloneDefaults(), { general: { maxKanjiLimit: 99 } }).general.maxKanjiLimit, 30);
  assert.equal(mergeSettings(cloneDefaults(), { general: { maxKanjiLimit: -5 } }).general.maxKanjiLimit, 1);
  assert.equal(mergeSettings(cloneDefaults(), { general: { maxKanjiLimit: 7.4 } }).general.maxKanjiLimit, 7);
  assert.equal(mergeSettings(cloneDefaults(), { general: { captureDelayMs: 9999 } }).general.captureDelayMs, 1000);
  assert.equal(mergeSettings(cloneDefaults(), { general: { captureDelayMs: -1 } }).general.captureDelayMs, 0);
  assert.equal(mergeSettings(cloneDefaults(), { general: { autoDismissSeconds: 61 } }).general.autoDismissSeconds, 60);
  assert.equal(mergeSettings(cloneDefaults(), { general: { autoDismissSeconds: -1 } }).general.autoDismissSeconds, 0);
});

test('appearance settings are clamped and validated', () => {
  assert.equal(mergeSettings(cloneDefaults(), { appearance: { fontScale: 3 } }).appearance.fontScale, 1.5);
  assert.equal(mergeSettings(cloneDefaults(), { appearance: { fontScale: 0.1 } }).appearance.fontScale, 0.7);
  assert.equal(mergeSettings(cloneDefaults(), { appearance: { theme: 'not-a-theme' } }).appearance.theme, 'midnight');
  assert.equal(mergeSettings(cloneDefaults(), { appearance: { theme: 'ocean' } }).appearance.theme, 'ocean');
});

test('theme list covers the documented palettes', () => {
  for (const theme of ['midnight', 'ocean', 'forest', 'violet', 'crimson', 'amber', 'graphite', 'slate', 'snow', 'cream']) {
    assert.ok(THEME_KEYS.includes(theme), `missing theme ${theme}`);
  }
});

test('opacity clamps from 30', () => {
  assert.equal(mergeSettings(cloneDefaults(), { notifications: { opacity: 20 } }).notifications.opacity, 30);
  assert.equal(mergeSettings(cloneDefaults(), { notifications: { opacity: 55 } }).notifications.opacity, 55);
  assert.equal(mergeSettings(cloneDefaults(), { notifications: { opacity: 100 } }).notifications.opacity, 100);
});
