// ── History Tab ───────────────────────────────────────────────────────────────
let _historyRecords = [];
let _historyOffset = 0;
let _historyHasMore = false;

async function loadHistory() {
  _historyOffset = 0;
  _historyRecords = [];
  _historyHasMore = false;

  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">Loading…</div>';
  empty.style.display = "none";

  await _fetchHistoryPage(0, true);
}

async function _fetchHistoryPage(offset, replace) {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");

  try {
    const resp = await fetch(`/api/history?limit=20&offset=${offset}`);
    const data = await resp.json();
    const newRecords = data.records || [];
    _historyHasMore = !!data.has_more;
    _historyOffset = offset + newRecords.length;

    if (replace) {
      _historyRecords = newRecords;
    } else {
      _historyRecords = _historyRecords.concat(newRecords);
    }

    _renderHistory(document.getElementById("history-search").value.trim().toLowerCase());
  } catch (e) {
    list.innerHTML = `<div style="color:var(--error);font-size:12px">Failed to load history: ${e.message}</div>`;
  }
}

function _renderHistory(query) {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  list.innerHTML = "";

  const filtered = query
    ? _historyRecords.filter(r =>
        (r.song_name || "").toLowerCase().includes(query) ||
        (r.caption || "").toLowerCase().includes(query)
      )
    : _historyRecords;

  if (!filtered.length) {
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  filtered.forEach(r => {
    const card = document.createElement("div");
    card.style.cssText = "background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-size:12px;";

    const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : "";
    const files = r.output_files || [];
    const params = r.params || {};

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>
          <span style="font-weight:600;color:var(--text)">${esc(r.song_name || "Untitled")}</span>
          <span style="color:var(--muted);margin-left:8px;font-size:11px">${ts}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="secondary small hist-bookmark-btn" style="font-size:11px;padding:2px 8px"
            title="${r.bookmarked ? "Remove from favorites" : "Bookmark this track"}">${r.bookmarked ? "★" : "☆"}</button>
          <button class="secondary small hist-load-btn" style="font-size:11px;padding:2px 8px"
            title="Re-load these settings into the current state">📥 Load</button>
        </div>
      </div>
      <div style="color:var(--accent2);margin-top:4px;word-break:break-word">${esc(r.caption || "(no tags)")}</div>
      ${params.bpm ? `<div style="color:var(--muted);margin-top:2px">${params.bpm} BPM · ${params.key || ""}${params.scale ? " " + params.scale : ""} · ${params.duration || "?"}s · seed ${r.seed}</div>` : `<div style="color:var(--muted);margin-top:2px">seed ${r.seed}</div>`}
      <div class="hist-files" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px"></div>
      <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">
        <button onclick="quickRemix(${r.id},'drums')" class="secondary small" style="font-size:10px;padding:2px 6px" title="Remix with different drums">🥁 Remix Drums</button>
        <button onclick="quickRemix(${r.id},'tempo')" class="secondary small" style="font-size:10px;padding:2px 6px" title="Remix at different tempo">⚡ Remix Tempo</button>
        <button onclick="quickRemix(${r.id},'key')" class="secondary small" style="font-size:10px;padding:2px 6px" title="Remix in different key">🎵 Remix Key</button>
        <button onclick="quickRemix(${r.id},'mood')" class="secondary small" style="font-size:10px;padding:2px 6px" title="Remix with different mood">🎭 Remix Mood</button>
        <span id="remix-status-${r.id}" style="font-size:10px;color:var(--muted);align-self:center"></span>
      </div>
    `;

    const filesDiv = card.querySelector(".hist-files");
    const bust = "?t=" + Date.now();
    files.forEach(f => {
      const a = document.createElement("a");
      a.href = "/download/" + encodeURIComponent(f) + bust;
      a.download = f;
      a.textContent = "⬇ " + f;
      a.title = "Download " + f;
      a.style.cssText = "color:var(--accent2);font-size:11px;";
      filesDiv.appendChild(a);
    });

    card.querySelector(".hist-load-btn").addEventListener("click", () => {
      _loadHistoryRecord(r);
    });

    // Phase 4 hook — feature modules (collections drag-drop, …) can decorate cards.
    document.dispatchEvent(new CustomEvent("nyx-history-card", {
      detail: { card, record: r },
    }));

    card.querySelector(".hist-bookmark-btn").addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/favorites/${r.id}/bookmark`, { method: "POST" });
        const data = await resp.json();
        if (data.error) { showToast(data.error, "error"); return; }
        r.bookmarked = data.bookmarked;
        btn.textContent = data.bookmarked ? "★" : "☆";
        btn.title = data.bookmarked ? "Remove from favorites" : "Bookmark this track";
      } finally {
        btn.disabled = false;
      }
    });

    list.appendChild(card);
  });

  // Append "Load older" button if more pages exist and no active search filter
  if (_historyHasMore && !query) {
    const btn = document.createElement("button");
    btn.className = "secondary small";
    btn.textContent = "Load older";
    btn.style.cssText = "margin-top:10px;width:100%;font-size:12px;";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Loading…";
      await _fetchHistoryPage(_historyOffset, false);
    });
    list.appendChild(btn);
  }
}

