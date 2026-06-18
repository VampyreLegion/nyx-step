// ── DAW piano-roll editor ─────────────────────────────────────────────────────
const _DAW_PR_ROW_H = 12;     // px per semitone
const _DAW_PR_LO = 24;        // C1
const _DAW_PR_HI = 96;        // C7
let _dawPROpen = false;
let _dawPRTrackId = null;
let _dawPRSelected = null;
let _dawPRLastDur = 0;

function _dawPRTrack() { return dawState.tracks.find(t => t.id === _dawPRTrackId) || null; }
function _dawPRSnapStep() { return (typeof _dawSnapDiv === "function" && dawState.snap) ? _dawSnapDiv() : 0.25; }

function openPianoRoll(trackId) {
  const t = dawState.tracks.find(x => x.id === trackId);
  if (!t || t.kind !== "midi") return;
  _dawPRTrackId = trackId; _dawPROpen = true; _dawPRSelected = null;
  const panel = document.getElementById("daw-pianoroll-panel");
  if (panel) panel.style.display = "block";
  dawRenderPianoRoll();
  const body = document.getElementById("daw-pr-body");
  if (body) {
    const notes = t.notes || [];
    const ref = notes.length ? Math.round(notes.reduce((a, n) => a + n.pitch, 0) / notes.length) : 60;
    body.scrollTop = Math.max(0, (_DAW_PR_HI - ref) * _DAW_PR_ROW_H - body.clientHeight / 2);
  }
}
function dawClosePianoRoll() {
  _dawPROpen = false; _dawPRSelected = null;
  const panel = document.getElementById("daw-pianoroll-panel");
  if (panel) panel.style.display = "none";
}
function dawRenderPianoRollIfOpen() {
  if (!_dawPROpen) return;
  if (!_dawPRTrack()) { dawClosePianoRoll(); return; }
  dawRenderPianoRoll();
}

function _dawPRRefreshSelection() {
  const vel = document.querySelector("#daw-pianoroll-panel input[type=range]");
  if (vel) { vel.disabled = !_dawPRSelected; if (_dawPRSelected) vel.value = _dawPRSelected.vel; }
  const grid = document.getElementById("daw-pr-grid");
  if (!grid) return;
  for (const el of grid.children) {
    if (!el._note) continue;
    el.style.outline = (el._note === _dawPRSelected) ? "2px solid #00d4b6" : "none";
    el.style.zIndex = (el._note === _dawPRSelected) ? "2" : "1";
  }
}

function dawRenderPianoRoll() {
  const panel = document.getElementById("daw-pianoroll-panel");
  const t = _dawPRTrack();
  if (!panel || !t) return;
  const prev = document.getElementById("daw-pr-body");
  const sTop = prev ? prev.scrollTop : -1, sLeft = prev ? prev.scrollLeft : 0;
  panel.innerHTML = "";

  // toolbar
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:6px";
  const title = document.createElement("strong");
  title.textContent = "🎹 " + t.name; title.style.cssText = "font-size:12px;color:#00d4b6";
  const velLab = document.createElement("label");
  velLab.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:4px";
  velLab.textContent = "Vel";
  const vel = document.createElement("input");
  vel.type = "range"; vel.min = "0"; vel.max = "127"; vel.step = "1";
  vel.value = _dawPRSelected ? _dawPRSelected.vel : 100; vel.disabled = !_dawPRSelected;
  vel.style.cssText = "width:120px";
  vel.addEventListener("input", () => {
    if (!_dawPRSelected) return;
    _dawPRSelected.vel = parseInt(vel.value, 10);
    const grid = document.getElementById("daw-pr-grid");
    if (grid) for (const el of grid.children) if (el._note === _dawPRSelected)
      el.style.opacity = (0.35 + 0.5 * (_dawPRSelected.vel / 127));
    dawMarkDirty();
  });
  velLab.appendChild(vel);
  const count = document.createElement("span");
  count.style.cssText = "font-size:11px;color:#5a5f6e"; count.textContent = (t.notes || []).length + " notes";
  const close = document.createElement("button");
  close.className = "secondary small"; close.textContent = "✕ Close";
  close.style.cssText = "font-size:11px;margin-left:auto"; close.addEventListener("click", dawClosePianoRoll);
  bar.appendChild(title); bar.appendChild(velLab); bar.appendChild(count); bar.appendChild(close);
  panel.appendChild(bar);

  // body
  const rows = _DAW_PR_HI - _DAW_PR_LO + 1;
  const totalH = rows * _DAW_PR_ROW_H;
  const body = document.createElement("div");
  body.id = "daw-pr-body";
  body.style.cssText = "display:flex;height:240px;overflow:auto;border:1px solid #2d3041;border-radius:4px;background:#0b0c10";

  // keyboard gutter
  const keys = document.createElement("div");
  keys.style.cssText = `position:sticky;left:0;z-index:3;width:42px;flex:0 0 42px;height:${totalH}px;background:#15171f;border-right:1px solid #2d3041`;
  const black = new Set([1, 3, 6, 8, 10]);
  for (let p = _DAW_PR_HI; p >= _DAW_PR_LO; p--) {
    const k = document.createElement("div");
    const isBlack = black.has(((p % 12) + 12) % 12);
    k.style.cssText = `height:${_DAW_PR_ROW_H}px;font-size:8px;color:${isBlack ? "#888" : "#cfd3df"};` +
      `background:${isBlack ? "#1a1c26" : "#22252f"};border-bottom:1px solid #14151c;padding-left:3px;cursor:pointer;box-sizing:border-box`;
    if (p % 12 === 0) k.textContent = "C" + (p / 12 - 1);
    k.addEventListener("mousedown", () => { if (typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, p, 100); });
    keys.appendChild(k);
  }
  body.appendChild(keys);

  // grid
  const arr = (typeof dawArrangementLength === "function") ? dawArrangementLength() : 16;
  const gridW = Math.max(panel.clientWidth || 600, Math.max(16, arr) * _dawPxPerSec);
  const grid = document.createElement("div");
  grid.id = "daw-pr-grid";
  const stepPx = Math.max(2, _dawPRSnapStep() * _dawPxPerSec);
  grid.style.cssText = `position:relative;height:${totalH}px;width:${gridW}px;` +
    `background-image:repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px ${_DAW_PR_ROW_H}px),` +
    `repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px ${stepPx}px)`;
  for (const n of (t.notes || [])) {
    const el = document.createElement("div");
    el._note = n;
    const top = (_DAW_PR_HI - n.pitch) * _DAW_PR_ROW_H;
    el.style.cssText = `position:absolute;left:${n.start * _dawPxPerSec}px;top:${top}px;` +
      `width:${Math.max(4, n.dur * _dawPxPerSec)}px;height:${_DAW_PR_ROW_H - 2}px;` +
      `background:${t.color};opacity:${0.35 + 0.5 * (n.vel / 127)};border-radius:2px;cursor:grab;` +
      (n === _dawPRSelected ? "outline:2px solid #00d4b6;z-index:2" : "z-index:1");
    const handle = document.createElement("div");
    handle.style.cssText = "position:absolute;right:0;top:0;width:5px;height:100%;cursor:ew-resize";
    el.appendChild(handle);
    _dawPRWireNote(el, handle, n, grid);
    grid.appendChild(el);
  }
  _dawPRWireGrid(grid);
  body.appendChild(grid);
  panel.appendChild(body);
  if (sTop >= 0) { body.scrollTop = sTop; body.scrollLeft = sLeft; }
}

