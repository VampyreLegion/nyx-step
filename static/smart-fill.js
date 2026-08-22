// ── Smart Fill ──────────────────────────────────────────────────────────────
async function smartFill(arrangementId, sectionIndex) {
  const statusEl = document.getElementById('sf-status');
  if (statusEl) statusEl.textContent = 'Generating fill...';
  try {
    const res = await fetch('/smart-fill', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ arrangement_id: arrangementId, section_index: sectionIndex }),
    });
    const data = await res.json();
    if (data.suggested_caption) {
      if (_arrState && _arrState.sections[sectionIndex]) {
        _arrState.sections[sectionIndex].caption = data.suggested_caption;
        renderArrangement();
      }
      if (statusEl) statusEl.textContent = `Fill: ${data.suggested_caption.substring(0, 60)}...`;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}
