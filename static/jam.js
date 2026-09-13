// ── Finish My Jam — upload a sketch, get AI backing tracks ──────────────────

let _jamState = { uploaded: false, filename: "", analysis: {} };
let _musicgenStatus = null;

async function jamUpload() {
  const input = document.getElementById("jam-file-input");
  const status = document.getElementById("jam-status");
  if (!input.files.length) return;
  const file = input.files[0];
  status.textContent = "Uploading & analyzing…";
  const form = new FormData();
  form.append("audio", file);
  try {
    const resp = await fetch("/api/jam/upload", { method: "POST", body: form });
    const data = await resp.json();
    if (data.error) { status.textContent = "Error: " + data.error; return; }
    _jamState.uploaded = true;
    _jamState.filename = data.filename;
    _jamState.analysis = data.analysis || {};
    const a = _jamState.analysis;
    document.getElementById("jam-bpm").value = a.bpm || 120;
    document.getElementById("jam-key").value = a.key || "C";
    document.getElementById("jam-scale").value = a.scale || "Major";
    document.getElementById("jam-duration").value = a.duration || 30;
    document.getElementById("jam-analysis").style.display = "";
    document.getElementById("jam-lyrics-block").style.display = "";
    _jamBuildCaption();
    _jamPopulateLyricsModelPicker();
    status.textContent = "Analyzed — BPM " + (a.bpm || "?") + ", Key " + (a.key || "?") + " " + (a.scale || "") + ", " + (a.duration || "?") + "s";
    if (a.chords) status.textContent += " | Chords: " + a.chords;
    showToast("Jam analyzed: " + file.name, "success");
  } catch (err) { status.textContent = "Upload failed: " + err.message; }
}

async function jamGenerateBacking() {
  const status = document.getElementById("jam-status");
  const player = document.getElementById("jam-backing-audio");
  const playerWrap = document.getElementById("jam-backing-wrap");
  if (!_jamState.uploaded) { showToast("Upload a jam file first", "error"); return; }
  status.textContent = "Submitting backing generation…";
  const body = {
    jam_filename: _jamState.filename,
    tags: document.getElementById("jam-tags").value.trim() || "instrumental backing",
    bpm: parseInt(document.getElementById("jam-bpm").value) || 120,
    key: document.getElementById("jam-key").value || "C",
    scale: document.getElementById("jam-scale").value || "Major",
    duration: parseFloat(document.getElementById("jam-duration").value) || 30,
    song_name: document.getElementById("jam-song-name").value.trim() || "Jam Backing",
    steps: parseInt(document.getElementById("jam-steps").value) || 8,
    cfg_scale: parseFloat(document.getElementById("jam-cfg").value) || 2.0,
    seed: parseInt(document.getElementById("jam-seed").value) || 0,
    dit_model: document.getElementById("jam-dit").value || "turbo",
  };
  try {
    const resp = await fetch("/api/jam/generate-backing", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error) { status.textContent = "Error: " + data.error; return; }
    status.textContent = "Queued — job " + (data.prompt_id || "").substring(0, 8) + " (position " + data.queue_position + "). Watch the History tab for completion.";
    showToast("Backing track queued!", "success");
  } catch (err) { status.textContent = "Error: " + err.message; }
}

async function jamMusicGen() {
  const status = document.getElementById("jam-mg-status");
  const player = document.getElementById("jam-mg-audio");
  const playerWrap = document.getElementById("jam-mg-wrap");
  const prompt = document.getElementById("jam-mg-prompt").value.trim() || "upbeat guitar jam";
  const duration = parseFloat(document.getElementById("jam-mg-duration").value) || 8.0;
  if (!_jamState.uploaded) { showToast("Upload a jam file first", "error"); return; }
  status.textContent = "Generating with MusicGen… (may take 10–60s)";
  const body = { prompt, duration, jam_filename: _jamState.filename };
  try {
    const resp = await fetch("/api/jam/musicgen", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error) { status.textContent = "Error: " + data.error; return; }
    const url = "/library/audio/jams/" + encodeURIComponent(data.filename);
    player.src = url;
    player.play();
    playerWrap.style.display = "";
    status.textContent = "MusicGen done — " + data.duration + "s, " + data.sampling_rate + "Hz";
    showToast("MusicGen track ready!", "success");
  } catch (err) { status.textContent = "Error: " + err.message; }
}

