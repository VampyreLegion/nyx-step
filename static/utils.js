// ── Toast notifications ───────────────────────────────────────────────────────
let _toastStyleInjected = false;
let _toastContainer = null;

function _ensureToastInfra() {
  if (!_toastStyleInjected) {
    const style = document.createElement("style");
    style.textContent = `
      #nyx-toast-container {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9999;
        display: flex;
        flex-direction: column-reverse;
        gap: 8px;
        pointer-events: none;
      }
      .nyx-toast {
        padding: 10px 16px;
        border-radius: 7px;
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        opacity: 0;
        transform: translateX(30px);
        transition: opacity 0.25s, transform 0.25s;
        pointer-events: auto;
        max-width: 320px;
        word-break: break-word;
        cursor: default;
      }
      .nyx-toast.show { opacity: 1; transform: translateX(0); }
      .nyx-toast.info    { background: #2563eb; }
      .nyx-toast.success { background: #16a34a; }
      .nyx-toast.error   { background: #dc2626; }
      .nyx-toast.warning { background: #d97706; }
    `;
    document.head.appendChild(style);
    _toastStyleInjected = true;
  }
  if (!_toastContainer) {
    _toastContainer = document.createElement("div");
    _toastContainer.id = "nyx-toast-container";
    document.body.appendChild(_toastContainer);
  }
}

function showToast(message, type = "info") {
  _ensureToastInfra();
  const toast = document.createElement("div");
  toast.className = "nyx-toast " + type;
  toast.textContent = message;
  _toastContainer.appendChild(toast);
  // Trigger show animation
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("show"));
  });
  // Auto-dismiss after 3s
  setTimeout(() => {
    toast.classList.remove("show");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Fallback removal
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

const _debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function statusLabel(s) {
  return {queued: "⏳ Queued", running: "⚙ Running…", mixing: "🎙 Mixing vocals…", done: "✅ Done", error: "❌ Error"}[s] || s;
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
  updateTagTokenCount();
  updatePayloadPreview();
}

function updateTagTokenCount() {
  const el = document.getElementById("tag-token-count");
  const tags = document.getElementById("overview-tags").value;
  const tokens = tags.split(",").map(t => t.trim()).filter(t => t.length > 0);
  const n = tokens.length;
  if (el) {
    el.textContent = n + (n === 1 ? " token" : " tokens");
    el.style.color = n >= 15 ? "var(--error)" : n >= 12 ? "var(--warning, #f0a500)" : "var(--muted)";
  }
  ["token-badge-style", "token-badge-instruments", "token-badge-vocals"].forEach(id => {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n > 0 ? "" : "none";
    badge.className = "tab-token-badge" + (n >= 15 ? " error" : n >= 12 ? " warn" : "");
  });
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
    `Engine:   ${s.engine === "minimax" ? "MiniMax Music3" : "ACE-Step v1.5"}`,
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

function openGuideSection(id) {
  document.querySelector('[data-tab="guide"]').click();
  const btn = document.querySelector(`[data-guide="${id}"]`);
  if (btn) btn.click();
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
