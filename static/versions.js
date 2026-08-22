// ── Phase 4: Song Versioning ─────────────────────────────────────────────────
// Save completed generations as named song versions, browse iteration history
// with a param diff view, and restore any version back into the form.

document.addEventListener("nyx-job-files", e => {
  const { promptId, container } = e.detail;
  const card = document.getElementById("job-" + promptId);
  if (!card || card.querySelector(".btn-save-version")) return;

  const btn = document.createElement("button");
  btn.className = "secondary small btn-save-version";
  btn.textContent = "💾 Save Version";
  btn.title = "Snapshot this generation's settings as a new version of this song";
  btn.style.cssText = "font-size:11px;padding:2px 8px;";
  btn.addEventListener("click", () => _saveVersionFromJob(promptId, btn));
  container.prepend(btn);
});

async function _saveVersionFromJob(promptId, btn) {
  if (typeof _resolveRetakePayload !== "function") {
    alert("Versioning unavailable — job payload resolver missing.");
    return;
  }
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const payload = await _resolveRetakePayload(promptId);
    if (!payload) { alert("Could not read this job's parameters."); return; }
    const notes = prompt(`Version note (optional):`, "") ?? "";
    const resp = await fetch("/api/versions", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        song_name: payload.song_name || "Untitled",
        prompt_id: promptId,
        params: payload,
        notes: typeof notes === "string" ? notes : "",
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) { alert("Save failed: " + (data.error || resp.statusText)); return; }
    showToast(`Saved v${data.version?.version} of "${payload.song_name}"`, "success");
    if (typeof loadVersionSongs === "function") loadVersionSongs();
  } catch (e) {
    alert("Save version error: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "💾 Save Version";
  }
}

// ── Versions panel ───────────────────────────────────────────────────────────

let _versionSongs = [];
let _currentVersions = [];   // light list for the selected song
let _versionDetailsCache = {}; // id → full detail

async function loadVersionSongs() {
  const sel = document.getElementById("versions-song-select");
  if (!sel) return;
  try {
    const data = await fetch("/api/versions").then(r => r.json());
    _versionSongs = data.songs || [];
    const prev = sel.value;
    sel.innerHTML = `<option value="">— ${_versionSongs.length ? "choose a song" : "no saved versions yet"} —</option>` +
      _versionSongs.map(s =>
        `<option value="${esc(s.song_name)}">${esc(s.song_name)} (${s.n_versions})</option>`).join("");
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  } catch (e) {
    sel.innerHTML = `<option value="">failed to load</option>`;
  }
}