function _dawPRPitchFromY(grid, clientY) {
  const r = grid.getBoundingClientRect();
  const p = _DAW_PR_HI - Math.floor((clientY - r.top) / _DAW_PR_ROW_H);
  return Math.max(_DAW_PR_LO, Math.min(_DAW_PR_HI, p));
}

function _dawPRWireGrid(grid) {
  grid.addEventListener("mousedown", e => {
    if (e.target !== grid) return;            // empty grid only
    const r = grid.getBoundingClientRect();
    const rawStart = (e.clientX - r.left) / _dawPxPerSec;
    const start = Math.max(0, (typeof _dawSnapSec === "function") ? _dawSnapSec(rawStart, e.ctrlKey) : rawStart);
    const pitch = _dawPRPitchFromY(grid, e.clientY);
    const dur = _dawPRLastDur || _dawPRSnapStep();
    const velEl = document.querySelector("#daw-pianoroll-panel input[type=range]");
    const vel = (velEl && !velEl.disabled) ? parseInt(velEl.value, 10) : 100;
    const note = { start, dur, pitch, vel };
    dawAddNote(_dawPRTrackId, note);          // full re-render
    _dawPRSelected = note; _dawPRRefreshSelection();
    if (typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, pitch, vel);
  });
}

function _dawPRWireNote(el, handle, note, grid) {
  handle.addEventListener("mousedown", e => {
    e.stopPropagation();
    const startX = e.clientX, origDur = note.dur, step = _dawPRSnapStep();
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      const rawEnd = note.start + Math.max(0.02, origDur + dx);
      const snapped = (typeof _dawSnapSec === "function") ? _dawSnapSec(rawEnd, m.ctrlKey) : rawEnd;
      note.dur = Math.max(step, snapped - note.start);
      _dawPRLastDur = note.dur;
      el.style.width = Math.max(4, note.dur * _dawPxPerSec) + "px";
      dawMarkDirty();
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); dawNoteEdited(_dawPRTrackId); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  el.addEventListener("mousedown", e => {
    if (e.target === handle) return;
    e.stopPropagation();
    _dawPRSelected = note; _dawPRRefreshSelection();
    const startX = e.clientX, origStart = note.start;
    let moved = false;
    const onMove = m => {
      moved = true;
      const dx = (m.clientX - startX) / _dawPxPerSec;
      note.start = Math.max(0, (typeof _dawSnapSec === "function") ? _dawSnapSec(Math.max(0, origStart + dx), m.ctrlKey) : Math.max(0, origStart + dx));
      note.pitch = _dawPRPitchFromY(grid, m.clientY);
      el.style.left = (note.start * _dawPxPerSec) + "px";
      el.style.top = ((_DAW_PR_HI - note.pitch) * _DAW_PR_ROW_H) + "px";
      dawMarkDirty();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
      if (moved && typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, note.pitch, note.vel);
      dawNoteEdited(_dawPRTrackId);
    };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  el.addEventListener("dblclick", e => {
    e.stopPropagation();
    dawRemoveNote(_dawPRTrackId, note);
    if (_dawPRSelected === note) _dawPRSelected = null;
  });
}

document.addEventListener("keydown", e => {
  if (!_dawPROpen || !_dawPRSelected) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "Delete" || e.key === "Backspace") {
    dawRemoveNote(_dawPRTrackId, _dawPRSelected); _dawPRSelected = null; e.preventDefault();
  }
});
