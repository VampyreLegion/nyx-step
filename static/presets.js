// ── Preset build / apply ──────────────────────────────────────────────────────
function _buildPreset() {
  syncParamsFromDOM();
  return {
    _version: 1,
    song_name: document.getElementById("song-name").value.trim() || "Untitled",
    tags: document.getElementById("overview-tags").value,
    lyrics: mwState.lyrics,
    genre: mwState.genre,
    bpm: mwState.bpm,
    key: mwState.key,
    scale: mwState.scale,
    mode: mwState.mode,
    time_sig: mwState.time_sig,
    chords: mwState.chords,
    notes: mwState.notes,
    instruments: [...mwState.instruments],
    vocal_tags: [...mwState.vocal_tags],
    steps: mwState.steps,
    cfg_scale: mwState.cfg_scale,
    duration: mwState.duration,
    seed: mwState.seed,
    lock_seed: mwState.lock_seed,
    temperature: mwState.temperature,
    top_p: mwState.top_p,
    top_k: mwState.top_k,
    min_p: mwState.min_p,
  };
}

function _applyPreset(p) {
  const _m = (k, v) => { if (v !== undefined) mwState[k] = v; };
  _m("genre",       p.genre);
  _m("bpm",         p.bpm);
  _m("key",         p.key);
  _m("scale",       p.scale);
  _m("mode",        p.mode);
  _m("time_sig",    p.time_sig);
  _m("chords",      p.chords);
  _m("notes",       p.notes);
  _m("instruments", p.instruments ? [...p.instruments] : undefined);
  _m("vocal_tags",  p.vocal_tags  ? [...p.vocal_tags]  : undefined);
  _m("steps",       p.steps);
  _m("cfg_scale",   p.cfg_scale);
  _m("duration",    p.duration);
  _m("seed",        p.seed);
  _m("lock_seed",   p.lock_seed);
  _m("temperature", p.temperature);
  _m("top_p",       p.top_p);
  _m("top_k",       p.top_k);
  _m("min_p",       p.min_p);
  _m("lyrics",      p.lyrics);

  const _set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
  _set("style-bpm",     mwState.bpm);
  _set("style-key",     mwState.key);
  _set("style-scale",   mwState.scale);
  _set("style-mode",    mwState.mode);
  _set("style-timesig", mwState.time_sig);
  _set("style-chords",  mwState.chords);
  _set("style-notes",   mwState.notes);
  _set("param-steps",    mwState.steps);
  _set("param-cfg",      mwState.cfg_scale);
  _set("param-duration", mwState.duration);
  _set("param-temp",     mwState.temperature);
  _set("param-topp",     mwState.top_p);
  _set("param-topk",     mwState.top_k);
  _set("param-minp",     mwState.min_p);
  _set("param-seed",     mwState.seed);
  const lockEl = document.getElementById("param-lock-seed");
  if (lockEl) lockEl.checked = mwState.lock_seed;
  _set("song-name",       p.song_name);
  _set("overview-tags",   p.tags ?? "");
  _set("overview-lyrics", mwState.lyrics);
  _set("lyrics-editor",   mwState.lyrics);

  _syncInstrumentChips();
  const instrDisplay = document.getElementById("instrument-selected");
  if (instrDisplay) instrDisplay.value = mwState.instruments.join(", ");
  _syncVocalChips();
  const vocalDisplay = document.getElementById("vocal-selected");
  if (vocalDisplay) vocalDisplay.value = mwState.vocal_tags.join(", ");

  updatePayloadPreview();
}

// ── Preset modal ──────────────────────────────────────────────────────────────
function _openPresetModal() {
  const modal = document.getElementById("preset-modal");
  const songName = document.getElementById("song-name").value.trim();
  if (songName) document.getElementById("preset-name-input").value = songName;
  modal.style.display = "flex";
  _refreshPresetList();
}

function _closePresetModal() {
  document.getElementById("preset-modal").style.display = "none";
}

