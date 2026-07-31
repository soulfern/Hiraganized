const api = window.uninstaller;

const $ = (sel) => document.querySelector(sel);

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

async function init() {
  try {
    const { sizes } = await api.getPaths();
    if (sizes) {
      $('#size-app').textContent = formatBytes(sizes.app);
      $('#size-settings').textContent = formatBytes(sizes.userData);
      // OCR total = python install + downloaded model cache.
      $('#size-ocr').textContent = formatBytes((sizes.python || 0) + (sizes.modelCache || 0));
    }
  } catch (_) {
    // Sizes are best-effort; the uninstaller still works without them.
  }
}

function closeWindow() {
  api.close();
}

$('#btn-close').addEventListener('click', closeWindow);
$('#btn-cancel').addEventListener('click', closeWindow);

$('#btn-uninstall').addEventListener('click', async () => {
  const options = {
    settings: $('#opt-settings').checked,
    ocr: $('#opt-ocr').checked,
  };

  $('#btn-uninstall').disabled = true;
  $('#btn-cancel').disabled = true;

  // Switch to the status view.
  $('#main').classList.add('hidden');
  $('#status-view').classList.remove('hidden');
  $('#status-text').textContent =
    'Removing Hiraganized…\n\nA Windows prompt may ask for permission. Please approve it so cleanup can finish.';

  const result = await api.execute(options);

  if (!result.success) {
    $('#status-text').textContent =
      `Uninstall could not start:\n${result.error || 'Unknown error'}\n\nYou can close this window and try again.`;
    return;
  }

  // Cleanup runs after this process exits; the window closes momentarily.
  $('#status-text').textContent = 'Finishing up…\n\nHiraganized will now close.';
}, { once: false });

init();
