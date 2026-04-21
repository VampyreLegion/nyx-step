// ── Initialisation ────────────────────────────────────────────────────────────
syncOverviewFromState();
connectSSE();
loadGuideSection("starthere", null);

fetch("/queue").then(r => r.json()).then(data => {
  (data.my_jobs || []).forEach(j => addJobCard(j.prompt_id, j.song_name, j.status, j.output_files));
  const c = data.comfyui;
  document.getElementById("queue-badge").textContent =
    `Queue: ${c.running} running, ${c.pending} pending`;
});
