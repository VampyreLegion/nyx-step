// ── DAW session grid (clip-launch looper) ─────────────────────────────────────
let _dawSessionOpen = false;

function dawRenderSessionIfOpen() { if (_dawSessionOpen) dawRenderSession(); }

function dawRenderSession() {
  const host = document.getElementById("daw-session-grid");
  if (!host) return;
  const scenes = dawState.scenes ?? 4;
  host.innerHTML = "";
  host.style.cssText = "display:flex;gap:4px;overflow-x:auto;align-items:flex-start";
  for (const track of dawState.tracks) {
    const col = document.createElement("div");
    col.style.cssText = `display:flex;flex-direction:column;gap:4px;min-width:96px;border-top:2px solid ${track.color}`;
    const hdr = document.createElement("div");
    hdr.textContent = track.name;
    hdr.style.cssText = "font-size:10px;color:#e2e4ed;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    col.appendChild(hdr);
    const active = (typeof dawCellActive === "function") ? dawCellActive(track.id) : -1;
    for (let s = 0; s < scenes; s++) {
      const ref = (track.cells || [])[s] || null;
      const cell = document.createElement("div");
      const isActive = active === s;
      cell.style.cssText = "height:34px;border-radius:3px;font-size:9px;padding:3px;overflow:hidden;cursor:pointer;display:flex;align-items:center;" +
        (ref ? ("background:" + track.color + "22;border:1px solid " + track.color + ";color:#e2e4ed")
             : "background:#0b0c10;border:1px dashed #2d3041;color:#5a5f6e;justify-content:center");
      if (isActive) cell.style.boxShadow = "0 0 0 2px #00d4b6";
      cell.textContent = ref ? ((isActive ? "▶ " : "") + ref.name) : "drop clip";
      cell.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      cell.addEventListener("drop", e => {
        e.preventDefault();
        const raw = e.dataTransfer.getData("application/x-daw-clip");
        if (!raw) return;
        const src = JSON.parse(raw);
        dawSetCell(track.id, s, { file: src.file, name: src.name || src.file });
      });
      cell.addEventListener("click", () => {
        if (!(track.cells || [])[s]) return;
        if ((typeof dawCellActive === "function" ? dawCellActive(track.id) : -1) === s) dawStopCell(track.id);
        else dawLaunchCell(track.id, s);
      });
      col.appendChild(cell);
    }
    host.appendChild(col);
  }
}
