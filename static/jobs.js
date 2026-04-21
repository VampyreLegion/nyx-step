// ── Generate ──────────────────────────────────────────────────────────────────
let _activeGenPromptId = null;
let _genProgressTimer = null;

function setGenProgress(state, label) {
  const wrap = document.getElementById("gen-progress-wrap");
  const bar = document.getElementById("gen-progress-bar");
  const lbl = document.getElementById("gen-progress-label");
  clearTimeout(_genProgressTimer);
  wrap.style.display = "block";
  bar.className = "job-progress-bar " + state;
  lbl.textContent = label;
  if (state === "done" || state === "error") {
    _genProgressTimer = setTimeout(() => { wrap.style.display = "none"; }, 5000);
  }
}

document.getElementById("btn-generate").addEventListener("click", async () => {
  const btn = document.getElementById("btn-generate");
  const songName = document.getElementById("song-name").value.trim() || "Untitled";
  const status = document.getElementById("generate-status");

  btn.disabled = true;
  btn.textContent = "🎵 Submitting…";
  setGenProgress("queued", "Submitting to ComfyUI…");
  status.textContent = "";

  const payload = {
    ...mwState,
    tags: document.getElementById("overview-tags").value.trim(),
    lyrics: document.getElementById("overview-lyrics").value,
    song_name: songName,
  };

  try {
    const resp = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {
      const text = await resp.text().catch(() => resp.statusText);
      const msg = resp.status === 502 ? "ComfyUI is offline or unreachable" : (text.slice(0, 120) || resp.statusText);
      status.textContent = "Error: " + msg;
      status.style.color = "var(--error)";
      setGenProgress("error", "Error: " + msg);
      btn.disabled = false; btn.textContent = "🎵 Generate Music Idea";
      return;
    }
    if (!resp.ok) {
      const msg = data.error || resp.statusText;
      status.textContent = "Error: " + msg;
      status.style.color = "var(--error)";
      setGenProgress("error", "Error: " + msg);
      btn.disabled = false; btn.textContent = "🎵 Generate Music Idea";
      return;
    }
    _activeGenPromptId = data.prompt_id;
    addJobCard(data.prompt_id, songName, "queued", []);
    status.textContent = `Queued — ${data.prompt_id}`;
    status.style.color = "var(--muted)";
    setGenProgress("queued", "Queued — waiting for ComfyUI to start…");
    btn.disabled = false; btn.textContent = "🎵 Generate Music Idea";
  } catch (e) {
    const msg = e.message.includes("JSON") ? "ComfyUI is offline or unreachable" : e.message;
    status.textContent = "Error: " + msg;
    status.style.color = "var(--error)";
    setGenProgress("error", "Error: " + msg);
    btn.disabled = false; btn.textContent = "🎵 Generate Music Idea";
  }
});

// ── SSE — job status ──────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource("/events");
  es.addEventListener("job_done", e => {
    const data = JSON.parse(e.data);
    addJobCard(data.prompt_id, data.song_name || "Song", "done", data.files);
    if (data.prompt_id === _activeGenPromptId) setGenProgress("done", "✓ Done — audio ready");
  });
  es.addEventListener("job_running", e => {
    const data = JSON.parse(e.data);
    addJobCard(data.prompt_id, data.song_name || "Song", "running", []);
    if (data.prompt_id === _activeGenPromptId) setGenProgress("running", "Generating audio…");
  });
  es.addEventListener("job_error", e => {
    const data = JSON.parse(e.data);
    updateJobCard(data.prompt_id, "error");
    if (data.prompt_id === _activeGenPromptId) setGenProgress("error", "Generation failed");
  });
  es.addEventListener("queue_update", e => {
    const data = JSON.parse(e.data);
    document.getElementById("queue-badge").textContent =
      `Queue: ${data.running} running, ${data.pending} pending`;
  });
  es.onerror = () => { setTimeout(connectSSE, 3000); es.close(); };
}

// ── Job cards ─────────────────────────────────────────────────────────────────
function addJobCard(promptId, songName, status, files) {
  if (document.getElementById("job-" + promptId)) {
    updateJobCard(promptId, status, files);
    return;
  }
  const card = document.createElement("div");
  card.className = "job-card";
  card.id = "job-" + promptId;
  card.innerHTML = `
    <div style="font-weight:600">${songName}</div>
    <div class="status ${status}">${statusLabel(status)}</div>
    <div class="job-progress"><div class="job-progress-bar ${status}"></div></div>
    <div class="job-files" style="margin-top:6px"></div>
  `;
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
  document.getElementById("jobs-list").prepend(card);
}

function updateJobCard(promptId, status, files) {
  const card = document.getElementById("job-" + promptId);
  if (!card) return;
  card.querySelector(".status").className = "status " + status;
  card.querySelector(".status").textContent = statusLabel(status);
  const bar = card.querySelector(".job-progress-bar");
  if (bar) bar.className = "job-progress-bar " + status;
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
}