async function loadVersionsForSong(songName) {
  const wrap = document.getElementById("versions-list-wrap");
  const diffWrap = document.getElementById("versions-diff-wrap");
  _currentVersions = [];
  _versionDetailsCache = {};
  diffWrap.style.display = "none";
  if (!songName) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading…</div>';
  try {
    const data = await fetch("/api/versions?song_name=" + encodeURIComponent(songName)).then(r => r.json());
    _currentVersions = data.versions || [];
  } catch (e) {
    wrap.innerHTML = `<div style="color:var(--error);font-size:12px">Load failed: ${e.message}</div>`;
    return;
  }
  if (!_currentVersions.length) { wrap.innerHTML = ""; return; }

  wrap.innerHTML = `
    <table style="width:100%;font-size:12px;border-collapse:collapse">
      <thead><tr style="color:var(--muted);text-align:left">
        <th style="padding:4px 6px;border-bottom:1px solid var(--border)">Ver</th>
        <th style="padding:4px 6px;border-bottom:1px solid var(--border)">Saved</th>
        <th style="padding:4px 6px;border-bottom:1px solid var(--border)">Note</th>
        <th style="padding:4px 6px;border-bottom:1px solid var(--border);text-align:right"></th>
      </tr></thead>
      <tbody id="versions-tbody"></tbody>
    </table>`;

  const tbody = wrap.querySelector("#versions-tbody");
  [..._currentVersions].reverse().forEach(v => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:5px 6px;border-bottom:1px solid var(--border);color:var(--accent);font-weight:600">v${v.version}</td>
      <td style="padding:5px 6px;border-bottom:1px solid var(--border);color:var(--muted)">${new Date(v.created_at).toLocaleString()}</td>
      <td style="padding:5px 6px;border-bottom:1px solid var(--border)">${esc(v.notes || "—")}</td>
      <td style="padding:5px 6px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">
        <button class="secondary small ver-restore-btn" style="font-size:11px;padding:2px 8px"
          title="Load these settings back into the form">↩ Restore</button>
      </td>`;
    tr.querySelector(".ver-restore-btn").addEventListener("click", ev =>
      _restoreVersion(v.id, ev.currentTarget));
    tbody.appendChild(tr);
  });

  _renderVersionDiffSelectors();
}

function _renderVersionDiffSelectors() {
  const diffWrap = document.getElementById("versions-diff-wrap");
  if (_currentVersions.length < 2) {
    diffWrap.style.display = "none";
    return;
  }
  const opts = [..._currentVersions].reverse()
    .map(v => `<option value="${v.id}">v${v.version} — ${new Date(v.created_at).toLocaleString()}</option>`)
    .join("");
  diffWrap.style.display = "";
  diffWrap.innerHTML = `
    <div class="section-title" style="margin-top:14px">Compare Versions</div>
    <div class="row" style="align-items:center;margin-bottom:8px">
      <div class="field-group" style="margin-bottom:0"><label>Base</label>
        <select id="diff-a">${opts}</select></div>
      <div class="field-group" style="margin-bottom:0"><label>Compare</label>
        <select id="diff-b">${opts}</select></div>
      <button class="secondary small" id="btn-run-diff" style="align-self:flex-end">🔍 Diff</button>
    </div>
    <div id="diff-result" class="preview-box" style="min-height:40px;max-height:320px;overflow-y:auto">Pick two versions and hit Diff.</div>`;
  const sels = diffWrap.querySelectorAll("select");
  sels[0].selectedIndex = 1; // default: previous vs latest
  diffWrap.querySelector("#btn-run-diff").addEventListener("click", async () => {
    const aId = parseInt(document.getElementById("diff-a").value, 10);
    const bId = parseInt(document.getElementById("diff-b").value, 10);
    const out = document.getElementById("diff-result");
    out.textContent = "Diffing…";
    try {
      const [a, b] = await Promise.all([_fetchVersionDetail(aId), _fetchVersionDetail(bId)]);
      out.innerHTML = _paramsDiffHtml(a, b);
    } catch (e) {
      out.textContent = "Diff failed: " + e.message;
    }
  });
}

async function _fetchVersionDetail(id) {
  if (_versionDetailsCache[id]) return _versionDetailsCache[id];
  const d = await fetch("/api/versions/" + id).then(r => r.json());
  if (d.error) throw new Error(d.error);
  _versionDetailsCache[id] = d;
  return d;
}

function _flattenParams(detail) {
  const p = { ...(detail.params || {}) };
  // Surface the interesting fields first-class.
  const flat = {
    tags: p.tags ?? "",
    lyrics_lines: String(p.lyrics ?? "").split("\n").filter(l => l.trim()).length,
    seed: p.seed ?? 0,
  };
  ["bpm","key","scale","mode","time_sig","chords","notes","steps","cfg_scale",
   "duration","temperature","top_p","top_k","min_p","genre","audio_format"].forEach(k => {
    if (p[k] !== undefined && p[k] !== "") flat[k] = p[k];
  });
  if (Array.isArray(p.instruments)) flat.instruments = p.instruments.join(", ");
  if (Array.isArray(p.vocal_tags)) flat.vocal_tags = p.vocal_tags.join(", ");
  return flat;
}

function _paramsDiffHtml(a, b) {
  const fa = _flattenParams(a), fb = _flattenParams(b);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  let rows = "";
  keys.forEach(k => {
    const va = fa[k], vb = fb[k];
    const sa = va === undefined ? "—" : esc(String(va));
    const sb = vb === undefined ? "—" : esc(String(vb));
    const changed = JSON.stringify(va) !== JSON.stringify(vb);
    rows += `<tr>
      <td style="padding:3px 8px;color:${changed ? "var(--warning)" : "var(--muted)"};white-space:nowrap">${esc(k)}</td>
      <td style="padding:3px 8px;color:${changed ? "var(--warning)" : "var(--muted)"};word-break:break-word">${sa}</td>
      <td style="padding:3px 8px;color:${changed ? "var(--success)" : "var(--muted)"};word-break:break-word">${sb}</td>
    </tr>`;
  });
  const nChanged = keys.filter(k => JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).length;
  return `<div style="color:var(--muted);margin-bottom:4px">v${a.version} → v${b.version}: ${nChanged} field${nChanged === 1 ? "" : "s"} changed</div>
    <table style="width:100%;font-size:11px;border-collapse:collapse">
      <thead><tr style="text-align:left;color:var(--muted)">
        <th style="padding:2px 8px">Field</th><th style="padding:2px 8px">v${a.version}</th><th style="padding:2px 8px">v${b.version}</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
}

async function _restoreVersion(versionId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const d = await fetch(`/api/versions/${versionId}/restore`, { method: "POST" }).then(r => r.json());
    if (d.error) { alert("Restore failed: " + d.error); return; }
    _applyRestoredVersion(d);
    showToast(`Loaded v${d.version} into the form`, "success");
    document.querySelector('[data-tab="overview"]').click();
  } catch (e) {
    alert("Restore error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↩ Restore"; }
  }
}

function _applyRestoredVersion(d) {
  const p = d.params || {};
  document.getElementById("overview-tags").value = d.tags || "";
  mwState.lyrics = d.lyrics || "";
  document.getElementById("overview-lyrics").value = mwState.lyrics;
  document.getElementById("lyrics-editor").value = mwState.lyrics;
  const set = (id, key, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null && val !== "") { el.value = val; mwState[key] = val; }
  };
  set("style-bpm", "bpm", p.bpm);
  set("style-key", "key", p.key);
  set("style-scale", "scale", p.scale);
  set("style-mode", "mode", p.mode);
  set("style-timesig", "time_sig", p.time_sig);
  set("style-chords", "chords", p.chords);
  set("style-notes", "notes", p.notes);
  set("param-steps", "steps", p.steps);
  set("param-cfg", "cfg_scale", p.cfg_scale);
  set("param-duration", "duration", p.duration);
  set("param-temp", "temperature", p.temperature);
  set("param-topp", "top_p", p.top_p);
  set("param-topk", "top_k", p.top_k);
  set("param-minp", "min_p", p.min_p);
  if (d.seed) {
    mwState.seed = d.seed; mwState.lock_seed = true;
    document.getElementById("param-seed").value = d.seed;
    document.getElementById("param-lock-seed").checked = true;
  }
  if (p.genre !== undefined) mwState.genre = p.genre;
  if (p.song_name || d.song_name) document.getElementById("song-name").value = p.song_name || d.song_name;
  updateTagTokenCount();
  updatePayloadPreview();
}

document.getElementById("versions-song-select")?.addEventListener("change", e => {
  loadVersionsForSong(e.target.value);
});
document.getElementById("btn-versions-refresh")?.addEventListener("click", async () => {
  await loadVersionSongs();
  const sel = document.getElementById("versions-song-select");
  if (sel.value) loadVersionsForSong(sel.value);
});
