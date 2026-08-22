// ── Phase 4: Mood Arc editor ─────────────────────────────────────────────────
// Canvas-based curve editor: drag points across the timeline (x = position in
// song, y = mood lane), build an emotional journey, get genre tag suggestions.

const MOOD_LANES = [           // bottom → top on canvas
  { name: "Dark",       color: "#7c3aed" },
  { name: "Angry",      color: "#ff6b6b" },
  { name: "Anxious",    color: "#ffcc44" },
  { name: "Melancholy", color: "#4a7fd9" },
  { name: "Nostalgic",  color: "#d98cb3" },
  { name: "Chill",      color: "#00d4b6" },
  { name: "Uplifting",  color: "#8bd450" },
  { name: "Euphoric",   color: "#f5d90a" },
];
const _moodNames = MOOD_LANES.map(m => m.name);

let _arcPoints = [];          // [{position: 0-100, mood: "Chill"}]
let _arcDragIdx = -1;
let _arcCanvas, _arcCtx;

const ARC_LANE_COLORS = Object.fromEntries(MOOD_LANES.map(m => [m.name, m.color]));

function initMoodArc() {
  if (_arcCanvas) return;
  _arcCanvas = document.getElementById("mood-arc-canvas");
  if (!_arcCanvas) return;
  _arcCtx = _arcCanvas.getContext("2d");

  const resize = () => {
    const w = _arcCanvas.parentElement.clientWidth || 800;
    _arcCanvas.width = w * devicePixelRatio;
    _arcCanvas.height = 260 * devicePixelRatio;
    _arcCanvas.style.width = w + "px";
    _arcCanvas.style.height = "260px";
    drawMoodArc();
  };
  window.addEventListener("resize", resize);
  resize();

  _arcCanvas.addEventListener("pointerdown", _arcPointerDown);
  _arcCanvas.addEventListener("pointermove", _arcPointerMove);
  _arcCanvas.addEventListener("pointerup", _arcPointerUp);
  _arcCanvas.addEventListener("pointerleave", _arcPointerUp);
  _arcCanvas.addEventListener("dblclick", _arcDblClick);

  // Start with a simple two-point arc so the canvas is never blank.
  _arcPoints = [
    { position: 10, mood: "Melancholy" },
    { position: 85, mood: "Uplifting" },
  ];
  drawMoodArc();
  loadMoodArcPresets();
  suggestGenreFromArc();
}

function _arcLaneAtY(yCss) {
  const h = 260, topPad = 26, bottomPad = 14;
  const laneH = (h - topPad - bottomPad) / MOOD_LANES.length;
  let lane = Math.floor((yCss - topPad) / laneH);
  return Math.max(0, Math.min(MOOD_LANES.length - 1, lane));
}
function _laneToY(lane) {
  const h = 260, topPad = 26, bottomPad = 14;
  const laneH = (h - topPad - bottomPad) / MOOD_LANES.length;
  return topPad + lane * laneH + laneH / 2;
}
function _posToX(pos) {
  const w = _arcCanvas.clientWidth || 800, padL = 96, padR = 14;
  return padL + (pos / 100) * (w - padL - padR);
}
function _xToPos(xCss) {
  const w = _arcCanvas.clientWidth || 800, padL = 96, padR = 14;
  return Math.max(0, Math.min(100, ((xCss - padL) / (w - padL - padR)) * 100));
}

