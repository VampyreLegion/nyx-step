// ── Auto-Genre Detection ────────────────────────────────────────────────────
async function detectGenre() {
  const tagInput = document.getElementById('caption-input') || document.getElementById('overview-tags');
  const tags = tagInput ? tagInput.value.trim() : '';
  if (!tags) return alert('Enter some tags first');
  const statusEl = document.getElementById('auto-genre-status');
  if (statusEl) statusEl.textContent = 'Detecting genre...';
  try {
    const res = await fetch('/detect-genre', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ tags }),
    });
    const data = await res.json();
    if (data.suggested_genres && data.suggested_genres.length) {
      const genreStr = data.suggested_genres.map(g => g.name || g).join(', ');
      if (statusEl) statusEl.textContent = `Suggested: ${genreStr}`;
      if (data.additional_tags) {
        tagInput.value = `${tags}, ${data.additional_tags}`;
      }
    } else if (statusEl) {
      statusEl.textContent = 'No genre suggestions';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}
