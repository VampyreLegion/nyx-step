// ── Lego Mode & Complete Mode ──────────────────────────────────────────────────
function _legoSubmit(mode) {
  const prefix  = mode === "lego" ? "lego" : "complete";
  const endpoint = mode === "lego" ? "/lego" : "/complete";
  const btnLabel = mode === "lego" ? "🧱 Add Element" : "🎼 Complete Track";

  const btn    = document.getElementById(`btn-${prefix}-submit`);
  const status = document.getElementById(`${prefix}-status`);
  const result = document.getElementById(`${prefix}-result`);
  const fileEl = document.getElementById(`${prefix}-file`);

  if (!fileEl.files.length) { status.textContent = "Select an audio file first."; return; }

  btn.disabled = true;
  btn.textContent = "Sending…";
  status.textContent = "Uploading audio…";
  status.style.color = "var(--muted)";
  result.innerHTML = "";

  const s = mwState;
  const form = new FormData();
  form.append("audio",        fileEl.files[0]);
  form.append("tags",         document.getElementById(`${prefix}-tags`).value.trim());
  form.append("lyrics",       prefix === "complete" ? document.getElementById("complete-lyrics").value : "");
  form.append("song_name",    document.getElementById(`${prefix}-song-name`).value || prefix);
  form.append("denoise",      document.getElementById(`${prefix}-denoise`).value);
  form.append("steps",        document.getElementById(`${prefix}-steps`).value);
  form.append("cfg",          document.getElementById(`${prefix}-cfg`).value);
  form.append("duration",     document.getElementById(`${prefix}-duration`).value);
  form.append("bpm",          s.bpm || 120);
  form.append("key",          s.key || "C");
  form.append("scale",        s.scale || "Major");
  form.append("audio_format", s.audio_format || "mp3");
  form.append("audio_quality",s.audio_quality || "V0");
  form.append("dit_model",    s.dit_model || "sft");
  form.append("sampler_name", s.sampler_name || "er_sde");
  form.append("scheduler",    s.scheduler || "linear_quadratic");
  form.append("seed",         (s.lock_seed && s.seed) ? s.seed : 0);

  fetch(endpoint, { method: "POST", body: form })
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
      btn.textContent = btnLabel;
    });
}

document.getElementById("btn-lego-submit").addEventListener("click", () => _legoSubmit("lego"));
document.getElementById("btn-complete-submit").addEventListener("click", () => _legoSubmit("complete"));
