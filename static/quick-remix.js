// ── One-Click Remix ─────────────────────────────────────────────────────────
async function quickRemix(historyId, variationType) {
  const statusEl = document.getElementById(`remix-status-${historyId}`);
  if (statusEl) statusEl.textContent = `Remixing (${variationType})...`;
  try {
    const res = await fetch('/quick-remix', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ history_id: historyId, variation_type: variationType }),
    });
    const data = await res.json();
    if (data.ok) {
      if (statusEl) statusEl.textContent = 'Remix queued!';
      if (typeof loadHistory === 'function') loadHistory();
    } else {
      if (statusEl) statusEl.textContent = 'Error: ' + (data.error || 'failed');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}
