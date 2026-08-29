// ── DAW Hum→MIDI: record the hum first, convert it offline after ─────────────
// Flow: 🎙 Mic → 🎙 Rec Hum (capture mic into an audio take on a track) →
// 🎵 Hum→MIDI analyses the recorded audio, snaps the pitches into the
// selected key + scale, and inserts the resulting notes onto a MIDI track
// at the position where you started recording the hum.
let _P2M = {
  micOn: false,          // WE hold a mic reference (button state)
  cap: null,             // { blob, url, anchor, dur, file } — last hum take
  busy: false,           // conversion running
  key: 9,                // tonic pitch class (9 = A)
  scale: "major",
  _rec: null,            // active MediaRecorder while capturing
};
const _P2M_SCALES = {
  chromatic:   [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major:       [0, 2, 4, 5, 7, 9, 11],
  minor:       [0, 2, 3, 5, 7, 8, 10],
  harm_minor:  [0, 2, 3, 5, 7, 8, 11],
  dorian:      [0, 2, 3, 5, 7, 9, 10],
  mixolydian:  [0, 2, 4, 5, 7, 9, 10],
  pent_major:  [0, 2, 4, 7, 9],
  pent_minor:  [0, 3, 5, 7, 10],
  blues:       [0, 3, 5, 6, 7, 10],
};
const _P2M_SCALE_LABELS = [
  ["major", "Major"], ["minor", "Minor"], ["harm_minor", "Harmonic Minor"],
  ["dorian", "Dorian"], ["mixolydian", "Mixolydian"], ["pent_major", "Pentatonic"],
  ["pent_minor", "Min Pent"], ["blues", "Blues"], ["chromatic", "Chromatic"],
];

// Pure: snap a midi pitch (float) onto the nearest note in key+scale.
function dawP2MMapNote(midi, key, scale) {
  key = ((key % 12) + 12) % 12;
  const deg = _P2M_SCALES[scale] || _P2M_SCALES.chromatic;
  if (!deg || deg.length > 11) return Math.round(midi);
  const r = (((midi % 12) + 12) % 12 - key + 24) % 12;
  let bestD = 0, bestGap = 12;
  for (const d of deg) {
    const up = (d - r + 12) % 12, down = (r - d + 12) % 12;
    const gap = Math.min(up, down);
    if (gap < bestGap) { bestGap = gap; bestD = d; }
  }
  const up = (bestD - r + 12) % 12, down = (r - bestD + 12) % 12;
  const delta = up <= down ? up : -down;
  return Math.max(0, Math.min(127, Math.round(midi) + Math.round(delta)));
}

function _p2mShow(msg) {
  const el = document.getElementById("daw-p2m-stat");
  if (el) el.textContent = msg;
}
function _p2mStatus(msg) { if (typeof dawRecStatus === "function") dawRecStatus(msg); }

const _p2mYield = () =>
  (typeof document !== "undefined" && typeof requestAnimationFrame === "function")
    ? new Promise((r) => requestAnimationFrame(() => r()))
    : Promise.resolve();

// Analyse a mono Float32Array into note events via YIN fundamental estimation.
// events: [{ start, dur, pitch, vel }] — pitch is an integer midi note.
// Range ~58 Hz..2.2 kHz (covers voiced hums incl. low male registers).
async function dawP2MExtract(data, sr, onProg) {
  const n = data.length;
  if (n < 512) return [];
  const minLag = Math.max(2, Math.floor(sr / 2200));
  const maxLag = Math.min(Math.floor(sr / 58), Math.floor(n / 2) - 2);
  const win = (Math.max(2048, 3 * maxLag, Math.floor(sr * 0.05)) + 1) & ~1;
  const hop = Math.max(128, Math.floor(sr * 0.016));
  const start = Math.floor((n - win) / hop) + 1;
  if (start <= 0) return [];
  const eSthr = 2e-5 * win;
  const pit = new Float32Array(start);                            // f0 Hz per window (0 = silent)
  const rmsArr = new Float32Array(start);                         // RMS per window (for velocity)

  for (let wi = 0; wi < start; wi++) {
    if (wi % 30 === 0) { await _p2mYield(); if (onProg) onProg(wi / start); }
    const s = wi * hop;
    let eS = 0;
    for (let i = 0; i < win; i++) eS += data[s + i] * data[s + i];
    const rms = Math.sqrt(eS / win);
    rmsArr[wi] = rms;
    if (eS < eSthr || rms < 0.0035) continue;

    // YIN: difference function d(tau) (DC-immune by construction).
    const d = new Float64Array(maxLag + 2);
    const dsumEnd = win - maxLag;
    for (let tau = 1; tau <= maxLag; tau++) {
      let acc = 0;
      const upto = dsumEnd;
      for (let i = 0; i < upto; i++) {
        const dd = data[s + i] - data[s + i + tau];
        acc += dd * dd;
      }
      d[tau] = acc;
    }
    // Cumulative-mean-normalized difference: first dip below threshold that is a
    // LOCAL minimum (dip valley, not a crossing mid-descent) — rejects 2T/3T
    // subharmonic locks. A candidate must also repeat at 2·lag (its double must
    // be equally periodic), which only true periods satisfy — this rejects
    // harmonic-partial lags (T/k) and false small-lag valleys at a stroke.
    let cm = 0, lag = 0;
    for (let tau = minLag; tau <= maxLag; tau++) {
      cm += d[tau];
      if (cm <= 0) continue;
      const r = d[tau] * tau / cm;
      if (r < 0.14) {
        const rPrev = tau > minLag ? d[tau - 1] * (tau - 1) / (cm - d[tau]) : 1;
        const rNext = tau < maxLag ? d[tau + 1] * (tau + 1) / (cm + d[tau + 1]) : 1;
        if (rPrev >= r && r <= rNext) {
          if (2 * tau <= maxLag) {                                // confirm at 2·lag
            let cm2 = cm;
            for (let z = tau + 1; z <= 2 * tau; z++) cm2 += d[z];
            if (d[2 * tau] * 2 * tau / cm2 >= 0.14) continue;     // not a true period → keep looking
          }
          lag = tau; break;
        }
      }
    }
    if (!lag) {                                                   // cloudy frame: first valley
      const tl = Math.max(minLag + 2, Math.floor(minLag * 1.6)); // (don't fish the HF edge)
      for (let tau = tl; tau <= Math.floor(maxLag * 0.95); tau++) {
        const r = d[tau] * tau / cm;
        if (r < 0.35) {
          const rPrev = tau > tl ? d[tau - 1] * (tau - 1) / (cm - d[tau]) : 1;
          const rNext = tau < maxLag ? d[tau + 1] * (tau + 1) / (cm + d[tau + 1]) : 1;
          if (rPrev >= r && r <= rNext) { lag = tau; break; }
        }
      }
      if (!lag) continue;
    }
    // Parabolic interpolation for sub-sample frequency resolution.
    const y0 = d[lag - 1], y1 = d[lag], y2 = d[lag + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-12) {
      const off = 0.5 * (y0 - y2) / den;
      lag += Math.max(-0.5, Math.min(0.5, off));
    }
    lag = Math.max(minLag, Math.min(maxLag, lag));
    pit[wi] = sr / lag;
  }

  // Median filter (11) across pitch only, ignoring silence, to kill single-frame
  // octave flips and vibrato jitter before quantization.
  for (let wi = 0; wi < start; wi++) {
    if (pit[wi] <= 0) continue;
    let k = 0;
    const vals = [];
    for (let j = Math.max(0, wi - 5); j <= Math.min(start - 1, wi + 5); j++) {
      if (pit[j] > 0) { vals[k++] = pit[j]; }
    }
    if (k >= 6) {
      vals.sort((a, b) => a - b);
      pit[wi] = vals[k >> 1];
    }
  }

  // Second, wider median (~0.4 s) over voiced windows: collapses slow estimator
  // drift (vibrato, chirp) to the note's time-averaged pitch. Silence stays 0
  // so note boundaries depend on the real gaps, not on the median window.
  const med2 = new Float32Array(start);
  for (let wi = 0; wi < start; wi++) {
    if (pit[wi] <= 0) continue;
    let k = 0;
    const vals = [];
    const rw = Math.max(12, Math.floor(sr * 0.4 / hop / 2));
    for (let j = Math.max(0, wi - rw); j <= Math.min(start - 1, wi + rw); j++) {
      if (pit[j] > 0) { vals[k++] = pit[j]; }
    }
    if (k >= Math.max(2, Math.floor((2 * rw + 1) * 0.25))) {
      vals.sort((a, b) => a - b);
      med2[wi] = vals[k >> 1];
    }
  }
  for (let wi = 0; wi < start; wi++) if (med2[wi] > 0) pit[wi] = med2[wi];

  const evs = [];
  let out = { pitch: null, raw: 0, t0: 0, vel: 0 };
  const flush = (endT) => {
    if (out.pitch === null) return;
    const dur = endT - out.t0;
    if (dur >= 0.04) {
      const rms = rmsArr[Math.max(0, Math.min(start - 1, Math.round(out.t0 * sr / hop)))];
      out.vel = Math.max(40, Math.min(120, Math.round(40 + Math.min(1, rms) * 170)));
      evs.push({ start: out.t0, dur, pitch: dawP2MMapNote(out.raw, _P2M.key, _P2M.scale), vel: out.vel });
    }
    out.pitch = null;
  };
  for (let wi = 0; wi < start; wi++) {
    const t = (wi * hop) / sr;
    const f = pit[wi];
    if (!(f > 0)) {
      if (out.pitch !== null) flush(t + 0.15);                    // close on silence
      continue;
    }
    const midiF = 69 + 12 * Math.log2(f / 440);
    if (out.pitch === null) {
      out.pitch = 1; out.raw = midiF; out.t0 = t;
    } else if (Math.abs(midiF - out.raw) < 0.6) {
      out.raw = out.raw * 0.5 + midiF * 0.5;                      // keep the lock armed
    } else {
      flush(t);
      out.pitch = 1; out.raw = midiF; out.t0 = t;
    }
  }
  flush(((start - 1) * hop + win) / sr);
  return evs;
}

// ── Mic toggle ────────────────────────────────────────────────────────────────
async function dawP2MToggleMic() {
  if (_P2M.micOn) {
    if (_P2M._rec) await dawP2MRecHum();                        // stop capture first
    _dawMicRelease();
    _P2M.micOn = false;
    _p2mStatus("mic off");
  } else {
    try {
      await _dawMicAcquire();
      _P2M.micOn = true;
      _p2mStatus("mic on — 🎙 Rec Hum to capture, then 🎵 Hum→MIDI");
    } catch (_) { _p2mStatus("mic unavailable (permission denied?)"); }
  }
  _p2mUi();
}

// ── Hum capture (mic → audio take on a track) ───────────────────────────────
async function dawP2MRecHum() {
  if (_P2M._rec) {                                               // stop
    const rec = _P2M._rec; _P2M._rec = null;
    let stopped;
    try { stopped = rec.stop(); if (stopped && stopped.then) await stopped; } catch (_) {}
    _p2mUi();
    return;
  }
  try {
    if (!_P2M.micOn) await _dawMicAcquire();
    if (!_P2M.micOn) { _P2M.micOn = true; }
    if (!_dawMicStream || !_dawMicStream.active) throw new Error("no mic stream");
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(_dawMicStream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const anchor = (typeof dawGetPlayhead === "function") ? dawGetPlayhead() : 0;
    rec.start();
    rec.onstop = () => _humFinish(rec, rec._hum);
    _P2M._rec = rec;
    rec._hum = { chunks, anchor, t0: performance.now() };
    _p2mShow("🔴 rec hum… tap again to stop");
    _p2mStatus("hum recording — hum/sing a bar, tap ⬛ Stop when done");
  } catch (err) {
    _p2mShow("mic unavailable");
    _p2mStatus("hum recording failed: " + (err && err.message ? err.message : err));
  }
  _p2mUi();
}

function _humFinish(rec, cap) {
  const blob = new Blob(cap.chunks, { type: rec.mimeType || "audio/webm" });
  _P2M.cap = { blob, anchor: cap.anchor, dur: (performance.now() - cap.t0) / 1000, file: null };
  _p2mShow(`hum ${_P2M.cap.dur.toFixed(1)}s captured ✔ — set key/scale, then 🎵 Hum→MIDI`);
  _p2mStatus(`hum take ${_P2M.cap.dur.toFixed(1)}s recorded at ${_FMT(cap.anchor)}`);
  _humImportTake();                                               // land it on an audio track
  _p2mUi();
}

async function _humImportTake() {
  const cap = _P2M.cap;
  if (!cap || cap.dur < 0.4 || typeof document === "undefined") return;
  try {
    const fd = new FormData();
    fd.append("file", new File([cap.blob], "hum_take.webm", { type: cap.blob.type || "audio/webm" }));
    const resp = await fetch("/daw/import", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || "upload failed");
    cap.file = data.file;
    let track = dawState.tracks.find((t) => t.kind !== "midi");
    if (!track && typeof dawAddTrack === "function") {
      dawAddTrack("Hum 🎤 take");
      track = dawState.tracks.find((t) => t.kind !== "midi");
    }
    if (track) {
      const clip = dawAddClip(track.id, {
        file: data.file, name: "Hum 🎤 take",
        source_duration: data.duration || cap.dur,
      }, cap.anchor);
      if (clip && typeof dawGetBuffer === "function") {
        await dawGetBuffer(clip.file);
        renderTimeline();
        if (typeof dawLoadLibrary === "function") dawLoadLibrary();
      }
    }
  } catch (_) {}                                                   // keep blob for conversion anyway
}

// ── Offline Hum→MIDI conversion ──────────────────────────────────────────────
async function dawP2MConvert() {
  if (_P2M.busy) return;
  if (!_P2M.cap || !_P2M.cap.blob) { _p2mShow("nothing recorded — press 🎙 Rec Hum first"); return; }
  const cap = _P2M.cap;
  _P2M.busy = true; _p2mUi();
  try {
    _p2mShow("decoding hum…");
    _p2mStatus("hum→midi: analysing the recorded take…");
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ac = new Ctor();
    let mono, sr;
    try {
      const buf = await ac.decodeAudioData(await cap.blob.arrayBuffer());
      sr = buf.sampleRate;
      if (buf.numberOfChannels > 1) {
        const ch0 = buf.getChannelData(0), ch1 = buf.getChannelData(1);
        mono = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
      } else mono = buf.getChannelData(0);
    } finally { try { ac.close(); } catch (_) {} }

    const events = await dawP2MExtract(mono, sr, (p) => {
      _p2mShow("converting… " + Math.round(p * 100) + "%");
    });
    if (!events.length) {
      _p2mShow("no sustained pitches found — try humming clearer/louder");
      _p2mStatus("hum→midi: nothing to convert");
      return;
    }

    // Target: armed MIDI track, else first MIDI track, else create one.
    let tgt = (dawState.tracks || []).find((t) => t.kind === "midi" && t.arm)
      || (dawState.tracks || []).find((t) => t.kind === "midi");
    if (!tgt) tgt = (typeof dawAddMidiTrack === "function") ? dawAddMidiTrack("Hum 🎤 MIDI") : null;
    if (!tgt) { _p2mShow("no MIDI track — add one first"); return; }

    tgt.notes = tgt.notes || [];
    for (const e of events) {
      const q = (typeof dawQuantRange === "function")
        ? dawQuantRange(cap.anchor + e.start, e.dur)
        : { start: cap.anchor + e.start, dur: e.dur };
      tgt.notes.push({ start: Math.max(0, q.start), dur: q.dur, pitch: e.pitch, vel: e.vel });
    }
    if (typeof _dawAfterMutate === "function") _dawAfterMutate(); else renderTimeline();
    _p2mShow(`➜ ${events.length} notes`);
    _p2mStatus(`hum→midi: ${events.length} notes on “${tgt.name}” at ${_FMT(cap.anchor)}`);
  } catch (err) {
    _p2mShow("conversion failed");
    _p2mStatus("hum→midi: " + (err && err.message ? err.message : err));
  } finally {
    _P2M.busy = false; _p2mUi();
  }
}

function _FMT(t) {
  if (!(t >= 0)) return "0:00";
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

// No-op: kept so the daw-record.js device-change hook stays safe.
function dawP2MOnStreamChanged() {}

function dawP2MPeek() {
  return { micOn: _P2M.micOn, cap: !!_P2M.cap, busy: _P2M.busy, key: _P2M.key, scale: _P2M.scale };
}

function _p2mUi() {
  const mb = document.getElementById("daw-mic-btn");
  if (mb) {
    mb.textContent = _P2M.micOn ? "🎙 Mic: ON" : "🎙 Mic";
    mb.style.background = _P2M.micOn ? "#2ea043" : "";
    mb.style.color = _P2M.micOn ? "#fff" : "";
  }
  const rb = document.getElementById("daw-hum-rec");
  if (rb) {
    const rec = !!_P2M._rec;
    rb.textContent = rec ? "⬛ Stop Hum" : "🎙 Rec Hum";
    rb.style.background = rec ? "#c0392b" : "";
    rb.style.color = rec ? "#fff" : "";
  }
  const cb = document.getElementById("daw-p2m-toggle");
  if (cb) {
    cb.textContent = _P2M.busy ? "… Converting" : "🎵 Hum→MIDI";
    cb.style.background = _P2M.busy ? "#7c65d9" : "";
    cb.style.color = _P2M.busy ? "#fff" : "";
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const ks = document.getElementById("daw-p2m-key");
    if (ks) {
      ks.innerHTML = "";
      const NN = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      NN.forEach((nm, i) => {
        const o = document.createElement("option"); o.value = String(i); o.textContent = nm;
        if (i === _P2M.key) o.selected = true;
        ks.appendChild(o);
      });
      ks.addEventListener("change", () => {
        _P2M.key = parseInt(ks.value, 10) || 0;
        _p2mStatus(`hum→midi key ${ks.options[ks.selectedIndex].text}`);
      });
    }
    const ss = document.getElementById("daw-p2m-scale");
    if (ss) {
      ss.innerHTML = "";
      for (const [v, l] of _P2M_SCALE_LABELS) {
        const o = document.createElement("option"); o.value = v; o.textContent = l;
        if (v === _P2M.scale) o.selected = true;
        ss.appendChild(o);
      }
      ss.addEventListener("change", () => {
        _P2M.scale = ss.value;
        _p2mStatus(`hum→midi scale ${ss.options[ss.selectedIndex].text}`);
      });
    }
    const mb = document.getElementById("daw-mic-btn");
    if (mb) mb.addEventListener("click", dawP2MToggleMic);
    const rb = document.getElementById("daw-hum-rec");
    if (rb) {
      rb.addEventListener("click", dawP2MRecHum);
      rb.title = "Record the mic into an audio take on a track";
    }
    const cb = document.getElementById("daw-p2m-toggle");
    if (cb) {
      cb.addEventListener("click", dawP2MConvert);
      cb.title = "Convert the recorded hum into MIDI notes (key/scale forced)";
    }
    _p2mUi();
  });
}