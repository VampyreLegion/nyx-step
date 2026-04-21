// ── Stems tab — Extract ───────────────────────────────────────────────────────
document.getElementById("btn-stems-extract").addEventListener("click", async () => {
  const btn = document.getElementById("btn-stems-extract");
  const fileInput = document.getElementById("stems-file");
  const songName = document.getElementById("stems-song-name").value || "Stem Extract";
  const status = document.getElementById("stems-extract-status");
  if (!fileInput.files.length) { status.textContent = "Select a file first."; return; }
  btn.disabled = true; btn.textContent = "Sending…";
  status.textContent = "Uploading…";
  const form = new FormData();
  form.append("audio", fileInput.files[0]);
  form.append("song_name", songName);
  form.append("steps", mwState.steps);
  form.append("duration", mwState.duration);
  form.append("seed", mwState.seed);
  try {
    const resp = await fetch("/stems/extract", {method: "POST", body: form});
    const data = await resp.json();
    if (!resp.ok) { status.textContent = "Error: " + data.error; return; }
    status.textContent = "Queued — " + data.prompt_id;
  } catch(e) {
    status.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false; btn.textContent = "Send Extract Job to ComfyUI";
  }
});

// ── Demucs file browser ───────────────────────────────────────────────────────
document.getElementById("btn-demucs-browse-server").addEventListener("click", async () => {
  const panel = document.getElementById("demucs-server-list");
  if (panel.style.display !== "none") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  panel.innerHTML = "<div style='padding:8px;font-size:12px;color:var(--muted)'>Loading…</div>";
  try {
    const data = await fetch("/stems/audio-files").then(r => r.json());
    if (!data.files.length) {
      panel.innerHTML = "<div style='padding:8px;font-size:12px;color:var(--muted)'>(no audio files found)</div>";
      return;
    }
    panel.innerHTML = data.files.map(f =>
      `<div style="padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)" data-file="${f}">${f}</div>`
    ).join("");
    panel.querySelectorAll("[data-file]").forEach(el => {
      el.addEventListener("mouseenter", () => el.style.background = "var(--surface)");
      el.addEventListener("mouseleave", () => el.style.background = "");
      el.addEventListener("click", () => {
        document.getElementById("demucs-filename").value = el.dataset.file;
        panel.style.display = "none";
      });
    });
  } catch {
    panel.innerHTML = "<div style='padding:8px;font-size:12px;color:var(--error)'>Failed to load file list</div>";
  }
});

document.getElementById("btn-demucs-browse-local").addEventListener("click", () => {
  document.getElementById("demucs-local-file").click();
});

document.getElementById("demucs-local-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById("demucs-upload-status");
  status.textContent = "Uploading…";
  status.style.color = "var(--muted)";
  const form = new FormData();
  form.append("audio", file);
  try {
    const resp = await fetch("/stems/demucs/upload", {method: "POST", body: form});
    const data = await resp.json();
    if (data.filename) {
      document.getElementById("demucs-filename").value = data.filename;
      status.textContent = `Uploaded: ${data.filename}`;
      status.style.color = "var(--accent2)";
    } else {
      status.textContent = "Upload failed"; status.style.color = "var(--error)";
    }
  } catch {
    status.textContent = "Upload failed"; status.style.color = "var(--error)";
  }
  e.target.value = "";
});

document.getElementById("btn-demucs-run").addEventListener("click", () => {
  const filename = document.getElementById("demucs-filename").value.trim();
  const model = document.getElementById("demucs-model").value;
  const log = document.getElementById("demucs-log");
  const btn = document.getElementById("btn-demucs-run");
  if (!filename) { log.textContent = "Enter a filename."; return; }
  log.textContent = "";
  btn.textContent = "Busy Separating…";
  btn.disabled = true;
  const stemLinks = document.getElementById("demucs-stem-links");
  if (stemLinks) stemLinks.innerHTML = "";
  const params = new URLSearchParams({filename, model});
  const es = new EventSource("/stems/demucs/stream?" + params.toString());
  es.addEventListener("log", e => {
    const {line} = JSON.parse(e.data);
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener("done", async () => {
    es.close();
    log.textContent += "[done]\n";
    btn.textContent = "Separate";
    btn.disabled = false;
    try {
      const r = await fetch(`/stems/demucs/files?filename=${encodeURIComponent(filename)}&model=${encodeURIComponent(model)}`);
      const data = await r.json();
      if (stemLinks && data.stems && data.stems.length) {
        stemLinks.innerHTML = "<div style='font-size:12px;color:var(--muted);margin-bottom:6px'>Separated stems:</div>" +
          data.stems.map(s =>
            `<a href="/stems/demucs/download/${encodeURIComponent(data.model)}/${encodeURIComponent(data.track)}/${encodeURIComponent(s)}" download="${s}" style="display:inline-block;margin:3px 6px 3px 0;padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;color:var(--accent);font-size:12px;text-decoration:none">⬇ ${s}</a>`
          ).join("");
      }
    } catch(_) {}
  });
  es.onerror = () => {
    es.close();
    btn.textContent = "Separate";
    btn.disabled = false;
  };
});
