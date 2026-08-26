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

document.addEventListener("DOMContentLoaded", () => {
  _checkMusicGenStatus();
  document.getElementById("jam-file-input")?.addEventListener("change", jamUpload);
  document.getElementById("jam-generate-btn")?.addEventListener("click", jamGenerateBacking);
  document.getElementById("jam-mg-btn")?.addEventListener("click", jamMusicGen);
  document.getElementById("jam-mm-btn")?.addEventListener("click", jamMiniMax);
});
