// ── State ─────────────────────────────────────────────────────────────────────
const mwState = {
  genre: "", bpm: 120, key: "C", scale: "Major", mode: "",
  time_sig: "4/4", instruments: [], vocal_tags: [], lyrics: "",
  steps: 8, cfg_scale: 2.0, duration: 30.0, seed: 0, lock_seed: false,
  temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
};

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "overview") updatePreviews();
    if (btn.dataset.tab === "lint") updateLintStatePreview();
  });
});

document.querySelectorAll(".inner-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const parent = btn.closest(".tab-panel") || btn.parentElement.parentElement;
    parent.querySelectorAll(".inner-tab-btn").forEach(b => b.classList.remove("active"));
    const targetId = btn.dataset.inner || btn.dataset.guide;
    parent.querySelectorAll(".inner-panel").forEach(p => p.classList.remove("active"));
    if (btn.dataset.inner) {
      const panel = document.getElementById(btn.dataset.inner);
      if (panel) panel.classList.add("active");
    }
    if (btn.dataset.guide) loadGuideSection(btn.dataset.guide, btn);
    btn.classList.add("active");
  });
});

// ── Style tab ─────────────────────────────────────────────────────────────────
const bind = (id, key, transform) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    mwState[key] = transform ? transform(el.value) : el.value;
    updatePreviews();
  });
};

bind("style-genre", "genre");
bind("style-bpm", "bpm", v => parseInt(v) || 120);
bind("style-key", "key");
bind("style-scale", "scale");
bind("style-mode", "mode");
bind("style-timesig", "time_sig");
bind("param-steps", "steps", v => parseInt(v) || 8);
bind("param-cfg", "cfg_scale", v => parseFloat(v) || 2.0);
bind("param-duration", "duration", v => parseFloat(v) || 30);
bind("param-temp", "temperature", v => parseFloat(v) || 0.85);
bind("param-topp", "top_p", v => parseFloat(v) || 0.9);
bind("param-topk", "top_k", v => parseInt(v) || 0);
bind("param-minp", "min_p", v => parseFloat(v) || 0.0);
bind("param-seed", "seed", v => parseInt(v) || 0);
document.getElementById("param-lock-seed").addEventListener("change", e => {
  mwState.lock_seed = e.target.checked;
});

// ── Lyrics tab ────────────────────────────────────────────────────────────────
document.getElementById("lyrics-editor").addEventListener("input", e => {
  mwState.lyrics = e.target.value;
  updatePreviews();
});

document.querySelectorAll(".tag-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const editor = document.getElementById("lyrics-editor");
    const tag = btn.dataset.tag;
    const pos = editor.selectionStart;
    const before = editor.value.substring(0, pos);
    const after = editor.value.substring(pos);
    editor.value = before + "\n" + tag + "\n" + after;
    editor.selectionStart = editor.selectionEnd = pos + tag.length + 2;
    editor.focus();
    mwState.lyrics = editor.value;
    updatePreviews();
  });
});

// Templates
const TEMPLATES = {
  "Verse-Chorus": "[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n",
  "Verse-Chorus-Bridge": "[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n",
  "Intro-Verse-Chorus-Outro": "[Intro: Atmospheric]\n\n[Verse]\n\n[Chorus: Anthemic]\n\n[Verse]\n\n[Chorus: Anthemic]\n\n[Outro]\n",
  "EDM Structure": "[Intro: Atmospheric]\n\n[Build]\n\n[Drop]\n\n[Breakdown]\n\n[Build]\n\n[Drop]\n\n[Outro]\n",
  "Minimal": "[Verse]\n\n[Chorus]\n",
};
const tplSel = document.getElementById("lyrics-template");
Object.keys(TEMPLATES).forEach(k => {
  const opt = document.createElement("option");
  opt.value = k; opt.textContent = k;
  tplSel.appendChild(opt);
});
tplSel.addEventListener("change", () => {
  if (!tplSel.value) return;
  const editor = document.getElementById("lyrics-editor");
  editor.value = TEMPLATES[tplSel.value] || "";
  mwState.lyrics = editor.value;
  updatePreviews();
});

// ── Instruments tab ───────────────────────────────────────────────────────────
fetch("/api/instruments").then(r => r.json()).then(data => {
  const container = document.getElementById("instrument-chips");
  data.categories.forEach(cat => {
    const title = document.createElement("div");
    title.className = "section-title";
    title.style.marginTop = "10px";
    title.textContent = cat.name;
    container.appendChild(title);
    const row = document.createElement("div");
    cat.subcategories.forEach(sub => {
      sub.items.forEach(item => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = item;
        chip.addEventListener("click", () => {
          chip.classList.toggle("active");
          if (chip.classList.contains("active")) {
            mwState.instruments.push(item);
          } else {
            mwState.instruments = mwState.instruments.filter(i => i !== item);
          }
          document.getElementById("instrument-selected").textContent =
            mwState.instruments.join(", ") || "(none)";
          updatePreviews();
        });
        row.appendChild(chip);
      });
    });
    container.appendChild(row);
  });
}).catch(() => {
  document.getElementById("instrument-chips").textContent = "Failed to load instruments";
});

