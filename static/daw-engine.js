// ── DAW Web Audio engine ──────────────────────────────────────────────────────
let _dawCtx = null;
const _dawBufferCache = new Map();     // file → AudioBuffer (or "error")
let _dawMaster = null;
let _dawMasterAnalyser = null;
const _dawTrackChains = new Map();   // trackId → { gain, pan, analyser }
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
    _dawMasterAnalyser = _dawCtx.createAnalyser();
    _dawMasterAnalyser.fftSize = 256;
    _dawMaster.connect(_dawMasterAnalyser);
    _dawMasterAnalyser.connect(_dawCtx.destination);
  }
  return _dawCtx;
}

function _dawSyncChains() {
  const ctx = _dawEnsureCtx();
  const ids = new Set(dawState.tracks.map(t => t.id));
  for (const [id, chain] of _dawTrackChains) {
    if (!ids.has(id)) {
      try { chain.gain.disconnect(); chain.pan.disconnect(); chain.analyser.disconnect(); } catch (_) {}
      _dawTrackChains.delete(id);
    }
  }
  for (const t of dawState.tracks) {
    let chain = _dawTrackChains.get(t.id);
    if (!chain) {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      gain.connect(pan); pan.connect(analyser); analyser.connect(_dawMaster);
      chain = { gain, pan, analyser };
      _dawTrackChains.set(t.id, chain);
    }
    chain.pan.pan.value = t.pan ?? 0;
  }
}

function _dawApplyMixState() {
  const soloOn = dawState.tracks.some(t => t.solo);
  for (const t of dawState.tracks) {
    const chain = _dawTrackChains.get(t.id);
    if (!chain) continue;
    const audible = soloOn ? t.solo : !t.mute;
    chain.gain.gain.value = audible ? (t.volume ?? 1) : 0;
  }
  if (_dawMaster) _dawMaster.gain.value = dawState.master_volume ?? 1;
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
  _dawSyncChains();
  _dawStartCtxTime = ctx.currentTime + _DAW_LOOKAHEAD;
  _dawStartPlayhead = _dawPlayhead;
  for (const track of dawState.tracks) {
    const chain = _dawTrackChains.get(track.id);
    if (!chain) continue;
    for (const clip of track.clips) {
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= _dawPlayhead) continue;
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;
      let when, bufOffset, playDur;
      if (clip.start >= _dawPlayhead) {
        when = _dawStartCtxTime + (clip.start - _dawPlayhead);
        bufOffset = clip.offset;
        playDur = clip.duration;
      } else {
        const into = _dawPlayhead - clip.start;
        when = _dawStartCtxTime;
        bufOffset = clip.offset + into;
        playDur = clip.duration - into;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(chain.gain);
      src.start(when, bufOffset, playDur);
      _dawActiveSources.push(src);
    }
  }
  _dawApplyMixState();
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

// Re-apply mix state without re-scheduling sources.
function dawReschedule() {
  _dawApplyMixState();
}

function dawEngineSetTrackVolume(trackId, gain) {
  const t = dawState.tracks.find(t => t.id === trackId);
  const chain = _dawTrackChains.get(trackId);
  if (!t || !chain) return;
  const soloOn = dawState.tracks.some(t => t.solo);
  const audible = soloOn ? t.solo : !t.mute;
  chain.gain.gain.value = audible ? gain : 0;
}

function dawEngineSetTrackPan(trackId, pan) {
  const chain = _dawTrackChains.get(trackId);
  if (chain) chain.pan.pan.value = pan;
}

function dawEngineSetMasterVolume(gain) {
  if (_dawMaster) _dawMaster.gain.value = gain;
}

function _dawAnalyserPeak(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
  return peak;
}

function dawEngineTrackPeak(trackId) {
  const chain = _dawTrackChains.get(trackId);
  return chain ? _dawAnalyserPeak(chain.analyser) : 0;
}

function dawEngineMasterPeak() {
  return _dawMasterAnalyser ? _dawAnalyserPeak(_dawMasterAnalyser) : 0;
}
