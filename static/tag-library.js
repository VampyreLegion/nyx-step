// ── Tag Library — saved tag combos ────────────────────────────────────────────
let _tagPresets = [];

function _openTagLibrary() {
  document.getElementById("tag-library-modal").style.display = "flex";
  _refreshTagLibrary();
}

function _closeTagLibrary() {
  document.getElementById("tag-library-modal").style.display = "none";
}

async function _refreshTagLibrary() {
  const list = document.getElementById("tag-library-list");
  list.innerHTML = "<div style='color:var(--muted);padding:8px;font-size:12px'>Loading…</div>";
  try {
    const data = await fetch("/api/tag-presets").then(r => r.json());
    _tagPresets = data.presets || [];
  } catch (e) {
    list.innerHTML = `<div style='color:var(--error);padding:8px;font-size:12px'>Failed to load: ${esc(e.message)}</div>`;
    return;
  }
  if (!_tagPresets.length) {
    list.innerHTML = "<div style='color:var(--muted);padding:8px;font-size:12px'>(no saved tag combos yet — stage tags in the Tags field, then save them here)</div>";
    return;
  }
  list.innerHTML = "";
  _tagPresets.forEach(p => {
    const chip = document.createElement("div");
    chip.style.cssText = "display:flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border);border-radius:14px;padding:5px 10px;margin:4px;cursor:pointer";
    chip.title = "Click to load this combo into the Tags field\n" + p.tags;
    const label = document.createElement("span");
    label.textContent = p.name;
    label.style.cssText = "font-size:12px;color:var(--accent2);white-space:nowrap";
    const preview = document.createElement("span");
    preview.textContent = p.tags.length > 46 ? p.tags.slice(0, 46) + "…" : p.tags;
    preview.style.cssText = "font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1";
    const del = document.createElement("button");
    del.className = "secondary small";
    del.textContent = "🗑";
    del.style.cssText = "font-size:10px;padding:1px 6px;border:none";
    del.title = "Delete this combo";
    del.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm(`Delete tag combo "${p.name}"?`)) return;
      const resp = await fetch(`/api/tag-presets/${p.id}`, { method: "DELETE" });
      if (!resp.ok) { showToast((await resp.json().catch(() => ({}))).error || "Delete failed", "error"); return; }
      showToast("Tag combo deleted", "info");
      _refreshTagLibrary();
    });
    chip.addEventListener("click", () => {
      const field = document.getElementById("overview-tags");
      // Append to existing tags rather than clobbering them
      const cur = field.value.trim();
      const incoming = p.tags.trim();
      if (cur && !cur.split(",").map(t => t.trim()).includes(incoming)) {
        field.value = cur + ", " + incoming;
      } else if (!cur) {
        field.value = incoming;
      }
      updateTagTokenCount();
      updatePayloadPreview();
      _closeTagLibrary();
      showToast(`Loaded "${p.name}"`, "success");
    });
    chip.appendChild(label);
    chip.appendChild(preview);
    chip.appendChild(del);
    list.appendChild(chip);
  });
}

document.getElementById("btn-tag-library-save").addEventListener("click", async () => {
  const nameInput = document.getElementById("tag-library-name-input");
  const statusEl = document.getElementById("tag-library-status");
  const tags = document.getElementById("overview-tags").value.trim();
  const name = nameInput.value.trim();
  if (!name) { statusEl.textContent = "Enter a name first."; return; }
  if (!tags) { statusEl.textContent = "Tags field is empty — nothing to save."; return; }
  const btn = document.getElementById("btn-tag-library-save");
  btn.disabled = true;
  try {
    const resp = await fetch("/api/tag-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, tags }),
    });
    const data = await resp.json();
    if (data.error) { statusEl.textContent = data.error; return; }
    statusEl.textContent = `Saved "${data.name}".`;
    showToast("Tag combo saved", "success");
    nameInput.value = "";
    _refreshTagLibrary();
  } catch (e) {
    statusEl.textContent = "Save failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-open-tag-library").addEventListener("click", _openTagLibrary);
document.getElementById("btn-tag-library-close").addEventListener("click", _closeTagLibrary);
document.getElementById("tag-library-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) _closeTagLibrary();
});
