// ── DAW recording: MIDI-in → notes, audio-in → clip ────────────────────────────
// Transport-integrated. Press ● REC with tracks armed:
//   · midi tracks  → incoming MIDI NoteOn/NoteOff becomes notes[] at the playhead
//   · audio tracks → microphone becomes an audio clip (uploaded to /daw/import)
// Timestamps are anchored to the AudioContext clock so they line up whether or
// not the transport is playing. Optional metronome click.
let _dawRec = null;                 // active session state
let _dawRecInput = null;            // currently attached MIDIInput
let _dawRecRaf = null;
let _dawRecClickTimer = null;
let _dawMidiInputSel = "auto";
let _dawAudioInputDev = null;
let _dawMetronomeOn = true;
let _dawRecMon = new Map();             // trackId -> Map(pitch -> { g, oscs }) — live monitor voices

// Shared MIDI message fan-out (record handler + monitor both subscribe).
const _dawMidiListeners = new Set();
dawAddMidiListener(_dawRecOnMidi);      // recording handler guards itself on _dawRec
function dawAddMidiListener(fn) { _dawMidiListeners.add(fn); }
function dawRemoveMidiListener(fn) { _dawMidiListeners.delete(fn); }
function _dawMidiDispatch(e) { for (const fn of _dawMidiListeners) { try { fn(e); } catch (_) {} } }

// Shared microphone stream with reference counting (record + monitor).
let _dawMicStream = null, _dawMicRefs = 0, _dawMicDevice = null;
async function _dawMicAcquire() {
  _dawMicRefs++;
  if (_dawMicStream && _dawMicStream.active && _dawMicDevice === _dawAudioInputDev) return _dawMicStream;
  if (_dawMicStream) {
    try { _dawMicStream.getTracks().forEach(tr => tr.stop()); } catch (_) {}
    _dawMicStream = null;
  }
  try {
    const c = _dawAudioInputDev ? { audio: { deviceId: { exact: _dawAudioInputDev } } } : { audio: true };
    _dawMicStream = await navigator.mediaDevices.getUserMedia(c);
    _dawMicDevice = _dawAudioInputDev;
  } catch (err) {
    _dawMicRefs = Math.max(0, _dawMicRefs - 1);
    _dawMicStream = null;
    throw err;
  }
  return _dawMicStream;
}
function _dawMicRelease() {
  _dawMicRefs = Math.max(0, _dawMicRefs - 1);
  if (_dawMicRefs === 0 && _dawMicStream) {
    try { _dawMicStream.getTracks().forEach(tr => tr.stop()); } catch (_) {}
    _dawMicStream = null; _dawMicDevice = null;
  }
}

// Monitor state.
let _dawMonOpen = false, _dawMonRaf = null, _dawMonAnalyser = null, _dawMonSource = null;
let _dawMonActive = new Map(), _dawMonKeyEls = new Map(), _dawMonMsgCount = 0;
let _dawMonPeakHold = 0;

// ── UI wiring ───────────────────────────────────────────────────────────────
function dawRecWireUi() {
  const recBtn = document.getElementById("daw-record-btn");
  const midiSel = document.getElementById("daw-midi-in-select");
  const audioSel = document.getElementById("daw-audio-in-select");
  const clickCb = document.getElementById("daw-metronome");
  if (recBtn) recBtn.addEventListener("click", () => dawToggleRecord());
  const monBtn = document.getElementById("daw-monitor-toggle");
  if (monBtn) monBtn.addEventListener("click", () => dawToggleMonitor());
  if (midiSel) {
    midiSel.addEventListener("focus", () => dawRecPopulateMidiInputs());
    midiSel.addEventListener("change", () => { _dawMidiInputSel = midiSel.value; dawRecAttachMidi(); });
  }
  if (audioSel) {
    audioSel.addEventListener("focus", () => dawRecPopulateAudioInputs());
    audioSel.addEventListener("change", () => {
      _dawAudioInputDev = audioSel.value || null;
      if (typeof dawP2MOnStreamChanged === "function") dawP2MOnStreamChanged();
      if (_dawMonOpen && _dawMicRefs <= 1 && !(_dawRec && _dawRec.active)) {
        _dawMicRelease();
        _dawMicAcquire().then(s => { _dawMonSetupAnalyser(s); _dawMonSetMicDevice(); })
          .catch(() => _dawMonSetMicDevice("microphone unavailable"));
      }
    });
  }
  if (clickCb) clickCb.addEventListener("change", () => { _dawMetronomeOn = clickCb.checked; });
  dawRecPopulateAudioInputs();
}

