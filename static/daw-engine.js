// ── DAW Web Audio engine ──────────────────────────────────────────────────────
let _dawCtx = null;
const _dawBufferCache = new Map();     // file → AudioBuffer (or "error")
let _dawMaster = null;
let _dawActiveSources = [];
let _dawIsPlaying = false;
let _dawPlayhead = 0;                   // seconds
let _dawStartCtxTime = 0;              // ctx.currentTime when playback began
let _dawStartPlayhead = 0;            // playhead when playback began
let _dawRaf = null;
let _dawLoop = false;
const _DAW_LOOKAHEAD = 0.08;

function _dawEnsureCtx() {
  if (!_dawCtx) {
    _dawCtx = new (window.AudioContext || window.webkitAudioContext)();
    _dawMaster = _dawCtx.createGain();
    _dawMaster.gain.value = 1.0;
    _dawMaster.connect(_dawCtx.destination);
  }
  return _dawCtx;
}

async function dawGetBuffer(file) {
  if (_dawBufferCache.has(file)) {
    const v = _dawBufferCache.get(file);
    return v === "error" ? null : v;
  }
  try {
    const ctx = _dawEnsureCtx();
    const ab = await fetch("/daw/audio/" + file.split("/").map(encodeURIComponent).join("/")).then(r => {
      if (!r.ok) throw new Error("fetch " + r.status);
      return r.arrayBuffer();
    });
    const buf = await ctx.decodeAudioData(ab);
    _dawBufferCache.set(file, buf);
    return buf;
  } catch (e) {
    _dawBufferCache.set(file, "error");
    return null;
  }
}

function _dawAudibleTracks() {
  const soloed = dawState.tracks.filter(t => t.solo);
  const active = soloed.length ? soloed : dawState.tracks.filter(t => !t.mute);
  return new Set(active.map(t => t.id));
}

function _dawScheduleAll() {
  const ctx = _dawEnsureCtx();
  _dawStartCtxTime = ctx.currentTime + _DAW_LOOKAHEAD;
  _dawStartPlayhead = _dawPlayhead;
  const audible = _dawAudibleTracks();
  for (const track of dawState.tracks) {
    if (!audible.has(track.id)) continue;
    for (const clip of track.clips) {
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= _dawPlayhead) continue;          // already past
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;          // not loaded / errored
      let when, bufOffset, playDur;
      if (clip.start >= _dawPlayhead) {
        when = _dawStartCtxTime + (clip.start - _dawPlayhead);
        bufOffset = clip.offset;
        playDur = clip.duration;
      } else {                                         // straddles playhead
        const into = _dawPlayhead - clip.start;
        when = _dawStartCtxTime;
        bufOffset = clip.offset + into;
        playDur = clip.duration - into;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      src.connect(g); g.connect(_dawMaster);
      src.start(when, bufOffset, playDur);
      _dawActiveSources.push(src);
    }
  }
}

function _dawStopSources() {
  for (const s of _dawActiveSources) { try { s.stop(); } catch (_) {} }
  _dawActiveSources = [];
}

function _dawTick() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  const len = dawArrangementLength();
  if (len > 0 && _dawPlayhead >= len) {
    if (_dawLoop) { dawSeek(0); }
    else { dawStop(); if (typeof dawOnPlayhead === "function") dawOnPlayhead(0); return; }
  }
  if (typeof dawOnPlayhead === "function") dawOnPlayhead(_dawPlayhead);
  _dawRaf = requestAnimationFrame(_dawTick);
}

async function dawPlay() {
  const ctx = _dawEnsureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  // Preload all referenced buffers before scheduling
  const files = new Set();
  for (const t of dawState.tracks) for (const c of t.clips) files.add(c.file);
  await Promise.all([...files].map(dawGetBuffer));
  if (_dawIsPlaying) _dawStopSources();
  _dawIsPlaying = true;
  _dawScheduleAll();
  cancelAnimationFrame(_dawRaf);
  _dawRaf = requestAnimationFrame(_dawTick);
}

function dawPause() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  _dawIsPlaying = false;
  cancelAnimationFrame(_dawRaf);
  _dawStopSources();
}

function dawStop() {
  _dawIsPlaying = false;
  cancelAnimationFrame(_dawRaf);
  _dawStopSources();
  _dawPlayhead = 0;
  if (typeof dawOnPlayhead === "function") dawOnPlayhead(0);
}

function dawSeek(t) {
  _dawPlayhead = Math.max(0, t);
  if (_dawIsPlaying) { _dawStopSources(); _dawScheduleAll(); }
  if (typeof dawOnPlayhead === "function") dawOnPlayhead(_dawPlayhead);
}

function dawSetLoop(on) { _dawLoop = on; }
function dawGetPlayhead() { return _dawPlayhead; }
function dawIsPlaying() { return _dawIsPlaying; }

// Re-schedule mid-playback after a mute/solo change.
function dawReschedule() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  _dawStopSources();
  _dawScheduleAll();
}
