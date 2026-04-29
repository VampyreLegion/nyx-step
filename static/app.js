// ── State ─────────────────────────────────────────────────────────────────────
const mwState = {
  genre: "", bpm: 120, key: "C", scale: "Major", mode: "",
  time_sig: "4/4", chords: "", notes: "",
  instruments: [], vocal_tags: [], lyrics: "",
  steps: 8, cfg_scale: 2.0, duration: 30.0, seed: 0, lock_seed: false,
  temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
};

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "overview") syncOverviewFromState();
    if (btn.dataset.tab === "lyrics") document.getElementById("lyrics-editor").value = mwState.lyrics;
    if (btn.dataset.tab === "lint") updateLintStatePreview();
  });
});

document.querySelectorAll(".inner-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const parent = btn.closest(".tab-panel") || btn.parentElement.parentElement;
    parent.querySelectorAll(".inner-tab-btn").forEach(b => b.classList.remove("active"));
    const targetId = btn.dataset.inner || btn.dataset.guide;
    parent.querySelectorAll(".inner-panel").forEach(p => p.classList.remove("active"));
    if (btn.dataset.inner) {
      const panel = document.getElementById(btn.dataset.inner);
      if (panel) panel.classList.add("active");
    }
    if (btn.dataset.guide) loadGuideSection(btn.dataset.guide, btn);
    btn.classList.add("active");
  });
});

// ── Style tab ─────────────────────────────────────────────────────────────────
const _debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const bind = (id, key, transform) => {
  const el = document.getElementById(id);
  if (!el) return;
  const handler = () => {
    mwState[key] = transform ? transform(el.value) : el.value;
    document.getElementById("overview-tags").value = buildCaption();
    updatePayloadPreview();
  };
  const debounced = _debounce(handler, 150);
  el.addEventListener("input", debounced);
  el.addEventListener("change", handler);
};

bind("style-bpm", "bpm", v => parseInt(v) || 120);
bind("style-key", "key");
bind("style-scale", "scale");
bind("style-mode", "mode");
bind("style-timesig", "time_sig");
bind("style-chords", "chords");
document.getElementById("style-chords-preset").addEventListener("change", e => {
  if (!e.target.value) return;
  document.getElementById("style-chords").value = e.target.value;
  mwState.chords = e.target.value;
  e.target.value = "";
  updatePayloadPreview();
});
bind("style-notes", "notes");
bind("param-steps", "steps", v => parseInt(v) || 8);
bind("param-cfg", "cfg_scale", v => parseFloat(v) || 2.0);
bind("param-duration", "duration", v => parseFloat(v) || 30);
bind("param-temp", "temperature", v => parseFloat(v) || 0.85);
bind("param-topp", "top_p", v => parseFloat(v) || 0.9);
bind("param-topk", "top_k", v => parseInt(v) || 0);
bind("param-minp", "min_p", v => parseFloat(v) || 0.0);
bind("param-seed", "seed", v => parseInt(v) || 0);
document.getElementById("param-lock-seed").addEventListener("change", e => {
  mwState.lock_seed = e.target.checked;
});
document.getElementById("btn-random-seed").addEventListener("click", () => {
  const seed = Math.floor(Math.random() * (2 ** 32 - 1)) + 1;
  document.getElementById("param-seed").value = seed;
  document.getElementById("param-lock-seed").checked = true;
  mwState.seed = seed;
  mwState.lock_seed = true;
  updatePayloadPreview();
});

// ── Lyrics tab ────────────────────────────────────────────────────────────────
document.getElementById("lyrics-editor").addEventListener("input", e => {
  mwState.lyrics = e.target.value;
  updatePayloadPreview();
});

// Keep overview-lyrics in sync with mwState so tab switches don't lose edits
document.getElementById("overview-lyrics").addEventListener("input", e => {
  mwState.lyrics = e.target.value;
});

// ── Tagging tab — staging buffer ─────────────────────────────────────────────
let _tagBuffer = [];

function _insertAtCursor(text) {
  const editor = document.getElementById("lyrics-editor");
  const pos = editor.selectionStart;
  const before = editor.value.substring(0, pos);
  const after = editor.value.substring(pos);
  editor.value = before + text + after;
  editor.selectionStart = editor.selectionEnd = pos + text.length;
  editor.focus();
  mwState.lyrics = editor.value;
  updatePayloadPreview();
}

function _updateStagingBar() {
  const list = document.getElementById("tag-staging-list");
  const btn = document.getElementById("btn-insert-parens");
  if (_tagBuffer.length === 0) {
    list.innerHTML = "<span style='color:var(--muted)'>(click plain-text tags to stage, then insert as a group)</span>";
    btn.disabled = true;
  } else {
    list.innerHTML = _tagBuffer
      .map(t => `<span style="background:var(--surface2);border:1px solid var(--accent);border-radius:10px;padding:1px 8px;margin:2px;display:inline-block;font-size:11px;color:var(--accent)">${t}</span>`)
      .join("");
    btn.disabled = false;
  }
}

document.querySelectorAll(".tag-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tag = btn.dataset.tag;
    // Tags already wrapped in [ ] or ( ) → insert directly
    if (tag.startsWith("[") || tag.startsWith("(")) {
      const isSectionTag = tag.startsWith("[") &&
        !tag.startsWith("[Vocal:") &&
        !tag.match(/^\[[a-z]{2}\]$/);
      _insertAtCursor(isSectionTag ? "\n" + tag + "\n" : tag);
      return;
    }
    // Plain text → toggle in staging buffer
    const idx = _tagBuffer.indexOf(tag);
    if (idx === -1) {
      _tagBuffer.push(tag);
      btn.style.borderColor = "var(--accent)";
      btn.style.color = "var(--accent)";
    } else {
      _tagBuffer.splice(idx, 1);
      btn.style.borderColor = "";
      btn.style.color = "";
    }
    _updateStagingBar();
  });
});

document.getElementById("btn-insert-parens").addEventListener("click", () => {
  if (!_tagBuffer.length) return;
  _insertAtCursor(`(${_tagBuffer.join(", ")})`);
  _tagBuffer = [];
  document.querySelectorAll(".tag-btn").forEach(b => { b.style.borderColor = ""; b.style.color = ""; });
  _updateStagingBar();
});