function dawRecStatus(msg) {
  const el = document.getElementById("daw-record-status");
  if (el) el.textContent = msg || "";
}

function _dawSetRecButton(on) {
  const b = document.getElementById("daw-record-btn");
  if (!b) return;
  b.textContent = on ? "● STOP" : "● REC";
  b.style.background = on ? "#e05f5f" : "";
  b.style.color = on ? "#fff" : "";
}

// ── Device discovery ───────────────────────────────────────────────────────────
async function dawRecPopulateMidiInputs() {
  const sel = document.getElementById("daw-midi-in-select");
  if (!sel) return;
  const acc = await dawInitMidi();
  if (!acc) {
    const hint = typeof dawMidiErrorHint === "function" ? dawMidiErrorHint() : "";
    sel.innerHTML = "";
    const o = document.createElement("option"); o.value = "auto";
    o.textContent = hint ? "MIDI: " + hint : "no MIDI";
    sel.appendChild(o);
    return;
  }
  const cur = sel.value;
  sel.innerHTML = "";
  const auto = document.createElement("option"); auto.value = "auto"; auto.textContent = "MIDI in: auto"; sel.appendChild(auto);
  for (const inp of acc.inputs.values()) {
    const o = document.createElement("option"); o.value = inp.id; o.textContent = inp.name || "MIDI input"; sel.appendChild(o);
  }
  if (cur) sel.value = cur; else sel.value = "auto";
  _dawMidiInputSel = sel.value;
  dawRecAttachMidi();
}

async function dawRecPopulateAudioInputs() {
  const sel = document.getElementById("daw-audio-in-select");
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  if (sel.options.length > 1) return;
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    if (!inputs.length) return;
    sel.innerHTML = "";
    const d0 = document.createElement("option"); d0.value = ""; d0.textContent = "Mic: default"; sel.appendChild(d0);
    inputs.forEach((d, i) => {
      const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || ("Microphone " + (i + 1)); sel.appendChild(o);
    });
  } catch (_) {}
}

// ── Arm / record API ──────────────────────────────────────────────────────────
function dawToggleArm(trackId) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return;
  t.arm = !t.arm;
  if (typeof renderTimeline === "function") renderTimeline();
  if (!_dawRec) dawRecStatus(t.arm ? "armed — press ● REC" : "");
}

function dawRecAttachMidi() {
  if (_dawRecInput) { try { _dawRecInput.onmidimessage = null; } catch (_) {} }
  _dawRecInput = null;
  if (!_dawMidiAccess) return;
  if (_dawMidiInputSel === "auto") {
    _dawRecInput = _dawMidiAccess.inputs.values().next().value || null;
  } else {
    for (const i of _dawMidiAccess.inputs.values()) if (i.id === _dawMidiInputSel) { _dawRecInput = i; break; }
  }
  if (_dawRecInput) _dawRecInput.onmidimessage = _dawMidiDispatch;
}

async function dawToggleRecord() {
  if (_dawRec) await dawStopRecord();
  else await dawStartRecord();
}

