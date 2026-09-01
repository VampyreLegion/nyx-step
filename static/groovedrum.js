// ── GrooveLab 16-Step Drum Synthesizer ───────────────────────────────────────
// In-browser TR-808 / TR-909 style drum machine using Web Audio.
//   • 16-step sequencer grid (per-instrument rows)
//   • Synthesized kick / snare / clap / closed & open hats / toms / crash / ride
//   • Web MIDI pad input (note triggers + live step writing)
//   • Play/stop, BPM, swing
//   • Offline render → "Bounce to DAW" WAV upload to /groovelab/upload

(function () {
  const INSTRUMENTS = [
    { id: "kick",  name: "KICK",   midi: 36 },
    { id: "snare", name: "SNARE",  midi: 38 },
    { id: "clap",  name: "CLAP",   midi: 39 },
    { id: "hhc",   name: "CHAT",   midi: 42 },   // closed hat
    { id: "hho",   name: "OHAT",   midi: 46 },   // open hat
    { id: "tomL",  name: "TOM L",  midi: 50 },
    { id: "tomH",  name: "TOM H",  midi: 48 },
    { id: "crash", name: "CRASH",  midi: 49 },
    { id: "ride",  name: "RIDE",   midi: 51 },
  ];

  let ctx = null;
  let master = null;
  let playing = false;
  let bpm = 120;
  let swing = 0;
  let steps = 16;
  let pattern = {};                 // instrId -> Set(stepIndex)
  const midiNoteToInstr = {};
  INSTRUMENTS.forEach(i => { midiNoteToInstr[i.midi] = i.id; pattern[i.id] = new Set(); });

  const gridEl = document.getElementById("grd-step-grid");
  const playBtn = document.getElementById("grd-play");
  const bpmInput = document.getElementById("grd-bpm");
  const swingInput = document.getElementById("grd-swing");
  const clearBtn = document.getElementById("grd-clear");
  const bounceBtn = document.getElementById("grd-bounce");
  const statusEl = document.getElementById("grd-status");
  const midiStatusEl = document.getElementById("grd-midi-status");

  const TR808 = document.getElementById("grd-808");
  const TR909 = document.getElementById("grd-909");
  let engine = (TR808 && TR909) ? (TR909.checked ? 909 : 808) : 808;
  if (TR808) TR808.addEventListener("change", () => { engine = 808; });
  if (TR909) TR909.addEventListener("change", () => { engine = 909; });

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function makeNoiseBuffer(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  let _noiseBuf = null;
  function noiseBuf() {
    if (!_noiseBuf) _noiseBuf = makeNoiseBuffer(1.0);
    return _noiseBuf;
  }

  const env = (peak, decay, when) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + decay);
    return g;
  };

  // ── Voices ──────────────────────────────────────────────────────────────────
  function voiceKick(when) {
    const o = ctx.createOscillator();
    const g = env(1, 0.4, when);
    o.frequency.setValueAtTime(engine === 909 ? 120 : 150, when);
    o.frequency.exponentialRampToValueAtTime(engine === 909 ? 45 : 40, when + 0.08);
    o.type = engine === 909 ? "sine" : "sine";
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + 0.5);
    if (engine === 808) { // punch via noise tick
      const n = ctx.createBufferSource(); n.buffer = noiseBuf();
      const bp = ctx.createBiquadFilter(); bp.type = "lowpass"; bp.frequency.value = 180;
      const g2 = env(0.6, 0.03, when);
      n.connect(bp); bp.connect(g2); g2.connect(master);
      n.start(when); n.stop(when + 0.05);
    }
  }

  function voiceSnare(when) {
    // body tone + noise burst (909 uses a more tonal snare)
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(engine === 909 ? 220 : 180, when);
    o.type = "triangle";
    const g1 = env(0.6, 0.18, when);
    o.connect(g1); g1.connect(master);
    o.start(when); o.stop(when + 0.25);
    const n = ctx.createBufferSource(); n.buffer = noiseBuf();
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = engine === 909 ? 1800 : 2000; bp.Q.value = 0.8;
    const g2 = env(0.7, 0.16, when);
    n.connect(bp); bp.connect(g2); g2.connect(master);
    n.start(when); n.stop(when + 0.2);
  }

  function voiceClap(when) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf();
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, when);
    // band-passed noise with 3 quick decaying pops
    for (let i = 0; i < 3; i++) {
      const t = when + i * 0.012;
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.6, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    }
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
    n.connect(bp); bp.connect(g); g.connect(master);
    n.start(when); n.stop(when + 0.35);
  }

  function voiceClosedHat(when) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf();
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
    n.connect(hp); hp.connect(g); g.connect(master);
    n.start(when); n.stop(when + 0.06);
  }

  function voiceOpenHat(when) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf();
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.5);
    n.connect(hp); hp.connect(g); g.connect(master);
    n.start(when); n.stop(when + 0.55);
  }

  function voiceTom(when, freq) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq, when);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, when + 0.1);
    o.type = "sine";
    const g = env(0.7, 0.3, when);
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + 0.35);
  }

  function voiceCrash(when) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf();
    const bp = ctx.createBiquadFilter(); bp.type = "highpass"; bp.frequency.value = 4500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 2.0);
    n.connect(bp); bp.connect(g); g.connect(master);
    n.start(when); n.stop(when + 2.1);
  }

  function voiceRide(when) {
    // metallic-ish bell: pair of detuned high sines + lowpassed noise
    [0, 6].forEach(det => {
      const o = ctx.createOscillator();
      o.frequency.value = 2000 + det;
      o.type = "sine";
      const g = env(0.35, 0.9, when);
      o.connect(g); g.connect(master);
      o.start(when); o.stop(when + 1.0);
    });
    const n = ctx.createBufferSource(); n.buffer = noiseBuf();
    const bp = ctx.createBiquadFilter(); bp.type = "lowpass"; bp.frequency.value = 9000;
    const g = env(0.25, 0.6, when);
    n.connect(bp); bp.connect(g); g.connect(master);
    n.start(when); n.stop(when + 0.7);
  }

  const VOICES = {
    kick:  voiceKick,
    snare: voiceSnare,
    clap:  voiceClap,
    hhc:   voiceClosedHat,
    hho:   voiceOpenHat,
    tomL:  (w) => voiceTom(w, 160),
    tomH:  (w) => voiceTom(w, 260),
    crash: voiceCrash,
    ride:  voiceRide,
  };

  // ── UI / Grid ───────────────────────────────────────────────────────────────
  function buildGrid() {
    if (!gridEl) return;
    gridEl.innerHTML = "";
    gridEl.style.display = "grid";
    gridEl.style.gridTemplateColumns = "70px repeat(" + steps + ", 1fr)";
    gridEl.style.gap = "2px";
    gridEl.style.padding = "6px";
    gridEl.style.background = "var(--surface2, #14161f)";
    gridEl.style.border = "1px solid var(--border, #2d3041)";
    gridEl.style.borderRadius = "8px";
    gridEl.style.overflowX = "auto";

    // header row
    const corner = document.createElement("div");
    corner.textContent = "";
    gridEl.appendChild(corner);
    for (let s = 0; s < steps; s++) {
      const c = document.createElement("div");
      c.textContent = (s + 1) % 4 === 0 ? String(s + 1) : "";
      c.style.fontSize = "9px";
      c.style.textAlign = "center";
      c.style.color = (s + 1) % 4 === 0 ? "var(--accent, #7c65d9)" : "var(--muted, #888)";
      c.style.height = "18px";
      gridEl.appendChild(c);
    }

    INSTRUMENTS.forEach(instr => {
      const label = document.createElement("div");
      label.textContent = instr.name;
      label.style.fontSize = "10px";
      label.style.fontWeight = "700";
      label.style.color = "var(--accent2, #00d4b6)";
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.cursor = "pointer";
      label.title = "Click to audition";
      label.style.userSelect = "none";
      label.addEventListener("click", () => {
        ensureCtx();
        triggerInstr(instr.id);
      });
      gridEl.appendChild(label);

      for (let s = 0; s < steps; s++) {
        const cell = document.createElement("button");
        cell.dataset.instr = instr.id;
        cell.dataset.step = s;
        cell.type = "button";
        cell.style.minWidth = "20px";
        cell.style.height = "26px";
        cell.style.border = "1px solid " + (s % 4 === 3 ? "var(--accent, #7c65d9)" : "var(--border, #2d3041)");
        cell.style.borderRadius = "4px";
        cell.style.background = "var(--surface, #0b0c10)";
        cell.style.cursor = "pointer";
        // group-colour by pad group
        const group = { kick: 1, snare: 1, clap: 1, hhc: 2, hho: 2, tomL: 3, tomH: 3, crash: 4, ride: 4 }[instr.id] || 0;
        cell.dataset.group = group;
        cell.addEventListener("click", () => {
          toggleStep(instr.id, s);
        });
        gridEl.appendChild(cell);
      }
    });
  }

  const GROUP_COLORS = { 1: "#e0af68", 2: "#9ece6a", 3: "#7dcfff", 4: "#f7768e" };

  let liveStep = -1;

  function paint() {
    if (!gridEl) return;
    gridEl.querySelectorAll("button[data-step]").forEach(cell => {
      const instr = cell.dataset.instr;
      const s = Number(cell.dataset.step);
      const on = pattern[instr].has(s);
      const group = cell.dataset.group;
      const accent = GROUP_COLORS[group] || "var(--accent2, #00d4b6)";
      cell.style.background = on ? accent : "var(--surface, #0b0c10)";
      const isLive = s === liveStep;
      if (isLive && !on) {
        cell.style.boxShadow = "inset 0 0 0 2px rgba(255,255,255,0.6)";
      } else if (isLive && on) {
        cell.style.boxShadow = "inset 0 0 0 2px #fff";
      } else {
        cell.style.boxShadow = "none";
      }
    });
  }

  function paintPlayhead(s) {
    liveStep = s;
    paint();
  }

  function toggleStep(instr, s) {
    if (pattern[instr].has(s)) pattern[instr].delete(s);
    else pattern[instr].add(s);
    paint();
  }

  function playDrum(id) {
    const v = VOICES[id];
    if (v) { const w = ctx.currentTime; v(w); }
  }

  function triggerInstr(id) {
    playDrum(id);
  }

  // ── Transport (lookahead scheduler) ─────────────────────────────────────────
  function stepDuration() {
    return 60 / bpm / 4; // sixteenth note
  }

  let nextNoteTime = 0;   // absolute ctx time of next step
  let currentStep = 0;
  let schedulerId = null;

  function scheduleStep(stepIdx, when) {
    INSTRUMENTS.forEach(instr => {
      if (pattern[instr.id].has(stepIdx)) VOICES[instr.id](when);
    });
  }

  function scheduler() {
    const dur = stepDuration();
    while (nextNoteTime < ctx.currentTime + 0.1) {
      scheduleStep(currentStep, nextNoteTime + (currentStep % 2 === 1 ? swing * dur : 0));
      paintPlayhead(currentStep);
      nextNoteTime += dur;
      currentStep = (currentStep + 1) % steps;
    }
    schedulerId = window.setTimeout(scheduler, 25);
  }

  function startLoop() {
    ctx = ensureCtx();
    playing = true;
    if (playBtn) playBtn.textContent = "⏸ Stop";
    currentStep = 0;
    nextNoteTime = ctx.currentTime + 0.06;
    scheduler();
  }

  function stopLoop() {
    playing = false;
    if (schedulerId) { clearTimeout(schedulerId); schedulerId = null; }
    if (playBtn) playBtn.textContent = "▶ Play";
    paintPlayhead(-1);
    paint();
  }

  function togglePlay() {
    if (playing) stopLoop();
    else startLoop();
  }

  // ── Bounce to DAW (offline render → WAV → upload) ───────────────────────────
  async function bounceToDaw() {
    ensureCtx();
    if (bounceBtn) { bounceBtn.disabled = true; bounceBtn.textContent = "Rendering…"; }
    if (statusEl) { statusEl.textContent = "Rendering 16-step pattern to WAV…"; statusEl.style.color = "var(--muted)"; }
    try {
      const dur = stepDuration();
      const totalSeconds = Math.max(0.25, 4 * steps * dur); // 4 bars
      const sampleRate = 44100;
      const totalFrames = Math.ceil(totalSeconds * sampleRate);
      const off = new OfflineAudioContext(2, totalFrames, sampleRate);
      const offMaster = off.createGain();
      offMaster.gain.value = 0.8;
      offMaster.connect(off.destination);
      // Rebuild voices against the offline context via a shared scheduler
      const origMain = ctx;
      ctx = off;
      const origMaster = master;
      master = offMaster;
      _noiseBuf = null;
      try {
        // schedule the full 4-bar pattern: steps loop 4 times
        for (let bar = 0; bar < 4; bar++) {
          for (let s = 0; s < steps; s++) {
            const when = (bar * steps + s) * dur;
            INSTRUMENTS.forEach(instr => {
              if (pattern[instr.id].has(s)) VOICES[instr.id](when);
            });
          }
        }
      } finally {
        ctx = origMain;
        master = origMaster;
      }
      const rendered = await off.startRendering();
      const wav = audioBufferToWav(rendered);
      if (statusEl) statusEl.textContent = "Uploading to DAW library…";
      const fd = new FormData();
      fd.append("file", wav, "groove_drums.wav");
      fd.append("name", (document.getElementById("groovelab-name") && document.getElementById("groovelab-name").value.trim()) || "GrooveLab Drums");
      const res = await fetch("/groovelab/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.ok) {
        if (statusEl) {
          statusEl.innerHTML = '✓ <strong>"' + data.name + '"</strong> bounced to DAW Clip Library — <a href="#" id="grd-goto-daw" style="color:var(--accent2,#00d4b6)">switch to DAW tab →</a>';
          statusEl.style.color = "var(--accent2, #00d4b6)";
        }
        const goto = document.getElementById("grd-goto-daw");
        if (goto) goto.addEventListener("click", e => {
          e.preventDefault();
          const b = document.querySelector('.tab-btn[data-tab="daw"]');
          if (b) b.click();
        });
      } else {
        if (statusEl) { statusEl.textContent = "Error: " + (data.error || "upload failed"); statusEl.style.color = "var(--error, #f38ba8)"; }
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = "Bounce failed: " + e.message; statusEl.style.color = "var(--error, #f38ba8)"; }
    } finally {
      if (bounceBtn) { bounceBtn.disabled = false; bounceBtn.textContent = "⇓ Bounce to DAW (WAV)"; }
    }
  }

  // 16-bit PCM WAV encoder from an AudioBuffer (44.1 kHz stereo)
  function audioBufferToWav(buf) {
    const numCh = buf.numberOfChannels, sr = buf.sampleRate;
    const numFrames = buf.length, blockAlign = numCh * 2, dataSize = numFrames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); wstr(8, "WAVE");
    wstr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); wstr(36, "data"); view.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < numFrames; i++) for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(off, s, true); off += 2;
    }
    return new Blob([view], { type: "audio/wav" });
  }

  // ── Web MIDI input ──────────────────────────────────────────────────────────
  function initMidi() {
    if (!navigator.requestMIDIAccess) {
      if (midiStatusEl) midiStatusEl.textContent = "MIDI not supported in this browser.";
      return;
    }
    navigator.requestMIDIAccess().then(access => {
      if (midiStatusEl) {
        const inputs = Array.from(access.inputs.values()).length;
        midiStatusEl.innerHTML = "MIDI ready — " + inputs + " input(s). Map pads using the grid, or hit a MIDI note to trigger the matching drum.";
        midiStatusEl.style.color = "var(--accent2, #00d4b6)";
      }
      access.onstatechange = () => {
        if (midiStatusEl) {
          const inputs = Array.from(access.inputs.values()).length;
          midiStatusEl.textContent = "MIDI ready — " + inputs + " input(s).";
        }
      };
      access.inputs.forEach(input => {
        input.onmidimessage = onMidiMessage;
      });
    }).catch(err => {
      if (midiStatusEl) { midiStatusEl.textContent = "MIDI access denied: " + err.message; midiStatusEl.style.color = "var(--error, #f38ba8)"; }
    });
  }

  function onMidiMessage(e) {
    const [cmd, note, vel] = e.data;
    if ((cmd & 0xf0) !== 0x90 || vel === 0) return; // only note-on with velocity
    const instrId = midiNoteToInstr[note];
    if (!instrId) return;
    ensureCtx();
    triggerInstr(instrId);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  function init() {
    if (!document.getElementById("tab-groovelab")) return;
    buildGrid();
    paint();
    if (playBtn) playBtn.addEventListener("click", togglePlay);
    if (clearBtn) clearBtn.addEventListener("click", () => {
      INSTRUMENTS.forEach(i => pattern[i.id].clear());
      paint();
    });
    if (bpmInput) bpmInput.addEventListener("input", () => {
      bpm = Math.max(40, Math.min(300, Number(bpmInput.value) || 120));
    });
    if (swingInput) swingInput.addEventListener("input", () => {
      swing = Math.max(0, Math.min(0.5, Number(swingInput.value) || 0));
    });
    if (bounceBtn) bounceBtn.addEventListener("click", () => {
      ensureCtx();
      bounceToDaw();
    });
    initMidi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // expose for debugging
  window.GrooveDrum = {
    resetPattern: () => { INSTRUMENTS.forEach(i => pattern[i.id].clear()); paint(); },
    setStep: (instr, s, on) => { if (pattern[instr]) { on ? pattern[instr].add(s) : pattern[instr].delete(s); paint(); } },
  };
})();
