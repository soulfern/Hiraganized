const appApi = window.hiraganized;
let allEntries = [];
let currentIndex = 0;
let fontScale = 1;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function applyAppearance(state) {
  const theme = state.settings?.appearance?.theme || 'midnight';
  document.documentElement.dataset.theme = theme;
  fontScale = Number(state.settings?.appearance?.fontScale) || 1;


  document.documentElement.style.fontSize = `${13 * fontScale}px`;
}

function render(payload) {
  allEntries = payload.entries || [];
  currentIndex = 0;
  document.body.classList.remove('closing');
  renderTabs();
  renderEntry(0);
  fitToContent();
}

function fitToContent() {


  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const card = document.querySelector('.popup-card');
      const height = Math.ceil(card.getBoundingClientRect().height);
      appApi.resizePopup(height);
    });
  });
}

function renderTabs() {
  const bar = $('#tab-bar');
  bar.innerHTML = '';
  allEntries.forEach((entry, i) => {
    const tab = document.createElement('button');
    tab.className = 'tab-item' + (i === currentIndex ? ' active' : '');
    tab.textContent = entry.character || '�';
    tab.addEventListener('click', () => selectTab(i));
    bar.appendChild(tab);
  });
}

function selectTab(index) {
  if (index === currentIndex) return;
  currentIndex = index;
  $$('.tab-item').forEach((t, i) => t.classList.toggle('active', i === index));
  renderEntry(index);
  fitToContent();

}

function renderEntry(index) {
  const entry = allEntries[index];
  if (!entry) return;

  const charEl = $('#popup-char');
  charEl.textContent = entry.character || '';

  const len = (entry.character || '').length;
  charEl.style.fontSize = len <= 1 ? '2.6rem' : len <= 2 ? '2.2rem' : len <= 3 ? '1.9rem' : '1.55rem';

  const readingEl = $('#popup-reading');
  const kunEl = $('#popup-reading-kun');

  if (entry.isCompound) {


    readingEl.textContent = (entry.readings || []).join(' · ');
    kunEl.textContent = '';
  } else {
    const onyomi = (entry.onyomi || []).join(' · ');
    const kunyomi = (entry.kunyomi || []).join(' · ');
    readingEl.textContent = onyomi ? `On: ${onyomi}` : '—';
    kunEl.textContent = kunyomi ? `Kun: ${kunyomi}` : '';
  }

  const meanings = (entry.meanings || []).slice(0, 4).join(' · ');
  $('#popup-meaning').textContent = meanings || '—';

  const jlpt = entry.jlpt ? 'JLPT ' + entry.jlpt : '';
  $('#popup-jlpt').textContent = jlpt;
}

function resetPopupView() {
  document.body.classList.remove('closing');
  $('#tab-bar').innerHTML = '';
  $('#popup-reading').textContent = '';
  $('#popup-reading-kun').textContent = '';
  $('#popup-meaning').textContent = '';
  $('#popup-jlpt').textContent = '';
  $('#popup-char').textContent = '';
  $('#popup-char').style.fontSize = '';
  $('#popup-reading').style.fontSize = '';
  $('#popup-reading').style.fontWeight = '';
}

appApi.onPopupPayload(render);
appApi.onOcrResult((text) => {
  resetPopupView();
  const re = $('#popup-reading');
  re.textContent = text;
  re.style.fontSize = text.length > 40 ? '0.85rem' : '1rem';
  re.style.fontWeight = '400';
  fitToContent();
});
appApi.onPopupWarning((message) => {
  resetPopupView();
  const pc = $('#popup-char');
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
  fitToContent();
});
appApi.onState(applyAppearance);

$('#popup-close').addEventListener('click', () => window.close());