function drawMoodArc() {
  if (!_arcCtx) return;
  const ctx = _arcCtx;
  const w = _arcCanvas.clientWidth || 800, h = 260;
  ctx.save();
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);

  // Lanes
  const topPad = 26, bottomPad = 14;
  const laneH = (h - topPad - bottomPad) / MOOD_LANES.length;
  MOOD_LANES.forEach((m, i) => {
    const y = topPad + i * laneH;
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)";
    ctx.fillRect(96, y, w - 96 - 14, laneH);
    ctx.fillStyle = m.color;
    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(m.name, 90, y + laneH / 2 + 4);
  });

  // Time gridlines every 25%
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (let p = 0; p <= 100; p += 25) {
    const x = _posToX(p);
    ctx.beginPath(); ctx.moveTo(x, topPad); ctx.lineTo(x, h - bottomPad); ctx.stroke();
    ctx.fillStyle = "#8a8f9e"; ctx.font = "10px system-ui"; ctx.textAlign = "center";
    ctx.fillText(p + "%", x, h - 3);
  }

  if (_arcPoints.length) {
    // Curve through points
    const pts = [..._arcPoints].sort((a, b) => a.position - b.position)
      .map(p => ({ x: _posToX(p.position), y: _laneToY(_moodNames.indexOf(p.mood)) }));
    ctx.strokeStyle = "#00d4b6";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1].x + pts[i].x) / 2;
      ctx.quadraticCurveTo(mx, pts[i - 1].y, pts[i].x, pts[i].y);
    }
    ctx.stroke();

    // Points
    pts.forEach((pt, i) => {
      const mood = [..._arcPoints].sort((a, b) => a.position - b.position)[i].mood;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, _arcDragIdx === i ? 9 : 6.5, 0, Math.PI * 2);
      ctx.fillStyle = ARC_LANE_COLORS[mood] || "#fff";
      ctx.fill();
      ctx.strokeStyle = "#0b0c10";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#e2e4ed";
      ctx.font = "10px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(Math.round([..._arcPoints].sort((a, b) => a.position - b.position)[i].position) + "%", pt.x, pt.y - 12);
    });
  }
  ctx.restore();
}

function _arcHitTest(xCss, yCss) {
  const sorted = [..._arcPoints].sort((a, b) => a.position - b.position);
  for (let i = 0; i < sorted.length; i++) {
    const px = _posToX(sorted[i].position);
    const py = _laneToY(_moodNames.indexOf(sorted[i].mood));
    if (Math.hypot(px - xCss, py - yCss) < 12) return i;
  }
  return -1;
}

function _arcEventPos(ev) {
  const rect = _arcCanvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function _arcPointerDown(ev) {
  const { x, y } = _arcEventPos(ev);
  const hit = _arcHitTest(x, y);
  if (hit >= 0) {
    _arcDragIdx = hit;
    _arcCanvas.setPointerCapture(ev.pointerId);
  } else {
    // Click empty space → add a point there
    const sorted = [..._arcPoints].sort((a, b) => a.position - b.position);
    if (sorted.some(p => Math.abs(_posToX(p.position) - x) < 18)) return;
    _addArcPoint(Math.round(_xToPos(x)), MOOD_LANES[_arcLaneAtY(y)].name);
  }
  drawMoodArc();
}

function _arcPointerMove(ev) {
  if (_arcDragIdx < 0) return;
  const { x, y } = _arcEventPos(ev);
  const sorted = [..._arcPoints].sort((a, b) => a.position - b.position);
  const pos = Math.round(_xToPos(x));
  // Keep ordering sane: don't allow dragging past neighbours
  const minP = _arcDragIdx > 0 ? sorted[_arcDragIdx - 1].position + 1 : 0;
  const maxP = _arcDragIdx < sorted.length - 1 ? sorted[_arcDragIdx + 1].position - 1 : 100;
  const mood = MOOD_LANES[_arcLaneAtY(y)].name;

  // Find the original object this drag index refers to and update it.
  const target = sorted[_arcDragIdx];
  target.position = Math.max(minP, Math.min(maxP, pos));
  target.mood = mood;
  drawMoodArc();
}

function _arcPointerUp() {
  if (_arcDragIdx >= 0) {
    _arcDragIdx = -1;
    drawMoodArc();
    suggestGenreFromArc();
  }
}

function _arcDblClick(ev) {
  const { x, y } = _arcEventPos(ev);
  const hit = _arcHitTest(x, y);
  if (hit < 0) return;
  if (_arcPoints.length <= 1) { showToast("A mood arc needs at least one point", "warning"); return; }
  const sorted = [..._arcPoints].sort((a, b) => a.position - b.position);
  _arcPoints.splice(_arcPoints.indexOf(sorted[hit]), 1);
  drawMoodArc();
  suggestGenreFromArc();
}

function _addArcPoint(position, mood) {
  if (_arcPoints.length >= 32) { showToast("Max 32 points", "warning"); return; }
  _arcPoints.push({ position, mood });
  _arcPoints.sort((a, b) => a.position - b.position);
  drawMoodArc();
  suggestGenreFromArc();
}

// Mood palette chips — click to add a point at the next free slot.
function renderMoodPalette() {
  const wrap = document.getElementById("mood-palette");
  wrap.innerHTML = "";
  MOOD_LANES.forEach(m => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.borderColor = m.color;
    chip.title = `Add a ${m.name} point`;
    chip.innerHTML = `<span style="color:${m.color}">●</span> ${m.name}`;
    chip.addEventListener("click", () => {
      const taken = new Set(_arcPoints.map(p => Math.round(p.position / 5)));
      let pos = 50;
      for (let cand = 5; cand <= 95; cand += 5) {
        if (!taken.has(cand / 5)) { pos = cand; break; }
      }
      _addArcPoint(pos, m.name);
    });
    wrap.appendChild(chip);
  });
}

