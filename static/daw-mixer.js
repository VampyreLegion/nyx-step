// ── DAW mixer panel ───────────────────────────────────────────────────────────
let _dawMixerOpen = false;
let _dawMeterRaf = null;
let _dawMasterMuted = false;

function gainToDb(g) { return g <= 0.0001 ? -Infinity : 20 * Math.log10(g); }
function dbToGain(db) { return db <= -60 ? 0 : Math.pow(10, db / 60 * 3); }   // -60dB→0, 0dB→1, +6dB→~2
function _dbLabel(g) { const d = gainToDb(g); return d === -Infinity ? "-∞" : (d >= 0 ? "+" : "") + d.toFixed(1) + " dB"; }

// Keep both controls (inline slider + panel fader + dB label) in sync without rebuilding.
function dawReflectVolume(trackId, gain) {
  const inline = document.getElementById("daw-inline-vol-" + trackId);
  if (inline && parseFloat(inline.value) !== gain) inline.value = gain;
  const fader = document.getElementById("daw-fader-" + trackId);
  if (fader) { const db = gainToDb(gain); fader.value = db === -Infinity ? -60 : db; }
  const lab = document.getElementById("daw-db-" + trackId);
  if (lab) lab.textContent = _dbLabel(gain);
}

function _dawMeterEl(id) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:10px;height:90px;background:#0b0c10;border:1px solid #2d3041;position:relative;border-radius:2px";
  const bar = document.createElement("div");
  bar.id = id + "-bar";
  bar.style.cssText = "position:absolute;bottom:0;left:0;right:0;height:0;background:#4caf50";
  wrap.appendChild(bar);
  wrap.id = id;
  return wrap;
}

function _dawStrip(track) {
  const strip = document.createElement("div");
  strip.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 4px;border-right:1px solid #2d3041;min-width:64px;border-top:2px solid ${track.color}`;

  const name = document.createElement("div");
  name.textContent = track.name;
  name.style.cssText = "font-size:10px;color:#e2e4ed;max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

  const meterRow = document.createElement("div");
  meterRow.style.cssText = "display:flex;gap:3px;align-items:flex-end";
  meterRow.appendChild(_dawMeterEl("daw-meter-" + track.id));

  const fader = document.createElement("input");
  fader.type = "range"; fader.min = "-60"; fader.max = "6"; fader.step = "0.5";
  const db = gainToDb(track.volume ?? 1);
  fader.value = db === -Infinity ? -60 : db;
  fader.id = "daw-fader-" + track.id;
  fader.style.cssText = "writing-mode:vertical-lr;direction:rtl;width:14px;height:90px";
  fader.addEventListener("input", () => dawSetTrackVolume(track.id, dbToGain(parseFloat(fader.value))));
  meterRow.appendChild(fader);

  const dbLab = document.createElement("div");
  dbLab.id = "daw-db-" + track.id;
  dbLab.textContent = _dbLabel(track.volume ?? 1);
  dbLab.style.cssText = "font-size:9px;color:#8a8f9e;font-family:monospace";

  const pan = document.createElement("input");
  pan.type = "range"; pan.min = "-1"; pan.max = "1"; pan.step = "0.02";
  pan.value = track.pan ?? 0;
  pan.title = "Pan"; pan.style.cssText = "width:54px;height:10px";
  pan.addEventListener("input", () => dawSetTrackPan(track.id, parseFloat(pan.value)));

  const btns = document.createElement("div");
  btns.style.cssText = "display:flex;gap:3px";
  const mk = (label, on, fn) => {
    const b = document.createElement("button");
    b.className = "secondary small"; b.textContent = label;
    b.style.cssText = "font-size:9px;padding:1px 5px;" + (on ? "background:#7c65d9;color:#fff" : "");
    b.addEventListener("click", fn);
    return b;
  };
  btns.appendChild(mk("M", track.mute, () => { dawToggleMute(track.id); dawReschedule(); dawRenderMixer(); }));
  btns.appendChild(mk("S", track.solo, () => { dawToggleSolo(track.id); dawReschedule(); dawRenderMixer(); }));
  const fxOn = !!(track.fx && (track.fx.eq?.on || track.fx.reverb?.on || track.fx.delay?.on));
  const fxBtn = mk("FX", fxOn, () => openFxPanel(track.id, fxBtn));
  btns.appendChild(fxBtn);

  strip.appendChild(name); strip.appendChild(meterRow);
  strip.appendChild(dbLab); strip.appendChild(pan); strip.appendChild(btns);
  return strip;
}

function _dawMasterStrip() {
  const strip = document.createElement("div");
  strip.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 8px;border-left:2px solid #00d4b6;margin-left:6px;min-width:64px";

  const name = document.createElement("div");
  name.textContent = "MASTER";
  name.style.cssText = "font-size:10px;color:#00d4b6;font-weight:bold";

  const meterRow = document.createElement("div");
  meterRow.style.cssText = "display:flex;gap:3px;align-items:flex-end";
  meterRow.appendChild(_dawMeterEl("daw-meter-master"));

  const fader = document.createElement("input");
  fader.type = "range"; fader.min = "-60"; fader.max = "6"; fader.step = "0.5";
  const db = gainToDb(dawState.master_volume ?? 1);
  fader.value = db === -Infinity ? -60 : db;
  fader.id = "daw-fader-master";
  fader.style.cssText = "writing-mode:vertical-lr;direction:rtl;width:14px;height:90px";
  fader.addEventListener("input", () => {
    dawSetMasterVolume(dbToGain(parseFloat(fader.value)));
    document.getElementById("daw-db-master").textContent = _dbLabel(dawState.master_volume);
  });
  meterRow.appendChild(fader);

  const dbLab = document.createElement("div");
  dbLab.id = "daw-db-master";
  dbLab.textContent = _dbLabel(dawState.master_volume ?? 1);
  dbLab.style.cssText = "font-size:9px;color:#8a8f9e;font-family:monospace";

  const mute = document.createElement("button");
  mute.className = "secondary small"; mute.textContent = "M";
  mute.style.cssText = "font-size:9px;padding:1px 5px;" + (_dawMasterMuted ? "background:#7c65d9;color:#fff" : "");
  mute.addEventListener("click", () => {
    _dawMasterMuted = !_dawMasterMuted;
    if (typeof dawEngineSetMasterVolume === "function")
      dawEngineSetMasterVolume(_dawMasterMuted ? 0 : (dawState.master_volume ?? 1));
    dawRenderMixer();
  });

  strip.appendChild(name); strip.appendChild(meterRow); strip.appendChild(dbLab); strip.appendChild(mute);
  return strip;
}

