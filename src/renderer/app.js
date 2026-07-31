const appApi = window.hiraganized;
let settings = null;
let recording = false;

const $ = (selector) => document.querySelector(selector);

function nestedValue(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function renderState(next) {
  settings = next.settings || settings;
  const hotkey = nestedValue(settings, 'shortcuts.triggerCapture');
  if (hotkey && !recording) $('#hotkey-recorder').textContent = formatAccelerator(hotkey);

  // General toggles.
  const launch = nestedValue(settings, 'general.launchOnStartup') === true;
  const minimized = nestedValue(settings, 'general.startMinimized') === true;
  const showCompound = nestedValue(settings, 'general.showCompoundCharacters') !== false;

  $('#set-launchOnStartup').checked = launch;
  $('#set-startMinimized').checked = minimized;
  $('#set-showCompoundCharacters').checked = showCompound;
  setStartMinimizedDisabled(!launch);
}

function updateSetting(path, rawValue) {
  const [section, key] = path.split('.');
  if (!section || !key) return;
  return appApi.updateSettings({ [section]: { [key]: rawValue } });
}

function formatAccelerator(accel) {
  return accel
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace('Shift', 'Shift')
    .replace('Alt', 'Alt')
    .replace('Super', 'Win');
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** Modifiers held according to the event's modifier flags (no key appended). */
function modsFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('CommandOrControl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Super');
  return parts;
}

/** Normalize a non-modifier key for Electron's accelerator syntax. */
function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Build a full accelerator from held modifiers + a key. */
function comboOf(mods, key) {
  return [...mods, key].join('+');
}

/** "Start minimized" is only meaningful when launching at startup. */
function setStartMinimizedDisabled(disabled) {
  const input = $('#set-startMinimized');
  const row = input.closest('.setting-row');
  input.disabled = disabled;
  row.classList.toggle('disabled', disabled);
  if (disabled) input.checked = false;
}

function bindToggle(selector, path) {
  const el = $(selector);
  el.addEventListener('change', async () => {
    if (path === 'general.launchOnStartup' && !el.checked) {
      // Turning off startup forces start-minimized off too.
      $('#set-startMinimized').checked = false;
      setStartMinimizedDisabled(true);
    } else if (path === 'general.launchOnStartup' && el.checked) {
      setStartMinimizedDisabled(false);
    }
    await updateSetting(path, el.checked);
  });
}

function bindEvents() {
  $('#minimize-window').addEventListener('click', () => appApi.minimizeWindow());
  $('#close-window').addEventListener('click', () => appApi.hideWindow());
  $('#profile-link').addEventListener('click', (e) => {
    e.preventDefault();
    appApi.openExternal('https://github.com/soulfern');
  });

  bindToggle('#set-launchOnStartup', 'general.launchOnStartup');
  bindToggle('#set-startMinimized', 'general.startMinimized');
  bindToggle('#set-showCompoundCharacters', 'general.showCompoundCharacters');

  const recorder = $('#hotkey-recorder');
  let heldMods = new Set();
  let lastPreview = '';

  function commit(accelerator) {
    recording = false;
    heldMods = new Set();
    lastPreview = '';
    recorder.classList.remove('recording');
    recorder.textContent = formatAccelerator(accelerator);
    updateSetting('shortcuts.triggerCapture', accelerator);
  }

  function cancelRecording() {
    recording = false;
    heldMods = new Set();
    lastPreview = '';
    recorder.classList.remove('recording');
    const hotkey = nestedValue(settings, 'shortcuts.triggerCapture') || 'CommandOrControl+Shift+K';
    recorder.textContent = formatAccelerator(hotkey);
  }

  recorder.addEventListener('click', () => {
    if (recording) return;
    recording = true;
    heldMods = new Set();
    lastPreview = '';
    recorder.classList.add('recording');
    recorder.textContent = 'Press keys...';
  });

  document.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      cancelRecording();
      return;
    }

    if (MODIFIER_KEYS.has(event.key)) {
      // Preview the currently-held modifiers (no duplicate key appended).
      heldMods.add(event.key);
      const mods = modsFromEvent(event);
      lastPreview = mods.length ? formatAccelerator(mods.join('+')) : 'Press keys...';
      recorder.textContent = lastPreview;
      return;
    }

    // A non-modifier key completes the combination immediately.
    commit(comboOf(modsFromEvent(event), normalizeKey(event.key)));
  });

  // Commit once all keys are released — this lets modifier-only hotkeys
  // (e.g. just "Shift") be selected without pressing an extra key.
  document.addEventListener('keyup', (event) => {
    if (!recording) return;
    if (!MODIFIER_KEYS.has(event.key)) return;
    heldMods.delete(event.key);
    if (heldMods.size === 0 && lastPreview) {
      commit(lastPreview);
    }
  });
}

function showOcrSetup() {
  $('#settings-view').classList.add('hidden');
  $('#main-content').classList.add('loading');
  const cancel = $('#loading-cancel');
  cancel.disabled = false;
  cancel.style.display = 'none';
}

function hideOcrSetup() {
  $('#settings-view').classList.remove('hidden');
  $('#main-content').classList.remove('loading');
}

function updateOcrProgress(data) {
  const step = $('#loading-step');
  const subtitle = $('#loading-subtitle');
  const bar = $('#loading-bar');
  const detail = $('#loading-detail');
  const cancel = $('#loading-cancel');
  cancel.style.display = 'inline-block';
  if (data.step) step.textContent = data.step;
  subtitle.textContent = data.subtitle || '';
  subtitle.style.display = data.subtitle ? '' : 'none';
  if (data.progress != null) {
    bar.style.width = Math.min(100, Math.max(0, data.progress * 100)) + '%';
  } else {
    bar.style.width = '0';
  }
  detail.textContent = data.detail || '';
  detail.style.display = data.detail ? '' : 'none';
}

$('#loading-cancel').addEventListener('click', () => {
  $('#loading-cancel').disabled = true;
  appApi.cancelOcrSetup();
});

appApi.onState(renderState);
appApi.onOcrSetupStart(showOcrSetup);
appApi.onOcrSetupProgress(updateOcrProgress);
appApi.onOcrSetupDone(hideOcrSetup);
bindEvents();
