// ── Utilities ─────────────────────────────────────────────────────────────────
const _debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function statusLabel(s) {
  return {queued: "⏳ Queued", running: "⚙ Running…", done: "✅ Done", error: "❌ Error"}[s] || s;
}

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

// ── Guide cache + loader ───────────────────────────────────────────────────────
const _guideCache = {};
function loadGuideSection(sectionId, btn) {
  if (_guideCache[sectionId]) {
    document.getElementById("guide-content").innerHTML = _guideCache[sectionId];
    return;
  }
  document.getElementById("guide-content").innerHTML = "<p>Loading…</p>";
  fetch("/guide/" + sectionId)
    .then(r => r.text())
    .then(html => {
      _guideCache[sectionId] = html;
      document.getElementById("guide-content").innerHTML = html;
    });
}
