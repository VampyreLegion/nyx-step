// ── Quick Groove to Song ────────────────────────────────────────────────────
async function grooveToSong(clipId) {
  const statusEl = document.getElementById('gts-status');
  if (statusEl) statusEl.textContent = 'Analyzing groove...';
  try {
    const res = await fetch('/groove-to-song', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ groove_clip_id: clipId }),
    });
    const data = await res.json();
    if (data.suggested_caption) {
      const tagInput = document.getElementById('caption-input') || document.getElementById('tags');
      if (tagInput) tagInput.value = data.suggested_caption;
      const lyricsEl = document.getElementById('lyrics-editor');
      if (lyricsEl && data.suggested_lyrics) lyricsEl.value = data.suggested_lyrics;
      if (statusEl) statusEl.textContent = `Applied: ${data.bpm} BPM, ${data.key}, ${data.suggested_genre}`;
    } else {
      if (statusEl) statusEl.textContent = 'Error: ' + (data.error || 'no result');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}
