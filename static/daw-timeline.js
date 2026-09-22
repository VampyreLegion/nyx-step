// ── DAW timeline rendering + interaction ──────────────────────────────────────
let _dawPxPerSec = 12;          // zoom
const _DAW_LANE_H = 74;
const _DAW_MIN_LEN = 60;        // seconds of empty ruler
let _dawSelectedClip = null;

function dawZoom(factor) {
  _dawPxPerSec = Math.min(120, Math.max(3, _dawPxPerSec * factor));
  renderTimeline();
}

function _dawTimelineWidth() {
  return Math.max(_DAW_MIN_LEN, dawArrangementLength() + 10) * _dawPxPerSec;
}

function _dawDrawClipWave(canvas, clip, color) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const buf = _dawBufferCache.get(clip.file);
  if (!buf || buf === "error") {
    ctx.fillStyle = buf === "error" ? "#e05f5f" : "#8a8f9e";
    ctx.font = "10px sans-serif";
    ctx.fillText(buf === "error" ? "⚠ failed" : "loading…", 4, 14);
    return;
  }
  const w = canvas.width, h = canvas.height, mid = h / 2;
  const sr = buf.sampleRate;
  const startS = Math.floor(clip.offset * sr);
  const lenS = Math.floor(clip.duration * sr);
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(lenS / w));
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let peak = 0;
    const s = startS + x * step;
    for (let j = 0; j < step && s + j < ch.length; j++) {
      const v = Math.abs(ch[s + j]); if (v > peak) peak = v;
    }
    ctx.moveTo(x, mid - peak * mid);
    ctx.lineTo(x, mid + peak * mid);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function _dawDrawClipFades(canvas, clip) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const fi = (clip.fade_in ?? 0) * _dawPxPerSec;
  const fo = (clip.fade_out ?? 0) * _dawPxPerSec;
  ctx.strokeStyle = "#e2e4ed"; ctx.fillStyle = "rgba(0,212,182,0.18)"; ctx.lineWidth = 1;
  if (fi > 0) {
    const x = Math.min(fi, w);
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(x, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, 0); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
  }
  if (fo > 0) {
    const x = Math.max(0, w - fo);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(w, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
}

function _dawDrawRuler() {
  const canvas = document.getElementById("daw-ruler");
  const w = _dawTimelineWidth();
  canvas.width = w; canvas.style.width = w + "px";
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, canvas.height);
  ctx.fillStyle = "#8a8f9e"; ctx.font = "10px monospace";
  ctx.strokeStyle = "#2d3041";
  const stepSec = _dawPxPerSec < 8 ? 30 : _dawPxPerSec < 20 ? 10 : 5;
  for (let s = 0; s * _dawPxPerSec < w; s += stepSec) {
    const x = s * _dawPxPerSec;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    const m = Math.floor(s / 60), sec = s % 60;
    ctx.fillText(`${m}:${String(sec).padStart(2, "0")}`, x + 2, 14);
  }
}