function _loadHistoryRecord(r) {
  const p = r.params || {};

  // Restore the full generation state so the Generate/Style/Instruments/Vocals
  // tabs reflect the selected track. Mirrors _applyPreset in presets.js.
  const _m = (k, v) => { if (v !== undefined && v !== null) mwState[k] = v; };
  _m("genre",       p.genre);
  _m("bpm",         p.bpm);
  _m("key",         p.key);
  _m("scale",       p.scale);
  _m("mode",        p.mode);
  _m("time_sig",    p.time_sig);
  _m("chords",      p.chords);
  _m("notes",       p.notes);
  _m("instruments", p.instruments ? [...p.instruments] : undefined);
  _m("vocal_tags",  p.vocal_tags  ? [...p.vocal_tags]  : undefined);
  _m("steps",       p.steps);
  _m("cfg_scale",   p.cfg_scale);
  _m("duration",    p.duration);
  _m("temperature", p.temperature);
  _m("top_p",       p.top_p);
  _m("top_k",       p.top_k);
  _m("min_p",       p.min_p);
  _m("negative_tags", p.negative_tags);

  if (r.seed) {
    _m("seed", r.seed);
    mwState.lock_seed = true;
  } else if (p.seed) {
    _m("seed", p.seed);
    _m("lock_seed", p.lock_seed ?? false);
  }
  if (r.lyrics !== undefined) _m("lyrics", r.lyrics);

  const _set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
  _set("style-bpm",     mwState.bpm);
  _set("style-key",     mwState.key);
  _set("style-scale",   mwState.scale);
  _set("style-mode",    mwState.mode);
  _set("style-timesig", mwState.time_sig);
  _set("style-chords",  mwState.chords);
  _set("style-notes",   mwState.notes);
  _set("param-steps",    mwState.steps);
  _set("param-cfg",      mwState.cfg_scale);
  _set("param-duration", mwState.duration);
  _set("param-temp",     mwState.temperature);
  _set("param-topp",     mwState.top_p);
  _set("param-topk",     mwState.top_k);
  _set("param-minp",     mwState.min_p);
  _set("param-seed",     mwState.seed);
  _set("param-negative-tags", mwState.negative_tags);
  const lockEl = document.getElementById("param-lock-seed");
  if (lockEl) lockEl.checked = mwState.lock_seed;

  _set("song-name",       p.song_name || r.song_name);
  _set("overview-tags",   r.caption ?? "");
  _set("overview-lyrics", mwState.lyrics);
  _set("lyrics-editor",   mwState.lyrics);

  if (typeof _syncInstrumentChips === "function") _syncInstrumentChips();
  const instrDisplay = document.getElementById("instrument-selected");
  if (instrDisplay) instrDisplay.value = mwState.instruments.join(", ");
  if (typeof _syncVocalChips === "function") _syncVocalChips();
  const vocalDisplay = document.getElementById("vocal-selected");
  if (vocalDisplay) vocalDisplay.value = mwState.vocal_tags.join(", ");

  updateTagTokenCount();
  updatePayloadPreview();
  // Switch to overview tab so user sees what was loaded
  const overviewBtn = document.querySelector('[data-tab="overview"]');
  if (overviewBtn) overviewBtn.click();
}

document.getElementById("history-search").addEventListener("input", e => {
  _renderHistory(e.target.value.trim().toLowerCase());
});

document.getElementById("btn-history-refresh").addEventListener("click", loadHistory);

document.getElementById("btn-history-clear").addEventListener("click", async () => {
  if (!confirm("Clear all history? This will permanently delete your generation history and cannot be undone.")) return;
  try {
    const resp = await fetch("/api/history", { method: "DELETE" });
    const data = await resp.json();
    if (data.error) { alert("Error: " + data.error); return; }
    _historyRecords = [];
    _historyOffset = 0;
    _historyHasMore = false;
    _renderHistory("");
  } catch (e) {
    alert("Failed to clear history: " + e.message);
  }
});

document.getElementById("btn-history-insights")?.addEventListener("click", async () => {
  const panel = document.getElementById("history-insights");
  panel.style.display = "block";
  panel.textContent = "Crunching…";
  try {
    const d = await fetch("/api/history/insights").then(r => r.json());
    if (!d.tags?.length) {
      panel.innerHTML = "<i style='color:var(--muted)'>No scored generations yet — click 📊 Score on some job cards first; insights build from scored tracks.</i>";
      return;
    }
    const header = `<tr><th>Tag</th><th>Avg quality</th><th>Uses</th></tr>`;
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const row = t => `<tr><td>${esc(t.tag)}</td><td>${t.avg_quality}</td><td>${t.count}</td></tr>`;
    panel.innerHTML =
      `<b>Best-performing tags</b> (from ${d.scored_tag_uses} scored tag uses)` +
      `<table style="font-size:11px;margin:4px 0">${header}` +
      d.tags.map(row).join("") + `</table>` +
      (d.weakest?.length ? `<b>Weakest tags</b><table style="font-size:11px;margin:4px 0">${header}` +
        d.weakest.map(row).join("") + `</table>` : "");
  } catch (e) { panel.textContent = "Insights failed: " + e.message; }
});

// When a generation finishes, pull the newest entries so the History tab is
// current instead of showing a stale cached list.
mwBus.on("job:done", () => { if (_historyRecords.length) loadHistory(); });
