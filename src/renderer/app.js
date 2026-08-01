const appApi = window.hiraganized;
let settings = null;
let recording = false;
let lastTheme = null;

const $ = (selector) => document.querySelector(selector);

const THEME_NAMES = ['midnight', 'ocean', 'forest', 'violet', 'crimson', 'amber', 'graphite', 'slate', 'snow', 'cream'];
const THEME_LABELS = {
  midnight: 'Midnight', ocean: 'Ocean', forest: 'Forest', violet: 'Violet', crimson: 'Crimson',
  amber: 'Amber', graphite: 'Graphite', slate: 'Slate', snow: 'Snow', cream: 'Cream'
};

const THEME_SWATCH = {
  midnight: ['#1e1e1e', '#4a7bd6'],
  ocean: ['#14212e', '#3aa0ff'],
  forest: ['#15221b', '#4ade80'],
  violet: ['#211c30', '#a78bfa'],
  crimson: ['#2b1a1f', '#f87171'],
  amber: ['#241e15', '#fbbf24'],
  graphite: ['#202020', '#9ca3af'],
  slate: ['#1b2129', '#94a3b8'],
  snow: ['#f2f4f8', '#4a7bd6'],
  cream: ['#f6f1e6', '#b07d3b']
};

function nestedValue(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

const SLIDER_FORMATS = {
  'notifications.opacity': (v) => `${v}%`,
  'appearance.fontScale': (v) => `${Number(v).toFixed(2)}x`,
  'general.autoDismissSeconds': (v) => (v > 0 ? `${v}s` : 'Off'),
  'general.maxKanjiLimit': (v) => String(v),
  'general.captureDelayMs': (v) => (v > 0 ? `${v} ms` : 'Instant')
};

function renderThemeSwatches(theme) {
  const grid = $('#theme-grid');
  if (grid.dataset.built) {
    grid.querySelectorAll('.theme-swatch').forEach((sw) => {
      sw.classList.toggle('active', sw.dataset.theme === theme);
    });
    return;
  }
  grid.dataset.built = 'true';
  for (const name of THEME_NAMES) {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch' + (name === theme ? ' active' : '');
    btn.dataset.theme = name;
    btn.title = THEME_LABELS[name];
    const [swBg, swAccent] = THEME_SWATCH[name] || ['#444', '#888'];
    btn.innerHTML =
      `<span class="swatch-circle" style="background:${swBg};border-color:${swAccent}"></span>` +
      `<span class="swatch-name">${THEME_LABELS[name]}</span>`;
    btn.addEventListener('click', () => {
      updateSetting('appearance.theme', name);
      grid.querySelectorAll('.theme-swatch').forEach((sw) => sw.classList.toggle('active', sw.dataset.theme === name));
    });
    grid.appendChild(btn);
  }
}

function renderSlider(path) {
  const input = $(`#slider-${path.split('.').pop()}`);
  if (!input) return;
  const value = nestedValue(settings, path);
  input.value = String(value);
  const label = $(`#value-${path.split('.').pop()}`);
  if (label) label.innerHTML = SLIDER_FORMATS[path](value);
  input.style.setProperty('--slider-fill', `${((value - input.min) / (input.max - input.min)) * 100}%`);
}

function renderState(next) {
  settings = next.settings || settings;
  const hotkey = nestedValue(settings, 'shortcuts.triggerCapture');
  if (hotkey && !recording) $('#hotkey-recorder').textContent = formatAccelerator(hotkey);

  const launch = nestedValue(settings, 'general.launchOnStartup') === true;
  const minimized = nestedValue(settings, 'general.startMinimized') === true;
  const showCompound = nestedValue(settings, 'general.showCompoundCharacters') !== false;
  const magnifier = nestedValue(settings, 'general.magnifier') !== false;
  const showLogs = nestedValue(settings, 'debug.showLogs') === true;

  $('#set-launchOnStartup').checked = launch;
  $('#set-startMinimized').checked = minimized;
  $('#set-showCompoundCharacters').checked = showCompound;
  $('#set-magnifier').checked = magnifier;
  $('#set-showLogs').checked = showLogs;
  setStartMinimizedDisabled(!launch);

  for (const path of Object.keys(SLIDER_FORMATS)) renderSlider(path);
  renderThemeSwatches(nestedValue(settings, 'appearance.theme'));



  const theme = nestedValue(settings, 'appearance.theme') || 'midnight';
  if (theme !== lastTheme) {
    lastTheme = theme;
    document.documentElement.dataset.theme = theme;
  }
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

function modsFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('CommandOrControl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Super');
  return parts;
}

function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function comboOf(mods, key) {
  return [...mods, key].join('+');
}

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


      $('#set-startMinimized').checked = false;
      setStartMinimizedDisabled(true);
    } else if (path === 'general.launchOnStartup' && el.checked) {
      setStartMinimizedDisabled(false);
    }
    await updateSetting(path, el.checked);
  });
}

function bindSlider(path) {
  const input = $(`#slider-${path.split('.').pop()}`);
  if (!input) return;
  const label = $(`#value-${path.split('.').pop()}`);
  input.addEventListener('input', () => {
    input.style.setProperty('--slider-fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
    if (label) label.innerHTML = SLIDER_FORMATS[path](Number(input.value));
  });
  input.addEventListener('change', () => updateSetting(path, Number(input.value)));
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
  bindToggle('#set-magnifier', 'general.magnifier');
  bindToggle('#set-showLogs', 'debug.showLogs');
  for (const path of Object.keys(SLIDER_FORMATS)) bindSlider(path);

  $('#reset-settings-btn').addEventListener('click', async () => {
    const btn = $('#reset-settings-btn');
    btn.disabled = true;
    try {
      await appApi.resetSettings();
    } catch {}
    setTimeout(() => { btn.disabled = false; }, 1200);
  });

  $('#clear-cache-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Clearing...';
    try {
      const res = await appApi.clearDictionaryCache();
      btn.textContent = res && res.ok ? 'Cache cleared' : 'Failed — retry';
    } catch {
      btn.textContent = 'Failed — retry';
    }
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Clear dictionary cache'; }, 2000);
  });

  const recorder = $('#hotkey-recorder');
  let heldMods = new Set();
  let lastPreview = '';
  let recordingStart = 0;

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




    recordingStart = event.timeStamp;
    recorder.classList.add('recording');
    recorder.textContent = 'Press keys...';
  });





  const pressed = new Set();

  const modsFromSession = (event) => {
    const parts = [];
    if (event.ctrlKey && pressed.has('Control')) parts.push('CommandOrControl');
    if (event.shiftKey && pressed.has('Shift')) parts.push('Shift');
    if (event.altKey && pressed.has('Alt')) parts.push('Alt');
    if (event.metaKey && pressed.has('Meta')) parts.push('Super');
    return parts;
  };

  document.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      cancelRecording();
      return;
    }

    if (MODIFIER_KEYS.has(event.key)) {


      if (event.timeStamp <= recordingStart) return;
      pressed.add(event.key);
      heldMods.add(event.key);
      const mods = modsFromSession(event);
      lastPreview = mods.length ? formatAccelerator(mods.join('+')) : 'Press keys...';
      recorder.textContent = lastPreview;
      return;
    }



    pressed.add(event.key);
    commit(comboOf(modsFromSession(event), normalizeKey(event.key)));
  });





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

appApi.getVersion().then((v) => { $('#version-tag').textContent = `v${v}`; });

appApi.onState(renderState);
appApi.onOcrSetupStart(showOcrSetup);
appApi.onOcrSetupProgress(updateOcrProgress);
appApi.onOcrSetupDone(hideOcrSetup);
bindEvents();