function dawRenderTrackHeaders() {
  const head = document.getElementById("daw-tracks-head");
  head.innerHTML = "";
  for (const t of dawState.tracks) {
    const row = document.createElement("div");
    row.style.cssText = `height:${_DAW_LANE_H}px;border-bottom:1px solid #2d3041;padding:4px 6px;display:flex;flex-direction:column;gap:2px;border-left:3px solid ${t.color}`;
    const name = document.createElement("input");
    name.value = t.name;
    name.style.cssText = "background:transparent;border:none;color:#e2e4ed;font-size:12px;width:100%";
    name.addEventListener("change", () => dawRenameTrack(t.id, name.value));
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:4px";
    const mk = (label, on, fn, title) => {
      const b = document.createElement("button");
      b.className = "secondary small"; b.textContent = label; b.title = title;
      b.style.cssText = "font-size:10px;padding:1px 6px;" + (on ? "background:#7c65d9;color:#fff" : "");
      b.addEventListener("click", fn);
      return b;
    };
    btns.appendChild(mk("M", t.mute, () => { dawToggleMute(t.id); dawReschedule(); }, "Mute"));
    btns.appendChild(mk("S", t.solo, () => { dawToggleSolo(t.id); dawReschedule(); }, "Solo"));
    btns.appendChild(mk("✕", false, () => { if (confirm("Remove track?")) dawRemoveTrack(t.id); }, "Remove"));
    const armBtn = document.createElement("button");
    armBtn.className = "secondary small"; armBtn.textContent = "●"; armBtn.title = "Record arm (MIDI in / audio in)";
    armBtn.style.cssText = "font-size:10px;padding:1px 6px;" + (t.arm ? "background:#e05f5f;color:#fff" : "");
    armBtn.addEventListener("click", () => { if (typeof dawToggleArm === "function") dawToggleArm(t.id); });
    btns.appendChild(armBtn);
    const genActive = (typeof _dawGenTracks !== "undefined") && _dawGenTracks.has(t.id);
    const genBtn = document.createElement("button");
    genBtn.className = "secondary small";
    genBtn.textContent = genActive ? "⏳" : "🎵";
    genBtn.title = "Generate onto this track";
    genBtn.disabled = genActive;
    genBtn.style.cssText = "font-size:10px;padding:1px 6px;";
    if (!genActive) genBtn.addEventListener("click", () => { if (typeof openGenerateDialog === "function") openGenerateDialog(t.id, genBtn); });
    btns.appendChild(genBtn);
    const vol = document.createElement("input");
    vol.type = "range"; vol.min = "0"; vol.max = "2"; vol.step = "0.01";
    vol.value = t.volume ?? 1;
    vol.id = "daw-inline-vol-" + t.id;
    vol.title = "Volume";
    vol.style.cssText = "width:100%;height:12px;margin-top:2px";
    vol.addEventListener("input", () => dawSetTrackVolume(t.id, parseFloat(vol.value)));
    row.appendChild(name); row.appendChild(btns); row.appendChild(vol);
    if (t.kind === "midi") {
      const midiRow = document.createElement("div");
      midiRow.style.cssText = "display:flex;gap:4px;margin-top:1px";
      const wave = document.createElement("select");
      wave.title = "Synth waveform"; wave.style.cssText = "font-size:9px;flex:1;min-width:0";
      for (const w of ["sine", "triangle", "sawtooth", "square"]) {
        const o = document.createElement("option"); o.value = w; o.textContent = w;
        if ((t.synth || {}).wave === w) o.selected = true; wave.appendChild(o);
      }
      wave.addEventListener("change", () => dawSetTrackSynth(t.id, { wave: wave.value }));
      const outSel = document.createElement("select");
      outSel.title = "MIDI output (Internal synth or hardware over USB)"; outSel.style.cssText = "font-size:9px;flex:1;min-width:0";
      const rebuild = () => {
        outSel.innerHTML = "";
        const oi = document.createElement("option"); oi.value = ""; oi.textContent = "Internal synth"; outSel.appendChild(oi);
        for (const o of (typeof dawMidiOutputs === "function" ? dawMidiOutputs() : [])) {
          const op = document.createElement("option"); op.value = o.id; op.textContent = o.name;
          if (t.midi_out === o.id) op.selected = true; outSel.appendChild(op);
        }
        if (t.midi_out) outSel.value = t.midi_out;
      };
      rebuild();
      outSel.addEventListener("focus", async () => { if (typeof dawInitMidi === "function") { await dawInitMidi(); rebuild(); } });
      outSel.addEventListener("change", () => dawSetTrackMidiOut(t.id, outSel.value || null));
      midiRow.appendChild(wave); midiRow.appendChild(outSel);
      btns.appendChild(mk("🎹", false, () => { if (typeof openPianoRoll === "function") openPianoRoll(t.id); }, "Edit notes (piano roll)"));
      row.appendChild(midiRow);
    }
    head.appendChild(row);
  }
}

