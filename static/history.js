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
  if (r.caption) document.getElementById("overview-tags").value = r.caption;
  if (r.caption) {
    // Try to sync tags back — just update mwState.genre etc loosely
    document.getElementById("overview-tags").value = r.caption;
  }
  if (r.lyrics !== undefined) {
    mwState.lyrics = r.lyrics;
    document.getElementById("overview-lyrics").value = r.lyrics;
    document.getElementById("lyrics-editor").value = r.lyrics;
  }
  if (p.bpm)         { mwState.bpm = p.bpm;               document.getElementById("style-bpm").value = p.bpm; }
  if (p.key)         { mwState.key = p.key;               document.getElementById("style-key").value = p.key; }
  if (p.scale)       { mwState.scale = p.scale;           document.getElementById("style-scale").value = p.scale; }
  if (p.mode !== undefined) { mwState.mode = p.mode;      document.getElementById("style-mode").value = p.mode; }
  if (p.time_sig)    { mwState.time_sig = p.time_sig;     document.getElementById("style-timesig").value = p.time_sig; }
  if (p.steps)       { mwState.steps = p.steps;           document.getElementById("param-steps").value = p.steps; }
  if (p.cfg_scale)   { mwState.cfg_scale = p.cfg_scale;   document.getElementById("param-cfg").value = p.cfg_scale; }
  if (p.duration)    { mwState.duration = p.duration;     document.getElementById("param-duration").value = p.duration; }
  if (p.temperature) { mwState.temperature = p.temperature; document.getElementById("param-temp").value = p.temperature; }
  if (p.top_p !== undefined) { mwState.top_p = p.top_p;  document.getElementById("param-topp").value = p.top_p; }
  if (p.top_k !== undefined) { mwState.top_k = p.top_k;  document.getElementById("param-topk").value = p.top_k; }
  if (p.min_p !== undefined) { mwState.min_p = p.min_p;  document.getElementById("param-minp").value = p.min_p; }
  if (r.seed) {
    mwState.seed = r.seed; mwState.lock_seed = true;
    document.getElementById("param-seed").value = r.seed;
    document.getElementById("param-lock-seed").checked = true;
  }
  if (p.song_name)   document.getElementById("song-name").value = p.song_name;
  updateTagTokenCount();
  updatePayloadPreview();
  // Switch to overview tab so user sees what was loaded
  document.querySelector('[data-tab="overview"]').click();
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