function dawRenderMixer() {
  const host = document.getElementById("daw-mixer-strips");
  if (!host) return;
  host.innerHTML = "";
  host.style.cssText = "display:flex;align-items:flex-start;overflow-x:auto";
  for (const t of dawState.tracks) host.appendChild(_dawStrip(t));
  host.appendChild(_dawMasterStrip());
}

function dawRenderMixerIfOpen() { if (_dawMixerOpen) dawRenderMixer(); }

function _dawDrawMeter(id, peak) {
  const bar = document.getElementById(id + "-bar");
  if (!bar) return;
  const pct = Math.min(100, peak * 100);
  bar.style.height = pct + "%";
  bar.style.background = pct > 90 ? "#e05f5f" : pct > 70 ? "#e0c84f" : "#4caf50";
}

function dawStartMeters() {
  _dawMixerOpen = true;
  if (_dawMeterRaf) return;
  const tick = () => {
    const dawActive = document.getElementById("tab-daw")?.classList.contains("active");
    if (!_dawMixerOpen || !dawActive) { _dawMeterRaf = null; return; }
    for (const t of dawState.tracks) _dawDrawMeter("daw-meter-" + t.id, dawEngineTrackPeak(t.id));
    _dawDrawMeter("daw-meter-master", dawEngineMasterPeak());
    _dawMeterRaf = requestAnimationFrame(tick);
  };
  _dawMeterRaf = requestAnimationFrame(tick);
}

function dawStopMeters() {
  _dawMixerOpen = false;
  if (_dawMeterRaf) { cancelAnimationFrame(_dawMeterRaf); _dawMeterRaf = null; }
}

// Called after a project loads/creates: clear stale master-mute so a new project
// doesn't inherit the previous one's muted master, and re-apply its master volume.
function dawResetMixerForProject() {
  _dawMasterMuted = false;
  if (typeof dawEngineSetMasterVolume === "function") dawEngineSetMasterVolume(dawState.master_volume ?? 1);
}

let _dawFxPanelEl = null;
function _dawCloseFxPanel() {
  if (!_dawFxPanelEl) return;
  _dawFxPanelEl.remove(); _dawFxPanelEl = null;
  document.removeEventListener("mousedown", _dawFxOutside);
  document.removeEventListener("keydown", _dawFxEsc);
}
function _dawFxOutside(e) { if (_dawFxPanelEl && !_dawFxPanelEl.contains(e.target)) _dawCloseFxPanel(); }
function _dawFxEsc(e) { if (e.key === "Escape") _dawCloseFxPanel(); }

function openFxPanel(trackId, anchor) {
  _dawCloseFxPanel();
  const track = dawState.tracks.find(t => t.id === trackId);
  if (!track) return;
  const fx = track.fx || { eq: {}, reverb: {}, delay: {} };
  const m = document.createElement("div");
  _dawFxPanelEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:210px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 230) + "px";
  m.style.top = (r.bottom + 4) + "px";

  const apply = () => dawSetTrackFx(trackId, fx);
  const header = (label, key) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:#00d4b6;font-weight:bold";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!fx[key].on;
    cb.addEventListener("change", () => { fx[key].on = cb.checked; apply(); });
    const sp = document.createElement("span"); sp.textContent = label;
    row.appendChild(cb); row.appendChild(sp);
    return row;
  };
  const slider = (label, key, prop, min, max, step) => {
    const row = document.createElement("label");
    row.style.cssText = "font-size:10px;color:#e2e4ed;display:flex;align-items:center;gap:6px;justify-content:space-between";
    const sp = document.createElement("span"); sp.textContent = label;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = min; inp.max = max; inp.step = step;
    inp.value = fx[key][prop] ?? 0; inp.style.cssText = "width:110px";
    inp.addEventListener("input", () => { fx[key][prop] = parseFloat(inp.value); apply(); });
    row.appendChild(sp); row.appendChild(inp);
    return row;
  };

  m.appendChild(header("EQ", "eq"));
  m.appendChild(slider("Low dB", "eq", "low", -12, 12, 0.5));
  m.appendChild(slider("Mid dB", "eq", "mid", -12, 12, 0.5));
  m.appendChild(slider("High dB", "eq", "high", -12, 12, 0.5));
  m.appendChild(header("Reverb", "reverb"));
  m.appendChild(slider("Wet", "reverb", "wet", 0, 1, 0.01));
  m.appendChild(header("Delay", "delay"));
  m.appendChild(slider("Time s", "delay", "time", 0, 1, 0.01));
  m.appendChild(slider("Feedback", "delay", "feedback", 0, 0.9, 0.01));
  m.appendChild(slider("Wet", "delay", "wet", 0, 1, 0.01));

  document.body.appendChild(m);
  setTimeout(() => {
    document.addEventListener("mousedown", _dawFxOutside);
    document.addEventListener("keydown", _dawFxEsc);
  }, 0);
}
