const DEFAULT_SETTINGS = Object.freeze({
  general: {
    minimizeToTray: false,
    closeToTray: true,
    launchOnStartup: false,
    startMinimized: false,
    showCompoundCharacters: false
  },
  shortcuts: {
    triggerCapture: 'CommandOrControl+Shift+K'
  },
  notifications: {
    opacity: 96
  },
  advanced: {
    logging: true
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
  result.notifications.opacity = clampNumber(result.notifications.opacity, 55, 100, DEFAULT_SETTINGS.notifications.opacity);
  if (!result.general.launchOnStartup) result.general.startMinimized = false;
  return result;
}

module.exports = { DEFAULT_SETTINGS, cloneDefaults, mergeSettings };
