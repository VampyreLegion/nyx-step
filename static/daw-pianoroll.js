// ── DAW piano-roll editor ─────────────────────────────────────────────────────
const _DAW_PR_ROW_H = 12;     // px per semitone
const _DAW_PR_LO = 24;        // C1
const _DAW_PR_HI = 96;        // C7
let _dawPROpen = false;
let _dawPRTrackId = null;
let _dawPRSel = new Set();    // selected notes (note objects)
let _dawPRPrimary = null;     // anchor note inside the selection (velocity/preview)
let _dawPRLastDur = 0;

function _dawPRTrack() { return dawState.tracks.find(t => t.id === _dawPRTrackId) || null; }
function _dawPRSnapStep() { return (typeof _dawSnapDiv === "function" && dawState.snap) ? _dawSnapDiv() : 0.25; }

function _dawPRClearSel() { _dawPRSel = new Set(); _dawPRPrimary = null; }
function _dawPRSetSelOne(note) { _dawPRSel = new Set([note]); _dawPRPrimary = note; }
function _dawPRSetPrimary(note) {
  if (note && _dawPRSel.has(note)) _dawPRPrimary = note;
  else _dawPRPrimary = _dawPRSel.size ? [..._dawPRSel][_dawPRSel.size - 1] : null;
}

