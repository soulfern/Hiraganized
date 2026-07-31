const appApi = window.hiraganized;
let allEntries = [];
let currentIndex = 0;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function render(payload) {
  allEntries = payload.entries || [];
  currentIndex = 0;
  document.body.classList.remove('closing');
  renderTabs();
  renderEntry(0);
}

function renderTabs() {
  const bar = $('#tab-bar');
  bar.innerHTML = '';
  allEntries.forEach((entry, i) => {
    const tab = document.createElement('button');
    tab.className = 'tab-item' + (i === currentIndex ? ' active' : '');
    tab.textContent = entry.character || '\uFFFD';
    tab.addEventListener('click', () => selectTab(i));
    bar.appendChild(tab);
  });
}

function selectTab(index) {
  if (index === currentIndex) return;
  currentIndex = index;
  $$('.tab-item').forEach((t, i) => t.classList.toggle('active', i === index));
  renderEntry(index);
}

function renderEntry(index) {
  const entry = allEntries[index];
  if (!entry) return;

  const charEl = $('#popup-char');
  charEl.textContent = entry.character || '';

  const len = (entry.character || '').length;
  if (len <= 1) charEl.style.fontSize = '32px';
  else if (len <= 2) charEl.style.fontSize = '28px';
  else if (len <= 3) charEl.style.fontSize = '24px';
  else charEl.style.fontSize = '20px';

  let readings;
  if (entry.isCompound) {
    readings = (entry.readings || []).join(' \u00b7 ');
  } else {
    readings = [...(entry.onyomi || []), ...(entry.kunyomi || [])].join(' \u00b7 ');
  }
  if (!readings && entry.readings) readings = entry.readings.join(' \u00b7 ');
  $('#popup-reading').textContent = readings || '\u2014';

  const meanings = (entry.meanings || []).slice(0, 4).join(' \u00b7 ');
  $('#popup-meaning').textContent = meanings || '\u2014';

  const jlpt = entry.jlpt ? 'JLPT ' + entry.jlpt : '';
  $('#popup-jlpt').textContent = jlpt;
}

appApi.onPopupPayload(render);
appApi.onOcrResult((text) => {
  document.body.classList.remove('closing');
  $('#popup-char').textContent = '';
  const re = $('#popup-reading');
  re.textContent = text;
  re.style.fontSize = text.length > 40 ? '11px' : '13px';
  re.style.fontWeight = '400';
  $('#popup-jlpt').textContent = '';
  $('#popup-meaning').textContent = '';
  $('#tab-bar').innerHTML = '';
});
appApi.onPopupWarning((message) => {
  document.body.classList.remove('closing');
  $('#tab-bar').innerHTML = '';
  $('#popup-reading').textContent = '';
  $('#popup-meaning').textContent = '';
  $('#popup-jlpt').textContent = '';
  const pc = $('#popup-char');
  pc.textContent = '';
  const lines = message.split('\n');
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:6px;';
  for (const line of lines) {
    const el = document.createElement('span');
    el.textContent = line;
    el.style.cssText = line === lines[0]
      ? 'font-size:18px;font-weight:600;text-align:center;'
      : 'font-size:12px;font-weight:400;text-align:center;opacity:0.75;';
    wrapper.appendChild(el);
  }
  pc.appendChild(wrapper);
});

$('#popup-close').addEventListener('click', () => window.close());
