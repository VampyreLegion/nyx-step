// ── A/B Compare ───────────────────────────────────────────────────────────────
// Pick two finished jobs as A and B; shows side-by-side players + tag diff.
const _abCompare = { A: null, B: null };

function setCompareSlot(slot, promptId, file, name, seed, tags) {
  _abCompare[slot] = { promptId, file, name, seed, tags: tags || "" };
  renderCompare();
}

function _tagTokens(tags) {
  return tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
}

function _escCompare(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderCompare() {
  const panel = document.getElementById("ab-compare-panel");
  if (!panel) return;
  const { A, B } = _abCompare;
  if (!A && !B) { panel.style.display = "none"; return; }
  panel.style.display = "block";

  const col = (slot, j) => {
    if (!j) return `<div style="flex:1;color:var(--muted)">Pick a job as ${slot}</div>`;
    let tagHtml = "";
    if (A && B) {
      const mine = _tagTokens(j.tags);
      const other = _tagTokens(slot === "A" ? B.tags : A.tags);
      tagHtml = mine.map(t =>
        other.includes(t)
          ? `<span style="color:var(--muted)">${_escCompare(t)}</span>`
          : `<span style="color:var(--accent2);font-weight:bold">${_escCompare(t)}</span>`
      ).join(", ");
    } else {
      tagHtml = `<span style="color:var(--muted)">${_escCompare(j.tags)}</span>`;
    }
    return `<div style="flex:1;min-width:0">
      <b>${slot}: ${_escCompare(j.name)}</b> <span style="color:var(--muted)">seed ${_escCompare(j.seed)}</span><br>
      <audio controls src="/download/${encodeURIComponent(j.file)}" style="width:100%;margin:4px 0"></audio>
      <div style="font-size:11px;word-wrap:break-word">${tagHtml}</div>
    </div>`;
  };

  const sameSeed = A && B && String(A.seed) === String(B.seed);
  panel.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center">
       <strong>🔬 A/B Compare</strong>
       <span style="font-size:11px;color:${sameSeed ? "var(--success)" : "var(--muted)"}">
         ${A && B ? (sameSeed ? "✓ same seed — differences come from the tags" : "⚠ different seeds — differences may be random") : ""}
       </span>
       <button class="secondary small" style="font-size:11px;padding:2px 8px" onclick="_abCompare.A=null;_abCompare.B=null;renderCompare()">✕ Clear</button>
     </div>
     <div style="display:flex;gap:12px;margin-top:6px">${col("A", A)}${col("B", B)}</div>
     <div style="font-size:10px;color:var(--muted);margin-top:4px">Highlighted tags differ between A and B. Tip: 🎲 lock a seed, change one tag, generate, then compare.</div>`;
}