async function jamMiniMax() {
  const status = document.getElementById("jam-mm-status");
  const caption = document.getElementById("jam-mm-caption").value.trim();
  const lyrics = document.getElementById("jam-mm-lyrics").value.trim();
  if (!caption) { showToast("Enter a music description", "error"); return; }
  if (!lyrics) { showToast("Enter lyrics (or [Instrumental] for no vocals)", "error"); return; }
  status.textContent = "Submitting to MiniMax Music3… (may take 2–5 min)";
  const body = {
    caption,
    lyrics,
    duration: parseFloat(document.getElementById("jam-mm-duration").value) || 120,
    cfg_scale: parseFloat(document.getElementById("jam-mm-cfg").value) || 7.0,
    seed: parseInt(document.getElementById("jam-mm-seed").value) || 0,
    save_format: document.getElementById("jam-mm-format").value || "mp3",
    song_name: document.getElementById("jam-song-name").value.trim() || "MiniMax Song",
  };
  try {
    const resp = await fetch("/api/jam/minimax", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error) { status.textContent = "Error: " + data.error; return; }
    status.textContent = "Queued — job " + (data.prompt_id || "").substring(0, 8) + " (position " + data.queue_position + "). MiniMax Music3 generates up to 5 min songs — watch History tab for completion.";
    showToast("MiniMax Music3 song queued!", "success");
  } catch (err) { status.textContent = "Error: " + err.message; }
}

function _checkMusicGenStatus() {
  fetch("/api/jam/musicgen/status").then(r => r.json()).then(d => {
    const badge = document.getElementById("jam-mg-badge");
    if (d.status === "ok") {
      _musicgenStatus = d;
      if (badge) { badge.textContent = "● Online"; badge.style.color = "var(--accent2,#4caf50)"; }
    } else {
      _musicgenStatus = null;
      if (badge) { badge.textContent = "● Offline"; badge.style.color = "var(--error,#f38ba8)"; }
    }
  }).catch(() => {
    _musicgenStatus = null;
    const badge = document.getElementById("jam-mg-badge");
    if (badge) { badge.textContent = "● Offline"; badge.style.color = "var(--error,#f38ba8)"; }
  });
}

// ── AI Add Lyrics to your instrumental ───────────────────────────────────────
function _jamBuildCaption() {
  // Build a MiniMax caption from the detected analysis so a generated song
  // matches the uploaded jam's feel (BPM/key/scale/chords).
  const a = _jamState.analysis || {};
  const parts = [];
  if (a.bpm) parts.push(a.bpm + " BPM");
  if (a.key) parts.push(a.key + (a.scale ? " " + a.scale : ""));
  if (a.chords) parts.push(a.chords);
  if (a.duration) parts.push(a.duration + "s");
  const genre = (a.genre || _jamState.genre || "").trim();
  if (genre) parts.unshift(genre);
  const caption = parts.join(", ");
  const el = document.getElementById("jam-mm-caption");
  if (el && caption) {
    // keep any existing user text; only prefill when the box is empty
    if (!el.value.trim()) el.value = caption + ". ";
  }
}

async function _jamPopulateLyricsModelPicker() {
  const select = document.getElementById("jam-lyrics-model");
  if (!select) return;
  try {
    const data = await fetch("/ollama/models").then(r => r.json());
    const models = Array.isArray(data) ? data
      : data.models ? data.models : (data.data || []);
    const names = models
      .map(m => (typeof m === "string" ? m : (m.name || m.model)))
      .filter(Boolean);
    if (names.length) {
      const current = select.value;
      select.innerHTML = names
        .map(n => `<option value="${n.replace(/"/g, "&quot;")}">${n}</option>`)
        .join("");
      if ([...select.options].some(o => o.value === current)) select.value = current;
    }
  } catch (e) { /* model list unavailable — keep default */ }
}

let _jamLyricsStream = null;