async function dawStartRecord() {
  if (_dawRec) return;
  const tracks = (dawState.tracks || []).filter(t => t.arm);
  const midiTracks = tracks.filter(t => t.kind === "midi").map(t => t.id);
  const audioTracks = tracks.filter(t => t.kind !== "midi").map(t => t.id);
  if (!midiTracks.length && !audioTracks.length) { dawRecStatus("arm a track first (●)"); return; }

  const ctx = (typeof _dawEnsureCtx === "function") ? _dawEnsureCtx() : null;
  if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
  _dawRec = {
    active: true,
    t0: (typeof dawGetPlayhead === "function") ? dawGetPlayhead() : 0,
    ctx0: ctx ? ctx.currentTime : 0,
    perf0: performance.now(),
    midiTracks, audioTracks,
    pending: {}, recorders: [], stream: null,
  };
  _dawSetRecButton(true);

  if (midiTracks.length) {
    for (const tid of midiTracks) _dawRec.pending[tid] = {};
    if (typeof dawInitMidi === "function") await dawInitMidi();
    dawRecAttachMidi();
    dawRecStatus(_dawRecInput ? "recording MIDI…" : "recording (no MIDI input found)");
  }
  if (audioTracks.length) await _dawRecStartAudio(audioTracks);

  _dawRecTick();
  if (_dawMetronomeOn) _dawRecClickSched();
}

function dawRecNow() {
  const r = _dawRec; if (!r) return (typeof dawGetPlayhead === "function") ? dawGetPlayhead() : 0;
  if (_dawCtx) return r.t0 + (_dawCtx.currentTime - r.ctx0);
  return r.t0 + (performance.now() - r.perf0) / 1000;
}

// Advance the playhead while recording when the transport isn't playing.
function _dawRecTick() {
  if (!_dawRec) return;
  if (_dawCtx && !_dawIsPlaying) {
    const t = _dawRec.t0 + (_dawCtx.currentTime - _dawRec.ctx0);
    _dawPlayhead = t;
    if (typeof dawOnPlayhead === "function") dawOnPlayhead(t);
  }
  _dawRecRaf = requestAnimationFrame(_dawRecTick);
}

// ── MIDI-in → notes ────────────────────────────────────────────────────────────
function _dawRecOnMidi(e) {
  const r = _dawRec;
  if (!r || !r.active) return;
  const d = e.data;
  if (!d || d.length < 3) return;
  const st = d[0] & 0xf0;
  const pitch = d[1] & 127, vel = d[2] & 127;
  if (st === 0x90 && vel > 0) {
    const at = dawRecNow();
    for (const tid of r.midiTracks) {
      r.pending[tid][pitch] = { start: at, vel };
      _dawMonitorOn(tid, pitch, vel);
    }
  } else if (st === 0x80 || (st === 0x90 && vel === 0)) {
    const t = dawRecNow();
    for (const tid of r.midiTracks) {
      const p = r.pending[tid] && r.pending[tid][pitch];
      if (p) {
        delete r.pending[tid][pitch];
        const track = dawState.tracks.find(x => x.id === tid);
        if (track) {
          (track.notes = track.notes || []).push({ start: p.start, dur: Math.max(0.02, t - p.start), pitch, vel: p.vel });
        }
      }
      _dawMonitorOff(tid, pitch);
    }
    if (typeof renderTimeline === "function") renderTimeline();
  }
}

