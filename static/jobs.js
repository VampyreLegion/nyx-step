// ── Generate ──────────────────────────────────────────────────────────────────
let _activeGenPromptId = null;
let _genProgressTimer = null;
let _jobPayloads = {};
const _jobFilesByPrompt = {};  // promptId → files array (for fix retake seed lookup)
const _waveInstances = {};  // filename → WaveSurfer instance

// ── Dismissed jobs (persisted across page loads) ───────────────────────────
const _LS_KEY = "nyx_dismissed_jobs";
let _dismissedJobs = new Set(JSON.parse(localStorage.getItem(_LS_KEY) || "[]"));

function _saveDismissed() {
  localStorage.setItem(_LS_KEY, JSON.stringify([..._dismissedJobs]));
}

function clearJobList() {
  const list = document.getElementById("jobs-list");
  list.querySelectorAll(".job-card").forEach(c => {
    _dismissedJobs.add(c.id.replace("job-", ""));
  });
  _saveDismissed();
  list.innerHTML = "";
  _updateJobsHistoryLink();
}

document.getElementById("btn-clear-jobs").addEventListener("click", clearJobList);

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
      const msg = resp.status === 502 ? "ComfyUI is offline or unreachable" : (text || resp.statusText);
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
    _dismissedJobs.delete(data.prompt_id);
    _saveDismissed();
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
    if (data.files && data.files.length) mwState.lastAudioFile = data.files[0];
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
  if (_dismissedJobs.has(promptId)) return;
  if (document.getElementById("job-" + promptId)) {
    updateJobCard(promptId, status, files);
    return;
  }
  const card = document.createElement("div");
  card.className = "job-card";
  card.id = "job-" + promptId;
  card.innerHTML = `
    <div style="font-weight:600;display:flex;justify-content:space-between;align-items:center">
      <span>${songName}</span>
      <button class="secondary small btn-cancel-job" data-pid="${promptId}" style="font-size:10px;padding:2px 7px;color:var(--error,#f38ba8);display:none" title="Cancel this job">✕ Cancel</button>
    </div>
    <div class="status ${status}">${statusLabel(status)}</div>
    <div class="job-progress"><div class="job-progress-bar ${status}"></div></div>
    <div class="job-files" style="margin-top:6px"></div>
  `;
  const cancelBtn = card.querySelector(".btn-cancel-job");
  if (status === "queued" || status === "running") cancelBtn.style.display = "";
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true; cancelBtn.textContent = "Cancelling…";
    const r = await fetch(`/queue/${promptId}`, {method: "DELETE"});
    if (r.ok) { updateJobCard(promptId, "error"); cancelBtn.style.display = "none"; }
    else { cancelBtn.disabled = false; cancelBtn.textContent = "✕ Cancel"; }
  });
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
  const list = document.getElementById("jobs-list");
  list.prepend(card);
  // Cap at 5 visible job cards
  const cards = list.querySelectorAll(".job-card");
  if (cards.length > 5) cards[cards.length - 1].remove();
  // Show/hide "View all in History" link
  _updateJobsHistoryLink();
}

function _updateJobsHistoryLink() {
  const list = document.getElementById("jobs-list");
  const count = list.querySelectorAll(".job-card").length;
  let link = document.getElementById("jobs-history-link");
  if (count >= 5) {
    if (!link) {
      link = document.createElement("div");
      link.id = "jobs-history-link";
      link.style.cssText = "text-align:center;margin-top:8px;font-size:12px;";
      link.innerHTML = '<a href="#" style="color:var(--muted);text-decoration:none" id="jobs-history-anchor">View all in History →</a>';
      list.after(link);
      document.getElementById("jobs-history-anchor").addEventListener("click", e => {
        e.preventDefault();
        document.querySelector('[data-tab="history"]').click();
      });
    }
    link.style.display = "";
  } else if (link) {
    link.style.display = "none";
  }
}

