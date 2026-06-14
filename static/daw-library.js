// ── DAW clip library ──────────────────────────────────────────────────────────
let _dawLibItems = [];   // {file, name, duration, kind}

async function dawLoadLibrary() {
  const list = document.getElementById("daw-lib-list");
  if (list) list.textContent = "loading…";
  try {
    const d = await fetch("/daw/library").then(r => r.json());
    _dawLibItems = [
      ...(d.clips || []).map(c => ({ ...c, kind: "clip" })),
      ...(d.stems || []).map(s => ({ ...s, duration: s.duration || 0, kind: "stem" })),
    ];
    dawRenderLibrary();
  } catch (e) {
    if (list) list.textContent = "Library failed: " + e.message;
  }
}

function dawRenderLibrary() {
  const list = document.getElementById("daw-lib-list");
  const q = (document.getElementById("daw-lib-search")?.value || "").toLowerCase();
  list.innerHTML = "";
  const items = _dawLibItems.filter(i => i.name.toLowerCase().includes(q) || i.file.toLowerCase().includes(q));
  if (!items.length) { list.textContent = "No clips. Generate some music or run Demucs first."; return; }
  for (const it of items) {
    const chip = document.createElement("div");
    chip.draggable = true;
    chip.className = "daw-lib-chip";
    chip.style.cssText = "display:flex;align-items:center;gap:4px;font-size:11px;background:#1a1c26;border:1px solid #2d3041;border-radius:4px;padding:3px 6px;cursor:grab;color:#e2e4ed";
    const dot = it.kind === "stem" ? "🎛" : "🎵";
    chip.textContent = `⠿ ${dot} ${it.name}`;
    chip.title = it.file;
    chip.addEventListener("dragstart", e => {
      e.dataTransfer.setData("application/x-daw-clip", JSON.stringify({
        file: it.file, name: it.name,
        source_duration: it.duration || 0,
      }));
      e.dataTransfer.effectAllowed = "copy";
    });
    list.appendChild(chip);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const s = document.getElementById("daw-lib-search");
  if (s) s.addEventListener("input", dawRenderLibrary);
  const r = document.getElementById("daw-lib-refresh");
  if (r) r.addEventListener("click", dawLoadLibrary);
});
