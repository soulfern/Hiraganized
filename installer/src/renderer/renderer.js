const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let cleanup;

// ── Title bar ──────────────────────────────────────────────────────────────────

$('#btnMin').onclick = () => {};
$('#btnClose').onclick = () => window.close();

// ── Page switching ─────────────────────────────────────────────────────────────

function showPage(id) {
  $$('.page').forEach((p) => p.classList.remove('active'));
  $(`#page-${id}`).classList.add('active');
}

function setStep(idx, state) {
  const el = $(`#s${idx}`);
  el.className = 'tl-step';
  if (state === 'active') el.classList.add('active');
  if (state === 'done') el.classList.add('done');
}

// ── Welcome ────────────────────────────────────────────────────────────────────

$('#btnBrowse').onclick = async () => {
  const dir = await window.installer.selectDir();
  if (dir) $('#installDir').value = dir;
};

$('#btnInstall').onclick = () => startInstall();

// ── Install ────────────────────────────────────────────────────────────────────

const STEPS = [
  { label: 'Copying files', id: 1 },
  { label: 'Python', id: 2 },
  { label: 'manga-ocr', id: 3 },
  { label: 'Shortcuts', id: 4 },
];

function buildProgressList() {
  const list = $('#progressList');
  list.innerHTML = '';
  STEPS.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'progress-item';
    div.id = `pitem-${i}`;
    div.innerHTML = `
      <div class="row">
        <span class="plabel">${s.label}</span>
        <span class="ppct">—</span>
      </div>
      <div class="detail"></div>
      <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
    `;
    list.appendChild(div);
  });
}

function updateProgress(data) {
  const item = $(`#pitem-${data.step}`);
  if (!item) return;

  const pctEl = item.querySelector('.ppct');
  const fill = item.querySelector('.bar-fill');
  const detail = item.querySelector('.detail');

  if (data.detail) detail.textContent = data.detail;

  if (data.pct === -1) {
    pctEl.textContent = '…';
    fill.style.width = '40%';
    fill.classList.add('indeterminate');
  } else {
    fill.classList.remove('indeterminate');
    pctEl.textContent = `${data.pct}%`;
    fill.style.width = `${data.pct}%`;
  }
}

async function startInstall() {
  const dir = $('#installDir').value.trim();
  if (!dir) return;

  $('#btnInstall').disabled = true;

  showPage('progress');
  buildProgressList();
  setStep(0, 'done');
  setStep(1, 'active');

  cleanup = window.installer.onProgress((data) => {
    updateProgress(data);
  });

  const result = await window.installer.run(dir);

  if (result.cancelled) {
    window.close();
    return;
  }

  if (!result.success) {
    showPage('welcome');
    setStep(0, 'active');
    setStep(1, '');
    $('#btnInstall').disabled = false;
    $('#btnInstall').textContent = 'Retry';
    alert(`Installation failed:\n${result.error}`);
    return;
  }

  setStep(1, 'done');
  setStep(2, 'active');
  showPage('done');
  window._installDir = result.installDir;
}

// ── Cancel ─────────────────────────────────────────────────────────────────────

$('#btnCancel').onclick = async () => {
  await window.installer.cancel();
};

// ── Finish ─────────────────────────────────────────────────────────────────────

$('#btnFinish').onclick = async () => {
  const launch = $('#chkLaunch').checked;
  const dir = window._installDir || $('#installDir').value;
  $('#btnFinish').disabled = true;

  if (launch && dir) {
    await window.installer.launchApp(dir);
  } else {
    window.close();
  }
};
