// ── DAW Hum→MIDI: mic on/off + live pitch detection → scale/key-forced MIDI ────
// Notes produced here flow through the shared _dawMidiDispatch fan-out, so an
// armed MIDI track records them while ● REC is active (exactly like USB MIDI),
// and the 📊 Monitor lights up as you hum. Toggle Hum→MIDI off to record plain
// MIDI/USB instead — the mic stays where you left it.
let _P2M = {
  micOn: false,          // WE hold a mic reference (button state)
  on: false,             // Hum→MIDI detection enabled
  key: 9,                // tonic pitch class (9 = A)
  scale: "major",
  ctx: null, node: null, src: null,
  active: null, thr: null, hits: 0, tailT: 0,
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
  return Math.max(0, Math.min(127, Math.round(midi) + delta));
}

function _p2mNoteName(p) {
  const N = (typeof _DAW_MON_NOTES !== "undefined") ? _DAW_MON_NOTES :
    ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return N[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
}
function _p2mShow(note, f) {
  const el = document.getElementById("daw-p2m-stat");
  if (el) el.textContent = note === null ? "—" : `🎵 ${_p2mNoteName(note)} · ${note} · ${f.toFixed(0)} Hz`;
}
function _p2mStatus(msg) { if (typeof dawRecStatus === "function") dawRecStatus(msg); }

function _p2mSend(note, vel) {
  if (typeof _dawMidiDispatch !== "function") return;
  try {
    _dawMidiDispatch({ data: new Uint8Array([0x90, note & 127, vel & 127]) });
  } catch (_) {}
}
function _p2mSendOff(note) {
  if (typeof _dawMidiDispatch !== "function") return;
  try {
    _dawMidiDispatch({ data: new Uint8Array([0x80, note & 127, 0]) });
  } catch (_) {}
}
function _p2mCloseActive() {
  if (_P2M.active !== null) _p2mSendOff(_P2M.active);
  _P2M.active = null; _P2M.thr = null; _P2M.hits = 0;
}

function _p2mOnMsg(e) {
  if (!_P2M.on) return;
  const t = e.data;
  if (!t) return;
  if (t.type === "silence") {
    if (_P2M.active !== null && performance.now() - _P2M.tailT > 90) _p2mCloseActive();
    if (!_P2M.active) _p2mShow(null);
    return;
  }
  if (t.type !== "pitch" || t.conf < 0.82) return;
  const f = t.f;
  if (f <= 0) return;
  const midiF = 69 + 12 * Math.log2(f / 440);
  const note = dawP2MMapNote(midiF, _P2M.key, _P2M.scale);
  _p2mShow(note, f);
  if (note === _P2M.thr) _P2M.hits++;
  else { _P2M.thr = note; _P2M.hits = 1; }
  if (_P2M.hits >= 2 && note !== _P2M.active) {   // settled on a note → open it
    if (_P2M.active !== null) _p2mSendOff(_P2M.active);
    const vel = Math.max(40, Math.min(120, Math.round(40 + t.rms * 170)));
    _p2mSend(note, vel);
    _P2M.active = note;
  }
  _P2M.tailT = performance.now();
}

async function _p2mBuild() {
  try {
    if (_P2M.node) { try { _P2M.node.port.onmessage = null; _P2M.node.disconnect(); } catch (_) {} _P2M.node = null; }
    const ctx = (typeof _dawEnsureCtx === "function") ? _dawEnsureCtx() : null;
    if (!ctx || typeof _dawMicStream === "undefined" || !_dawMicStream || !_dawMicStream.active) return false;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
    let wk = null;
    try { wk = await ctx.audioWorklet.addModule("/static/daw-p2m-worklet.js?v=1"); } catch (_) {}
    if (!wk) return false;
    const src = ctx.createMediaStreamSource(_dawMicStream);
    const node = new AudioWorkletNode(ctx, "daw-p2m-processor");
    node.port.onmessage = _p2mOnMsg;
    src.connect(node);
    _P2M.ctx = ctx; _P2M.src = src; _P2M.node = node;
    _P2M.active = null; _P2M.thr = null; _P2M.hits = 0; _P2M.tailT = 0;
    return true;
  } catch (err) {
    _P2M.node = null; _P2M.src = null;
    return false;
  }
}
function _p2mTeardown() {
  if (_P2M.node) { try { _P2M.node.port.onmessage = null; _P2M.node.disconnect(); } catch (_) {} }
  if (_P2M.src) { try { _P2M.src.disconnect(); } catch (_) {} }
  _P2M.node = null; _P2M.src = null; _P2M.ctx = null;
  _p2mCloseActive();
  _p2mShow(null);
}

// ── Public API ─────────────────────────────────────────────────────────────────
async function dawP2MToggleMic() {
  if (_P2M.micOn) {
    if (_P2M.on) dawP2MToggle();                              // mic off also stops Hum→MIDI
    _dawMicRelease();
    _P2M.micOn = false;
    _p2mTeardown();
    _p2mStatus("mic off");
  } else {
    try {
      await _dawMicAcquire();
      _P2M.micOn = true;
      _p2mStatus("mic on — hum with 🎵 Hum→MIDI to make notes");
    } catch (_) {
      _p2mStatus("mic unavailable (permission denied?)");
    }
  }
  _p2mUi();
}

async function dawP2MToggle() {
  if (_P2M.on) {
    _P2M.on = false;
    _p2mTeardown();
    _p2mStatus("hum→midi off");
  } else {
    if (!_P2M.micOn) {
      try { await _dawMicAcquire(); _P2M.micOn = true; }
      catch (_) { _p2mStatus("Hum→MIDI needs the mic — allow access, retry"); _p2mUi(); return; }
    }
    if (await _p2mBuild()) {
      _P2M.on = true;
      _p2mStatus("hum→midi on — sing into the mic (records to armed MIDI tracks)");
    } else {
      _p2mStatus("hum→midi failed to start");
    }
  }
  _p2mUi();
}

// Called when the mic device select changes (daw-record.js).
async function dawP2MOnStreamChanged() {
  if (!_P2M.micOn) return;
  try {
    await _dawMicAcquire();
    if (_P2M.on) await _p2mBuild();
  } catch (_) {}
}

function dawP2MPeek() {
  return { micOn: _P2M.micOn, on: _P2M.on, key: _P2M.key, scale: _P2M.scale, active: _P2M.active };
}

function _p2mUi() {
  const mb = document.getElementById("daw-mic-btn");
  if (mb) {
    mb.textContent = _P2M.micOn ? "🎙 Mic: ON" : "🎙 Mic";
    mb.style.background = _P2M.micOn ? "#2ea043" : "";
    mb.style.color = _P2M.micOn ? "#fff" : "";
  }
  const hb = document.getElementById("daw-p2m-toggle");
  if (hb) {
    hb.textContent = _P2M.on ? "🎵 Hum→MIDI: ON" : "🎵 Hum→MIDI";
    hb.style.background = _P2M.on ? "#7c65d9" : "";
    hb.style.color = _P2M.on ? "#fff" : "";
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
      ks.addEventListener("change", () => { _P2M.key = parseInt(ks.value, 10) || 0; _p2mStatus(`hum→midi key ${ks.options[ks.selectedIndex].text}`); });
    }
    const ss = document.getElementById("daw-p2m-scale");
    if (ss) {
      ss.innerHTML = "";
      for (const [v, l] of _P2M_SCALE_LABELS) {
        const o = document.createElement("option"); o.value = v; o.textContent = l;
        if (v === _P2M.scale) o.selected = true;
        ss.appendChild(o);
      }
      ss.addEventListener("change", () => { _P2M.scale = ss.value; _p2mStatus(`hum→midi scale ${ss.options[ss.selectedIndex].text}`); });
    }
    const mb = document.getElementById("daw-mic-btn");
    if (mb) mb.addEventListener("click", dawP2MToggleMic);
    const hb = document.getElementById("daw-p2m-toggle");
    if (hb) hb.addEventListener("click", dawP2MToggle);
    if (mb) mb.title = "Turn the microphone on/off (recording + Hum→MIDI)";
    _p2mUi();
  });
}