// ── Vocals tab ────────────────────────────────────────────────────────────────
fetch("/api/vocals").then(r => r.json()).then(data => {
  const container = document.getElementById("vocal-chips");
  Object.entries(data).forEach(([group, keywords]) => {
    const title = document.createElement("div");
    title.className = "section-title";
    title.style.marginTop = "10px";
    title.textContent = group;
    container.appendChild(title);
    const row = document.createElement("div");
    keywords.forEach(kw => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = kw;
      chip.addEventListener("click", () => {
        chip.classList.toggle("active");
        if (chip.classList.contains("active")) {
          mwState.vocal_tags.push(kw);
        } else {
          mwState.vocal_tags = mwState.vocal_tags.filter(v => v !== kw);
        }
        document.getElementById("vocal-selected").textContent =
          mwState.vocal_tags.join(", ") || "(none)";
        updatePreviews();
      });
      row.appendChild(chip);
    });
    container.appendChild(row);
  });
}).catch(() => {
  document.getElementById("vocal-chips").textContent = "Failed to load vocals";
});

// ── Preview update ────────────────────────────────────────────────────────────
function buildCaption() {
  const parts = [];
  const s = mwState;
  if (s.genre) parts.push(s.genre.toLowerCase());
  if (s.bpm && (s.genre || s.bpm !== 120)) parts.push(s.bpm + " BPM");
  if (s.key && (s.genre || s.key !== "C" || s.scale !== "Major"))
    parts.push(s.scale ? s.key + " " + s.scale : s.key);
  if (s.mode) parts.push(s.mode + " mode");
  if (s.time_sig && (s.genre || s.time_sig !== "4/4")) parts.push(s.time_sig + " time");
  parts.push(...s.instruments);
  parts.push(...s.vocal_tags);
  return parts.join(", ");
}

function updatePreviews() {
  const cap = buildCaption();
  document.getElementById("preview-tags").textContent = cap || "(empty)";
  document.getElementById("preview-lyrics").textContent = mwState.lyrics || "(empty)";
}

function updateLintStatePreview() {
  const cap = buildCaption();
  document.getElementById("lint-state-preview").textContent =
    `[Tags]\n${cap}\n\n[Lyrics]\n${mwState.lyrics || "(empty)"}`;
}

// ── Generate ──────────────────────────────────────────────────────────────────
document.getElementById("btn-generate").addEventListener("click", async () => {
  const songName = document.getElementById("song-name").value.trim() || "Untitled";
  const status = document.getElementById("generate-status");
  status.textContent = "Submitting\u2026";
  status.style.color = "var(--warning)";

  const payload = {
    ...mwState,
    tags: buildCaption(),
    song_name: songName,
  };

  try {
    const resp = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      status.textContent = "Error: " + (data.error || resp.statusText);
      status.style.color = "var(--error)";
      return;
    }
    status.textContent = `Queued \u2014 prompt_id: ${data.prompt_id}`;
    status.style.color = "var(--success)";
  } catch (e) {
    status.textContent = "Network error: " + e.message;
    status.style.color = "var(--error)";
  }
});

// ── SSE — job status ──────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource("/events");

  es.addEventListener("job_done", e => {
    const data = JSON.parse(e.data);
    addJobCard(data.prompt_id, data.song_name || "Song", "done", data.files);
  });
  es.addEventListener("job_running", e => {
    const data = JSON.parse(e.data);
    updateJobCard(data.prompt_id, "running");
  });
  es.addEventListener("job_error", e => {
    const data = JSON.parse(e.data);
    updateJobCard(data.prompt_id, "error");
  });
  es.addEventListener("queue_update", e => {
    const data = JSON.parse(e.data);
    document.getElementById("queue-badge").textContent =
      `Queue: ${data.running} running, ${data.pending} pending`;
  });

  es.onerror = () => { setTimeout(connectSSE, 3000); es.close(); };
}
connectSSE();

// Initial queue load
fetch("/queue").then(r => r.json()).then(data => {
  data.my_jobs.forEach(j => addJobCard(j.prompt_id, j.song_name, j.status, j.output_files));
  const c = data.comfyui;
  document.getElementById("queue-badge").textContent =
    `Queue: ${c.running} running, ${c.pending} pending`;
});

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
  if (files && files.length) addDownloadLinks(card.querySelector(".job-files"), files);
}

function addDownloadLinks(container, files) {
  container.innerHTML = "";
  files.forEach(f => {
    const a = document.createElement("a");
    a.href = "/download/" + encodeURIComponent(f);
    a.download = f;
    a.textContent = "\u2b07 " + f;
    a.style.cssText = "display:block;color:var(--accent2);font-size:12px;margin-top:4px;";
    container.appendChild(a);
  });
}