function renderTimeline() {
  dawRenderTrackHeaders();
  _dawDrawRuler();
  const lanes = document.getElementById("daw-lanes");
  const w = _dawTimelineWidth();
  lanes.innerHTML = "";
  lanes.style.width = w + "px";
  if (dawState.snap) {
    const period = Math.max(2, _dawSnapDiv() * _dawPxPerSec);
    lanes.style.backgroundImage = `repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px ${period}px)`;
  } else {
    lanes.style.backgroundImage = "none";
  }
  for (const track of dawState.tracks) {
    const lane = document.createElement("div");
    lane.dataset.trackId = track.id;
    lane.style.cssText = `position:relative;height:${_DAW_LANE_H}px;border-bottom:1px solid #1a1c26`;
    lane.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    lane.addEventListener("drop", e => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/x-daw-clip");
      if (!raw) return;
      const src = JSON.parse(raw);
      const rect = lane.getBoundingClientRect();
      const start = Math.max(0, _dawSnapSec((e.clientX - rect.left) / _dawPxPerSec, e.ctrlKey));
      const clip = dawAddClip(track.id, src, start);
      if (clip) dawSaveNow();
      if (clip) dawGetBuffer(clip.file).then(renderTimeline);
    });
    if (track.kind === "midi") {
      const notes = track.notes || [];
      const pitches = notes.map(n => n.pitch);
      const lo = pitches.length ? Math.min(...pitches) : 48;
      const hi = pitches.length ? Math.max(...pitches) : 72;
      const span = Math.max(1, hi - lo);
      const h = _DAW_LANE_H - 6;
      for (const n of notes) {
        const nb = document.createElement("div");
        const y = 3 + (1 - (n.pitch - lo) / span) * (h - 4);
        nb.style.cssText = `position:absolute;left:${n.start * _dawPxPerSec}px;top:${y}px;` +
          `width:${Math.max(2, n.dur * _dawPxPerSec)}px;height:3px;background:${track.color};border-radius:1px;opacity:0.9`;
        lane.appendChild(nb);
      }
      lane.addEventListener("dblclick", () => { if (typeof openPianoRoll === "function") openPianoRoll(track.id); });
      lanes.appendChild(lane);
      continue;
    }
    for (const clip of track.clips) lane.appendChild(_dawBuildClipEl(track, clip));
    lanes.appendChild(lane);
  }
}

function _dawBuildClipEl(track, clip) {
  const el = document.createElement("div");
  el.className = "daw-clip";
  el.style.cssText = `position:absolute;top:2px;height:${_DAW_LANE_H - 6}px;left:${clip.start * _dawPxPerSec}px;width:${Math.max(8, clip.duration * _dawPxPerSec)}px;background:${track.color}22;border:1px solid ${track.color};border-radius:3px;overflow:hidden;cursor:grab;` + (clip === _dawSelectedClip ? "box-shadow:0 0 0 2px #00d4b6" : "");
  const label = document.createElement("div");
  label.textContent = clip.name;
  label.style.cssText = "font-size:9px;color:#e2e4ed;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none";
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, clip.duration * _dawPxPerSec); canvas.height = _DAW_LANE_H - 22;
  canvas.style.cssText = "display:block;width:100%;pointer-events:none";
  el.appendChild(label); el.appendChild(canvas);
  _dawDrawClipWave(canvas, clip, track.color);
  _dawDrawClipFades(canvas, clip);

  const handle = document.createElement("div");
  handle.style.cssText = "position:absolute;right:0;top:10px;height:calc(100% - 10px);width:6px;cursor:ew-resize;background:linear-gradient(90deg,transparent,#00d4b6)";
  el.appendChild(handle);

  const fiH = document.createElement("div");
  fiH.title = "Fade in";
  fiH.style.cssText = "position:absolute;left:0;top:0;width:9px;height:9px;cursor:ew-resize;background:#00d4b6;opacity:0.85;border-radius:0 0 6px 0;z-index:2";
  const foH = document.createElement("div");
  foH.title = "Fade out";
  foH.style.cssText = "position:absolute;right:0;top:0;width:9px;height:9px;cursor:ew-resize;background:#00d4b6;opacity:0.85;border-radius:0 0 0 6px;z-index:2";
  el.appendChild(fiH); el.appendChild(foH);
  _dawWireFadeHandles(fiH, foH, el, clip);

  const menuBtn = document.createElement("div");
  menuBtn.textContent = "⋯"; menuBtn.title = "Clip actions";
  menuBtn.style.cssText = "position:absolute;right:14px;top:0;font-size:11px;line-height:11px;color:#e2e4ed;cursor:pointer;padding:0 3px;z-index:2;background:rgba(0,0,0,0.35);border-radius:2px";
  menuBtn.addEventListener("mousedown", e => e.stopPropagation());
  menuBtn.addEventListener("click", e => { e.stopPropagation(); if (typeof openClipMenu === "function") openClipMenu(clip, menuBtn); });
  el.appendChild(menuBtn);
  el.addEventListener("contextmenu", e => { e.preventDefault(); if (typeof openClipMenu === "function") openClipMenu(clip, menuBtn); });

  _dawWireClipDrag(el, handle, track, clip);
  return el;
}

