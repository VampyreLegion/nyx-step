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
    if (!_dawMixerOpen) { _dawMeterRaf = null; return; }
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
