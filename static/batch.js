// ── Batch Generation ────────────────────────────────────────────────────────
async function batchGenerate() {
  const tags = document.getElementById('tags')?.value || document.getElementById('caption-input')?.value || '';
  const lyrics = document.getElementById('lyrics-editor')?.value || '';
  const count = parseInt(document.getElementById('batch-count')?.value || '4');
  const statusEl = document.getElementById('batch-status');
  if (statusEl) statusEl.textContent = `Generating ${count} variants...`;
  const res = await fetch('/batch-generate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ tags, lyrics, duration: 30, song_name: 'Batch', count }),
  });
  const data = await res.json();
  if (statusEl) statusEl.textContent = `Queued ${data.queued.length} of ${data.total} variants`;
}
