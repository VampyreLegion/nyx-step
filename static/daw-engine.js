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

function _dawImpulse(ctx, seconds = 2, decay = 2.5) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
function _dawMakeEq(ctx) {
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 320;
  const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 1;
  const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 3200;
  low.connect(mid); mid.connect(high);
  return { input: low, output: high, low, mid, high };
}
function _dawMakeReverb(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1;
  const conv = ctx.createConvolver(); conv.buffer = _dawImpulse(ctx);
  const wet = ctx.createGain(); wet.gain.value = 0;
  input.connect(dry); dry.connect(output);
  input.connect(conv); conv.connect(wet); wet.connect(output);
  return { input, output, wet, dry, conv };
}
function _dawMakeDelay(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1;
  const delay = ctx.createDelay(2.0); delay.delayTime.value = 0.3;
  const fb = ctx.createGain(); fb.gain.value = 0;
  const wet = ctx.createGain(); wet.gain.value = 0;
  input.connect(dry); dry.connect(output);
  input.connect(delay); delay.connect(wet); wet.connect(output);
  delay.connect(fb); fb.connect(delay);
  return { input, output, delay, fb, wet, dry };
}

function dawEngineSetTrackFx(trackId, fx) {
  const chain = _dawTrackChains.get(trackId);
  if (!chain || !chain.eq) return;
  fx = fx || {};
  const eq = fx.eq || {}, rv = fx.reverb || {}, dl = fx.delay || {};
  chain.eq.low.gain.value  = eq.on ? (eq.low ?? 0) : 0;
  chain.eq.mid.gain.value  = eq.on ? (eq.mid ?? 0) : 0;
  chain.eq.high.gain.value = eq.on ? (eq.high ?? 0) : 0;
  chain.reverb.wet.gain.value = rv.on ? (rv.wet ?? 0.3) : 0;
  chain.delay.delay.delayTime.value = dl.time ?? 0.3;
  chain.delay.fb.gain.value  = dl.on ? (dl.feedback ?? 0.3) : 0;
  chain.delay.wet.gain.value = dl.on ? (dl.wet ?? 0.3) : 0;
}

