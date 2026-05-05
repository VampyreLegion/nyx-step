// ── Initialisation ────────────────────────────────────────────────────────────
syncOverviewFromState();
connectSSE();
loadGuideSection("starthere", null);

fetch("/queue").then(r => r.json()).then(data => {
  (data.my_jobs || []).forEach(j => addJobCard(j.prompt_id, j.song_name, j.status, j.output_files));
  const doneJob = (data.my_jobs || []).find(j => j.status === "done" && j.output_files && j.output_files.length);
  if (doneJob) mwState.lastAudioFile = doneJob.output_files[0];
  const c = data.comfyui;
  document.getElementById("queue-badge").textContent =
    `Queue: ${c.running} running, ${c.pending} pending`;
});