// ── Live monitoring of the MIDI input while recording ───────────────────────────
// External-MIDI tracks pass the note through to the hardware; internal-synth
// tracks play real-time oscillators through the track chain (so mute/solo/volume
// and FX apply). Voices sustain until the matching NoteOff arrives.
function _dawMonitorOn(trackId, pitch, vel) {
  const t = dawState.tracks.find(x => x.id === trackId);
  if (!t) return;
  const out = (t.midi_out && typeof dawMidiGetOutput === "function") ? dawMidiGetOutput(t.midi_out) : null;
  if (out) { try { out.send([0x90, pitch & 127, vel & 127]); } catch (_) {} return; }
  const ctx = _dawCtx; if (!ctx) return;
  try { if (typeof _dawSyncChains === "function") _dawSyncChains(); } catch (_) {}
  const chain = _dawTrackChains.get(trackId);
  const dest = chain ? chain.gain : _dawMaster;
  if (!dest) return;
  const synth = t.synth || ((typeof _dawDefaultSynth === "function") ? _dawDefaultSynth() : { wave: "sawtooth" });
  const wave = synth.wave || "sawtooth";
  const freq = 440 * Math.pow(2, (pitch - 69) / 12);
  const now = ctx.currentTime + 0.005;
  const peak = Math.max(0.001, (vel / 127) * 0.3);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(peak, now + 0.012);
  const oscs = [ctx.createOscillator()];
  oscs[0].type = wave; oscs[0].frequency.value = freq; oscs[0].connect(g);
  if (wave === "sawtooth" || wave === "square") {
    const o2 = ctx.createOscillator(); o2.type = wave; o2.frequency.value = freq * 1.005;
    const g2 = ctx.createGain(); g2.gain.value = 0.35; o2.connect(g2); g2.connect(g);
    oscs.push(o2);
  }
  g.connect(dest);
  let m = _dawRecMon.get(trackId);
  if (!m) { m = new Map(); _dawRecMon.set(trackId, m); }
  if (m.has(pitch)) _dawMonitorOff(trackId, pitch);
  for (const o of oscs) o.start(now);
  m.set(pitch, { g, oscs });
}

function _dawMonitorOff(trackId, pitch) {
  const t = dawState.tracks.find(x => x.id === trackId);
  if (!t) return;
  const out = (t.midi_out && typeof dawMidiGetOutput === "function") ? dawMidiGetOutput(t.midi_out) : null;
  if (out) { try { out.send([0x80, pitch & 127, 0]); } catch (_) {} return; }
  const m = _dawRecMon.get(trackId); if (!m) return;
  const n = m.get(pitch); if (!n) return;
  const ctx = _dawCtx;
  if (ctx) {
    const now = ctx.currentTime;
    n.g.gain.cancelScheduledValues(now);
    n.g.gain.setValueAtTime(Math.max(n.g.gain.value, 0.0001), now);
    n.g.gain.linearRampToValueAtTime(0.0001, now + 0.07);
    for (const o of n.oscs) { try { o.stop(now + 0.09); } catch (_) {} }
  }
  m.delete(pitch);
}

// Kill every monitor voice + hardware note for the given tracks (record stop).
function _dawMonitorRelease(trackIds) {
  for (const tid of trackIds) {
    const t = dawState.tracks.find(x => x.id === tid);
    const out = (t && t.midi_out && typeof dawMidiGetOutput === "function") ? dawMidiGetOutput(t.midi_out) : null;
    const m = _dawRecMon.get(tid);
    if (m) for (const pitch of [...m.keys()]) _dawMonitorOff(tid, pitch);
    if (out) { try { out.send([0xB0, 123, 0]); } catch (_) {} }
  }
  _dawRecMon.clear();
}

// ── Audio-in → clip ────────────────────────────────────────────────────────────
async function _dawRecStartAudio(trackIds) {
  const t0 = _dawRec.t0;
  let stream;
  try {
    stream = await _dawMicAcquire();
  } catch (err) {
    // Mic denied/unavailable — audio tracks fall back to nothing, MIDI still works.
    _dawRec.audioTracks = [];
    _dawRec.recorders = [];
    dawRecStatus("mic unavailable (audio tracks skipped)");
    return;
  }
  _dawRec.stream = stream;
  const mime = (typeof MediaRecorder === "undefined") ? "" :
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" :
    MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" :
    MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
  const ext = mime.includes("mp4") ? "m4a" : "webm";
  _dawRec.recorders = [];
  try {
    for (const tid of trackIds) {
      const track = dawState.tracks.find(t => t.id === tid);
      if (!track) continue;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = () => {
        _dawRecUploadAudio(track, chunks, rec.mimeType || mime, ext, t0).catch(err => dawRecStatus("audio upload failed: " + err.message));
      };
      rec.start(250);
      _dawRec.recorders.push(rec);
    }
  } catch (err) {
    _dawMicRelease();
    _dawRec.stream = null;
    _dawRec.audioTracks = [];
    _dawRec.recorders = [];
    dawRecStatus("mic unavailable (audio tracks skipped)");
  }
}

