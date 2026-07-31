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

function keyEventToAccelerator(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('CommandOrControl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Super');

  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}

function bindEvents() {
  $('#minimize-window').addEventListener('click', () => appApi.minimizeWindow());
  $('#close-window').addEventListener('click', () => appApi.hideWindow());
  $('#profile-link').addEventListener('click', (e) => {
    e.preventDefault();
    appApi.openExternal('https://github.com/soulfern');
  });

  const recorder = $('#hotkey-recorder');

  recorder.addEventListener('click', () => {
    if (recording) return;
    recording = true;
    recorder.classList.add('recording');
    recorder.textContent = 'Press keys...';
  });

  document.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      recording = false;
      recorder.classList.remove('recording');
      const hotkey = nestedValue(settings, 'shortcuts.triggerCapture') || 'CommandOrControl+Shift+K';
      recorder.textContent = formatAccelerator(hotkey);
      return;
    }

    const accelerator = keyEventToAccelerator(event);

    if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') {
      recorder.textContent = formatAccelerator(accelerator);
      return;
    }

    recording = false;
    recorder.classList.remove('recording');
    recorder.textContent = formatAccelerator(accelerator);

    updateSetting('shortcuts.triggerCapture', accelerator);
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
