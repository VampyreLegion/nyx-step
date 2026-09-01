// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "overview") syncOverviewFromState();
    if (btn.dataset.tab === "lyrics") document.getElementById("lyrics-editor").value = mwState.lyrics;
    if (btn.dataset.tab === "lint") updateLintStatePreview();
    if (btn.dataset.tab === "history") { if (typeof loadHistory === "function" && _historyRecords.length === 0) loadHistory(); }
    if (btn.dataset.tab === "library") { if (typeof loadLibrary === "function") loadLibrary(); }
    if (btn.dataset.tab === "jam") { if (typeof _checkMusicGenStatus === "function") _checkMusicGenStatus(); }
    if (btn.dataset.tab === "versions") { if (typeof loadVersionSongs === "function") loadVersionSongs(); }
    if (btn.dataset.tab === "moodarc") { if (typeof initMoodArc === "function") initMoodArc(); }
    if (btn.dataset.tab === "video") { if (typeof onVideoTabOpen === "function") onVideoTabOpen(); }
    if (btn.dataset.tab === "daw") { if (typeof onDawTabOpen === "function") onDawTabOpen(); }
    if (btn.dataset.tab === "groovelab") {
      const iframe = document.getElementById("groovelab-iframe");
      if (iframe) {
        // Force iframe reload to ensure audio context is alive
        const src = iframe.src;
        iframe.src = src;
      }
    }
    if (btn.dataset.tab === "integrations") {
      if (typeof initEmbeds === "function") initEmbeds();
      if (typeof refreshEmbedOnOpen === "function") refreshEmbedOnOpen("integrations");
      if (typeof updateIntegrationsTelemetry === "function") updateIntegrationsTelemetry();
    }
  });
});

document.querySelectorAll(".inner-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const parent = btn.closest(".tab-panel") || btn.parentElement.parentElement;
    parent.querySelectorAll(".inner-tab-btn").forEach(b => b.classList.remove("active"));
    parent.querySelectorAll(".inner-panel").forEach(p => p.classList.remove("active"));
    if (btn.dataset.inner) {
      const panel = document.getElementById(btn.dataset.inner);
      if (panel) panel.classList.add("active");
    }
    if (btn.dataset.guide) loadGuideSection(btn.dataset.guide, btn);
    btn.classList.add("active");
  });
});