function _dawWireClipDrag(el, handle, track, clip) {
  el.addEventListener("mousedown", e => {
    if (e.target === handle) return;
    _dawSelectedClip = clip; renderTimeline();
    const startX = e.clientX, origStart = clip.start;
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      let newStart = Math.max(0, _dawSnapSec(origStart + dx, m.ctrlKey));
      const laneEls = [...document.querySelectorAll("#daw-lanes > div")];
      let destTrack = track.id;
      for (const le of laneEls) {
        const r = le.getBoundingClientRect();
        if (m.clientY >= r.top && m.clientY <= r.bottom) { destTrack = le.dataset.trackId; break; }
      }
      dawMoveClip(clip.id, destTrack, newStart);
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  handle.addEventListener("mousedown", e => {
    const stretchMode = e.altKey;
    const startX = e.clientX, origDur = clip.duration;
    const srcLen0 = clip.src_len ?? clip.duration;
    const r0 = (srcLen0 > 0) ? (clip.duration / srcLen0) : 1;
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      const rawLen = Math.max(0.1, origDur + dx);
      const edge = _dawSnapSec(clip.start + rawLen, m.ctrlKey);
      const newLen = Math.max(0.1, edge - clip.start);
      if (stretchMode) dawStretchClip(clip.id, newLen);
      else dawTrimClip(clip.id, clip.offset, newLen / r0);
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    e.stopPropagation(); e.preventDefault();
  });
}

function _dawWireFadeHandles(fiH, foH, el, clip) {
  fiH.addEventListener("mousedown", e => {
    e.stopPropagation(); e.preventDefault();
    const rect = el.getBoundingClientRect();
    const onMove = m => dawSetClipFadeIn(clip.id, Math.max(0, (m.clientX - rect.left) / _dawPxPerSec));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  foH.addEventListener("mousedown", e => {
    e.stopPropagation(); e.preventDefault();
    const rect = el.getBoundingClientRect();
    const onMove = m => dawSetClipFadeOut(clip.id, Math.max(0, (rect.right - m.clientX) / _dawPxPerSec));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
}

document.addEventListener("keydown", e => {
  if (!document.getElementById("tab-daw")?.classList.contains("active")) return;
  if (!_dawSelectedClip) return;
  if (e.key === "Delete" || e.key === "Backspace") { dawDeleteClip(_dawSelectedClip.id); _dawSelectedClip = null; e.preventDefault(); }
  if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey)) { dawDuplicateClip(_dawSelectedClip.id); e.preventDefault(); }
});

function dawOnPlayhead(t) {
  const ph = document.getElementById("daw-playhead");
  const scroll = document.getElementById("daw-timeline-scroll");
  if (!ph) return;
  ph.style.display = "block";
  ph.style.left = (t * _dawPxPerSec) + "px";
  ph.style.height = scroll.scrollHeight + "px";
  const len = dawArrangementLength();
  const cur = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const tot = `${Math.floor(len / 60)}:${String(Math.floor(len % 60)).padStart(2, "0")}`;
  const timeEl = document.getElementById("daw-time");
  if (timeEl) timeEl.textContent = `${cur} / ${tot}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const ruler = document.getElementById("daw-ruler");
  if (ruler) ruler.addEventListener("click", e => {
    const rect = ruler.getBoundingClientRect();
    dawSeek(Math.max(0, (e.clientX - rect.left + ruler.parentElement.scrollLeft) / _dawPxPerSec));
  });
});