function _jamLyricsSetBusy(busy, btn) {
  const en = !busy;
  ["jam-lyrics-auto-btn", "jam-lyrics-theme-btn"].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !en;
  });
  if (btn) btn.textContent = busy ? "Writing lyrics…" : btn.dataset.idle;
}

function _jamStartLyrics(useTheme) {
  const status = document.getElementById("jam-lyrics-status");
  const preview = document.getElementById("jam-lyrics-preview");
  if (!_jamState.uploaded) { showToast("Upload a jam file first", "error"); return; }
  if (!preview) return;

  if (_jamLyricsStream) { _jamLyricsStream.close(); _jamLyricsStream = null; }

  const a = _jamState.analysis || {};
  const themeInput = document.getElementById("jam-lyrics-theme");
  const theme = (themeInput.value || "").trim();
  if (useTheme && !theme) { showToast("Enter a topic/theme, or use 'Automatic'", "error"); return; }

  const genre = (a.genre || _jamState.genre || "").trim();
  const isMinor = (a.scale === "Minor") || (a.scale && a.scale.toLowerCase() === "minor");
  const keyLabel = isMinor ? ((a.key || "C") + " minor") : (a.key || "C");
  const params = new URLSearchParams({
    topic: theme || "",
    genre: genre || "instrumental",
    key: keyLabel,
    mood: "matches the instrumental jam",
    structure: "Verse-Chorus-Verse-Chorus-Bridge-Outro",
    subject: theme || "the music's mood",
    model: document.getElementById("jam-lyrics-model").value || "gemma4:latest",
    lyric_style: "evocative, natural, singable",
    vocal_style: (a.vocal_language && a.vocal_language !== "en") ? "" : "clear lead vocal",
    instrumental: "false",
  });
  const enhancement = [];
  if (a.chords) enhancement.push("follows the chord progression " + a.chords);
  if (a.bpm) enhancement.push(a.bpm + " BPM groove");
  if (enhancement.length) params.set("enhancement_tags", enhancement.join("; "));

  preview.value = "";
  const autoBtn = document.getElementById("jam-lyrics-auto-btn");
  const themeBtn = document.getElementById("jam-lyrics-theme-btn");
  const active = useTheme ? themeBtn : autoBtn;
  _jamLyricsSetBusy(true, active);
  status.textContent = useTheme
    ? ("✍️ Writing lyrics about \"" + theme + "\" … (streaming)")
    : "✍️ Writing lyrics automatically from your jam's feel … (streaming)";

  const es = new EventSource("/ollama/stream?" + params.toString());
  _jamLyricsStream = es;
  es.addEventListener("token", e => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    preview.value += data.token || "";
    preview.scrollTop = preview.scrollHeight;
  });
  es.addEventListener("done", () => {
    es.close(); _jamLyricsStream = null;
    _jamLyricsSetBusy(false, active);
    status.textContent = "Done — " + preview.value.trim().split(/\n+/).length + " lines. Review below, then Copy to MiniMax.";
    showToast("Lyrics written!", "success");
  });
  es.onerror = () => {
    es.close(); _jamLyricsStream = null;
    _jamLyricsSetBusy(false, active);
    status.textContent = "Stream interrupted — the preview may be partial.";
  };
}

function _jamCopyLyricsToMinimax() {
  const preview = document.getElementById("jam-lyrics-preview");
  const mm = document.getElementById("jam-mm-lyrics");
  const status = document.getElementById("jam-lyrics-status");
  if (!preview || !mm) return;
  const text = preview.value.trim();
  if (!text) { showToast("No lyrics to copy yet", "error"); return; }
  mm.value = text;
  status.textContent = "Copied to MiniMax lyrics — you can edit, then click Generate Song.";
  showToast("Lyrics copied to MiniMax", "success");
}

