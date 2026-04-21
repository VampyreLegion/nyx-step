// ── Lint tab ──────────────────────────────────────────────────────────────────
document.getElementById("btn-lint-state").addEventListener("click", () => {
  lintAndShow(buildCaption(), mwState.lyrics);
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
    container.innerHTML = "<p style='color:var(--success)'>✅ All clear — no issues found.</p>";
    return;
  }
  const errors   = results.filter(r => r.severity === "error");
  const warnings = results.filter(r => r.severity === "warning");
  const tips     = results.filter(r => r.severity === "tip");
  let html = "";
  if (errors.length) {
    html += "<div style='margin-bottom:10px'><strong class='lint-error'>❌ ERRORS (must fix)</strong>";
    errors.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>→ ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  if (warnings.length) {
    html += "<div style='margin-bottom:10px'><strong class='lint-warning'>⚠ WARNINGS (should fix)</strong>";
    warnings.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>→ ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  if (tips.length) {
    html += "<div><strong class='lint-tip'>💡 TIPS (consider)</strong>";
    tips.forEach(r => {
      html += `<div style='margin:4px 0'><b>[${r.field}]</b> ${r.message}<br><i style='color:var(--muted)'>→ ${r.suggestion}</i></div>`;
    });
    html += "</div>";
  }
  container.innerHTML = html;
  document.getElementById("lint-fix-wrap").style.display =
    (errors.length || warnings.length) ? "block" : "none";
}

const _SECTION_KW = /\b(solo|verse|chorus|intro|outro|bridge|drop|breakdown|interlude|pre-chorus)\b/i;

function _autoFix(tags, lyrics) {
  let tokens = tags.split(",").map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  tokens = tokens.filter(t => { const tl = t.toLowerCase(); if (seen.has(tl)) return false; seen.add(tl); return true; });
  tokens = tokens.filter(t => !t.includes("[") && !t.includes("]") && !t.includes("(") && !t.includes(")") && !_SECTION_KW.test(t));
  if (tokens.length > 12) tokens = tokens.slice(0, 12);

  let lyr = lyrics;
  lyr = lyr.replace(/\[\[/g, "[").replace(/\]\]/g, "]");
  lyr = lyr.replace(/\[\]/g, "");
  const opens = (lyr.match(/\[/g) || []).length;
  const closes = (lyr.match(/\]/g) || []).length;
  if (opens > closes) lyr += "]".repeat(opens - closes);
  if (lyr.trim() && !/\[(Verse|Chorus|Intro|Outro|Bridge|Interlude|Pre-Chorus|Drop|Build|Breakdown)/i.test(lyr))
    lyr = "[Verse]\n\n" + lyr;

  return { tags: tokens.join(", "), lyrics: lyr };
}

document.getElementById("btn-lint-fix").addEventListener("click", async () => {
  const rawTags = document.getElementById("overview-tags").value;
  const { tags, lyrics } = _autoFix(rawTags, mwState.lyrics);
  document.getElementById("overview-tags").value = tags;
  mwState.lyrics = lyrics;
  document.getElementById("overview-lyrics").value = lyrics;
  document.getElementById("lyrics-editor").value = lyrics;
  updatePayloadPreview();
  await lintAndShow(tags, lyrics);
});
