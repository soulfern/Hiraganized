const appApi = window.hiraganized;

const overlay = document.getElementById('overlay');
const selectionBox = document.getElementById('selectionBox');
const info = document.getElementById('info');

let startX = 0, startY = 0;
let isDragging = false;

function updateSelection(x1, y1, x2, y2) {
  const l = Math.min(x1, x2);
  const t = Math.min(y1, y2);
  const r = Math.max(x1, x2);
  const b = Math.max(y1, y2);
  selectionBox.style.left = l + 'px';
  selectionBox.style.top = t + 'px';
  selectionBox.style.width = (r - l) + 'px';
  selectionBox.style.height = (b - t) + 'px';
  selectionBox.style.display = 'block';
}

overlay.addEventListener('mousedown', (e) => {
  isDragging = true;
  startX = e.clientX;
  startY = e.clientY;
  selectionBox.style.display = 'none';
  info.textContent = 'Release to capture this region';
});

overlay.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  updateSelection(startX, startY, e.clientX, e.clientY);
});

document.addEventListener('mouseup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  if (w < 10 || h < 10) {
    info.textContent = 'Selection too small. Drag to select a region.';
    selectionBox.style.display = 'none';
    return;
  }
  appApi.commitSelection({ x, y, width: w, height: h });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    appApi.cancelSelection();
  }
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