// ── Add Lyrics — vocals mixed over the SAME instrumental ─────────────────────
function _jamCompleteCaption() {
  // Derive a caption from the Jam's analysis + any text in the MiniMax caption
  // or the AI lyrics block value.
  const mmCaption = document.getElementById("jam-mm-caption").value.trim();
  const aiCaption  = document.getElementById("jam-complete-caption").value.trim();
  const base = aiCaption || mmCaption;
  if (base) return base;
  const a = _jamState.analysis || {};
  const parts = [];
  if (a.bpm) parts.push(a.bpm + " BPM");
  if (a.key) parts.push(a.key + (a.scale ? " " + a.scale : ""));
  if (a.chords) parts.push(a.chords);
  if (a.duration) parts.push(a.duration + "s");
  return parts.join(", ");
}

async function jamComplete() {
  const status = document.getElementById("jam-complete-status");
  const btn = document.getElementById("jam-complete-btn");
  if (!_jamState.uploaded || !_jamState.filename) {
    status.textContent = "Upload a jam file first (step 1).";
    status.style.color = "var(--error)";
    return;
  }
  const lyrics = (document.getElementById("jam-lyrics-preview").value || document.getElementById("jam-mm-lyrics").value || "").trim();
  if (!lyrics) {
    status.textContent = "Use the AI step to write lyrics first, then click Add Lyrics.";
    status.style.color = "var(--error)";
    return;
  }
  const body = {
    jam_filename: _jamState.filename,
    caption: _jamCompleteCaption(),
    lyrics,
    song_name: document.getElementById("jam-song-name").value.trim() || "Jam Song",
    denoise: parseFloat(document.getElementById("jam-complete-denoise").value) || 0.75,
    steps: parseInt(document.getElementById("jam-complete-steps").value) || 20,
    cfg: parseFloat(document.getElementById("jam-complete-cfg").value) || 2.0,
    duration: parseFloat(document.getElementById("jam-complete-duration").value) || _jamState.analysis.duration || 30,
    seed: parseInt(document.getElementById("jam-complete-seed").value) || 0,
    bpm: parseInt(document.getElementById("jam-bpm").value) || 120,
    key: document.getElementById("jam-key").value || "C",
    scale: document.getElementById("jam-scale").value || "Major",
  };
  btn.disabled = true; btn.textContent = "Submitting…";
  status.textContent = "Submitting — vocals will be mixed onto your ORIGINAL track…";
  status.style.color = "var(--muted)";
  try {
    const r = await fetch("/api/jam/vocalize", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      status.textContent = "Error: " + (data.error || "unknown");
      status.style.color = "var(--error)";
      return;
    }
    status.textContent = "Vocals queued — your song stays as-is; AI vocals are generated (~1–2 min), then mixed over your instrumental. Check History to download.";
    status.style.color = "var(--accent2)";
    showToast("Lyrics queued onto your song", "success");
  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.style.color = "var(--error)";
  } finally {
    btn.disabled = false; btn.textContent = "🎙️ Add Lyrics to My Song";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  _checkMusicGenStatus();
  document.getElementById("jam-file-input")?.addEventListener("change", jamUpload);
  document.getElementById("jam-generate-btn")?.addEventListener("click", jamGenerateBacking);
  document.getElementById("jam-mg-btn")?.addEventListener("click", jamMusicGen);
  document.getElementById("jam-mm-btn")?.addEventListener("click", jamMiniMax);
  document.getElementById("jam-lyrics-auto-btn")?.addEventListener("click", () => _jamStartLyrics(false));
  document.getElementById("jam-lyrics-theme-btn")?.addEventListener("click", () => _jamStartLyrics(true));
  document.getElementById("jam-lyrics-copy-btn")?.addEventListener("click", _jamCopyLyricsToMinimax);
  document.getElementById("jam-lyrics-clear-btn")?.addEventListener("click", () => {
    const el = document.getElementById("jam-lyrics-preview");
    if (el) el.value = "";
    const st = document.getElementById("jam-lyrics-status");
    if (st) st.textContent = "Cleared. Add a theme or click a Write Lyrics button.";
  });
  document.getElementById("jam-complete-btn")?.addEventListener("click", jamComplete);
  const aiBtn = document.getElementById("jam-lyrics-auto-btn");
  const thBtn = document.getElementById("jam-lyrics-theme-btn");
  if (aiBtn) aiBtn.dataset.idle = aiBtn.textContent;
  if (thBtn) thBtn.dataset.idle = thBtn.textContent;
});
