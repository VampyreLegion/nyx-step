// ── Video Tab ─────────────────────────────────────────────────────────────────

let _videoSchedule = null;
let _videoJobId = null;
let _videoPollTimer = null;

// ── Section prompt editors ────────────────────────────────────────────────────

function parseLyricsSections(lyrics) {
  const re = /^\[([^\]]+)\]/gm;
  const sections = [];
  let m;
  while ((m = re.exec(lyrics)) !== null) {
    const name = m[1].split(":")[0].trim();
    if (!sections.includes(name)) sections.push(name);
  }
  return sections.length ? sections : ["Main"];
}

function buildSectionPromptEditors(sections) {
  const container = document.getElementById("video-section-prompts");
  if (!container) return;
  container.innerHTML = "";
  sections.forEach(section => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:0.8rem";
    wrap.innerHTML = `
      <label style="font-weight:600;display:block;margin-bottom:0.3rem">${section}</label>
      <textarea id="video-prompt-${section}" rows="2"
        style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:0.5rem;font-size:0.9em;resize:vertical"
        placeholder="Visual scene description for ${section}..."></textarea>`;
    container.appendChild(wrap);
  });
}

function getSectionPrompts() {
  const prompts = {};
  document.querySelectorAll("[id^='video-prompt-']").forEach(el => {
    const section = el.id.replace("video-prompt-", "");
    prompts[section] = el.value.trim();
  });
  return prompts;
}

function setSectionPrompts(promptsMap) {
  Object.entries(promptsMap).forEach(([section, text]) => {
    const el = document.getElementById(`video-prompt-${section}`);
    if (el) el.value = text;
  });
}

// ── Audio file selector ───────────────────────────────────────────────────────

async function loadAudioFileList() {
  const sel = document.getElementById("video-audio-select");
  const note = document.getElementById("video-audio-note");
  if (!sel) return;
  try {
    const resp = await fetch("/api/video/audio-files");
    if (!resp.ok) return;
    const data = await resp.json();
    const current = sel.value || (typeof mwState !== "undefined" ? mwState.lastAudioFile : "");
    sel.innerHTML = '<option value="">— select audio file —</option>';
    (data.files || []).forEach(f => {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      if (f === current) opt.selected = true;
      sel.appendChild(opt);
    });
    // Auto-select mwState.lastAudioFile if nothing is selected yet
    if (!sel.value && typeof mwState !== "undefined" && mwState.lastAudioFile) {
      sel.value = mwState.lastAudioFile;
    }
    if (note) note.textContent = sel.value ? `Selected: ${sel.value}` : `${data.files.length} file(s) available`;
  } catch (_) {}
}

function getSelectedAudioFile() {
  const sel = document.getElementById("video-audio-select");
  return (sel && sel.value) ? sel.value
    : (typeof mwState !== "undefined" ? mwState.lastAudioFile : null);
}

// ── Tab open hook ─────────────────────────────────────────────────────────────

function onVideoTabOpen() {
  loadAudioFileList();
  const lyrics = (typeof mwState !== "undefined" && mwState.lyrics) ? mwState.lyrics : "";
  const sections = parseLyricsSections(lyrics);
  buildSectionPromptEditors(sections);
  if (sections.length && lyrics) {
    suggestVideoPrompts(sections);
  }
}

// ── Suggest prompts ───────────────────────────────────────────────────────────