function _dawSyncChains() {
  const ctx = _dawEnsureCtx();
  const ids = new Set(dawState.tracks.map(t => t.id));
  for (const [id, chain] of _dawTrackChains) {
    if (!ids.has(id)) {
      try {
        chain.gain.disconnect(); chain.pan.disconnect(); chain.analyser.disconnect();
        if (chain.eq) { chain.eq.low.disconnect(); chain.eq.mid.disconnect(); chain.eq.high.disconnect(); }
        if (chain.reverb) { chain.reverb.input.disconnect(); chain.reverb.dry.disconnect(); chain.reverb.conv.disconnect(); chain.reverb.wet.disconnect(); chain.reverb.output.disconnect(); }
        if (chain.delay) { chain.delay.input.disconnect(); chain.delay.dry.disconnect(); chain.delay.delay.disconnect(); chain.delay.fb.disconnect(); chain.delay.wet.disconnect(); chain.delay.output.disconnect(); }
      } catch (_) {}
      _dawTrackChains.delete(id);
    }
  }
  for (const t of dawState.tracks) {
    let chain = _dawTrackChains.get(t.id);
    if (!chain) {
      const gain = ctx.createGain();
      const eq = _dawMakeEq(ctx);
      const reverb = _dawMakeReverb(ctx);
      const delay = _dawMakeDelay(ctx);
      const pan = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      gain.connect(eq.input);
      eq.output.connect(reverb.input);
      reverb.output.connect(delay.input);
      delay.output.connect(pan);
      pan.connect(analyser); analyser.connect(_dawMaster);
      chain = { gain, pan, analyser, eq, reverb, delay };
      _dawTrackChains.set(t.id, chain);
    }
    chain.pan.pan.value = t.pan ?? 0;
    dawEngineSetTrackFx(t.id, t.fx);
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

// Linear per-clip gain+fade envelope on a GainNode, in clip-local time (correct mid-clip).
function _dawScheduleClipEnvelope(cg, when, localStart, playDur, gain, fadeIn, fadeOut) {
  const dur = localStart + playDur;
  if (fadeIn + fadeOut > dur && (fadeIn + fadeOut) > 0) {
    const scale = dur / (fadeIn + fadeOut);
    fadeIn *= scale; fadeOut *= scale;
  }
  const env = (u) => {
    let f = 1;
    if (fadeIn > 0 && u < fadeIn) f = u / fadeIn;
    else if (fadeOut > 0 && u > dur - fadeOut) f = (dur - u) / fadeOut;
    return gain * Math.max(0, Math.min(1, f));
  };
  cg.gain.setValueAtTime(env(localStart), when);
  const bps = [];
  if (fadeIn > 0) bps.push(fadeIn);
  if (fadeOut > 0) bps.push(dur - fadeOut);
  bps.push(dur);
  bps.sort((a, b) => a - b);
  for (const bp of bps) {
    if (bp > localStart) cg.gain.linearRampToValueAtTime(env(bp), when + (bp - localStart));
  }
}

// Peak abs sample across channels over a clip's [offset, offset+dur] window (0 if buffer absent).
function dawEngineClipPeak(file, offsetSec, durSec) {
  const buf = _dawBufferCache.get(file);
  if (!buf || buf === "error") return 0;
  const sr = buf.sampleRate;
  const start = Math.max(0, Math.floor(offsetSec * sr));
  const end = Math.min(buf.length, Math.floor((offsetSec + durSec) * sr));
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = start; i < end; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
  }
  return peak;
}

// True reschedule — clip edits change envelopes scheduled at clip start.
function dawRescheduleClips() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  _dawStopSources();
  _dawScheduleAll();
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
  _dawCtxAtStart = ctx.currentTime;
  _dawPerfAtStart = (typeof performance !== "undefined") ? performance.now() : 0;
  for (const track of dawState.tracks) {
    const chain = _dawTrackChains.get(track.id);
    if (!chain) continue;
    if (track.kind === "midi") { _dawScheduleMidiTrack(track, chain, ctx); continue; }
    for (const clip of track.clips) {
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= _dawPlayhead) continue;
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;
      const srcLen = (clip.src_len ?? clip.duration) || buf.duration;
      const r = (srcLen > 0) ? (clip.duration / srcLen) : 1;
      const rate = 1 / r;
      let when, srcStart, srcConsume, timelineDur;
      if (clip.start >= _dawPlayhead) {
        when = _dawStartCtxTime + (clip.start - _dawPlayhead);
        srcStart = clip.offset; srcConsume = srcLen; timelineDur = clip.duration;
      } else {
        const into = _dawPlayhead - clip.start;          // timeline seconds
        when = _dawStartCtxTime;
        srcStart = clip.offset + into / r; srcConsume = srcLen - into / r; timelineDur = clip.duration - into;
      }
      const clipLocalStart = (clip.start >= _dawPlayhead) ? 0 : (_dawPlayhead - clip.start);
      const src = ctx.createBufferSource();
      const cg = ctx.createGain();
      src.connect(cg); cg.connect(chain.gain);
      const stretched = (clip.pitch_lock && Math.abs(r - 1) > 1e-3 && typeof dawStretchGet === "function") ? dawStretchGet(clip) : null;
      if (stretched) {
        src.buffer = stretched;
        src.playbackRate.value = 1;
        _dawScheduleClipEnvelope(cg, when, clipLocalStart, timelineDur, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(when, clipLocalStart, timelineDur);
      } else {
        if (clip.pitch_lock && Math.abs(r - 1) > 1e-3 && typeof dawRenderStretch === "function") dawRenderStretch(clip);
        src.buffer = buf;
        src.playbackRate.value = rate;
        _dawScheduleClipEnvelope(cg, when, clipLocalStart, timelineDur, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(when, srcStart, srcConsume);
      }
      _dawActiveSources.push(src);
    }
  }
  _dawApplyMixState();
}

function _dawStopSources() {
  for (const s of _dawActiveSources) { try { s.stop(); } catch (_) {} }
  _dawActiveSources = [];
  if (typeof dawMidiAllNotesOff === "function") dawMidiAllNotesOff();
}

let _dawMidiActiveOuts = new Set();
let _dawCtxAtStart = 0, _dawPerfAtStart = 0;
function _dawApplyAdsr(gainParam, when, dur, peak, env) {
  gainParam.setValueAtTime(0.0001, when);
  if (env === "pad") {
    const a = 0.15, r = 0.4;
    gainParam.linearRampToValueAtTime(peak, when + Math.min(a, dur));
    gainParam.setValueAtTime(peak, when + dur);
    gainParam.linearRampToValueAtTime(0.0001, when + dur + r);
  } else {
    const a = 0.005, d = Math.min(0.12, dur);
    gainParam.linearRampToValueAtTime(peak, when + a);
    gainParam.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.25), when + a + d);
    gainParam.linearRampToValueAtTime(0.0001, when + dur + 0.08);
  }
}
function dawPreviewNote(trackId, pitch, vel) {
  const ctx = _dawEnsureCtx();
  if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
  const track = dawState.tracks.find(t => t.id === trackId);
  const synth = (track && track.synth) || { wave: "sawtooth", env: "pluck" };
  try { _dawSyncChains(); } catch (_) {}
  const chain = _dawTrackChains.get(trackId);
  const dest = chain ? chain.gain : _dawMaster;
  if (!dest) return;
  const now = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator(); osc.type = synth.wave || "sawtooth";
  osc.frequency.value = (typeof _dawNoteFreq === "function") ? _dawNoteFreq(pitch) : 440 * Math.pow(2, (pitch - 69) / 12);
  const g = ctx.createGain();
  const peak = Math.max(0.001, ((vel || 100) / 127) * 0.3);
  _dawApplyAdsr(g.gain, now, 0.22, peak, synth.env || "pluck");
  osc.connect(g); g.connect(dest);
  osc.start(now); osc.stop(now + 0.4);
}

