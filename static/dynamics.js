// ── Dynamics Automation Curve Editor ─────────────────────────────────────────
window._dynPoints = [{ x: 0, y: 50 }, { x: 100, y: 50 }];
window._dynDragging = null;

const DYN_PRESETS = {
  'Build & Drop': [{ x: 0, y: 20 }, { x: 60, y: 85 }, { x: 70, y: 95 }, { x: 75, y: 10 }, { x: 100, y: 60 }],
  'Constant High': [{ x: 0, y: 80 }, { x: 100, y: 80 }],
  'Wave': [{ x: 0, y: 30 }, { x: 25, y: 80 }, { x: 50, y: 30 }, { x: 75, y: 80 }, { x: 100, y: 30 }],
  'Crescendo': [{ x: 0, y: 10 }, { x: 100, y: 90 }],
  'Decrescendo': [{ x: 0, y: 90 }, { x: 100, y: 10 }],
};

function loadDynPreset(name) {
  _dynPoints = DYN_PRESETS[name].map(p => ({ ...p }));
  renderDynamics();
}

function renderDynamics() {
  const canvas = document.getElementById('dyn-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.parentElement.clientWidth;
  const h = canvas.height = 140;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1c1917';
  ctx.fillRect(0, 0, w, h);
  // Grid
  ctx.strokeStyle = '#292524';
  ctx.lineWidth = 1;
  for (let y = 0; y <= 100; y += 25) {
    const py = h - (y / 100) * h;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
  }
  // Curve
  const sorted = [..._dynPoints].sort((a, b) => a.x - b.x);
  ctx.beginPath();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  sorted.forEach((p, i) => {
    const px = (p.x / 100) * w;
    const py = h - (p.y / 100) * h;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();
  // Points
  sorted.forEach(p => {
    const px = (p.x / 100) * w;
    const py = h - (p.y / 100) * h;
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0c0a09';
    ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
  });
}

function initDynCanvas() {
  const canvas = document.getElementById('dyn-canvas');
  if (!canvas) return;
  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = (1 - (e.clientY - rect.top) / rect.height) * 100;
    _dynPoints.push({ x: Math.round(x), y: Math.round(y) });
    renderDynamics();
  });
}