// ── Genre suggestion from arc shape ──────────────────────────────────────────

function suggestGenreFromArc() {
  const out = document.getElementById("mood-genre-suggest");
  if (!out) return;
  if (!_arcPoints.length) { out.innerHTML = ""; return; }
  const pts = [..._arcPoints].sort((a, b) => a.position - b.position);
  const idxs = pts.map(p => _moodNames.indexOf(p.mood));
  const startI = idxs[0], endI = idxs[idxs.length - 1];
  const counts = {};
  idxs.forEach(i => { counts[i] = (counts[i] || 0) + 1; });
  const dominant = _moodNames[Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]];
  const variance = Math.max(...idxs) - Math.min(...idxs);
  const rises = endI > startI + 1, falls = endI < startI - 1;
  const lowAvg = idxs.reduce((s, i) => s + i, 0) / idxs.length < 2.5;
  const highAvg = idxs.reduce((s, i) => s + i, 0) / idxs.length > 5;

  const genres = [], tags = [];
  if (rises && highAvg) { genres.push("uplifting trance"); tags.push("epic build-up", "euphoric drop"); }
  else if (rises) { genres.push("progressive house"); tags.push("gradual build", "emotional lift"); }
  if (falls && lowAvg) { genres.push("dark ambient"); tags.push("descent into darkness", "dread"); }
  else if (falls) { genres.push("cinematic"); tags.push("tragic turn", "emotional fall"); }
  if (["Dark", "Angry"].includes(dominant)) { genres.push("industrial techno"); tags.push("dark atmosphere", "aggressive drive"); }
  if (dominant === "Melancholy") { genres.push("shoegaze"); tags.push("melancholic wash", "dreamy reverb"); }
  if (dominant === "Nostalgic") { genres.push("synthwave"); tags.push("retro nostalgia", "hazy memory"); }
  if (["Chill"].includes(dominant)) { genres.push("chillout"); tags.push("laid-back groove", "relaxed"); }
  if (dominant === "Euphoric") { genres.push("euphoric edm"); tags.push("hands-up energy", "bright supersaw"); }
  if (dominant === "Anxious") { genres.push("idm"); tags.push("tense textures", "restless rhythm"); }
  if (variance >= 4) { tags.push("dynamic emotional journey"); }
  else if (variance <= 1) { tags.push("static mood", "minimal evolution"); }
  if (!genres.length) genres.push("ambient pop");

  const uniqueGenres = [...new Set(genres)].slice(0, 3);
  const uniqueTags = [...new Set(tags)];
  out.dataset.tags = JSON.stringify(uniqueTags);
  out.innerHTML =
    `<div style="margin-bottom:4px;color:var(--muted)">Shape says: <b>${esc(uniqueGenres.join(" / "))}</b></div>` +
    `<div>${uniqueTags.map(t => `<span class="tag-btn">${esc(t)}</span>`).join("")}</div>` +
    `<button class="secondary small" id="btn-mood-tags-apply" style="margin-top:6px;font-size:11px;padding:2px 8px">
       ➕ Add ${uniqueTags.length} tags to caption</button>`;
  out.querySelector("#btn-mood-tags-apply").addEventListener("click", () => {
    const el = document.getElementById("overview-tags");
    const existing = el.value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const add = uniqueTags.filter(t => !existing.includes(t.toLowerCase()));
    el.value = el.value ? el.value.replace(/\s*$/, "") + ", " + add.join(", ") : add.join(", ");
    updateTagTokenCount();
    showToast(`Added ${add.length} mood arc tags`, "success");
  });
}