document.getElementById("btn-clear-staging").addEventListener("click", () => {
  _tagBuffer = [];
  document.querySelectorAll(".tag-btn").forEach(b => { b.style.borderColor = ""; b.style.color = ""; });
  _updateStagingBar();
});

// Templates
const TEMPLATES = {
  "Verse-Chorus": "[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n",
  "Verse-Chorus-Bridge": "[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n",
  "Intro-Verse-Chorus-Outro": "[Intro: Atmospheric]\n\n[Verse]\n\n[Chorus: Anthemic]\n\n[Verse]\n\n[Chorus: Anthemic]\n\n[Outro]\n",
  "EDM Structure": "[Intro: Atmospheric]\n\n[Build]\n\n[Drop]\n\n[Breakdown]\n\n[Build]\n\n[Drop]\n\n[Outro]\n",
  "Minimal": "[Verse]\n\n[Chorus]\n",
};
const tplSel = document.getElementById("lyrics-template");
Object.keys(TEMPLATES).forEach(k => {
  const opt = document.createElement("option");
  opt.value = k; opt.textContent = k;
  tplSel.appendChild(opt);
});
tplSel.addEventListener("change", () => {
  if (!tplSel.value) return;
  const editor = document.getElementById("lyrics-editor");
  editor.value = TEMPLATES[tplSel.value] || "";
  mwState.lyrics = editor.value;
  updatePayloadPreview();
});

// ── Style tab — Genre browser ─────────────────────────────────────────────────
let _genres = [];
let _activeCategory = null;
let _activeGenre = null;

fetch("/api/genres").then(r => r.json()).then(data => {
  _genres = data.genres || [];
  const categories = [...new Set(_genres.map(g => g.parent))].sort();
  const catEl = document.getElementById("genre-categories");
  categories.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.dataset.cat = cat;
    btn.style.cssText = "width:100%;text-align:left;padding:7px 10px;border-radius:0;border:none;border-bottom:1px solid var(--border);font-size:12px;";
    btn.textContent = cat;
    btn.addEventListener("click", () => _selectCategory(cat));
    catEl.appendChild(btn);
  });
  if (categories.length) _selectCategory(categories[0]);
});

function _selectCategory(cat) {
  _activeCategory = cat;
  document.querySelectorAll("#genre-categories button").forEach(b => {
    const active = b.dataset.cat === cat;
    b.style.color = active ? "var(--accent)" : "";
    b.style.background = active ? "var(--surface2)" : "";
    b.style.fontWeight = active ? "600" : "";
  });
  _renderGenreGrid(_genres.filter(g => g.parent === cat));
}

function _renderGenreGrid(genres) {
  const grid = document.getElementById("genre-grid");
  grid.innerHTML = "";
  genres.forEach(genre => {
    const chip = document.createElement("span");
    chip.className = "chip" + (genre.name === _activeGenre ? " active" : "");
    chip.textContent = genre.name;
    chip.addEventListener("click", () => _selectGenre(genre));
    grid.appendChild(chip);
  });
}

function _selectGenre(genre) {
  _activeGenre = genre.name;
  mwState.genre = genre.name;
  mwState.bpm = Math.round((genre.bpm_min + genre.bpm_max) / 2);
  mwState.key = genre.default_key || "C";
  mwState.scale = genre.default_scale || "Major";
  mwState.mode = genre.default_mode || "";
  mwState.time_sig = genre.default_time_sig || "4/4";

  document.getElementById("style-bpm").value = mwState.bpm;
  document.getElementById("style-key").value = mwState.key;
  document.getElementById("style-scale").value = mwState.scale;
  document.getElementById("style-mode").value = mwState.mode;
  document.getElementById("style-timesig").value = mwState.time_sig;

  document.querySelectorAll("#genre-grid .chip").forEach(c => {
    c.classList.toggle("active", c.textContent === genre.name);
  });

  let info = `<strong style="color:var(--accent)">${genre.name}</strong>`;
  if (genre.description) info += ` — ${genre.description}`;
  if (genre.typical_instruments?.length)
    info += `<br><span style="color:var(--accent2)">Typical: ${genre.typical_instruments.join(", ")}</span>`;
  document.getElementById("genre-info").innerHTML = info;

  // Immediately reflect genre change in Overview tags
  document.getElementById("overview-tags").value = buildCaption();
  updatePayloadPreview();
}

document.getElementById("genre-search").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    if (_activeCategory) _selectCategory(_activeCategory);
    return;
  }
  const matches = _genres.filter(g =>
    g.name.toLowerCase().includes(q) ||
    g.parent.toLowerCase().includes(q) ||
    (g.tags || []).some(t => t.toLowerCase().includes(q))
  );
  _renderGenreGrid(matches);
});

// ── Instruments tab ───────────────────────────────────────────────────────────
fetch("/api/instruments").then(r => r.json()).then(data => {
  const container = document.getElementById("instrument-chips");
  data.categories.forEach(cat => {
    const title = document.createElement("div");
    title.className = "section-title";
    title.style.marginTop = "10px";
    title.textContent = cat.name;
    container.appendChild(title);
    const row = document.createElement("div");
    cat.subcategories.forEach(sub => {
      sub.items.forEach(item => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = item;
        chip.addEventListener("click", () => {
          chip.classList.toggle("active");
          if (chip.classList.contains("active")) {
            mwState.instruments.push(item);
          } else {
            mwState.instruments = mwState.instruments.filter(i => i !== item);
          }
          document.getElementById("instrument-selected").value =
            mwState.instruments.join(", ");
          updatePayloadPreview();
        });
        row.appendChild(chip);
      });
    });
    container.appendChild(row);
  });
}).catch(() => {
  document.getElementById("instrument-chips").textContent = "Failed to load instruments";
});

// ── Vocals tab ────────────────────────────────────────────────────────────────
fetch("/api/vocals").then(r => r.json()).then(data => {
  const container = document.getElementById("vocal-chips");
  Object.entries(data).forEach(([group, keywords]) => {
    const title = document.createElement("div");
    title.className = "section-title";
    title.style.marginTop = "10px";
    title.textContent = group;
    container.appendChild(title);
    const row = document.createElement("div");
    keywords.forEach(kw => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = kw;
      chip.addEventListener("click", () => {
        chip.classList.toggle("active");
        if (chip.classList.contains("active")) {
          mwState.vocal_tags.push(kw);
        } else {
          mwState.vocal_tags = mwState.vocal_tags.filter(v => v !== kw);
        }
        document.getElementById("vocal-selected").value =
          mwState.vocal_tags.join(", ");
        updatePayloadPreview();
      });
      row.appendChild(chip);
    });
    container.appendChild(row);
  });
}).catch(() => {
  document.getElementById("vocal-chips").textContent = "Failed to load vocals";
});