function addDownloadLinks(container, files) {
  container.innerHTML = "";
  const bust = "?t=" + Date.now();
  files.forEach(f => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;";
    const a = document.createElement("a");
    a.href = "/download/" + encodeURIComponent(f) + bust;
    a.download = f;
    a.textContent = "⬇ " + f;
    a.style.cssText = "color:var(--accent2);font-size:12px;flex:1;";
    const remixBtn = document.createElement("button");
    remixBtn.className = "secondary small";
    remixBtn.textContent = "🔀 Remix";
    remixBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    remixBtn.addEventListener("click", () => toggleRemixPanel(container.closest(".job-card"), f));
    row.appendChild(a);
    row.appendChild(remixBtn);
    container.appendChild(row);
  });
}

function toggleRemixPanel(card, sourceFile) {
  let panel = card.querySelector(".remix-panel");
  if (panel) { panel.remove(); return; }

  panel = document.createElement("div");
  panel.className = "remix-panel";
  panel.style.cssText = "margin-top:10px;padding:10px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);font-size:12px;";
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;color:var(--accent)">🔀 Remix: ${sourceFile}</div>
    <div style="display:flex;gap:12px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
      <label style="font-weight:normal;cursor:pointer">
        <input type="radio" name="remix-mode-${sourceFile}" value="variation" checked> Variation
      </label>
      <label style="font-weight:normal;cursor:pointer">
        <input type="radio" name="remix-mode-${sourceFile}" value="extend"> Extend
      </label>
      <span style="color:var(--muted);font-size:11px" id="remix-mode-hint-${CSS.escape(sourceFile)}">Re-imagine the full clip</span>
    </div>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <label style="font-weight:normal">Closeness to original:
        <input type="range" class="remix-denoise" min="0.05" max="0.95" step="0.05" value="0.5" style="width:120px;vertical-align:middle">
        <span class="remix-denoise-val">0.50</span>
      </label>
      <label class="remix-seed-wrap" style="font-weight:normal;display:none">Seed seconds:
        <input type="number" class="remix-seed-secs" min="3" max="60" value="10" style="width:60px">
      </label>
    </div>
    <div style="margin-bottom:8px">
      <input type="text" class="remix-name" placeholder="Remix name" value="Remix of ${sourceFile.replace('.mp3','')}" style="width:100%">
    </div>
    <button class="secondary small remix-submit">✨ Generate Remix</button>
    <span class="remix-status" style="margin-left:8px;color:var(--muted)"></span>
  `;

  const modeInputs = panel.querySelectorAll(`input[name="remix-mode-${sourceFile}"]`);
  const hintEl = panel.querySelector(`#remix-mode-hint-${CSS.escape(sourceFile)}`);
  const seedWrap = panel.querySelector(".remix-seed-wrap");
  const denoiseEl = panel.querySelector(".remix-denoise");
  const denoiseVal = panel.querySelector(".remix-denoise-val");

  modeInputs.forEach(r => r.addEventListener("change", () => {
    const isExtend = panel.querySelector(`input[name="remix-mode-${sourceFile}"]:checked`).value === "extend";
    seedWrap.style.display = isExtend ? "" : "none";
    hintEl.textContent = isExtend ? "Condition on last N seconds, generate continuation" : "Re-imagine the full clip";
  }));
  denoiseEl.addEventListener("input", () => { denoiseVal.textContent = parseFloat(denoiseEl.value).toFixed(2); });

  panel.querySelector(".remix-submit").addEventListener("click", async () => {
    const btn = panel.querySelector(".remix-submit");
    const statusEl = panel.querySelector(".remix-status");
    const mode = panel.querySelector(`input[name="remix-mode-${sourceFile}"]:checked`).value;
    btn.disabled = true; btn.textContent = "Submitting…";
    statusEl.textContent = "";

    const payload = {
      ...mwState,
      tags: document.getElementById("overview-tags").value.trim(),
      lyrics: document.getElementById("overview-lyrics").value,
      source_file: sourceFile,
      mode,
      denoise: parseFloat(denoiseEl.value),
      seed_seconds: parseFloat(panel.querySelector(".remix-seed-secs").value),
      song_name: panel.querySelector(".remix-name").value.trim() || "Remix",
      mode_scale: mwState.mode || "",
    };

    try {
      const resp = await fetch("/remix", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        statusEl.textContent = "Error: " + (data.error || resp.statusText);
        btn.disabled = false; btn.textContent = "✨ Generate Remix";
        return;
      }
      addJobCard(data.prompt_id, payload.song_name, "queued", []);
      statusEl.textContent = "Queued ✓";
      btn.textContent = "✨ Generate Remix";
      btn.disabled = false;
    } catch(e) {
      statusEl.textContent = "Error: " + e.message;
      btn.disabled = false; btn.textContent = "✨ Generate Remix";
    }
  });

  card.appendChild(panel);
}
