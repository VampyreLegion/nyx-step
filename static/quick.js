// ── Quick Generate (Simple Mode) ───────────────────────────────────────────────
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
  btn.textContent = "Thinking…";
  status.textContent = "Asking AI to expand your description…";
  status.style.color = "var(--muted)";

  try {
    const resp = await fetch("/ollama/expand", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({description: desc, model}),
    });
    const data = await resp.json();
    if (data.error) {
      status.textContent = "Error: " + data.error;
      status.style.color = "var(--error)";
      return;
    }

    // Apply tags
    if (data.tags) {
      mwState.tags = data.tags;
      document.getElementById("overview-tags").value = data.tags;
    }
    // Apply numeric params
    if (data.bpm)   { mwState.bpm  = parseInt(data.bpm)    || mwState.bpm;  document.getElementById("style-bpm").value  = mwState.bpm; }
    if (data.key)   { mwState.key  = data.key;  document.getElementById("style-key").value  = mwState.key; }
    if (data.scale) { mwState.scale = data.scale; document.getElementById("style-scale").value = mwState.scale; }
    if (data.time_sig) { mwState.time_sig = data.time_sig; document.getElementById("style-timesig").value = mwState.time_sig; }

    // Apply instruments list
    if (Array.isArray(data.instruments) && data.instruments.length) {
      mwState.instruments = data.instruments;
      const el = document.getElementById("instrument-selected");
      if (el) el.value = data.instruments.join(", ");
      if (typeof _syncInstrumentChips === "function") _syncInstrumentChips();
    }

    updateTagTokenCount();
    updatePayloadPreview();

    status.textContent = "Done — fields updated from AI expansion.";
    status.style.color = "var(--accent2)";
  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.style.color = "var(--error)";
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Expand";
  }
});
