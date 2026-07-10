// ── Quick Generate - Deep AI Expand ─────────────────────────────────────────────
(async () => {
  const sel = document.getElementById("quick-model");
  try {
    const data = await fetch("/ollama/models").then(r => r.json());
    (data.models || []).forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      if (m.startsWith("gemma4")) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (_) {
    sel.innerHTML = '<option value="gemma4:latest">gemma4:latest</option>';
  }
})();

document.getElementById("btn-quick-expand").addEventListener("click", async () => {
  const btn    = document.getElementById("btn-quick-expand");
  const status = document.getElementById("quick-status");
  const desc   = document.getElementById("quick-prompt").value.trim();
  const model  = document.getElementById("quick-model").value || "gemma4:latest";
  if (!desc) { status.textContent = "Enter a description first."; return; }

  btn.disabled = true;
  btn.textContent = "🧠 Researching, writing lyrics & arranging…";
  status.textContent = "AI is researching your idea, generating lyrics, and building full production tags…";
  status.style.color = "var(--muted)";

  try {
    const resp = await fetch("/ollama/expand-deep", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({description: desc, model}),
    });
    const data = await resp.json();
    if (data.error) {
      status.textContent = "Error: " + data.error;
      status.style.color = "var(--error)";
      btn.disabled = false;
      btn.textContent = "✨ Expand";
      return;
    }

    // ── Populate tags ────────────────────────────────────────────────────────
    if (data.tags) {
      mwState.tags = data.tags;
      document.getElementById("overview-tags").value = data.tags;
    }

    // ── Populate song name ───────────────────────────────────────────────────
    if (data.song_name) {
      document.getElementById("song-name").value = data.song_name;
    }

    // ── Populate genre (select it in style tab too) ──────────────────────────
    if (data.genre) {
      mwState.genre = data.genre;
    }

    // ── Populate numeric params ──────────────────────────────────────────────
    if (data.bpm)   { mwState.bpm  = parseInt(data.bpm)    || 120;  document.getElementById("style-bpm").value  = mwState.bpm; }
    if (data.key)   { mwState.key  = data.key;  document.getElementById("style-key").value  = mwState.key; }
    if (data.scale) { mwState.scale = data.scale; document.getElementById("style-scale").value = mwState.scale; }
    if (data.time_sig) { mwState.time_sig = data.time_sig; document.getElementById("style-timesig").value = mwState.time_sig; }
    if (data.mood) {
      // mood isn't a dedicated mwState field, but we can fold it into notes
      if (!mwState.notes) mwState.notes = "Mood: " + data.mood;
    }

    // ── Populate instruments ─────────────────────────────────────────────────
    if (Array.isArray(data.instruments) && data.instruments.length) {
      mwState.instruments = data.instruments;
      const el = document.getElementById("instrument-selected");
      if (el) el.value = data.instruments.join(", ");
      if (typeof _syncInstrumentChips === "function") _syncInstrumentChips();
    }

    // ── Populate vocal tags ──────────────────────────────────────────────────
    if (Array.isArray(data.vocal_tags) && data.vocal_tags.length) {
      mwState.vocal_tags = data.vocal_tags;
      const el = document.getElementById("vocal-selected");
      if (el) el.value = data.vocal_tags.join(", ");
      if (typeof _syncVocalChips === "function") _syncVocalChips();
    }

    // ── Populate lyrics ──────────────────────────────────────────────────────
    if (data.lyrics) {
      mwState.lyrics = data.lyrics;
      document.getElementById("overview-lyrics").value = data.lyrics;
      document.getElementById("lyrics-editor").value = data.lyrics;
    }

    // ── Sync UI ──────────────────────────────────────────────────────────────
    if (typeof updateTagTokenCount === "function") updateTagTokenCount();
    if (typeof updatePayloadPreview === "function") updatePayloadPreview();

    status.innerHTML = "✅ <strong>Done</strong> — tags, lyrics, and production settings loaded. Review in the <strong>Generate</strong> tab and click <strong>Generate</strong> when ready.";
    status.style.color = "var(--accent2)";

    // ── Switch to Generate tab so the user sees populated fields ─────────────
    const genTabBtn = document.querySelector('.tab-btn[data-tab="overview"]');
    if (genTabBtn) genTabBtn.click();

  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.style.color = "var(--error)";
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Expand";
  }
});