async function _dawRecUploadAudio(track, chunks, mime, ext, t0) {
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: mime });
  const fd = new FormData();
  fd.append("file", new File([blob], "rec_" + _dawUid("a") + "." + ext, { type: mime }));
  const resp = await fetch("/daw/import", { method: "POST", body: fd });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.error || "Upload failed");
  const clip = dawAddClip(track.id, {
    file: data.file,
    name: (data.name || "recorded").slice(0, 24),
    source_duration: data.duration || 0,
  }, t0);
  if (clip) {
    try {
      await dawGetBuffer(clip.file);
      const buf = (typeof _dawBufferCache !== "undefined") ? _dawBufferCache.get(clip.file) : null;
      if (buf && buf !== "error") { clip.duration = clip.source_duration = clip.src_len = buf.duration; }
    } catch (_) {}
  }
  if (typeof renderTimeline === "function") renderTimeline();
  dawRecStatus("audio recorded ✓");
}

// ── Stop ────────────────────────────────────────────────────────────────────────
async function dawStopRecord() {
  const r = _dawRec;
  if (!r) return;
  r.active = false;
  cancelAnimationFrame(_dawRecRaf); _dawRecRaf = null;
  clearTimeout(_dawRecClickTimer); _dawRecClickTimer = null;

  // Close any notes still held at stop time.
  const tEnd = dawRecNow();
  for (const tid of r.midiTracks) {
    const pend = (r.pending || {})[tid]; if (!pend) continue;
    const track = dawState.tracks.find(x => x.id === tid);
    if (!track) continue;
    for (const k of Object.keys(pend)) {
      const p = pend[k];
      (track.notes = track.notes || []).push({ start: p.start, dur: Math.max(0.02, tEnd - p.start), pitch: parseInt(k, 10), vel: p.vel });
    }
  }

  // Finalize MIDI-in capture + stop audio recorders (uploads happen async in onstop).
  const hadMidi = r.midiTracks.length > 0;
  const recs = r.recorders || [];
  _dawMonitorRelease(r.midiTracks);
  if (r.stream) { _dawMicRelease(); r.stream = null; }
  for (const rec of recs) { try { if (rec.state !== "inactive") rec.stop(); } catch (_) {} }

  _dawRec = null;
  _dawSetRecButton(false);
  for (const t of dawState.tracks) t.arm = false;
  if (typeof renderTimeline === "function") renderTimeline();
  dawRecStatus(recs.length ? "saving audio…" : (hadMidi ? "MIDI recorded ✓" : "stopped"));
}

// Used by transport stop + project switching: never throws.
async function dawRecStopAll() {
  if (_dawRec) await dawStopRecord();
}

// ── Metronome (beat click while recording) ───────────────────────────────────────
function _dawRecPlayClick(accent, when) {
  const ctx = _dawCtx; if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = accent ? 1046 : 1318;
  const g = ctx.createGain();
  const t0 = when - 0.01;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(accent ? 0.16 : 0.09, t0 + 0.002);
  g.gain.linearRampToValueAtTime(0.0001, t0 + 0.045);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + 0.06);
}

function _dawRecClickSched() {
  if (!_dawRec || !_dawCtx) return;
  const beat = 60 / (dawState.tempo || 120);
  const now = _dawCtx.currentTime - _dawRec.ctx0;
  const bIdx = Math.floor(now / beat) + 1;
  const waitMs = Math.max(0, (bIdx * beat - now) * 1000);
  _dawRecClickTimer = setTimeout(() => {
    if (!_dawRec) { _dawRecClickTimer = null; return; }
    if (_dawMetronomeOn) _dawRecPlayClick(bIdx % 4 === 0, _dawRec.ctx0 + bIdx * beat);
    _dawRecClickSched();
  }, waitMs);
}