async function _refreshPresetList() {
  const list = document.getElementById("preset-list");
  list.innerHTML = "<div style='color:var(--muted);padding:8px;font-size:12px'>Loading…</div>";
  try {
    const data = await fetch("/presets").then(r => r.json());
    if (!data.presets.length) {
      list.innerHTML = "<div style='color:var(--muted);padding:8px;font-size:12px'>(no saved presets)</div>";
      return;
    }
    list.innerHTML = data.presets.map(name =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border)">
        <span style="cursor:pointer;color:var(--text);font-size:12px;flex:1" data-load="${name}">${name}</span>
        <button class="secondary small" style="font-size:10px;padding:2px 6px" data-delete="${name}">🗑</button>
      </div>`
    ).join("");
    list.querySelectorAll("[data-load]").forEach(el => {
      el.addEventListener("click", async () => {
        const resp = await fetch(`/presets/${encodeURIComponent(el.dataset.load)}`);
        const preset = await resp.json();
        if (preset.error) return;
        _applyPreset(preset);
        _closePresetModal();
        document.getElementById("generate-status").textContent = `Loaded: ${el.dataset.load}`;
        document.getElementById("generate-status").style.color = "var(--accent2)";
      });
    });
    list.querySelectorAll("[data-delete]").forEach(el => {
      el.addEventListener("click", async () => {
        if (!confirm(`Delete "${el.dataset.delete}"?`)) return;
        await fetch(`/presets/${encodeURIComponent(el.dataset.delete)}`, {method: "DELETE"});
        _refreshPresetList();
      });
    });
  } catch {
    list.innerHTML = "<div style='color:var(--error);padding:8px;font-size:12px'>Failed to load presets</div>";
  }
}

document.getElementById("btn-preset-save-named").addEventListener("click", async () => {
  const btn = document.getElementById("btn-preset-save-named");
  const nameInput = document.getElementById("preset-name-input");
  const name = nameInput.value.trim() || document.getElementById("song-name").value.trim() || "preset";
  btn.disabled = true; btn.textContent = "Saving…";
  const preset = _buildPreset();
  preset.song_name = name;
  try {
    const resp = await fetch(`/presets/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(preset),
    });
    const data = await resp.json();
    document.getElementById("preset-modal-status").textContent = `Saved as "${data.saved || name}"`;
    nameInput.value = "";
    _refreshPresetList();
  } finally {
    btn.disabled = false; btn.textContent = "Save";
  }
});

document.getElementById("btn-save-preset").addEventListener("click", _openPresetModal);
document.getElementById("btn-load-preset").addEventListener("click", _openPresetModal);
document.getElementById("btn-preset-modal-close").addEventListener("click", _closePresetModal);
document.getElementById("preset-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) _closePresetModal();
});

// ── Clear buttons ─────────────────────────────────────────────────────────────
document.getElementById("btn-clear-overview").addEventListener("click", () => {
  if (!confirm("Clear all fields and reset state?")) return;
  Object.assign(mwState, {
    genre: "", bpm: 120, key: "C", scale: "Major", mode: "",
    time_sig: "4/4", chords: "", notes: "",
    instruments: [], vocal_tags: [], lyrics: "",
    steps: 8, cfg_scale: 2.0, duration: 30.0, seed: 0, lock_seed: false,
    temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
  });
  document.getElementById("song-name").value = "";
  document.getElementById("overview-tags").value = "";
  document.getElementById("overview-lyrics").value = "";
  document.getElementById("lyrics-editor").value = "";
  [["style-bpm","bpm"],["style-key","key"],["style-scale","scale"],["style-mode","mode"],
   ["style-timesig","time_sig"],["style-chords","chords"],["style-notes","notes"]].forEach(([id, k]) => {
    const el = document.getElementById(id); if (el) el.value = mwState[k] ?? "";
  });
  [["param-steps","steps"],["param-cfg","cfg_scale"],["param-duration","duration"],
   ["param-temp","temperature"],["param-topp","top_p"],["param-topk","top_k"],
   ["param-minp","min_p"],["param-seed","seed"]].forEach(([id, k]) => {
    const el = document.getElementById(id); if (el) el.value = mwState[k] ?? 0;
  });
  document.getElementById("param-lock-seed").checked = false;
  document.getElementById("instrument-selected").value = "";
  document.getElementById("vocal-selected").value = "";
  document.querySelectorAll("#instrument-chips .chip, #vocal-chips .chip").forEach(c => c.classList.remove("active"));
  _activeGenre = null;
  document.querySelectorAll("#genre-grid .chip").forEach(c => c.classList.remove("active"));
  updatePayloadPreview();
});

document.getElementById("btn-clear-jobs").addEventListener("click", () => {
  document.getElementById("jobs-list").innerHTML = "";
});