function updateJobCard(promptId, status, files) {
  const card = document.getElementById("job-" + promptId);
  if (!card) return;
  card.querySelector(".status").className = "status " + status;
  card.querySelector(".status").textContent = statusLabel(status);
  const bar = card.querySelector(".job-progress-bar");
  if (bar) bar.className = "job-progress-bar " + status;
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
  const cancelBtn = card.querySelector(".btn-cancel-job");
  if (cancelBtn && (status === "done" || status === "error")) cancelBtn.style.display = "none";
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
    metaBtn.textContent = "song creation file";
    metaBtn.title = "Download generation metadata (parameters, seed, caption) as JSON";
    metaBtn.style.cssText = "color:var(--muted);font-size:11px;text-decoration:none;padding:2px 6px;border:1px solid var(--border);border-radius:3px;";
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
      const cs = getComputedStyle(document.documentElement);
      const waveColor = cs.getPropertyValue("--border").trim() || "#444";
      const progressColor = cs.getPropertyValue("--accent").trim() || "#7c3aed";
      const ws = WaveSurfer.create({ /* jshint ignore:line */
        container: waveDiv,
        waveColor,
        progressColor,
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
    retakeRow.style.cssText = "margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    const retakeBtn = document.createElement("button");
    retakeBtn.className = "secondary small";
    retakeBtn.textContent = "🔁 Retake";
    retakeBtn.title = "Same prompt, new seed — generates a variation without changing structure";
    retakeBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    retakeBtn.addEventListener("click", () => retakeJob(promptId, retakeBtn));
    retakeRow.appendChild(retakeBtn);

    if (files.length > 1) {
      const zipBtn = document.createElement("button");
      zipBtn.className = "secondary small";
      zipBtn.textContent = "⬇ ZIP All";
      zipBtn.title = `Download all ${files.length} files as a ZIP archive`;
      zipBtn.style.cssText = "font-size:11px;padding:2px 8px;";
      zipBtn.addEventListener("click", async () => {
        zipBtn.disabled = true;
        zipBtn.textContent = "Zipping…";
        try {
          const r = await fetch("/download/zip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filenames: files, zip_name: `${promptId}_batch.zip` }),
          });
          if (!r.ok) { alert("ZIP failed: " + r.statusText); return; }
          const blob = await r.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${promptId}_batch.zip`;
          a.click();
        } catch (e) {
          alert("ZIP error: " + e);
        } finally {
          zipBtn.disabled = false;
          zipBtn.textContent = "⬇ ZIP All";
        }
      });
      retakeRow.appendChild(zipBtn);
    }

    // ── Quality Score button ──────────────────────────────────────────────────
    _jobFilesByPrompt[promptId] = files;
    const qBtn = document.createElement("button");
    qBtn.className = "secondary small";
    qBtn.textContent = "📊 Score";
    qBtn.title = "Analyse audio quality: loudness, dynamics, spectral balance, clipping, coherence";
    qBtn.style.cssText = "font-size:11px;padding:2px 8px;";
    qBtn.addEventListener("click", async () => {
      qBtn.disabled = true; qBtn.textContent = "…";
      const scoreEl = container.querySelector(".quality-score-result") || (() => {
        const d = document.createElement("div");
        d.className = "quality-score-result";
        d.style.cssText = "margin-top:4px;font-size:11px;color:var(--muted)";
        container.appendChild(d);
        return d;
      })();
      try {
        const r = await fetch("/quality/" + encodeURIComponent(files[0]));
        const d = await r.json();
        if (d.error) { scoreEl.textContent = "Score error: " + d.error; return; }
        const dims = Object.entries(d.scores).map(([k, v]) => `${k} ${v}`).join(" · ");
        let html = `<strong>Quality ${d.grade} (${d.composite}/10)</strong> — ${dims}`;
        if (d.suggestions?.length) {
          const allTags = [...new Set(d.suggestions.flatMap(f => f.add_tags || []))];
          html += d.suggestions.map(f =>
            `<div style="margin-top:3px">💡 ${f.text}` +
            (f.add_tags?.length ? ` — add <i style="color:var(--accent2)">${f.add_tags.join(", ")}</i>` : "") +
            (f.param_hint ? `<br><span style="color:var(--muted)">${f.param_hint}</span>` : "") +
            `</div>`).join("");
          if (allTags.length) {
            html += `<button class="secondary small" style="margin-top:4px;font-size:11px;padding:2px 8px"
                      onclick="applyFixAndRetake('${promptId}', ${JSON.stringify(allTags).replace(/"/g, "&quot;")}, this)">✨ Apply &amp; Retake</button>`;
          }
        }
        scoreEl.innerHTML = html;
      } catch(e) { scoreEl.textContent = "Score error: " + e.message; }
      finally { qBtn.disabled = false; qBtn.textContent = "📊 Score"; }
    });
    retakeRow.appendChild(qBtn);

    // ── A/B compare buttons ──────────────────────────────────────────────────
    ["A", "B"].forEach(slot => {
      const abBtn = document.createElement("button");
      abBtn.className = "secondary small";
      abBtn.textContent = slot === "A" ? "🅰" : "🅱";
      abBtn.title = `Set this take as side ${slot} in the A/B comparator`;
      abBtn.style.cssText = "font-size:11px;padding:2px 8px;";
      abBtn.addEventListener("click", async () => {
        let seed = _jobPayloads[promptId]?.seed ?? "?";
        let tags = _jobPayloads[promptId]?.tags ?? "";
        let name = _jobPayloads[promptId]?.song_name || "";
        try {
          const meta = await fetch("/meta/" + encodeURIComponent(files[0])).then(r => r.json());
          if (meta.seed !== undefined) seed = meta.seed;
          if (!tags && meta.caption) tags = meta.caption;
          if (!name && meta.song_name) name = meta.song_name;
        } catch (_) {}
        setCompareSlot(slot, promptId, files[0], name || "Untitled", seed, tags);
      });
      retakeRow.appendChild(abBtn);
    });

    // ── LRC Lyrics button (only if job had lyrics) ────────────────────────────
    const payload = _jobPayloads[promptId];
    const lyricsText = payload?.lyrics || "";
    if (lyricsText.trim()) {
      const lrcBtn = document.createElement("button");
      lrcBtn.className = "secondary small";
      lrcBtn.textContent = "🎵 LRC";
      lrcBtn.title = "Generate time-synchronized LRC file from the lyrics used in this generation";
      lrcBtn.style.cssText = "font-size:11px;padding:2px 8px;";
      lrcBtn.addEventListener("click", async () => {
        lrcBtn.disabled = true; lrcBtn.textContent = "Generating…";
        try {
          const r = await fetch("/lrc/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: files[0], lyrics: lyricsText, bpm: mwState.bpm || 120, save: true }),
          });
          const d = await r.json();
          if (d.error) { alert("LRC error: " + d.error); return; }
          const blob = new Blob([d.lrc], { type: "text/plain" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = d.filename;
          a.click();
        } catch(e) { alert("LRC error: " + e.message); }
        finally { lrcBtn.disabled = false; lrcBtn.textContent = "🎵 LRC"; }
      });
      retakeRow.appendChild(lrcBtn);
    }

    container.appendChild(retakeRow);
  }
}

