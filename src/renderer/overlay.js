const appApi = window.hiraganized;

const overlay = document.getElementById('overlay');
const selectionBox = document.getElementById('selectionBox');
const info = document.getElementById('info');
const lens = document.getElementById('lens');
const lensCtx = lens.getContext('2d');

const LENS_RADIUS = 75;

const LENS_ZOOM = 2;
const LENS_OFFSET = 24;

let startX = 0, startY = 0;
let isDragging = false;

let frames = [];
let magnifierEnabled = true;
let showCrosshair = false;

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

function drawLens(cx, cy) {
  if (!frames.length) return;






  const originX = Math.min(...frames.map((f) => f.displayBounds.x));
  const originY = Math.min(...frames.map((f) => f.displayBounds.y));
  const sx = cx + originX;
  const sy = cy + originY;
  const frame = frames.find((f) =>
    sx >= f.displayBounds.x && sx < f.displayBounds.x + f.displayBounds.width &&
    sy >= f.displayBounds.y && sy < f.displayBounds.y + f.displayBounds.height
  ) || frames[0];
  if (!frame) return;

  const fx = (sx - frame.displayBounds.x) * (frame.tw / frame.displayBounds.width);
  const fy = (sy - frame.displayBounds.y) * (frame.th / frame.displayBounds.height);





  const displayScaleX = frame.tw / frame.displayBounds.width;
  const displayScaleY = frame.th / frame.displayBounds.height;
  const srcRadiusX = LENS_RADIUS / displayScaleX;
  const srcRadiusY = LENS_RADIUS / displayScaleY;

  lensCtx.clearRect(0, 0, lens.width, lens.height);
  lensCtx.save();
  lensCtx.beginPath();
  lensCtx.arc(lens.width / 2, lens.height / 2, LENS_RADIUS, 0, Math.PI * 2);
  lensCtx.clip();
  lensCtx.imageSmoothingEnabled = false;
  lensCtx.drawImage(
    frame.img,
    fx - srcRadiusX / LENS_ZOOM, fy - srcRadiusY / LENS_ZOOM,
    (srcRadiusX * 2) / LENS_ZOOM, (srcRadiusY * 2) / LENS_ZOOM,
    0, 0, lens.width, lens.height
  );
  lensCtx.restore();
  lensCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  lensCtx.lineWidth = 1;
  lensCtx.beginPath();
  lensCtx.arc(lens.width / 2, lens.height / 2, LENS_RADIUS - 1, 0, Math.PI * 2);
  lensCtx.stroke();

  if (showCrosshair) {
    const cx = lens.width / 2;
    const cy = lens.height / 2;
    const arm = 8;
    lensCtx.strokeStyle = 'rgba(255,255,255,0.6)';
    lensCtx.lineWidth = 1.2;
    lensCtx.beginPath();
    lensCtx.moveTo(cx - arm, cy);
    lensCtx.lineTo(cx + arm, cy);
    lensCtx.moveTo(cx, cy - arm);
    lensCtx.lineTo(cx, cy + arm);
    lensCtx.stroke();
    lensCtx.fillStyle = 'rgba(255,255,255,0.85)';
    lensCtx.beginPath();
    lensCtx.arc(cx, cy, 1.4, 0, Math.PI * 2);
    lensCtx.fill();
  }
}

function moveLens(cx, cy) {
  drawLens(cx, cy);


  let lx = cx + LENS_OFFSET;
  if (lx + lens.width > window.innerWidth) lx = cx - LENS_OFFSET - lens.width;
  let ly = cy - lens.height / 2;
  ly = Math.max(0, Math.min(ly, window.innerHeight - lens.height));
  lens.style.left = lx + 'px';
  lens.style.top = ly + 'px';
  lens.style.display = 'block';
}

function hideLens() {
  lens.style.display = 'none';
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
  if (magnifierEnabled) moveLens(e.clientX, e.clientY);
  else hideLens();
});

document.addEventListener('mouseup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  hideLens();
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

appApi.onOverlayImage((payload) => {
  const data = payload || {};
  magnifierEnabled = data.magnifier !== false;
  showCrosshair = data.showCrosshair === true;
  frames = (data.frames || []).map((f) => ({
    img: (() => { const i = new Image(); i.src = f.dataUrl; return i; })(),
    displayBounds: f.displayBounds,
    tw: f.thumbnailWidth,
    th: f.thumbnailHeight
  }));
  if (!magnifierEnabled) hideLens();
});

appApi.onOverlayReset(() => {
  isDragging = false;
  selectionBox.style.display = 'none';
  hideLens();
  info.textContent = 'Drag to select a region • Esc to cancel';
});
