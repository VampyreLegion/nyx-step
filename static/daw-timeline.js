// ── DAW timeline rendering + interaction ──────────────────────────────────────
let _dawPxPerSec = 12;          // zoom
const _DAW_LANE_H = 64;
const _DAW_MIN_LEN = 60;        // seconds of empty ruler
let _dawSelectedClip = null;
const _dawPeakCache = new Map(); // file → Float32Array peaks

function dawZoom(factor) {
  _dawPxPerSec = Math.min(120, Math.max(3, _dawPxPerSec * factor));
  renderTimeline();
}

function _dawTimelineWidth() {
  return Math.max(_DAW_MIN_LEN, dawArrangementLength() + 10) * _dawPxPerSec;
}

function _dawComputePeaks(file, buf, targetPx) {
  const key = file + "@" + targetPx;
  if (_dawPeakCache.has(key)) return _dawPeakCache.get(key);
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / targetPx));
  const peaks = new Float32Array(targetPx);
  for (let i = 0; i < targetPx; i++) {
    let peak = 0;
    const start = i * step;
    for (let j = 0; j < step && start + j < ch.length; j++) {
      const v = Math.abs(ch[start + j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
  }
  _dawPeakCache.set(key, peaks);
  return peaks;
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
    row.appendChild(name); row.appendChild(btns);
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
      const start = Math.max(0, (e.clientX - rect.left) / _dawPxPerSec);
      const clip = dawAddClip(track.id, src, start);
      if (clip) dawGetBuffer(clip.file).then(renderTimeline);
    });
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

  const handle = document.createElement("div");
  handle.style.cssText = "position:absolute;right:0;top:0;width:6px;height:100%;cursor:ew-resize;background:linear-gradient(90deg,transparent,#00d4b6)";
  el.appendChild(handle);

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
      let newStart = Math.max(0, origStart + dx);
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
    const startX = e.clientX, origDur = clip.duration;
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      dawTrimClip(clip.id, clip.offset, Math.max(0.1, origDur + dx));
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    e.stopPropagation(); e.preventDefault();
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