function openPianoRoll(trackId) {
  const t = dawState.tracks.find(x => x.id === trackId);
  if (!t || t.kind !== "midi") return;
  _dawPRTrackId = trackId; _dawPROpen = true; _dawPRClearSel();
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
  _dawPROpen = false; _dawPRClearSel();
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
  if (vel) {
    vel.disabled = !_dawPRSel.size;
    if (_dawPRPrimary && _dawPRSel.has(_dawPRPrimary)) vel.value = _dawPRPrimary.vel;
  }
  const grid = document.getElementById("daw-pr-grid");
  if (!grid) return;
  for (const el of grid.children) {
    if (!el._note) continue;
    const on = _dawPRSel.has(el._note);
    el.style.outline = on ? "2px solid #00d4b6" : "none";
    el.style.zIndex = on ? "2" : "1";
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
  vel.value = _dawPRPrimary ? _dawPRPrimary.vel : 100; vel.disabled = !_dawPRSel.size;
  vel.style.cssText = "width:120px";
  vel.addEventListener("input", () => {
    if (!_dawPRSel.size) return;
    const v = parseInt(vel.value, 10);
    for (const n of _dawPRSel) n.vel = v;
    const grid = document.getElementById("daw-pr-grid");
    if (grid) for (const el of grid.children) if (el._note && _dawPRSel.has(el._note))
      el.style.opacity = (0.35 + 0.5 * (v / 127));
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
      (_dawPRSel.has(n) ? "outline:2px solid #00d4b6;z-index:2" : "z-index:1");
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

// ── Empty-grid click: draw a note; Shift+drag = marquee box selection ──────────
function _dawPRWireGrid(grid) {
  grid.addEventListener("mousedown", e => {
    if (e.target !== grid) return;            // empty grid only
    e.preventDefault();
    if (e.shiftKey) { _dawPRMarquee(grid, e); return; }
    const r = grid.getBoundingClientRect();
    const rawStart = (e.clientX - r.left) / _dawPxPerSec;
    const start = Math.max(0, (typeof _dawSnapSec === "function") ? _dawSnapSec(rawStart, e.ctrlKey) : rawStart);
    const pitch = _dawPRPitchFromY(grid, e.clientY);
    const dur = _dawPRLastDur || _dawPRSnapStep();
    const velEl = document.querySelector("#daw-pianoroll-panel input[type=range]");
    const vel = (velEl && !velEl.disabled && _dawPRSel.size) ? parseInt(velEl.value, 10) : 100;
    const note = { start, dur, pitch, vel };
    dawAddNote(_dawPRTrackId, note);          // full re-render
    _dawPRSetSelOne(note); _dawPRRefreshSelection();
    if (typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, pitch, vel);
  });
}

// Drawn "rubber band" — picks up every note fully inside the box.
function _dawPRMarquee(grid, e) {
  const gr = grid.getBoundingClientRect();
  const ax = e.clientX, ay = e.clientY;
  const noteEls = [...grid.children].filter(ch => ch._note);
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;border:1px solid #00d4b6;background:rgba(0,212,182,0.12);z-index:5;pointer-events:none;display:none";
  grid.appendChild(overlay);
  let cands = [];
  let primary = null;
  const paint = (cx, cy) => {
    overlay.style.display = "block";
    const x0 = Math.min(ax, cx), x1 = Math.max(ax, cx);
    const y0 = Math.min(ay, cy), y1 = Math.max(ay, cy);
    overlay.style.left = (x0 - gr.left) + "px";
    overlay.style.top = (y0 - gr.top) + "px";
    overlay.style.width = (x1 - x0) + "px";
    overlay.style.height = (y1 - y0) + "px";
    cands = [];
    for (const el of noteEls) {
      const r = el.getBoundingClientRect();
      if (x0 <= r.left && x1 >= r.right && y0 <= r.top && y1 >= r.bottom) { cands.push(el._note); primary = el._note; }
    }
    for (const el of noteEls) {
      const lit = cands.includes(el._note);
      el.style.outline = lit ? "2px solid #00d4b6" : "none";
      el.style.zIndex = lit ? "2" : "1";
    }
  };
  const onMove = m => paint(m.clientX, m.clientY);
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    overlay.remove();
    _dawPRSel = new Set(cands);
    _dawPRPrimary = primary;
    _dawPRRefreshSelection();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function _dawPRWireNote(el, handle, note, grid) {
  handle.addEventListener("mousedown", e => {
    e.stopPropagation();
    _dawPRSetSelOne(note); _dawPRRefreshSelection();
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
    e.preventDefault();

    // Shift/Ctrl-click toggles membership without dragging.
    if (e.shiftKey || e.ctrlKey) {
      if (_dawPRSel.has(note)) { _dawPRSel.delete(note); _dawPRSetPrimary(null); }
      else { _dawPRSel.add(note); _dawPRPrimary = note; }
      _dawPRRefreshSelection();
      return;
    }

    // Clicking outside the current selection: select (or re-anchor) it.
    if (!_dawPRSel.has(note)) { _dawPRSetSelOne(note); }
    else if (_dawPRSel.size > 1) { _dawPRPrimary = note; }
    _dawPRRefreshSelection();

    // Drag the whole selection together, keeping relative spacing.
    const selNotes = [..._dawPRSel];
    const n2el = new Map();
    for (const ch of grid.children) if (ch._note && _dawPRSel.has(ch._note)) n2el.set(ch._note, ch);
    const origs = new Map(selNotes.map(n => [n, { start: n.start, pitch: n.pitch }]));
    const prim = _dawPRPrimary;
    const origPrim = prim ? origs.get(prim) : null;
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    const onMove = m => {
      moved = true;
      const dyP = -Math.round((m.clientY - startY) / _DAW_PR_ROW_H);
      let dStart = (m.clientX - startX) / _dawPxPerSec, dPitch = dyP;
      if (origPrim) {
        const ns = Math.max(0, (typeof _dawSnapSec === "function") ? _dawSnapSec(Math.max(0, origPrim.start + dStart), m.ctrlKey) : Math.max(0, origPrim.start + dStart));
        dStart = ns - origPrim.start;
        const np = Math.max(_DAW_PR_LO, Math.min(_DAW_PR_HI, origPrim.pitch + dyP));
        dPitch = np - origPrim.pitch;
      }
      for (const n of selNotes) {
        const o = origs.get(n);
        n.start = Math.max(0, o.start + dStart);
        n.pitch = Math.max(_DAW_PR_LO, Math.min(_DAW_PR_HI, o.pitch + dPitch));
        const elx = n2el.get(n);
        if (elx) { elx.style.left = (n.start * _dawPxPerSec) + "px"; elx.style.top = ((_DAW_PR_HI - n.pitch) * _DAW_PR_ROW_H) + "px"; }
      }
      dawMarkDirty();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
      if (moved && prim && typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, prim.pitch, prim.vel);
      dawNoteEdited(_dawPRTrackId);
    };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  el.addEventListener("dblclick", e => {
    e.stopPropagation();
    _dawPRSel.delete(note);
    _dawPRSetPrimary(null);
    dawRemoveNote(_dawPRTrackId, note);
    if (!_dawPRSel.size) _dawPRClearSel();
  });
}

document.addEventListener("keydown", e => {
  if (!_dawPROpen) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (!_dawPRSel.size) return;
    const sel = [..._dawPRSel];
    for (const n of sel) dawRemoveNote(_dawPRTrackId, n);
    _dawPRClearSel();
    e.preventDefault();
    if (typeof renderTimeline === "function") renderTimeline();
  } else if (e.key === "Escape" && _dawPRSel.size) {
    _dawPRClearSel(); _dawPRRefreshSelection();
  }
});