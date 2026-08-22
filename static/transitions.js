// ── Tempo/Key Transitions ───────────────────────────────────────────────────
window._transitions = [];

function addTransition() {
  const bar = parseInt(document.getElementById('trans-bar')?.value || '8');
  const bpm = parseInt(document.getElementById('trans-bpm')?.value || '120');
  const key = document.getElementById('trans-key')?.value || '';
  const type = document.getElementById('trans-type')?.value || 'sudden';
  _transitions.push({ bar, bpm, key, type });
  _transitions.sort((a, b) => a.bar - b.bar);
  renderTransitions();
}

function removeTransition(idx) {
  _transitions.splice(idx, 1);
  renderTransitions();
}

function renderTransitions() {
  const el = document.getElementById('trans-list');
  if (!el) return;
  let html = '';
  _transitions.forEach((t, i) => {
    html += `<div style="display:flex;gap:6px;align-items:center;padding:6px 10px;border-radius:6px;background:#1c1917;border:1px solid #292524">
      <span style="color:#f59e0b;font-weight:700;font-size:11px">Bar ${t.bar}</span>
      <span style="color:#e7e5e4;font-size:11px">${t.bpm} BPM</span>
      ${t.key ? `<span style="color:#a855f7;font-size:11px">${t.key}</span>` : ''}
      <span style="color:#78716c;font-size:10px">${t.type}</span>
      <button onclick="removeTransition(${i})" style="margin-left:auto;padding:2px;background:none;border:none;color:#ef4444;cursor:pointer">&times;</button>
    </div>`;
  });
  el.innerHTML = html;
}
