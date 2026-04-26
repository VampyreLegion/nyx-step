// ── Cover Mode tab ─────────────────────────────────────────────────────────────
document.getElementById("btn-cover-submit").addEventListener("click", async () => {
  const btn     = document.getElementById("btn-cover-submit");
  const status  = document.getElementById("cover-status");
  const result  = document.getElementById("cover-result");
  const fileEl  = document.getElementById("cover-file");

  if (!fileEl.files.length) { status.textContent = "Select a reference audio file first."; return; }

  btn.disabled = true;
  btn.textContent = "Sending…";
  status.textContent = "Uploading reference audio…";
  status.style.color = "var(--muted)";
  result.innerHTML = "";

  const form = new FormData();
  form.append("audio",     fileEl.files[0]);
  form.append("tags",      document.getElementById("cover-tags").value.trim());
  form.append("lyrics",    document.getElementById("cover-lyrics").value);
  form.append("song_name", document.getElementById("cover-song-name").value || "Cover");
  form.append("denoise",   document.getElementById("cover-denoise").value);
  form.append("steps",     document.getElementById("cover-steps").value);
  form.append("cfg_scale", document.getElementById("cover-cfg").value);
  form.append("duration",  document.getElementById("cover-duration").value);

  try {
    const resp = await fetch("/cover", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) {
      status.textContent = "Error: " + (data.error || resp.statusText);
      status.style.color = "var(--error)";
      return;
    }
    status.textContent = `Queued — prompt ${data.prompt_id.slice(0, 8)}… (position ${data.queue_position})`;
    status.style.color = "var(--accent2)";
  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.style.color = "var(--error)";
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate Cover";
  }
});