// ── Monitor: live MIDI in + audio-input level ───────────────────────────────────
const _DAW_MON_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function _dawNoteName(p) { return _DAW_MON_NOTES[p % 12] + (Math.floor(p / 12) - 1); }
function _dawMonIsBlack(p) { return (p % 12 === 1 || p % 12 === 3 || p % 12 === 6 || p % 12 === 8 || p % 12 === 10); }

function dawToggleMonitor() {
  if (_dawMonOpen) dawMonClose();
  else dawMonOpen();
}

async function dawMonOpen() {
  if (_dawMonOpen) return;
  _dawMonOpen = true;
  const panel = document.getElementById("daw-monitor-panel");
  const btn = document.getElementById("daw-monitor-toggle");
  if (panel) panel.style.display = "flex";
  if (btn) { btn.style.background = "#7c65d9"; btn.style.color = "#fff"; }

  // MIDI side — populate the input list + attach the dispatcher so activity shows live.
  if (typeof dawRecPopulateMidiInputs === "function") { try { await dawRecPopulateMidiInputs(); } catch (_) {} }
  dawAddMidiListener(_dawMidMonMsg);
  _dawMidMonStatus();
  _dawMidMonReset();

  // Mic side — acquire the shared stream and build the analyser.
  try {
    const stream = await _dawMicAcquire();
    _dawMonSetupAnalyser(stream);
    _dawMonSetMicDevice();
  } catch (_) {
    _dawMonSetMicDevice("microphone unavailable");
  }
  if (_dawMonRaf) cancelAnimationFrame(_dawMonRaf);
  _dawMonRaf = requestAnimationFrame(_dawMonTick);
}

function dawMonClose() {
  if (!_dawMonOpen) return;
  _dawMonOpen = false;
  if (_dawMonRaf) cancelAnimationFrame(_dawMonRaf); _dawMonRaf = null;
  dawRemoveMidiListener(_dawMidMonMsg);
  _dawMonActive.clear();
  _dawMicRelease();
  _dawMonAnalyser = null;
  if (_dawMonSource) { try { _dawMonSource.disconnect(); } catch (_) {} _dawMonSource = null; }
  const panel = document.getElementById("daw-monitor-panel");
  const btn = document.getElementById("daw-monitor-toggle");
  if (panel) panel.style.display = "none";
  if (btn) { btn.style.background = ""; btn.style.color = ""; }
}

function _dawMonSetupAnalyser(stream) {
  const ctx = (typeof _dawEnsureCtx === "function") ? _dawEnsureCtx() : null;
  if (!ctx || !stream) return false;
  if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
  if (_dawMonSource) { try { _dawMonSource.disconnect(); } catch (_) {} _dawMonSource = null; }
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 2048; an.smoothingTimeConstant = 0.4;
  src.connect(an);
  _dawMonSource = src; _dawMonAnalyser = an;
  return true;
}

function _dawMonTick() {
  if (!_dawMonOpen) return;
  const a = _dawMonAnalyser;
  const bar = document.getElementById("daw-mon-mic-meter");
  const dbEl = document.getElementById("daw-mon-mic-db");
  if (a) {
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i] || 0; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    _dawMonPeakHold = Math.max(_dawMonPeakHold * 0.985, rms);
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    const peakDb = 20 * Math.log10(Math.max(_dawMonPeakHold, 1e-5));
    if (bar) bar.style.width = Math.max(0, Math.min(1, (db + 55) / 55) * 100).toFixed(1) + "%";
    if (dbEl) dbEl.textContent = `rms ${db.toFixed(1)} dB · peak ${peakDb.toFixed(1)} dB`;
  }
  _dawMonRaf = requestAnimationFrame(_dawMonTick);
}

