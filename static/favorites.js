// ── Favorites view inside the History tab ─────────────────────────────────────
let _favRecords = [];
let _histView = "all"; // "all" | "favorites"

function _setHistoryView(view) {
  _histView = view;
  document.getElementById("hist-view-all").classList.toggle("active", view === "all");
  document.getElementById("hist-view-favorites").classList.toggle("active", view === "favorites");
  const isFav = view === "favorites";
  document.getElementById("history-list").style.display = isFav ? "none" : "flex";
  document.getElementById("history-empty").style.display = "none";
  document.getElementById("favorites-list").style.display = isFav ? "flex" : "none";
  document.getElementById("favorites-empty").style.display = "none";
  if (isFav) loadFavorites();
}

async function loadFavorites() {
  const list = document.getElementById("favorites-list");
  list.innerHTML = "<div style='color:var(--muted);font-size:12px'>Loading…</div>";
  try {
    const data = await fetch("/api/favorites").then(r => r.json());
    _favRecords = data.records || [];
  } catch (e) {
    list.innerHTML = `<div style="color:var(--error);font-size:12px">Failed to load favorites: ${esc(e.message)}</div>`;
    return;
  }
  renderFavorites();
}

const _saveNotesDebounced = _debounce(async (id, notes, statusEl) => {
  try {
    const resp = await fetch(`/api/favorites/${id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.status);
    statusEl.textContent = "✓ saved";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  } catch (e) {
    statusEl.textContent = "save failed";
  }
}, 600);

function renderFavorites() {
  const list = document.getElementById("favorites-list");
  const empty = document.getElementById("favorites-empty");
  list.innerHTML = "";

  if (!_favRecords.length) {
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  _favRecords.forEach(r => {
    const card = document.createElement("div");
    card.style.cssText = "background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-size:12px;";

    const ts = r.created_at ? new Date(r.created_at).toLocaleString() : "";
    const params = r.params || {};

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>
          <span style="color:var(--warning)">★</span>
          <span style="font-weight:600;color:var(--text)">${esc(r.song_name || "Untitled")}</span>
          <span style="color:var(--muted);margin-left:8px;font-size:11px">${ts}</span>
        </div>
        <button class="secondary small fav-unbookmark-btn" style="font-size:11px;padding:2px 8px"
          title="Remove from favorites">☆ Unbookmark</button>
      </div>
      <div style="color:var(--accent2);margin-top:4px;word-break:break-word">${esc(r.caption || "(no tags)")}</div>
      ${params.bpm ? `<div style="color:var(--muted);margin-top:2px">${params.bpm} BPM · ${params.key || ""}${params.scale ? " " + params.scale : ""} · seed ${r.seed}</div>` : ""}
      <div class="fav-files" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px"></div>
      <div style="margin-top:8px">
        <label style="display:block;color:var(--muted);font-size:11px;margin-bottom:3px">Notes</label>
        <textarea class="fav-notes" rows="2" placeholder="Why do you love this one? What would you tweak?"
          style="min-height:44px;font-size:11px;font-family:inherit">${esc(r.notes || "")}</textarea>
        <span class="fav-notes-status" style="font-size:10px;color:var(--success)"></span>
      </div>
    `;

    const filesDiv = card.querySelector(".fav-files");
    const bust = "?t=" + Date.now();
    (r.output_files || []).forEach(f => {
      const a = document.createElement("a");
      a.href = "/download/" + encodeURIComponent(f) + bust;
      a.download = f;
      a.textContent = "⬇ " + f;
      a.style.cssText = "color:var(--accent2);font-size:11px;";
      filesDiv.appendChild(a);
    });

    card.querySelector(".fav-notes").addEventListener("input", e => {
      r.notes = e.target.value;
      _saveNotesDebounced(r.id, e.target.value, card.querySelector(".fav-notes-status"));
    });

    card.querySelector(".fav-unbookmark-btn").addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/favorites/${r.id}/bookmark`, { method: "POST" });
        const data = await resp.json();
        if (data.error) { showToast(data.error, "error"); return; }
        _favRecords = _favRecords.filter(x => x.id !== r.id);
        showToast("Removed from favorites", "info");
        renderFavorites();
        // Keep star state fresh if user flips back to All
        const histRec = _historyRecords.find(x => x.id === r.id);
        if (histRec) histRec.bookmarked = data.bookmarked;
        if (_historyRecords.length) _renderHistory(document.getElementById("history-search").value.trim().toLowerCase());
      } finally {
        btn.disabled = false;
      }
    });

    list.appendChild(card);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("hist-view-all").addEventListener("click", () => _setHistoryView("all"));
  document.getElementById("hist-view-favorites").addEventListener("click", () => _setHistoryView("favorites"));
});