// ── Preview update ────────────────────────────────────────────────────────────
function buildCaption() {
  const parts = [];
  const s = mwState;
  if (s.genre) parts.push(s.genre.toLowerCase());
  if (s.bpm && (s.genre || s.bpm !== 120)) parts.push(s.bpm + " BPM");
  if (s.key && (s.genre || s.key !== "C" || s.scale !== "Major"))
    parts.push(s.scale ? s.key + " " + s.scale : s.key);
  if (s.mode) parts.push(s.mode + " mode");
  if (s.time_sig && (s.genre || s.time_sig !== "4/4")) parts.push(s.time_sig + " time");
  if (s.chords) parts.push(s.chords);
  if (s.notes) parts.push(s.notes);
  parts.push(...s.instruments);
  parts.push(...s.vocal_tags);
  return parts.join(", ");
}

function syncParamsFromDOM() {
  const fields = [
    ["style-bpm",      "bpm",         v => parseInt(v)   || 120],
    ["style-key",      "key",         v => v || "C"],
    ["style-scale",    "scale",       v => v || "Major"],
    ["style-mode",     "mode",        v => v],
    ["style-timesig",  "time_sig",    v => v || "4/4"],
    ["style-chords",   "chords",      v => v],
    ["style-notes",    "notes",       v => v],
    ["param-steps",    "steps",       v => parseInt(v)   || 8],
    ["param-cfg",      "cfg_scale",   v => parseFloat(v) || 2.0],
    ["param-duration", "duration",    v => parseFloat(v) || 30],
    ["param-temp",     "temperature", v => parseFloat(v) || 0.85],
    ["param-topp",     "top_p",       v => parseFloat(v) || 0.9],
    ["param-topk",     "top_k",       v => parseInt(v)   || 0],
    ["param-minp",     "min_p",       v => parseFloat(v) || 0.0],
    ["param-seed",     "seed",        v => parseInt(v)   || 0],
  ];
  fields.forEach(([id, key, fn]) => {
    const el = document.getElementById(id);
    if (el) mwState[key] = fn(el.value);
  });
  const lock = document.getElementById("param-lock-seed");
  if (lock) mwState.lock_seed = lock.checked;
}

function syncOverviewFromState() {
  syncParamsFromDOM();
  document.getElementById("overview-tags").value = buildCaption();
  document.getElementById("overview-lyrics").value = mwState.lyrics || "";
  updatePayloadPreview();
}

function updatePayloadPreview() {
  const el = document.getElementById("payload-preview");
  if (!el) return;
  const tags = document.getElementById("overview-tags").value;
  const lyrics = document.getElementById("overview-lyrics").value;
  const s = mwState;
  const seedLabel = (s.lock_seed && s.seed !== 0) ? `${s.seed} (locked)` : "(random each run)";
  const lyricsLines = lyrics ? lyrics.split("\n").filter(l => l.trim()) : [];
  const lyricsSnippet = lyricsLines.length
    ? lyricsLines.slice(0, 3).join(" / ") + (lyricsLines.length > 3 ? " …" : "")
    : "(empty)";
  el.textContent = [
    `Tags:     ${tags || "(empty)"}`,
    `Lyrics:   ${lyricsSnippet}`,
    `BPM: ${s.bpm}   Key: ${s.key} ${s.scale}   Time: ${s.time_sig}`,
    `Steps: ${s.steps}   CFG: ${s.cfg_scale}   Duration: ${s.duration}s   Seed: ${seedLabel}`,
    `Temp: ${s.temperature}   Top-P: ${s.top_p}   Top-K: ${s.top_k}   Min-P: ${s.min_p}`,
  ].join("\n");
}

function updateLintStatePreview() {
  const cap = buildCaption();
  document.getElementById("lint-state-preview").textContent =
    `[Tags]\n${cap}\n\n[Lyrics]\n${mwState.lyrics || "(empty)"}`;
}

// ── Overview editable fields ──────────────────────────────────────────────────
document.getElementById("overview-tags").addEventListener("input", () => { updateTagTokenCount(); updatePayloadPreview(); });
document.getElementById("overview-lyrics").addEventListener("input", updatePayloadPreview);
document.getElementById("btn-sync-overview").addEventListener("click", syncOverviewFromState);

// ── Save / Load preset ────────────────────────────────────────────────────────
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
  // mwState
  if (p.genre     !== undefined) mwState.genre       = p.genre;
  if (p.bpm       !== undefined) mwState.bpm         = p.bpm;
  if (p.key       !== undefined) mwState.key         = p.key;
  if (p.scale     !== undefined) mwState.scale       = p.scale;
  if (p.mode      !== undefined) mwState.mode        = p.mode;
  if (p.time_sig  !== undefined) mwState.time_sig    = p.time_sig;
  if (p.chords    !== undefined) mwState.chords      = p.chords;
  if (p.notes     !== undefined) mwState.notes       = p.notes;
  if (p.instruments !== undefined) mwState.instruments  = [...p.instruments];
  if (p.vocal_tags  !== undefined) mwState.vocal_tags   = [...p.vocal_tags];
  if (p.steps       !== undefined) mwState.steps        = p.steps;
  if (p.cfg_scale   !== undefined) mwState.cfg_scale    = p.cfg_scale;
  if (p.duration    !== undefined) mwState.duration     = p.duration;
  if (p.seed        !== undefined) mwState.seed         = p.seed;
  if (p.lock_seed   !== undefined) mwState.lock_seed    = p.lock_seed;
  if (p.temperature !== undefined) mwState.temperature  = p.temperature;
  if (p.top_p       !== undefined) mwState.top_p        = p.top_p;
  if (p.top_k       !== undefined) mwState.top_k        = p.top_k;
  if (p.min_p       !== undefined) mwState.min_p        = p.min_p;
  if (p.lyrics      !== undefined) mwState.lyrics       = p.lyrics;

  // Style tab DOM
  const _set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
  _set("style-bpm",     mwState.bpm);
  _set("style-key",     mwState.key);
  _set("style-scale",   mwState.scale);
  _set("style-mode",    mwState.mode);
  _set("style-timesig", mwState.time_sig);
  _set("style-chords",  mwState.chords);
  _set("style-notes",   mwState.notes);

  // Parameters tab DOM
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

  // Overview DOM
  _set("song-name",       p.song_name);
  _set("overview-tags",   p.tags ?? "");
  _set("overview-lyrics", mwState.lyrics);
  _set("lyrics-editor",   mwState.lyrics);

  // Re-sync instrument chip active states
  _syncInstrumentChips();
  const instrDisplay = document.getElementById("instrument-selected");
  if (instrDisplay) instrDisplay.value = mwState.instruments.join(", ");

  // Re-sync vocal chip active states
  _syncVocalChips();
  const vocalDisplay = document.getElementById("vocal-selected");
  if (vocalDisplay) vocalDisplay.value = mwState.vocal_tags.join(", ");

  updatePayloadPreview();
}

