// ── Layer Stacking ──────────────────────────────────────────────────────────
window._layerState = { layers: [] };

function addLayer() {
  _layerState.layers.push({ name: `Layer ${_layerState.layers.length + 1}`, prompt: '', volume: 1.0, pan: 0 });
  renderLayers();
}

function removeLayer(idx) {
  _layerState.layers.splice(idx, 1);
  renderLayers();
}

function renderLayers() {
  const el = document.getElementById('layers-panel');
  if (!el) return;
  let html = '<div style="display:flex;flex-direction:column;gap:6px">';
  _layerState.layers.forEach((layer, i) => {
    html += `<div style="padding:10px;border-radius:8px;background:#1c1917;border:1px solid #292524">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <input value="${layer.name}" onchange="_layerState.layers[${i}].name=this.value" style="width:100px;padding:4px;border-radius:4px;border:1px solid #292524;background:#0c0a09;color:#e7e5e4;font-size:11px;font-weight:700">
        <input type="range" min="0" max="100" value="${Math.round(layer.volume*100)}" onchange="_layerState.layers[${i}].volume=this.value/100" style="flex:1">
        <span style="font-size:10px;color:#78716c;min-width:30px">Vol</span>
        <input type="range" min="-100" max="100" value="${Math.round(layer.pan*100)}" onchange="_layerState.layers[${i}].pan=this.value/100" style="width:60px">
        <span style="font-size:10px;color:#78716c;min-width:24px">Pan</span>
        <button onclick="removeLayer(${i})" style="padding:2px 6px;background:none;border:none;color:#ef4444;cursor:pointer">&times;</button>
      </div>
      <textarea rows="2" placeholder="Describe this layer..." onchange="_layerState.layers[${i}].prompt=this.value" style="width:100%;padding:6px;border-radius:6px;border:1px solid #292524;background:#0c0a09;color:#e7e5e4;font-size:11px;resize:vertical">${layer.prompt}</textarea>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

async function generateLayers() {
  if (!_layerState.layers.length) return alert('Add layers first');
  const statusEl = document.getElementById('layers-status');
  if (statusEl) statusEl.textContent = 'Generating layers...';
  const res = await fetch('/layers/generate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ layers: _layerState.layers, song_name: 'Layered Track', duration: 30 }),
  });
  const data = await res.json();
  if (statusEl) statusEl.textContent = `Queued ${data.queued.length} layers`;
}
