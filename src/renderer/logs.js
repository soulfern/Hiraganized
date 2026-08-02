const appApi = window.hiraganized;
const body = document.getElementById('logs-body');
let pending = [];
let flushTimer = null;

function applyAppearance(state) {
  const theme = state.settings?.appearance?.theme || 'midnight';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.font = state.settings?.appearance?.fontFamily || 'lexend';
}
appApi.onState(applyAppearance);

function levelOf(line) {
  const m = line.match(/\[(\w+)\]/);
  return m ? m[1].toUpperCase() : '';
}

function appendLine(line) {
  const div = document.createElement('div');
  div.className = 'log-line';
  const tsMatch = line.match(/^\S+ /);
  const ts = tsMatch ? tsMatch[0] : '';
  const rest = tsMatch ? line.slice(ts.length) : line;
  const lvl = levelOf(rest);
  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = ts;
  const lvlSpan = document.createElement('span');
  lvlSpan.className = `lvl-${lvl}`;
  lvlSpan.textContent = rest;
  div.appendChild(tsSpan);
  div.appendChild(lvlSpan);
  body.appendChild(div);
}

function trim() {
  while (body.childElementCount > 2000) body.removeChild(body.firstChild);
}

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  const lines = pending;
  pending = [];
  for (const line of lines) appendLine(line);
  trim();
  body.scrollTop = body.scrollHeight;
}

appApi.onLogLine((line) => {
  pending.push(line);
  if (!flushTimer) flushTimer = setTimeout(flush, 50);
});

document.getElementById('logs-close').addEventListener('click', () => appApi.closeWindow());

document.getElementById('logs-minimize').addEventListener('click', () => appApi.minimizeLogs());

const logsMaximizer = document.getElementById('logs-maximize');
const refreshMaximize = (maximized) => {
  logsMaximizer.textContent = maximized ? '\u2750' : '\u25A2';
  logsMaximizer.title = maximized ? 'Restore' : 'Maximize';
  logsMaximizer.setAttribute('aria-label', logsMaximizer.title);
};
logsMaximizer.addEventListener('click', () => appApi.maximizeLogs());
appApi.onLogsMaximized(refreshMaximize);
