// ── Generate ──────────────────────────────────────────────────────────────────
let _activeGenPromptId = null;
let _genProgressTimer = null;
let _jobPayloads = {};
const _waveInstances = {};  // filename → WaveSurfer instance

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
    _jobPayloads[data.prompt_id] = {...payload};
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
    a.title = "Download " + f;
    a.style.cssText = "color:var(--accent2);font-size:12px;flex:1;";
    const remixBtn = document.createElement("button");
    remixBtn.className = "secondary small";
    remixBtn.textContent = "🔀 Remix";
    remixBtn.title = "Create a variation, extension, or repaint of this clip";
    remixBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    remixBtn.addEventListener("click", () => toggleRemixPanel(container.closest(".job-card"), f));
    const metaBtn = document.createElement("a");
    metaBtn.href = "/meta/" + encodeURIComponent(f);
    metaBtn.download = f.replace(/\.[^.]+$/, "") + "_meta.json";
    metaBtn.textContent = "{}";
    metaBtn.title = "Download generation metadata (parameters, seed, caption) as JSON";
    metaBtn.style.cssText = "color:var(--muted);font-size:11px;font-family:monospace;text-decoration:none;padding:2px 4px;border:1px solid var(--border);border-radius:3px;";
    row.appendChild(a);
    row.appendChild(metaBtn);
    row.appendChild(remixBtn);
    container.appendChild(row);

    // Waveform player
    const waveWrap = document.createElement("div");
    waveWrap.style.cssText = "margin-top:6px;";
    const waveDiv = document.createElement("div");
    waveDiv.style.cssText = "width:100%;border-radius:4px;overflow:hidden;cursor:pointer;";
    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;";
    const playBtn = document.createElement("button");
    playBtn.className = "secondary small";
    playBtn.textContent = "▶";
    playBtn.title = "Play / Pause";
    playBtn.style.cssText = "font-size:13px;padding:2px 10px;min-width:36px;";
    const timeEl = document.createElement("span");
    timeEl.style.cssText = "font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;";
    timeEl.textContent = "0:00 / 0:00";
    controls.appendChild(playBtn);
    controls.appendChild(timeEl);
    waveWrap.appendChild(waveDiv);
    waveWrap.appendChild(controls);
    container.appendChild(waveWrap);
    const audioSrc = "/download/" + encodeURIComponent(f) + bust;
    if (typeof WaveSurfer !== "undefined") {
      const ws = WaveSurfer.create({ /* jshint ignore:line */
        container: waveDiv,
        waveColor: "var(--border)",
        progressColor: "var(--accent)",
        height: 40,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        url: audioSrc,
        interact: true,
      });
      _waveInstances[f] = ws;
      const fmt = s => {
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2,"0")}`;
      };
      ws.on("ready", () => { timeEl.textContent = `0:00 / ${fmt(ws.getDuration())}`; });
      ws.on("timeupdate", t => { timeEl.textContent = `${fmt(t)} / ${fmt(ws.getDuration())}`; });
      ws.on("play", () => { playBtn.textContent = "⏸"; });
      ws.on("pause", () => { playBtn.textContent = "▶"; });
      ws.on("finish", () => { playBtn.textContent = "▶"; });
      playBtn.addEventListener("click", () => ws.playPause());
    } else {
      const audioEl = document.createElement("audio");
      audioEl.controls = true;
      audioEl.src = audioSrc;
      audioEl.style.cssText = "width:100%;height:36px;";
      waveWrap.replaceWith(audioEl);
    }
  });

  if (files.length) {
    const promptId = container.closest(".job-card").id.replace("job-", "");
    const retakeRow = document.createElement("div");
    retakeRow.style.cssText = "margin-top:6px;";
    const retakeBtn = document.createElement("button");
    retakeBtn.className = "secondary small";
    retakeBtn.textContent = "🔁 Retake";
    retakeBtn.title = "Same prompt, new seed — generates a variation without changing structure";
    retakeBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    retakeBtn.addEventListener("click", () => retakeJob(promptId, retakeBtn));
    retakeRow.appendChild(retakeBtn);
    container.appendChild(retakeRow);
  }
}

async function retakeJob(promptId, btn) {
  const payload = _jobPayloads[promptId];
  if (!payload) {
    alert("No stored parameters for this job — only jobs generated in this session can be retaken.");
    return;
  }
  const retakePayload = {
    ...payload,
    lock_seed: false,
    seed: 0,
    song_name: "Retake of " + (payload.song_name || "Untitled"),
  };
  if (btn) { btn.disabled = true; btn.textContent = "🔁 Retaking…"; }
  try {
    const resp = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(retakePayload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert("Retake error: " + (data.error || resp.statusText));
    } else {
      _jobPayloads[data.prompt_id] = retakePayload;
      addJobCard(data.prompt_id, retakePayload.song_name, "queued", []);
    }
  } catch(e) {
    alert("Retake error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔁 Retake"; }
  }
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
        <input type="radio" name="remix-mode-${sourceFile}" value="variation" checked title="Re-imagine the full clip with a new seed and interpretation"> Variation
      </label>
      <label style="font-weight:normal;cursor:pointer">
        <input type="radio" name="remix-mode-${sourceFile}" value="extend" title="Condition on the last N seconds of the clip and generate a continuation"> Extend
      </label>
      <label style="font-weight:normal;cursor:pointer">
        <input type="radio" name="remix-mode-${sourceFile}" value="repaint" title="Regenerate a specific time window; audio outside the window stays intact"> Repaint
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
    <div class="remix-repaint-wrap" style="display:none;margin-bottom:8px;background:var(--surface3,#2a2a2a);padding:8px;border-radius:4px">
      <div style="color:var(--muted);font-size:11px;margin-bottom:6px">Drag handles to set the region to regenerate:</div>
      <canvas class="remix-timeline" width="400" height="36" style="width:100%;height:36px;border-radius:4px;cursor:crosshair;display:block;"></canvas>
      <div style="display:flex;gap:12px;align-items:center;margin-top:6px;flex-wrap:wrap">
        <label style="font-weight:normal;font-size:11px">Start (s):
          <input type="number" class="remix-repaint-start" min="0" step="0.5" value="5" style="width:65px">
        </label>
        <label style="font-weight:normal;font-size:11px">End (s):
          <input type="number" class="remix-repaint-end" min="0" step="0.5" value="15" style="width:65px">
        </label>
        <span class="remix-timeline-label" style="font-size:11px;color:var(--muted)"></span>
      </div>
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
  const repaintWrap = panel.querySelector(".remix-repaint-wrap");
  const denoiseEl = panel.querySelector(".remix-denoise");
  const denoiseVal = panel.querySelector(".remix-denoise-val");
  denoiseEl.title = "How closely to follow the original (lower = more creative, higher = more similar)";
  panel.querySelector(".remix-seed-secs").title = "How many seconds from the end of the clip to use as the seed for the continuation";
  panel.querySelector(".remix-repaint-start").title = "Start time in seconds of the region to regenerate";
  panel.querySelector(".remix-repaint-end").title = "End time in seconds of the region to regenerate";
  panel.querySelector(".remix-submit").title = "Submit this remix job to ComfyUI";

  const _hints = {
    variation: "Re-imagine the full clip",
    extend: "Condition on last N seconds, generate continuation",
    repaint: "Regenerate a time window; surrounding audio stays intact",
  };
  modeInputs.forEach(r => r.addEventListener("change", () => {
    const mode = panel.querySelector(`input[name="remix-mode-${sourceFile}"]:checked`).value;
    seedWrap.style.display = mode === "extend" ? "" : "none";
    repaintWrap.style.display = mode === "repaint" ? "block" : "none";
    hintEl.textContent = _hints[mode] || "";
    if (mode === "repaint") {
      // sync canvas px width to display width for sharp rendering
      requestAnimationFrame(() => {
        canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
        canvas.height = 36 * (window.devicePixelRatio || 1);
        canvas.style.height = "36px";
        _drawTimeline();
      });
    }
  }));
  denoiseEl.addEventListener("input", () => { denoiseVal.textContent = parseFloat(denoiseEl.value).toFixed(2); });

  // ── Repaint timeline canvas ─────────────────────────────────────────────────
  const canvas = panel.querySelector(".remix-timeline");
  const startInput = panel.querySelector(".remix-repaint-start");
  const endInput   = panel.querySelector(".remix-repaint-end");
  const tlLabel    = panel.querySelector(".remix-timeline-label");
  let _tlDuration  = 60;  // default; updated from WaveSurfer when available
  if (_waveInstances[sourceFile]) {
    const dur = _waveInstances[sourceFile].getDuration();
    if (dur > 0) _tlDuration = dur;
  }

  function _drawTimeline() {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const s = parseFloat(startInput.value) || 0;
    const e = parseFloat(endInput.value)   || 10;
    const sx = (s / _tlDuration) * W;
    const ex = (e / _tlDuration) * W;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(100,180,255,0.18)";
    ctx.fillRect(sx, 0, ex - sx, H);
    // handles
    [[sx, s], [ex, e]].forEach(([x, t]) => {
      ctx.fillStyle = "#5af";
      ctx.fillRect(x - 2, 0, 4, H);
      ctx.fillStyle = "#fff";
      ctx.font = "10px monospace";
      ctx.fillText(t.toFixed(1) + "s", Math.max(2, x - 14), H - 4);
    });
    tlLabel.textContent = `Region: ${s.toFixed(1)}s – ${e.toFixed(1)}s (${(e - s).toFixed(1)}s)`;
  }
  _drawTimeline();

  // Sync number inputs → canvas
  [startInput, endInput].forEach(inp => inp.addEventListener("input", _drawTimeline));

  // Mouse drag on canvas → update inputs
  let _dragHandle = null;  // "start" | "end"
  canvas.addEventListener("mousedown", ev => {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;
    const t = px * _tlDuration;
    const s = parseFloat(startInput.value) || 0;
    const e = parseFloat(endInput.value)   || 10;
    _dragHandle = Math.abs(t - s) < Math.abs(t - e) ? "start" : "end";
  });
  window.addEventListener("mousemove", ev => {
    if (!_dragHandle) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const t = Math.round(px * _tlDuration * 2) / 2;
    const s = parseFloat(startInput.value) || 0;
    const e = parseFloat(endInput.value)   || 10;
    if (_dragHandle === "start") { startInput.value = Math.min(t, e - 0.5).toFixed(1); }
    else                         { endInput.value   = Math.max(t, s + 0.5).toFixed(1); }
    _drawTimeline();
  });
  window.addEventListener("mouseup", () => { _dragHandle = null; });

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
      repaint_start: parseFloat(panel.querySelector(".remix-repaint-start").value) || 0,
      repaint_end: parseFloat(panel.querySelector(".remix-repaint-end").value) || 10,
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