// Resolve a job's generation payload. Uses the in-session cache when present,
// otherwise reconstructs it from /meta so jobs restored after a page reload
// can still be retaken. Returns null only when neither source has the data.
async function _resolveRetakePayload(promptId) {
  if (_jobPayloads[promptId]) return _jobPayloads[promptId];
  const files = _jobFilesByPrompt[promptId];
  if (!files || !files.length) return null;
  try {
    const meta = await fetch("/meta/" + encodeURIComponent(files[0])).then(r => r.json());
    if (!meta || meta.error || !meta.params) return null;
    const payload = {
      ...meta.params,
      tags: meta.caption || "",
      lyrics: meta.lyrics || "",
      seed: meta.seed ?? 0,          // actual seed used, not the requested 0
      song_name: meta.song_name || "Untitled",
    };
    _jobPayloads[promptId] = payload; // cache so further actions are instant
    return payload;
  } catch (_) {
    return null;
  }
}

async function retakeJob(promptId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "🔁 Retaking…"; }
  try {
    const payload = await _resolveRetakePayload(promptId);
    if (!payload) {
      alert("Could not load this job's parameters — its source file may be missing.");
      return;
    }
    const retakePayload = {
      ...payload,
      lock_seed: false,
      seed: 0,
      song_name: "Retake of " + (payload.song_name || "Untitled"),
    };
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

async function applyFixAndRetake(promptId, addTags, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "✨ Retaking…"; }
  try {
    const payload = await _resolveRetakePayload(promptId);
    if (!payload) { alert("Could not load this job's parameters — its source file may be missing."); return; }
    // Same seed isolates the tag change. _resolveRetakePayload already carries
    // the actual seed for restored jobs; for in-session jobs the cached payload
    // holds the requested seed (often 0), so confirm the real one from /meta.
    let seed = payload.seed || 0;
    try {
      const files = _jobFilesByPrompt[promptId];
      if (files?.length) {
        const meta = await fetch("/meta/" + encodeURIComponent(files[0])).then(r => r.json());
        if (meta.seed) seed = meta.seed;
      }
    } catch (_) {}
    const existing = payload.tags.split(",").map(t => t.trim().toLowerCase());
    const newTags = addTags.filter(t => !existing.includes(t.toLowerCase()));
    const merged = newTags.length
      ? payload.tags.trim() + ", " + newTags.join(", ")
      : payload.tags.trim();
    const resp = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        ...payload, tags: merged, seed, lock_seed: true,
        song_name: "Fix of " + (payload.song_name || "Untitled"),
      }),
    });
    if (!resp.ok) { alert("Retake error: HTTP " + resp.status); return; }
    const data = await resp.json();
    if (data.error) { alert("Retake error: " + data.error); return; }
    _jobPayloads[data.prompt_id] = {...payload, tags: merged, seed, lock_seed: true};
    addJobCard(data.prompt_id, "Fix of " + (payload.song_name || "Untitled"), "queued", []);
    showToast("Fix retake queued with same seed", "success");
  } catch (e) { alert("Retake error: " + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "✨ Apply & Retake"; } }
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
