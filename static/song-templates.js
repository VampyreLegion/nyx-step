// ── Template Starter Kit — song templates panel in the Generate tab ──────────
let _songTemplates = [];

async function loadSongTemplates() {
  const list = document.getElementById("song-templates-panel");
  if (!list) return;
  list.innerHTML = "<div style='color:var(--muted);font-size:12px'>Loading templates…</div>";
  try {
    const data = await fetch("/api/song-templates").then(r => r.json());
    _songTemplates = data.templates || [];
  } catch (e) {
    list.innerHTML = `<div style='color:var(--error);font-size:12px'>Failed to load templates: ${esc(e.message)}</div>`;
    return;
  }
  renderSongTemplates();
}

function renderSongTemplates() {
  const list = document.getElementById("song-templates-panel");
  if (!list) return;
  list.innerHTML = "";
  if (!_songTemplates.length) {
    list.innerHTML = "<div style='color:var(--muted);font-size:12px'>No templates yet.</div>";
    return;
  }
  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
  _songTemplates.forEach(tpl => {
    const card = document.createElement("div");
    card.style.cssText = "background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:200px;display:flex;flex-direction:column;gap:6px";
    if (tpl.builtin) card.style.borderColor = "#3a3556";

    const title = document.createElement("div");
    title.textContent = (tpl.builtin ? "📦 " : "") + tpl.name;
    title.style.cssText = "font-weight:600;font-size:12px;color:" + (tpl.builtin ? "var(--accent)" : "var(--accent2)");
    title.title = tpl.builtin ? "Built-in starter template" : "Your saved template";

    const d = tpl.data || {};
    const meta = document.createElement("div");
    meta.textContent = [d.genre, d.bpm ? d.bpm + " BPM" : "", d.duration ? Math.round(d.duration) + "s" : ""]
      .filter(Boolean).join(" · ") || "(no details)";
    meta.style.cssText = "font-size:11px;color:var(--muted);flex:1";

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:4px";
    const applyBtn = document.createElement("button");
    applyBtn.className = "small";
    applyBtn.textContent = "▶ Apply";
    applyBtn.style.cssText = "flex:1;font-size:11px;padding:4px 8px";
    applyBtn.title = "Load this template into the current state";
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      applyBtn.textContent = "…";
      try {
        const resp = await fetch(`/api/song-templates/${tpl.id}/apply`, { method: "POST" });
        const data = await resp.json();
        if (data.error) { showToast(data.error, "error"); return; }
        _applyPreset(data.data || data);
        syncOverviewFromState();
        showToast(`Template applied: ${tpl.name}`, "success");
      } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = "▶ Apply";
      }
    });
    btnRow.appendChild(applyBtn);

    if (!tpl.builtin) {
      const delBtn = document.createElement("button");
      delBtn.className = "secondary small";
      delBtn.textContent = "🗑";
      delBtn.style.cssText = "font-size:11px;padding:4px 8px";
      delBtn.title = "Delete this template";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete template "${tpl.name}"?`)) return;
        const resp = await fetch(`/api/song-templates/${tpl.id}`, { method: "DELETE" });
        if (!resp.ok) { showToast((await resp.json().catch(() => ({}))).error || "Delete failed", "error"); return; }
        showToast("Template deleted", "info");
        loadSongTemplates();
      });
      btnRow.appendChild(delBtn);
    }

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(btnRow);
    grid.appendChild(card);
  });
  list.appendChild(grid);
}

document.getElementById("btn-template-save-current").addEventListener("click", async () => {
  const nameInput = document.getElementById("template-name-input");
  const statusEl = document.getElementById("template-save-status");
  const name = nameInput.value.trim() || document.getElementById("song-name").value.trim();
  if (!name) { statusEl.textContent = "Enter a template name first."; return; }
  const btn = document.getElementById("btn-template-save-current");
  btn.disabled = true;
  try {
    const preset = _buildPreset();
    const resp = await fetch("/api/song-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data: preset }),
    });
    const data = await resp.json();
    if (data.error) { statusEl.textContent = data.error; return; }
    statusEl.textContent = `Saved as "${data.name}".`;
    showToast("Template saved", "success");
    nameInput.value = "";
    loadSongTemplates();
  } catch (e) {
    statusEl.textContent = "Save failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("DOMContentLoaded", loadSongTemplates);

// Reload templates when BioInfusor tab is opened
const _tplTabBtn = document.querySelector('[data-tab="easy"]');
if (_tplTabBtn) _tplTabBtn.addEventListener("click", () => setTimeout(loadSongTemplates, 50));
