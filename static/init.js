// ── Initialisation ────────────────────────────────────────────────────────────
const _hiVisBtn = document.getElementById('btn-hivis');
if (_hiVisBtn) {
  if (localStorage.getItem('hivis') === '1') {
    document.body.classList.add('hi-vis');
    _hiVisBtn.textContent = 'Hi-Vis: ON';
  }
  _hiVisBtn.addEventListener('click', function() {
    const on = document.body.classList.toggle('hi-vis');
    localStorage.setItem('hivis', on ? '1' : '0');
    this.textContent = on ? 'Hi-Vis: ON' : 'Hi-Vis: OFF';
  });
}

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

// ── Live dock telemetry (header badge) ──────────────────────────────────────
// Polls /api/comfy/status so the queue badge + ComfyUI status stay current even
// without generation events. Reflects the same data the Integrations tab shows.
let _dockStatusInterval = null;

function updateDockStatus() {
  if (_dockStatusInterval) clearTimeout(_dockStatusInterval);
  fetch("/api/comfy/status")
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (!d) throw new Error("bad response");
      const on = d.comfyui_online ? "●" : "○";
      const el = document.getElementById("comfy-status");
      if (el) el.textContent = "ComfyUI: " + on + (on === "●" ? " online" : " offline");
      const q = d.queue || {};
      const badge = document.getElementById("queue-badge");
      if (badge) badge.textContent = `Queue: ${q.running_count || 0} running, ${q.pending_count || 0} pending`;
    })
    .catch(() => {})
    .finally(() => { _dockStatusInterval = setTimeout(updateDockStatus, 10000); });
}
updateDockStatus();
