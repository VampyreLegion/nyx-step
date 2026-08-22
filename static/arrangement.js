// ── Arrangement Builder ──────────────────────────────────────────────────────
window._arrState = { sections: [], tempo: 120, id: null, name: '' };

const SECTION_TYPES = [
  { type: 'intro', label: 'Intro', color: '#10b981' },
  { type: 'verse', label: 'Verse', color: '#3b82f6' },
  { type: 'chorus', label: 'Chorus', color: '#f59e0b' },
  { type: 'bridge', label: 'Bridge', color: '#a855f7' },
  { type: 'break', label: 'Break', color: '#6b7280' },
  { type: 'drop', label: 'Drop', color: '#ef4444' },
  { type: 'build', label: 'Build', color: '#f97316' },
  { type: 'outro', label: 'Outro', color: '#14b8a6' },
  { type: 'custom', label: 'Custom', color: '#9ca3af' },
];

function addArrangementSection(type = 'verse') {
  const info = SECTION_TYPES.find(s => s.type === type) || SECTION_TYPES[8];
  _arrState.sections.push({ type, name: info.label, caption: '', lyrics: '', duration: 30 });
  renderArrangement();
}

function removeArrangementSection(idx) {
  _arrState.sections.splice(idx, 1);
  renderArrangement();
}

function moveArrangementSection(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= _arrState.sections.length) return;
  [_arrState.sections[idx], _arrState.sections[newIdx]] = [_arrState.sections[newIdx], _arrState.sections[idx]];
  renderArrangement();
}

function renderArrangement() {
  const el = document.getElementById('arrangement-timeline');
  if (!el) return;
  let html = '<div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">';
  SECTION_TYPES.forEach(s => {
    html += `<button onclick="addArrangementSection('${s.type}')" style="padding:4px 10px;border-radius:6px;border:1px solid ${s.color}40;background:${s.color}15;color:${s.color};font-size:11px;font-weight:700;cursor:pointer">+ ${s.label}</button>`;
  });
  html += '</div><div style="display:flex;flex-direction:column;gap:6px">';
  _arrState.sections.forEach((sec, i) => {
    const info = SECTION_TYPES.find(s => s.type === sec.type) || SECTION_TYPES[8];
    html += `<div style="display:flex;align-items:center;gap:8px;padding:10px;border-radius:8px;background:#1c1917;border-left:4px solid ${info.color}">
      <span style="color:${info.color};font-weight:800;font-size:12px;min-width:60px">${info.label}</span>
      <input value="${sec.caption}" placeholder="Tags/caption..." onchange="_arrState.sections[${i}].caption=this.value" style="flex:1;padding:6px;border-radius:6px;border:1px solid #292524;background:#0c0a09;color:#e7e5e4;font-size:12px">
      <input type="number" value="${sec.duration}" min="5" max="300" onchange="_arrState.sections[${i}].duration=+this.value" style="width:60px;padding:6px;border-radius:6px;border:1px solid #292524;background:#0c0a09;color:#e7e5e4;font-size:12px;text-align:center">
      <span style="color:#78716c;font-size:10px">sec</span>
      <button onclick="moveArrangementSection(${i},-1)" style="padding:4px;background:none;border:none;color:#78716c;cursor:pointer">&#9650;</button>
      <button onclick="moveArrangementSection(${i},1)" style="padding:4px;background:none;border:none;color:#78716c;cursor:pointer">&#9660;</button>
      <button onclick="removeArrangementSection(${i})" style="padding:4px;background:none;border:none;color:#ef4444;cursor:pointer">&times;</button>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

async function generateArrangement() {
  if (!_arrState.sections.length) return alert('Add sections first');
  const nameEl = document.getElementById('arr-name');
  const name = nameEl ? nameEl.value : 'Arrangement';
  const statusEl = document.getElementById('arr-status');
  if (statusEl) statusEl.textContent = 'Saving arrangement...';
  const res = await fetch('/api/arrangements', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ name, sections: _arrState.sections, tempo: _arrState.tempo }),
  });
  const data = await res.json();
  if (!data.ok) { if (statusEl) statusEl.textContent = 'Error saving'; return; }
  _arrState.id = data.id;
  if (statusEl) statusEl.textContent = 'Generating sections...';
  const gen = await fetch(`/api/arrangements/${data.id}/generate`, { method: 'POST' });
  const genData = await gen.json();
  if (statusEl) statusEl.textContent = `Queued ${genData.queued.length} of ${genData.total} sections`;
}

// ── Arrange subtabs ─────────────────────────────────────────────────────────
function showArrSubtab(id) {
  document.querySelectorAll('.arr-subpanel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.arr-subtab').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById(id);
  if (panel) panel.style.display = '';
  event.target.classList.add('active');
}