// ── Preset save / load ───────────────────────────────────────────────────────

async function loadMoodArcPresets() {
  const sel = document.getElementById("mood-arc-preset-select");
  try {
    const data = await fetch("/api/mood-arcs").then(r => r.json());
    window._moodArcPresets = data.arcs || [];
    sel.innerHTML = `<option value="">— saved arcs —</option>` +
      (data.arcs || []).map(a => `<option value="${a.id}">${esc(a.name)} (${a.data.length} pts)</option>`).join("");
  } catch (_) {
    sel.innerHTML = `<option value="">— load failed —</option>`;
  }
}

async function saveMoodArcPreset() {
  const input = document.getElementById("mood-arc-name");
  const name = input.value.trim();
  if (!name) { alert("Give the mood arc a name first."); return; }
  if (!_arcPoints.length) { alert("Add at least one point first."); return; }
  try {
    const resp = await fetch("/api/mood-arcs", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ name, data: _arcPoints }),
    });
    const d = await resp.json();
    if (!resp.ok || d.error) { alert("Save failed: " + (d.error || resp.statusText)); return; }
    showToast(`Saved preset "${name}"`, "success");
    input.value = "";
    loadMoodArcPresets();
  } catch (e) { alert("Save error: " + e.message); }
}

function applySelectedMoodArc(id) {
  const presets = window._moodArcPresets || [];
  const arc = presets.find(a => String(a.id) === String(id));
  if (!arc) return;
  _arcPoints = arc.data.map(p => ({
    position: Math.max(0, Math.min(100, Number(p.position) || 0)),
    mood: _moodNames.includes(p.mood) ? p.mood : "Chill",
  })).sort((a, b) => a.position - b.position);
  drawMoodArc();
  suggestGenreFromArc();
  showToast(`Loaded "${arc.name}"`, "info");
}

async function deleteSelectedMoodArc() {
  const sel = document.getElementById("mood-arc-preset-select");
  const id = sel.value;
  if (!id) { alert("Select a saved arc to delete."); return; }
  if (!confirm("Delete this mood arc preset?")) return;
  try {
    const resp = await fetch("/api/mood-arcs/" + id, { method: "DELETE" });
    const d = await resp.json();
    if (!resp.ok || d.error) { alert("Delete failed: " + (d.error || resp.statusText)); return; }
    sel.value = "";
    loadMoodArcPresets();
  } catch (e) { alert("Delete error: " + e.message); }
}

document.getElementById("btn-mood-save")?.addEventListener("click", saveMoodArcPreset);
document.getElementById("mood-arc-preset-select")?.addEventListener("change", e => applySelectedMoodArc(e.target.value));
document.getElementById("btn-mood-delete")?.addEventListener("click", deleteSelectedMoodArc);
document.getElementById("btn-mood-clear")?.addEventListener("click", () => {
  _arcPoints = [];
  drawMoodArc();
  suggestGenreFromArc();
});