function statusLabel(s) {
  return {queued: "\u23f3 Queued", running: "\u2699 Running\u2026", done: "\u2705 Done", error: "\u274c Error"}[s] || s;
}

// ── Easy tab — Ollama ─────────────────────────────────────────────────────────
fetch("/ollama/models").then(r => r.json()).then(data => {
  const sel = document.getElementById("easy-model");
  sel.innerHTML = "";
  data.models.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
});

document.getElementById("btn-easy-gen").addEventListener("click", () => {
  const log = document.getElementById("easy-log");
  log.style.display = "block";
  log.textContent = "";
  const editor = document.getElementById("lyrics-editor");
  editor.value = "";
  mwState.lyrics = "";

  const params = new URLSearchParams({
    topic: document.getElementById("easy-topic").value,
    genre: mwState.genre || "electronic",
    key: mwState.key,
    mood: document.getElementById("easy-mood").value,
    structure: document.getElementById("easy-structure").value,
    subject: document.getElementById("easy-subject").value,
    name_override: document.getElementById("easy-name-override").value,
    model: document.getElementById("easy-model").value,
  });

  const es = new EventSource("/ollama/stream?" + params.toString());
  es.addEventListener("token", e => {
    const {token} = JSON.parse(e.data);
    editor.value += token;
    mwState.lyrics = editor.value;
    log.textContent += token;
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener("done", () => {
    es.close();
    log.textContent += "\n[done]";
    updatePreviews();
  });
  es.onerror = () => { es.close(); log.textContent += "\n[error]"; };
});

// ── Guide tab ─────────────────────────────────────────────────────────────────
const _guideCache = {};
function loadGuideSection(sectionId, btn) {
  if (_guideCache[sectionId]) {
    document.getElementById("guide-content").innerHTML = _guideCache[sectionId];
    return;
  }
  document.getElementById("guide-content").innerHTML = "<p>Loading\u2026</p>";
  fetch("/guide/" + sectionId)
    .then(r => r.text())
    .then(html => {
      _guideCache[sectionId] = html;
      document.getElementById("guide-content").innerHTML = html;
    });
}
// Load summary on first visit
loadGuideSection("summary", null);

// ── Lint tab ──────────────────────────────────────────────────────────────────
document.getElementById("btn-lint-state").addEventListener("click", () => {
  const cap = buildCaption();
  lintAndShow(cap, mwState.lyrics);
});
document.getElementById("btn-lint-paste").addEventListener("click", () => {
  lintAndShow(
    document.getElementById("lint-tags").value,
    document.getElementById("lint-lyrics").value
  );
});

async function lintAndShow(tags, lyrics) {
  const resp = await fetch("/lint", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({tags, lyrics}),
  });
  const data = await resp.json();
  renderLintResults(data.results);
}

function renderLintResults(results) {
  const container = document.getElementById("lint-results");
  if (!results || results.length === 0) {
    container.innerHTML = "<p style='color:var(--success)'>\u2705 All clear \u2014 no issues found.</p>";
    return;
  }
  const errors = results.filter(r => r.severity === "error");
  const warnings = results.filter(r => r.severity === "warning");
  const tips = results.filter(r => r.severity === "tip");
  let html = "";
  if (errors.length) {
    html += "<div style='margin-bottom:10px'><strong class='lint-error'>\u274c ERRORS (must fix)</strong>";
    errors.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>\u2192 ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  if (warnings.length) {
    html += "<div style='margin-bottom:10px'><strong class='lint-warning'>\u26a0 WARNINGS (should fix)</strong>";
    warnings.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>\u2192 ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  if (tips.length) {
    html += "<div><strong class='lint-tip'>\ud83d\udca1 TIPS (consider)</strong>";
    tips.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>\u2192 ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  container.innerHTML = html;
}

// ── Stems tab ─────────────────────────────────────────────────────────────────
document.getElementById("btn-stems-extract").addEventListener("click", async () => {
  const fileInput = document.getElementById("stems-file");
  const songName = document.getElementById("stems-song-name").value || "Stem Extract";
  const status = document.getElementById("stems-extract-status");
  if (!fileInput.files.length) { status.textContent = "Select a file first."; return; }
  status.textContent = "Uploading\u2026";
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
    status.textContent = "Queued \u2014 " + data.prompt_id;
  } catch(e) { status.textContent = "Error: " + e.message; }
});

document.getElementById("btn-demucs-run").addEventListener("click", () => {
  const filename = document.getElementById("demucs-filename").value.trim();
  const model = document.getElementById("demucs-model").value;
  const log = document.getElementById("demucs-log");
  if (!filename) { log.textContent = "Enter a filename."; return; }
  log.textContent = "";
  const params = new URLSearchParams({filename, model});
  const es = new EventSource("/stems/demucs/stream?" + params.toString());
  es.addEventListener("log", e => {
    const {line} = JSON.parse(e.data);
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener("done", () => { es.close(); log.textContent += "[done]\n"; });
  es.onerror = () => { es.close(); };
});
