const THEME_KEYS = Object.freeze([
  'midnight', 'ocean', 'forest', 'violet', 'crimson', 'amber', 'graphite', 'slate', 'snow', 'cream'
]);
const FONT_FAMILY_KEYS = Object.freeze(['lexend', 'nunito', 'segoe-ui', 'inter']);

const DEFAULT_SETTINGS = Object.freeze({
  general: {
    minimizeToTray: false,
    closeToTray: true,
    launchOnStartup: false,
    startMinimized: false,
    showCompoundCharacters: false,
    maxKanjiLimit: 20,
captureDelayMs: 100,
    magnifier: false,
    showCrosshair: false,
    autoDismissSeconds: 0
  },
  appearance: {
    theme: 'midnight',
    fontScale: 1,
    uiFontScale: 1,
    fontFamily: 'lexend'
  },
  shortcuts: {
    triggerCapture: 'CommandOrControl+Shift+K'
  },
  notifications: {
    opacity: 100
  },
  advanced: {
    logging: true
  },
  debug: {
    showLogs: false
  }
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCompatibleValue(defaultValue, incomingValue) {
  if (incomingValue === null) return defaultValue === null;
  if (typeof incomingValue === 'number') return Number.isFinite(incomingValue) && (defaultValue === null || typeof defaultValue === 'number');
  return typeof incomingValue === typeof defaultValue;
}

function mergeSettings(base, incoming) {
  const result = JSON.parse(JSON.stringify(isPlainObject(base) ? base : DEFAULT_SETTINGS));
  if (!isPlainObject(incoming)) return result;

  for (const section of Object.keys(result)) {
    if (!isPlainObject(result[section]) || !isPlainObject(incoming[section])) continue;
    for (const key of Object.keys(result[section])) {
      const value = incoming[section][key];
      if (value !== undefined && isCompatibleValue(result[section][key], value)) {
        result[section][key] = value;
      }
    }
  }
  return normalizeSettings(result);
}

function clampNumber(value, minimum, maximum, fallback) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function normalizeSettings(settings) {
  const result = settings;
  const general = result.general;
  const appearance = result.appearance;
  general.maxKanjiLimit = Math.round(clampNumber(general.maxKanjiLimit, 1, 30, DEFAULT_SETTINGS.general.maxKanjiLimit));
  general.captureDelayMs = Math.round(clampNumber(general.captureDelayMs, 0, 1000, DEFAULT_SETTINGS.general.captureDelayMs));
  general.autoDismissSeconds = Math.round(clampNumber(general.autoDismissSeconds, 0, 60, DEFAULT_SETTINGS.general.autoDismissSeconds));
appearance.fontScale = clampNumber(appearance.fontScale, 0.7, 1.5, DEFAULT_SETTINGS.appearance.fontScale);
  appearance.uiFontScale = clampNumber(appearance.uiFontScale, 0.8, 1.2, DEFAULT_SETTINGS.appearance.uiFontScale);
  appearance.theme = THEME_KEYS.includes(appearance.theme) ? appearance.theme : DEFAULT_SETTINGS.appearance.theme;
  appearance.fontFamily = FONT_FAMILY_KEYS.includes(appearance.fontFamily) ? appearance.fontFamily : DEFAULT_SETTINGS.appearance.fontFamily;
  result.notifications.opacity = Math.round(clampNumber(result.notifications.opacity, 30, 100, DEFAULT_SETTINGS.notifications.opacity));
  if (!general.launchOnStartup) general.startMinimized = false;
  if (!general.magnifier) general.showCrosshair = false;
  return result;
}

module.exports = { DEFAULT_SETTINGS, THEME_KEYS, FONT_FAMILY_KEYS, cloneDefaults, mergeSettings };