// ── Chip sync helpers ─────────────────────────────────────────────────────────
function _syncInstrumentChips() {
  document.querySelectorAll("#instrument-chips .chip").forEach(chip => {
    chip.classList.toggle("active", mwState.instruments.includes(chip.textContent.trim()));
  });
}
function _syncVocalChips() {
  document.querySelectorAll("#vocal-chips .chip").forEach(chip => {
    chip.classList.toggle("active", mwState.vocal_tags.includes(chip.textContent.trim()));
  });
}

// Editable selected textareas
document.getElementById("instrument-selected").addEventListener("input", e => {
  mwState.instruments = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
  _syncInstrumentChips();
  updatePayloadPreview();
});
document.getElementById("vocal-selected").addEventListener("input", e => {
  mwState.vocal_tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
  _syncVocalChips();
  updatePayloadPreview();
});

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
  const nameInput = document.getElementById("preset-name-input");
  const name = nameInput.value.trim() || document.getElementById("song-name").value.trim() || "preset";
  const preset = _buildPreset();
  preset.song_name = name;
  const resp = await fetch(`/presets/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(preset),
  });
  const data = await resp.json();
  document.getElementById("preset-modal-status").textContent = `Saved as "${data.saved || name}"`;
  nameInput.value = "";
  _refreshPresetList();
});
document.getElementById("btn-save-preset").addEventListener("click", _openPresetModal);
document.getElementById("btn-load-preset").addEventListener("click", _openPresetModal);
document.getElementById("btn-preset-modal-close").addEventListener("click", _closePresetModal);
document.getElementById("preset-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) _closePresetModal();
});

// ── Clear button ──────────────────────────────────────────────────────────────
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
  ["style-bpm","style-key","style-scale","style-mode","style-timesig","style-chords","style-notes"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = mwState[{
      "style-bpm":"bpm","style-key":"key","style-scale":"scale","style-mode":"mode",
      "style-timesig":"time_sig","style-chords":"chords","style-notes":"notes"
    }[id]] ?? "";
  });
  ["param-steps","param-cfg","param-duration","param-temp","param-topp","param-topk","param-minp","param-seed"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = mwState[{
      "param-steps":"steps","param-cfg":"cfg_scale","param-duration":"duration",
      "param-temp":"temperature","param-topp":"top_p","param-topk":"top_k",
      "param-minp":"min_p","param-seed":"seed"
    }[id]] ?? 0;
  });
  document.getElementById("param-lock-seed").checked = false;
  document.getElementById("instrument-selected").value = "";
  document.getElementById("vocal-selected").value = "";
  document.querySelectorAll("#instrument-chips .chip, #vocal-chips .chip").forEach(c => c.classList.remove("active"));
  _activeGenre = null;
  document.querySelectorAll("#genre-grid .chip").forEach(c => c.classList.remove("active"));
  updatePayloadPreview();
});

document.getElementById("btn-clear-jobs").addEventListener("click", clearJobList);

// ── Generate ──────────────────────────────────────────────────────────────────
let _activeGenPromptId = null;
let _genProgressTimer = null;

function setGenProgress(state, label) {
  const wrap = document.getElementById("gen-progress-wrap");
  const bar = document.getElementById("gen-progress-bar");
  const lbl = document.getElementById("gen-progress-label");
  clearTimeout(_genProgressTimer);
  wrap.style.display = "block";
  bar.className = "job-progress-bar " + state;
  lbl.textContent = label;
  if (state === "done" || state === "error") {
    _genProgressTimer = setTimeout(() => { wrap.style.display = "none"; }, 5000);
  }
}

document.getElementById("btn-generate").addEventListener("click", async () => {
  const btn = document.getElementById("btn-generate");
  const songName = document.getElementById("song-name").value.trim() || "Untitled";
  const status = document.getElementById("generate-status");

  btn.disabled = true;
  btn.textContent = "🎵 Submitting…";
  setGenProgress("queued", "Submitting to ComfyUI…");
  status.textContent = "";

  const payload = {
    ...mwState,
    tags: document.getElementById("overview-tags").value.trim(),
    lyrics: document.getElementById("overview-lyrics").value,
    song_name: songName,
  };

  try {
    const resp = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {
      const text = await resp.text().catch(() => resp.statusText);
      const msg = resp.status === 502 ? "ComfyUI is offline or unreachable" : (text.slice(0, 120) || resp.statusText);
      status.textContent = "Error: " + msg;
      status.style.color = "var(--error)";
      setGenProgress("error", "Error: " + msg);
      btn.disabled = false;
      btn.textContent = "🎵 Generate Music Idea";
      return;
    }
    if (!resp.ok) {
      const msg = data.error || resp.statusText;
      status.textContent = "Error: " + msg;
      status.style.color = "var(--error)";
      setGenProgress("error", "Error: " + msg);
      btn.disabled = false;
      btn.textContent = "🎵 Generate Music Idea";
      return;
    }
    _activeGenPromptId = data.prompt_id;
    addJobCard(data.prompt_id, songName, "queued", []);
    status.textContent = `Queued \u2014 ${data.prompt_id}`;
    status.style.color = "var(--muted)";
    setGenProgress("queued", "Queued — waiting for ComfyUI to start…");
    btn.disabled = false;
    btn.textContent = "🎵 Generate Music Idea";
  } catch (e) {
    const msg = e.message.includes("JSON") ? "ComfyUI is offline or unreachable" : e.message;
    status.textContent = "Error: " + msg;
    status.style.color = "var(--error)";
    setGenProgress("error", "Error: " + msg);
    btn.disabled = false;
    btn.textContent = "🎵 Generate Music Idea";
  }
});

// ── SSE — job status ──────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource("/events");

  es.addEventListener("job_done", e => {
    const data = JSON.parse(e.data);
    addJobCard(data.prompt_id, data.song_name || "Song", "done", data.files);
    if (data.prompt_id === _activeGenPromptId) setGenProgress("done", "✓ Done — audio ready");
  });
  es.addEventListener("job_running", e => {
    const data = JSON.parse(e.data);
    addJobCard(data.prompt_id, data.song_name || "Song", "running", []);
    if (data.prompt_id === _activeGenPromptId) setGenProgress("running", "Generating audio…");
  });
  es.addEventListener("job_error", e => {
    const data = JSON.parse(e.data);
    updateJobCard(data.prompt_id, "error");
    if (data.prompt_id === _activeGenPromptId) setGenProgress("error", "Generation failed");
  });
  es.addEventListener("queue_update", e => {
    const data = JSON.parse(e.data);
    document.getElementById("queue-badge").textContent =
      `Queue: ${data.running} running, ${data.pending} pending`;
  });

  es.onerror = () => { setTimeout(connectSSE, 3000); es.close(); };
}
connectSSE();

// Initial queue load
fetch("/queue").then(r => r.json()).then(data => {
  data.my_jobs.forEach(j => addJobCard(j.prompt_id, j.song_name, j.status, j.output_files));
  const c = data.comfyui;
  document.getElementById("queue-badge").textContent =
    `Queue: ${c.running} running, ${c.pending} pending`;
});

function addJobCard(promptId, songName, status, files) {
  if (document.getElementById("job-" + promptId)) {
    updateJobCard(promptId, status, files);
    return;
  }
  const card = document.createElement("div");
  card.className = "job-card";
  card.id = "job-" + promptId;
  card.innerHTML = `
    <div style="font-weight:600">${songName}</div>
    <div class="status ${status}">${statusLabel(status)}</div>
    <div class="job-progress"><div class="job-progress-bar ${status}"></div></div>
    <div class="job-files" style="margin-top:6px"></div>
  `;
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
  document.getElementById("jobs-list").prepend(card);
}

function updateJobCard(promptId, status, files) {
  const card = document.getElementById("job-" + promptId);
  if (!card) return;
  card.querySelector(".status").className = "status " + status;
  card.querySelector(".status").textContent = statusLabel(status);
  const bar = card.querySelector(".job-progress-bar");
  if (bar) bar.className = "job-progress-bar " + status;
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
}

function addDownloadLinks(container, files) {
  container.innerHTML = "";
  const bust = "?t=" + Date.now();
  files.forEach(f => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;";
    const a = document.createElement("a");
    a.href = "/download/" + encodeURIComponent(f) + bust;
    a.download = f;
    a.textContent = "\u2b07 " + f;
    a.style.cssText = "color:var(--accent2);font-size:12px;flex:1;";
    const remixBtn = document.createElement("button");
    remixBtn.className = "secondary small";
    remixBtn.textContent = "\uD83D\uDD00 Remix";
    remixBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    remixBtn.addEventListener("click", () => toggleRemixPanel(container.closest(".job-card"), f));
    row.appendChild(a);
    row.appendChild(remixBtn);
    container.appendChild(row);
  });
}

function toggleRemixPanel(card, sourceFile) {
  let panel = card.querySelector(".remix-panel");
  if (panel) { panel.remove(); return; }

  panel = document.createElement("div");
  panel.className = "remix-panel";
  panel.style.cssText = "margin-top:10px;padding:10px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);font-size:12px;";
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;color:var(--accent)">🔀 Remix: ${sourceFile}</div>
    <div style="display:flex;gap:12px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
      <label style="font-weight:normal;cursor:pointer">
        <input type="radio" name="remix-mode-${sourceFile}" value="variation" checked> Variation
      </label>
      <label style="font-weight:normal;cursor:pointer">
        <input type="radio" name="remix-mode-${sourceFile}" value="extend"> Extend
      </label>
      <span style="color:var(--muted);font-size:11px" id="remix-mode-hint-${CSS.escape(sourceFile)}">Re-imagine the full clip</span>
    </div>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <label style="font-weight:normal">Closeness to original:
        <input type="range" class="remix-denoise" min="0.05" max="0.95" step="0.05" value="0.5" style="width:120px;vertical-align:middle">
        <span class="remix-denoise-val">0.50</span>
      </label>
      <label class="remix-seed-wrap" style="font-weight:normal;display:none">Seed seconds:
        <input type="number" class="remix-seed-secs" min="3" max="60" value="10" style="width:60px">
      </label>
    </div>
    <div style="margin-bottom:8px">
      <input type="text" class="remix-name" placeholder="Remix name" value="Remix of ${sourceFile.replace('.mp3','')}" style="width:100%">
    </div>
    <button class="secondary small remix-submit">✨ Generate Remix</button>
    <span class="remix-status" style="margin-left:8px;color:var(--muted)"></span>
  `;

  const modeInputs = panel.querySelectorAll(`input[name="remix-mode-${sourceFile}"]`);
  const hintEl = panel.querySelector(`#remix-mode-hint-${CSS.escape(sourceFile)}`);
  const seedWrap = panel.querySelector(".remix-seed-wrap");
  const denoiseEl = panel.querySelector(".remix-denoise");
  const denoiseVal = panel.querySelector(".remix-denoise-val");

  modeInputs.forEach(r => r.addEventListener("change", () => {
    const isExtend = panel.querySelector(`input[name="remix-mode-${sourceFile}"]:checked`).value === "extend";
    seedWrap.style.display = isExtend ? "" : "none";
    hintEl.textContent = isExtend ? "Condition on last N seconds, generate continuation" : "Re-imagine the full clip";
  }));
  denoiseEl.addEventListener("input", () => { denoiseVal.textContent = parseFloat(denoiseEl.value).toFixed(2); });

  panel.querySelector(".remix-submit").addEventListener("click", async () => {
    const btn = panel.querySelector(".remix-submit");
    const statusEl = panel.querySelector(".remix-status");
    const mode = panel.querySelector(`input[name="remix-mode-${sourceFile}"]:checked`).value;
    btn.disabled = true;
    btn.textContent = "Submitting…";
    statusEl.textContent = "";

    const payload = {
      ...mwState,
      tags: document.getElementById("overview-tags").value.trim(),
      lyrics: document.getElementById("overview-lyrics").value,
      source_file: sourceFile,
      mode,
      denoise: parseFloat(denoiseEl.value),
      seed_seconds: parseFloat(panel.querySelector(".remix-seed-secs").value),
      song_name: panel.querySelector(".remix-name").value.trim() || "Remix",
      mode_scale: mwState.mode || "",
    };

    try {
      const resp = await fetch("/remix", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) { statusEl.textContent = "Error: " + (data.error || resp.statusText); btn.disabled = false; btn.textContent = "✨ Generate Remix"; return; }
      addJobCard(data.prompt_id, payload.song_name, "queued", []);
      statusEl.textContent = "Queued ✓";
      btn.textContent = "✨ Generate Remix";
      btn.disabled = false;
    } catch(e) {
      statusEl.textContent = "Error: " + e.message;
      btn.disabled = false;
      btn.textContent = "✨ Generate Remix";
    }
  });

  card.appendChild(panel);
}