async function suggestVideoPrompts(sections) {
  const style = document.querySelector("input[name='video-style']:checked")?.value || "cinematic";
  const genre = (typeof mwState !== "undefined") ? (mwState.genre || "") : "";
  const caption = (typeof mwState !== "undefined") ? (mwState.caption || "") : "";
  try {
    const resp = await fetch("/api/video/suggest-prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections, genre, caption, style }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    setSectionPrompts(data.prompts || {});
  } catch (_) {}
}

// ── Analyse ───────────────────────────────────────────────────────────────────

async function analyseVideoAudio() {
  const btn = document.getElementById("video-analyse-btn");
  const result = document.getElementById("video-analyse-result");
  const genBtn = document.getElementById("video-generate-btn");
  if (!btn || !result || !genBtn) return;

  const audioFile = getSelectedAudioFile();

  if (!audioFile) {
    result.textContent = "No audio file selected. Choose a file from the Audio File dropdown.";
    return;
  }

  btn.disabled = true;
  result.textContent = "Analysing…";

  const lyrics = (typeof mwState !== "undefined") ? (mwState.lyrics || "") : "";
  const bpm = (typeof mwState !== "undefined") ? (mwState.bpm || null) : null;
  const chunkSeconds = parseFloat(document.getElementById("video-chunk-seconds").value);
  const fps = parseFloat(document.getElementById("video-fps").value);
  const syncMode = document.querySelector("input[name='video-sync']:checked")?.value || "both";

  try {
    const resp = await fetch("/api/video/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_file: audioFile,
        chunk_seconds: chunkSeconds,
        fps, sync_mode: syncMode,
        lyrics, bpm_hint: bpm,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { result.textContent = `Error: ${data.error}`; return; }
    _videoSchedule = data;
    result.textContent = `${data.bpm.toFixed(1)} BPM · ${data.chunks.length} chunks · ${data.duration.toFixed(1)}s`;
    genBtn.disabled = false;
  } catch (err) {
    result.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Generate ──────────────────────────────────────────────────────────────────

async function generateVideo() {
  if (!_videoSchedule) return;

  const genBtn = document.getElementById("video-generate-btn");
  const progressWrap = document.getElementById("video-progress-wrap");
  const progressBar = document.getElementById("video-progress-bar");
  const progressLabel = document.getElementById("video-progress-label");
  const downloadWrap = document.getElementById("video-download-wrap");
  const errorDiv = document.getElementById("video-error");
  if (!genBtn || !progressWrap || !progressBar || !progressLabel || !downloadWrap || !errorDiv) return;

  genBtn.disabled = true;
  progressWrap.style.display = "block";
  downloadWrap.style.display = "none";
  errorDiv.style.display = "none";
  progressBar.value = 0;
  progressLabel.textContent = "Starting…";

  const res = document.getElementById("video-resolution").value.split("x");
  const settings = {
    style: document.querySelector("input[name='video-style']:checked")?.value || "cinematic",
    sync_mode: document.querySelector("input[name='video-sync']:checked")?.value || "both",
    width: parseInt(res[0]),
    height: parseInt(res[1]),
    fps: parseFloat(document.getElementById("video-fps").value),
    steps: parseInt(document.getElementById("video-steps").value),
    cfg_base: parseFloat(document.getElementById("video-cfg").value),
    model_name: document.getElementById("video-model").value.trim(),
    text_encoder_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    vae_name: "wan_2.1_vae.safetensors",
    negative_prompt: document.getElementById("video-negative").value.trim(),
    seed: Math.floor(Math.random() * 2 ** 32),
  };

  try {
    const resp = await fetch("/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedule: _videoSchedule,
        section_prompts: getSectionPrompts(),
        settings,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { throw new Error(data.error || "Generate failed"); }
    _videoJobId = data.job_id;
    pollVideoStatus(data.chunks_total);
  } catch (err) {
    errorDiv.textContent = `Error: ${err.message}`;
    errorDiv.style.display = "block";
    progressWrap.style.display = "none";
    genBtn.disabled = false;
  }
}

// ── Status polling ────────────────────────────────────────────────────────────

function pollVideoStatus(total) {
  const progressBar = document.getElementById("video-progress-bar");
  const progressLabel = document.getElementById("video-progress-label");
  const downloadWrap = document.getElementById("video-download-wrap");
  const downloadLink = document.getElementById("video-download-link");
  const errorDiv = document.getElementById("video-error");
  const genBtn = document.getElementById("video-generate-btn");

  clearInterval(_videoPollTimer);
  _videoPollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/video/status/${_videoJobId}`);
      const state = await resp.json();
      const done = state.chunks_done || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      progressBar.value = pct;
      const note = state.chunk_note ? ` — ${state.chunk_note}` : "";
      progressLabel.textContent = `Chunk ${done} of ${total} · ${pct}%${note}`;
      if (state.status === "done") {
        clearInterval(_videoPollTimer);
        downloadLink.href = `/api/video/download/${_videoJobId}`;
        downloadWrap.style.display = "block";
        progressLabel.textContent = `Done — ${total} chunks`;
        genBtn.disabled = false;
      } else if (state.status === "error") {
        clearInterval(_videoPollTimer);
        errorDiv.textContent = `Error: ${state.error}`;
        errorDiv.style.display = "block";
        genBtn.disabled = false;
      }
    } catch (err) {
      progressLabel.textContent = "Poll error — retrying…";
      console.warn("Video poll error:", err);
    }
  }, 3000);
}

// ── Wire up event listeners ───────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("video-analyse-btn")?.addEventListener("click", analyseVideoAudio);
  document.getElementById("video-generate-btn")?.addEventListener("click", generateVideo);
  document.getElementById("video-audio-refresh")?.addEventListener("click", loadAudioFileList);
  document.getElementById("video-audio-select")?.addEventListener("change", () => {
    const sel = document.getElementById("video-audio-select");
    const note = document.getElementById("video-audio-note");
    if (note) note.textContent = sel.value ? `Selected: ${sel.value}` : "";
  });
  document.getElementById("video-regen-prompts")?.addEventListener("click", () => {
    const lyrics = (typeof mwState !== "undefined") ? (mwState.lyrics || "") : "";
    const sections = parseLyricsSections(lyrics);
    buildSectionPromptEditors(sections);
    suggestVideoPrompts(sections);
  });
  document.getElementById("video-cancel-btn")?.addEventListener("click", () => {
    clearInterval(_videoPollTimer);
    document.getElementById("video-progress-wrap").style.display = "none";
    document.getElementById("video-generate-btn").disabled = false;
  });

  // Hook into tab switching
  document.querySelectorAll(".tab-btn").forEach(btn => {
    if (btn.dataset.tab === "video") {
      btn.addEventListener("click", onVideoTabOpen);
    }
  });
});
