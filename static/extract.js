// ── Extract Mode ──────────────────────────────────────────────────────────────
(function () {
  const btn    = document.getElementById("btn-extract-submit");
  const status = document.getElementById("extract-status");
  const result = document.getElementById("extract-result");
  const fileEl = document.getElementById("extract-file");

  if (!btn) return;

  btn.addEventListener("click", () => {
    if (!fileEl.files.length) { status.textContent = "Select an audio file first."; return; }

    btn.disabled = true;
    btn.textContent = "Sending…";
    status.textContent = "Uploading audio…";
    status.style.color = "var(--muted)";
    result.innerHTML = "";

    const s = mwState;
    const form = new FormData();
    form.append("audio",        fileEl.files[0]);
    form.append("tags",         document.getElementById("extract-tags").value.trim());
    form.append("song_name",    document.getElementById("extract-song-name").value || "Extract");
    form.append("denoise",      document.getElementById("extract-denoise").value);
    form.append("steps",        document.getElementById("extract-steps").value);
    form.append("cfg",          document.getElementById("extract-cfg").value);
    form.append("duration",     document.getElementById("extract-duration").value);
    form.append("bpm",          s.bpm || 120);
    form.append("key",          s.key || "C");
    form.append("scale",        s.scale || "Major");
    form.append("audio_format", s.audio_format || "mp3");
    form.append("audio_quality",s.audio_quality || "V0");
    form.append("dit_model",    s.dit_model || "sft");
    form.append("sampler_name", s.sampler_name || "er_sde");
    form.append("scheduler",    s.scheduler || "linear_quadratic");
    form.append("seed",         (s.lock_seed && s.seed) ? s.seed : 0);

    fetch("/extract", { method: "POST", body: form })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          status.textContent = "Error: " + (data.error || "unknown");
          status.style.color = "var(--error)";
          return;
        }
        status.textContent = `Queued — prompt ${data.prompt_id.slice(0, 8)}…`;
        status.style.color = "var(--accent2)";
      })
      .catch(e => {
        status.textContent = "Error: " + e.message;
        status.style.color = "var(--error)";
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = "🔬 Extract Stem";
      });
  });
})();