function statusLabel(s) {
  return {queued: "\u23f3 Queued", running: "\u2699 Running\u2026", done: "\u2705 Done", error: "\u274c Error"}[s] || s;
}

// ── Easy tab — Ollama ─────────────────────────────────────────────────────────
const _easyArtistState = {};
const _easyVocalState = {};
let _easyStyleInstruments = [];
let _genreMap = {};

fetch("/ollama/models").then(r => r.json()).then(data => {
  const sel = document.getElementById("easy-model");
  sel.innerHTML = "";
  data.models.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
  if (data.models.includes("gemma4:latest")) sel.value = "gemma4:latest";
});

fetch("/api/genres").then(r => r.json()).then(data => {
  const genres = data.genres || [];
  genres.forEach(g => { _genreMap[g.name] = g; });
  const sel = document.getElementById("easy-style");
  const byParent = {};
  genres.forEach(g => {
    if (!byParent[g.parent]) byParent[g.parent] = [];
    byParent[g.parent].push(g);
  });
  Object.keys(byParent).sort().forEach(cat => {
    const og = document.createElement("optgroup");
    og.label = cat;
    byParent[cat].forEach(g => {
      const opt = document.createElement("option");
      opt.value = g.name;
      opt.textContent = g.name;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
});

document.getElementById("easy-style").addEventListener("change", e => {
  const val = e.target.value;
  const infoEl = document.getElementById("easy-style-info");
  if (!val) { infoEl.style.display = "none"; _easyStyleInstruments = []; return; }
  const g = _genreMap[val];
  if (!g) return;
  mwState.genre = g.name;
  mwState.bpm = Math.round((g.bpm_min + g.bpm_max) / 2);
  mwState.key = g.default_key || "C";
  mwState.scale = g.default_scale || "Major";
  _easyStyleInstruments = g.typical_instruments || [];
  let html = `<strong style="color:var(--accent)">${g.name}</strong>`;
  if (g.description) html += ` — ${g.description}`;
  if (_easyStyleInstruments.length) html += `<br>Instruments: ${_easyStyleInstruments.join(", ")}`;
  infoEl.innerHTML = html;
  infoEl.style.display = "block";
  updatePayloadPreview();
});

let _easyAppliedSource = null; // 'artist' | 'vocal' | null

function _resetOtherApply(otherInfoId) {
  const other = document.querySelector(`#${otherInfoId} [data-apply-state]`);
  if (other) { other.textContent = "Apply to state"; other.disabled = false; }
}

async function _doArtistLookup(artist, infoEl, stateObj, useWeb = false, applyType = "artist") {
  infoEl.textContent = useWeb ? "Searching web + looking up…" : "Looking up…";
  try {
    const resp = await fetch("/ollama/artist-info", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({artist, model: document.getElementById("easy-model").value, use_web: useWeb}),
    });
    const data = await resp.json();
    if (data.error) { infoEl.textContent = "Error: " + data.error; return; }
    Object.assign(stateObj, data);

    const instrTags = data.instrument_tags || [];
    const vocalTags = data.vocal_tags || [];
    const styleTags = data.style_tags || [];
    const genreTag = data.genre_tag || "";
    const allAceTags = [genreTag, ...instrTags, ...vocalTags, ...styleTags].filter(Boolean);

    let html = "";
    if (allAceTags.length) {
      html += `<div style="margin-bottom:4px"><span style="color:var(--muted)">Nyx-Step tags:</span> `
            + `<span style="color:var(--accent2)">${allAceTags.join(", ")}</span></div>`;
    }
    if (data.vocal_key) {
      html += `<div style="margin-bottom:2px"><span style="color:var(--muted)">Vocal key:</span> <span style="color:var(--accent)">${data.vocal_key}</span></div>`;
    }
    if (data.lyric_style) {
      html += `<div style="margin-bottom:2px"><span style="color:var(--muted)">Style:</span> ${data.lyric_style}</div>`;
    }
    if (data.lyric_themes?.length) {
      html += `<div style="margin-bottom:4px"><span style="color:var(--muted)">Themes:</span> ${data.lyric_themes.join(", ")}</div>`;
    }
    if (allAceTags.length) {
      html += `<button class="secondary small" data-apply-state="${encodeURIComponent(JSON.stringify({instrTags, vocalTags}))}" data-apply-type="${applyType}" style="margin-top:2px">Apply to state</button>`;
    }
    infoEl.innerHTML = html || "No info found";

    infoEl.querySelector("[data-apply-state]")?.addEventListener("click", e => {
      const {instrTags, vocalTags} = JSON.parse(decodeURIComponent(e.target.dataset.applyState));
      const type = e.target.dataset.applyType;

      if (type === "artist") {
        _resetOtherApply("easy-vocal-info");
        mwState.instruments = [...instrTags];
        mwState.vocal_tags = [...vocalTags];
      } else {
        _resetOtherApply("easy-artist-info");
        mwState.instruments = [];
        mwState.vocal_tags = [...vocalTags];
      }
      _easyAppliedSource = type;

      document.getElementById("instrument-selected").value = mwState.instruments.join(", ");
      document.getElementById("vocal-selected").value = mwState.vocal_tags.join(", ");
      document.getElementById("overview-tags").value = buildCaption();
      updatePayloadPreview();
      e.target.textContent = "Applied ✓";
      e.target.disabled = true;
    });
  } catch(err) {
    infoEl.textContent = "Lookup failed: " + err.message;
  }
}

document.getElementById("btn-easy-artist-lookup").addEventListener("click", () => {
  const artist = document.getElementById("easy-artist").value.trim();
  const infoEl = document.getElementById("easy-artist-info");
  if (!artist) { infoEl.textContent = "Enter an artist name."; return; }
  const useWeb = document.getElementById("easy-artist-web").checked;
  _doArtistLookup(artist, infoEl, _easyArtistState, useWeb, "artist");
});

document.getElementById("btn-easy-vocal-lookup").addEventListener("click", () => {
  const artist = document.getElementById("easy-vocal-artist").value.trim();
  const infoEl = document.getElementById("easy-vocal-info");
  if (!artist) { infoEl.textContent = "Enter an artist name."; return; }
  const useWeb = document.getElementById("easy-vocal-web").checked;
  _doArtistLookup(artist, infoEl, _easyVocalState, useWeb, "vocal");
});

document.getElementById("btn-easy-gen").addEventListener("click", () => {
  const btn = document.getElementById("btn-easy-gen");
  const log = document.getElementById("easy-log");
  log.style.display = "block";
  log.textContent = "";
  const editor = document.getElementById("lyrics-editor");
  editor.value = "";
  mwState.lyrics = "";
  btn.disabled = true;
  btn.textContent = "✨ Generating…";
  let tokenCount = 0;

  const instrumental = document.getElementById("easy-instrumental").checked;
  const instrSet = new Set([
    ..._easyStyleInstruments,
    ...(_easyArtistState.instrument_tags || []),
  ]);
  const instrumentsHint = [...instrSet].join(", ");
  const vocalTags = [
    ...(_easyVocalState.vocal_tags || []),
    ...(_easyArtistState.vocal_tags || []),
  ];
  const vocalStyle = [...new Set(vocalTags)].join(", ");

  const params = new URLSearchParams({
    topic: document.getElementById("easy-topic").value,
    genre: mwState.genre || document.getElementById("easy-style").value || "electronic",
    key: mwState.key,
    mood: document.getElementById("easy-mood").value,
    structure: document.getElementById("easy-structure").value,
    subject: document.getElementById("easy-subject").value,
    name_override: document.getElementById("easy-name-override").value,
    model: document.getElementById("easy-model").value,
    artist: document.getElementById("easy-artist").value.trim(),
    lyric_style: _easyArtistState.lyric_style || "",
    lyric_themes: (_easyArtistState.lyric_themes || []).join(", "),
    vocal_style: vocalStyle,
    instruments_hint: instrumentsHint,
    instrumental: instrumental ? "true" : "false",
  });

  const es = new EventSource("/ollama/stream?" + params.toString());
  es.addEventListener("token", e => {
    const {token} = JSON.parse(e.data);
    editor.value += token;
    mwState.lyrics = editor.value;
    log.textContent += token;
    log.scrollTop = log.scrollHeight;
    tokenCount++;
    btn.textContent = `✨ Generating… (${tokenCount} tokens)`;
  });
  es.addEventListener("done", () => {
    es.close();
    log.textContent += "\n[done]";
    btn.disabled = false;
    btn.textContent = "✨ Generate Music Idea";
    syncOverviewFromState();
  });
  es.onerror = () => {
    es.close();
    log.textContent += "\n[error]";
    btn.disabled = false;
    btn.textContent = "✨ Generate Music Idea";
  };
});

// ── Guide tab ─────────────────────────────────────────────────────────────────
const _guideCache = {};
function loadGuideSection(sectionId, btn) {
  if (_guideCache[sectionId]) {
    document.getElementById("guide-content").innerHTML = _guideCache[sectionId];
    return;
  }
  document.getElementById("guide-content").innerHTML = "<p>Loading\u2026</p>";
  fetch("/guide/" + sectionId)
    .then(r => r.text())
    .then(html => {
      _guideCache[sectionId] = html;
      document.getElementById("guide-content").innerHTML = html;
    });
}
// Load summary on first visit
loadGuideSection("starthere", null);

// ── Lint tab ──────────────────────────────────────────────────────────────────
document.getElementById("btn-lint-state").addEventListener("click", () => {
  const cap = buildCaption();
  lintAndShow(cap, mwState.lyrics);
});
document.getElementById("btn-lint-paste").addEventListener("click", () => {
  lintAndShow(
    document.getElementById("lint-tags").value,
    document.getElementById("lint-lyrics").value
  );
});

async function lintAndShow(tags, lyrics) {
  const resp = await fetch("/lint", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({tags, lyrics}),
  });
  const data = await resp.json();
  renderLintResults(data.results);
}

function renderLintResults(results) {
  const container = document.getElementById("lint-results");
  if (!results || results.length === 0) {
    container.innerHTML = "<p style='color:var(--success)'>\u2705 All clear \u2014 no issues found.</p>";
    return;
  }
  const errors = results.filter(r => r.severity === "error");
  const warnings = results.filter(r => r.severity === "warning");
  const tips = results.filter(r => r.severity === "tip");
  let html = "";
  if (errors.length) {
    html += "<div style='margin-bottom:10px'><strong class='lint-error'>\u274c ERRORS (must fix)</strong>";
    errors.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>\u2192 ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  if (warnings.length) {
    html += "<div style='margin-bottom:10px'><strong class='lint-warning'>\u26a0 WARNINGS (should fix)</strong>";
    warnings.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>\u2192 ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  if (tips.length) {
    html += "<div><strong class='lint-tip'>\ud83d\udca1 TIPS (consider)</strong>";
    tips.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>\u2192 ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  container.innerHTML = html;
  document.getElementById("lint-fix-wrap").style.display =
    (errors.length || warnings.length) ? "block" : "none";
}

// ── Lint Fix It ───────────────────────────────────────────────────────────────
const _SECTION_KW = /\b(solo|verse|chorus|intro|outro|bridge|drop|breakdown|interlude|pre-chorus)\b/i;

function _autoFix(tags, lyrics) {
  let tokens = tags.split(",").map(t => t.trim()).filter(Boolean);
  // Remove duplicates
  const seen = new Set();
  tokens = tokens.filter(t => { const tl = t.toLowerCase(); if (seen.has(tl)) return false; seen.add(tl); return true; });
  // Strip tokens with brackets, parens, or section keywords
  tokens = tokens.filter(t => !t.includes("[") && !t.includes("]") && !t.includes("(") && !t.includes(")") && !_SECTION_KW.test(t));
  // Clamp to 12
  if (tokens.length > 12) tokens = tokens.slice(0, 12);

  let lyr = lyrics;
  lyr = lyr.replace(/\[\[/g, "[").replace(/\]\]/g, "]");
  lyr = lyr.replace(/\[\]/g, "");
  const opens = (lyr.match(/\[/g) || []).length;
  const closes = (lyr.match(/\]/g) || []).length;
  if (opens > closes) lyr += "]".repeat(opens - closes);
  if (lyr.trim() && !/\[(Verse|Chorus|Intro|Outro|Bridge|Interlude|Pre-Chorus|Drop|Build|Breakdown)/i.test(lyr))
    lyr = "[Verse]\n\n" + lyr;

  return { tags: tokens.join(", "), lyrics: lyr };
}

document.getElementById("btn-lint-fix").addEventListener("click", async () => {
  const rawTags = document.getElementById("overview-tags").value;
  const { tags, lyrics } = _autoFix(rawTags, mwState.lyrics);
  document.getElementById("overview-tags").value = tags;
  mwState.lyrics = lyrics;
  document.getElementById("overview-lyrics").value = lyrics;
  document.getElementById("lyrics-editor").value = lyrics;
  updatePayloadPreview();
  await lintAndShow(tags, lyrics);
});

// ── Stems tab ─────────────────────────────────────────────────────────────────
document.getElementById("btn-stems-extract").addEventListener("click", async () => {
  const fileInput = document.getElementById("stems-file");
  const songName = document.getElementById("stems-song-name").value || "Stem Extract";
  const status = document.getElementById("stems-extract-status");
  if (!fileInput.files.length) { status.textContent = "Select a file first."; return; }
  status.textContent = "Uploading\u2026";
  const form = new FormData();
  form.append("audio", fileInput.files[0]);
  form.append("song_name", songName);
  form.append("steps", mwState.steps);
  form.append("duration", mwState.duration);
  form.append("seed", mwState.seed);
  try {
    const resp = await fetch("/stems/extract", {method: "POST", body: form});
    const data = await resp.json();
    if (!resp.ok) { status.textContent = "Error: " + data.error; return; }
    status.textContent = "Queued \u2014 " + data.prompt_id;
  } catch(e) { status.textContent = "Error: " + e.message; }
});

// ── Demucs file browser ───────────────────────────────────────────────────────
document.getElementById("btn-demucs-browse-server").addEventListener("click", async () => {
  const panel = document.getElementById("demucs-server-list");
  if (panel.style.display !== "none") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  panel.innerHTML = "<div style='padding:8px;font-size:12px;color:var(--muted)'>Loading…</div>";
  try {
    const data = await fetch("/stems/audio-files").then(r => r.json());
    if (!data.files.length) {
      panel.innerHTML = "<div style='padding:8px;font-size:12px;color:var(--muted)'>(no audio files found)</div>";
      return;
    }
    panel.innerHTML = data.files.map(f =>
      `<div style="padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)" data-file="${f}">${f}</div>`
    ).join("");
    panel.querySelectorAll("[data-file]").forEach(el => {
      el.addEventListener("mouseenter", () => el.style.background = "var(--surface)");
      el.addEventListener("mouseleave", () => el.style.background = "");
      el.addEventListener("click", () => {
        document.getElementById("demucs-filename").value = el.dataset.file;
        panel.style.display = "none";
      });
    });
  } catch {
    panel.innerHTML = "<div style='padding:8px;font-size:12px;color:var(--error)'>Failed to load file list</div>";
  }
});

document.getElementById("btn-demucs-browse-local").addEventListener("click", () => {
  document.getElementById("demucs-local-file").click();
});

document.getElementById("demucs-local-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById("demucs-upload-status");
  status.textContent = "Uploading…";
  status.style.color = "var(--muted)";
  const form = new FormData();
  form.append("audio", file);
  try {
    const resp = await fetch("/stems/demucs/upload", {method: "POST", body: form});
    const data = await resp.json();
    if (data.filename) {
      document.getElementById("demucs-filename").value = data.filename;
      status.textContent = `Uploaded: ${data.filename}`;
      status.style.color = "var(--accent2)";
    } else {
      status.textContent = "Upload failed";
      status.style.color = "var(--error)";
    }
  } catch {
    status.textContent = "Upload failed";
    status.style.color = "var(--error)";
  }
  e.target.value = "";
});

document.getElementById("btn-demucs-run").addEventListener("click", () => {
  const filename = document.getElementById("demucs-filename").value.trim();
  const model = document.getElementById("demucs-model").value;
  const log = document.getElementById("demucs-log");
  const btn = document.getElementById("btn-demucs-run");
  if (!filename) { log.textContent = "Enter a filename."; return; }
  log.textContent = "";
  btn.textContent = "Busy Separating…";
  btn.disabled = true;
  const stemLinks = document.getElementById("demucs-stem-links");
  if (stemLinks) stemLinks.innerHTML = "";
  const params = new URLSearchParams({filename, model});
  const es = new EventSource("/stems/demucs/stream?" + params.toString());
  es.addEventListener("log", e => {
    const {line} = JSON.parse(e.data);
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener("done", async () => {
    es.close();
    log.textContent += "[done]\n";
    btn.textContent = "Separate";
    btn.disabled = false;
    try {
      const r = await fetch(`/stems/demucs/files?filename=${encodeURIComponent(filename)}&model=${encodeURIComponent(model)}`);
      const data = await r.json();
      if (stemLinks && data.stems && data.stems.length) {
        stemLinks.innerHTML = "<div style='font-size:12px;color:var(--muted);margin-bottom:6px'>Separated stems:</div>" +
          data.stems.map(s =>
            `<a href="/stems/demucs/download/${encodeURIComponent(data.model)}/${encodeURIComponent(data.track)}/${encodeURIComponent(s)}" download="${s}" style="display:inline-block;margin:3px 6px 3px 0;padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;color:var(--accent);font-size:12px;text-decoration:none">⬇ ${s}</a>`
          ).join("");
      }
    } catch(_) {}
  });
  es.onerror = () => {
    es.close();
    btn.textContent = "Separate";
    btn.disabled = false;
  };
});

// ── Init ──────────────────────────────────────────────────────────────────────
syncOverviewFromState();