function _dawMidMonStatus() {
  const el = document.getElementById("daw-mon-midi-device");
  if (!el) return;
  if (_dawRecInput) el.textContent = "listening — " + (_dawRecInput.name || "MIDI input");
  else {
    const hint = typeof dawMidiErrorHint === "function" ? dawMidiErrorHint() : "";
    el.textContent = hint ? "MIDI blocked: " + hint : "no MIDI input found";
  }
}

function _dawMonSetMicDevice(txt) {
  const el = document.getElementById("daw-mon-mic-device");
  if (el) el.textContent = txt || (_dawMicStream && _dawMicStream.active ? "input active" : "input idle");
}

function _dawMidMonReset() {
  _dawMonActive.clear();
  _dawMidMonRenderKeys();
  const last = document.getElementById("daw-mon-midi-last");
  if (last) last.textContent = "waiting for MIDI…";
}

function _dawMidMonMsg(e) {
  const d = e.data;
  if (!d || d.length < 3) return;
  const st = d[0] & 0xf0, ch = (d[0] & 0x0f) + 1;
  const pitch = d[1] & 127, vel = d[2] & 127;
  _dawMonMsgCount++;
  const name = _dawNoteName(pitch);
  const last = document.getElementById("daw-mon-midi-last");
  if (st === 0x90 && vel > 0) {
    _dawMonActive.set(pitch, performance.now());
    if (last) last.textContent = `#${_dawMonMsgCount} · note ${pitch} (${name}) on · vel ${vel} · ch ${ch}`;
  } else if (st === 0x80 || (st === 0x90 && vel === 0)) {
    _dawMonActive.delete(pitch);
    if (last) last.textContent = `#${_dawMonMsgCount} · note ${pitch} (${name}) off · ch ${ch}`;
  }
  _dawMidMonRenderKeys();
}

function _dawMidMonRenderKeys() {
  if (!_dawMonKeyEls || !_dawMonKeyEls.size) _dawMidMonBuildKeys();
  for (const [p, el] of _dawMonKeyEls) {
    const on = _dawMonActive.has(p);
    el.style.background = on ? "#00d4b6" : (_dawMonIsBlack(p) ? "linear-gradient(180deg,#3a3f4c,#0e1017)" : "linear-gradient(180deg,#f0f2f7,#c9cdd8)");
  }
}

function _dawMidMonBuildKeys() {
  const el = document.getElementById("daw-mon-midi-keys");
  if (!el || el.dataset.built === "1") return;
  el.dataset.built = "1";
  _dawMonKeyEls = new Map();
  const LO = 48, HI = 71, BW = 18, BH = 42, BBW = 11;   // C3..B4 (two octaves)
  const whitePos = new Map();
  let wc = 0;
  for (let p = LO; p <= HI; p++) if (!_dawMonIsBlack(p)) whitePos.set(p, wc++);
  for (let p = LO; p <= HI; p++) {
    const k = document.createElement("div");
    if (_dawMonIsBlack(p)) {
      const r = whitePos.get(p - 1) + 1;
      k.style.cssText = `position:absolute;top:0;height:${Math.round(BH * 0.62)}px;width:${BBW}px;left:${Math.round(r * BW - BBW / 2)}px;z-index:2;border:1px solid #000;border-radius:0 0 3px 3px;background:linear-gradient(180deg,#3a3f4c,#0e1017)`;
    } else {
      k.style.cssText = `position:absolute;top:0;height:${BH}px;width:${BW}px;left:${whitePos.get(p) * BW}px;z-index:1;border:1px solid #7d828f;border-radius:0 0 3px 3px;background:linear-gradient(180deg,#f0f2f7,#c9cdd8)`;
    }
    k.title = `${p} · ${_dawNoteName(p)}`;
    _dawMonKeyEls.set(p, k);
    el.appendChild(k);
  }
}

document.addEventListener("DOMContentLoaded", dawRecWireUi);