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

  if (genre.typical_instruments?.length) {
    mwState.instruments = [...genre.typical_instruments];
    document.getElementById("instrument-selected").value = mwState.instruments.join(", ");
    _syncInstrumentChips();
  }

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