function _dawScheduleMidiTrack(track, chain, ctx) {
  const out = (track.midi_out && typeof dawMidiGetOutput === "function") ? dawMidiGetOutput(track.midi_out) : null;
  const synth = track.synth || { wave: "sawtooth", env: "pluck" };
  for (const n of (track.notes || [])) {
    const nEnd = n.start + n.dur;
    if (nEnd <= _dawPlayhead) continue;
    const startT = Math.max(n.start, _dawPlayhead);
    const when = _dawStartCtxTime + (startT - _dawPlayhead);
    const dur = Math.max(0.02, nEnd - startT);
    if (out) {
      const onMs = _dawPerfAtStart + (when - _dawCtxAtStart) * 1000;
      const offMs = onMs + dur * 1000;
      try {
        out.send([0x90, n.pitch & 127, n.vel & 127], onMs);
        out.send([0x80, n.pitch & 127, 0], offMs);
        _dawMidiActiveOuts.add(out);
      } catch (_) {}
    } else {
      const osc = ctx.createOscillator(); osc.type = synth.wave || "sawtooth";
      osc.frequency.value = (typeof _dawNoteFreq === "function") ? _dawNoteFreq(n.pitch) : 440;
      const g = ctx.createGain();
      const peak = Math.max(0.001, (n.vel / 127) * 0.3);
      _dawApplyAdsr(g.gain, when, dur, peak, synth.env || "pluck");
      osc.connect(g); g.connect(chain.gain);
      const rel = (synth.env === "pad") ? 0.4 : 0.08;
      osc.start(when); osc.stop(when + dur + rel);
      _dawActiveSources.push(osc);
    }
  }
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

// ── Session grid looper (free-launch loops through track chains) ───────────────
const _dawGridActive = new Map();   // trackId → { src, sceneIdx }

async function dawLaunchCell(trackId, sceneIdx) {
  const track = dawState.tracks.find(t => t.id === trackId);
  if (!track || !track.cells) return;
  const ref = track.cells[sceneIdx];
  if (!ref) return;
  const ctx = _dawEnsureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  _dawSyncChains(); _dawApplyMixState();
  dawStopCell(trackId);                       // one active cell per column
  const buf = await dawGetBuffer(ref.file);
  if (!buf) return;
  const chain = _dawTrackChains.get(trackId);
  if (!chain) return;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  src.connect(chain.gain);
  src.start();
  _dawGridActive.set(trackId, { src, sceneIdx });
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
}

function dawStopCell(trackId) {
  const a = _dawGridActive.get(trackId);
  if (a) { try { a.src.stop(); } catch (_) {} _dawGridActive.delete(trackId); }
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
}

function dawStopAllCells() {
  for (const [, a] of _dawGridActive) { try { a.src.stop(); } catch (_) {} }
  _dawGridActive.clear();
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
}

function dawCellActive(trackId) {
  const a = _dawGridActive.get(trackId);
  return a ? a.sceneIdx : -1;
}
