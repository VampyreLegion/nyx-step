// ── Audio Analysis ─────────────────────────────────────────────────────────────
let _lastAnalysis = null;

document.getElementById("btn-analyze").addEventListener("click", async () => {
  const btn    = document.getElementById("btn-analyze");
  const status = document.getElementById("analyze-status");
  const result = document.getElementById("analyze-result");
  const applyBtn = document.getElementById("btn-analyze-apply");
  const fileEl = document.getElementById("analyze-file");

  if (!fileEl.files.length) { status.textContent = "Select an audio file first."; return; }

  btn.disabled = true;
  btn.textContent = "Analyzing…";
  status.textContent = "Uploading and analyzing (Whisper transcription may take ~30s)…";
  status.style.color = "var(--muted)";
  result.style.display = "none";
  applyBtn.style.display = "none";
  _lastAnalysis = null;

  // Elapsed-time counter
  const _analyzeStart = Date.now();
  const _analyzeTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - _analyzeStart) / 1000);
    status.textContent = `Analyzing… ${elapsed}s`;
  }, 1000);

  const form = new FormData();
  form.append("audio", fileEl.files[0]);

  try {
    const resp = await fetch("/analyze", { method: "POST", body: form });
    clearInterval(_analyzeTimer);
    const data = await resp.json();
    if (!resp.ok || data.error) {
      status.textContent = "Error: " + (data.error || resp.statusText);
      status.style.color = "var(--error)";
      showToast("Analyze failed: " + (data.error || resp.statusText), "error");
      return;
    }
    _lastAnalysis = data;
    const lufsStr   = data.lufs   !== undefined ? ` &nbsp;|&nbsp; <b>LUFS:</b> ${data.lufs} LUFS` : "";
    const chordsStr = data.chords ? `<br><b>Detected Chords:</b> <span style="color:var(--accent2)">${data.chords}</span>` : "";
    result.innerHTML =
      `<b>BPM:</b> ${data.bpm} &nbsp;|&nbsp; ` +
      `<b>Key:</b> ${data.key} ${data.scale} &nbsp;|&nbsp; ` +
      `<b>Duration:</b> ${data.duration}s` + lufsStr + ` &nbsp;|&nbsp; ` +
      `<b>Language:</b> ${data.vocal_language} (${Math.round((data.language_probability||0)*100)}%)` +
      chordsStr +
      (data.lyrics ? `<br><br><b>Transcription:</b><br><pre style="white-space:pre-wrap;font-size:10px;margin:4px 0 0;color:var(--muted)">${data.lyrics}</pre>` : "");
    result.style.display = "block";
    applyBtn.style.display = "";
    status.textContent = "Analysis complete.";
    status.style.color = "var(--accent2)";
  } catch (e) {
    clearInterval(_analyzeTimer);
    status.textContent = "Error: " + e.message;
    status.style.color = "var(--error)";
    showToast("Analyze error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Analyze";
  }
});

document.getElementById("btn-analyze-apply").addEventListener("click", () => {
  if (!_lastAnalysis) return;
  const d = _lastAnalysis;
  if (d.bpm) {
    mwState.bpm = d.bpm;
    const el = document.getElementById("style-bpm");
    if (el) el.value = d.bpm;
  }
  if (d.key) {
    mwState.key = d.key;
    const el = document.getElementById("style-key");
    if (el) el.value = d.key;
  }
  if (d.scale) {
    mwState.scale = d.scale;
    const el = document.getElementById("style-scale");
    if (el) el.value = d.scale;
  }
  if (d.vocal_language && d.vocal_language !== "en") {
    mwState.vocal_language = d.vocal_language;
    const el = document.getElementById("param-vocal-language");
    if (el) el.value = d.vocal_language;
  }
  if (d.lyrics) {
    const plain = d.lyrics.replace(/^\[[\d:. ]+\] /gm, "").trim();
    mwState.lyrics = plain;
    const lyricsEl = document.getElementById("lyrics-editor");
    const overviewEl = document.getElementById("overview-lyrics");
    if (lyricsEl) lyricsEl.value = plain;
    if (overviewEl) overviewEl.value = plain;
  }
  if (d.chords) {
    mwState.chords = d.chords;
    const el = document.getElementById("style-chords");
    if (el) el.value = d.chords;
  }
  updatePayloadPreview();
  document.getElementById("analyze-status").textContent = "Applied to state — BPM, key, scale, chords, language, and lyrics updated.";
  document.getElementById("analyze-status").style.color = "var(--accent2)";
});
