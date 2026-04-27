// ── MIDI Extraction Tab ────────────────────────────────────────────────────────
(function () {
  const _modeEl = () => document.getElementById("midi-mode");
  const _bpmEl  = () => document.getElementById("midi-bpm");
  const _fileEl = () => document.getElementById("midi-file");
  const _statusEl = () => document.getElementById("midi-status");
  const _infoEl   = () => document.getElementById("midi-info");
  const _dlEl     = () => document.getElementById("midi-download");
  const _bpmRow   = () => document.getElementById("midi-bpm-row");

  function _setStatus(msg, color) {
    const el = _statusEl();
    if (!el) return;
    el.textContent = msg;
    el.style.color = color || "var(--muted)";
  }

  function _showInfo(info) {
    const el = _infoEl();
    if (!el) return;
    el.style.display = "block";
    el.innerHTML =
      `<strong>Mode:</strong> ${info.mode || "—"} &nbsp;` +
      `<strong>Notes:</strong> ${info.note_count ?? "—"} &nbsp;` +
      `<strong>Range:</strong> ${info.pitch_range || "—"} &nbsp;` +
      (info.duration_s ? `<strong>Duration:</strong> ${parseFloat(info.duration_s).toFixed(1)}s` : "");
  }

  // Toggle BPM row — only relevant for melody mode
  document.getElementById("midi-mode")?.addEventListener("change", function () {
    const row = _bpmRow();
    if (row) row.style.display = this.value === "melody" ? "flex" : "none";
  });

  document.getElementById("btn-midi-extract")?.addEventListener("click", async () => {
    const fileEl = _fileEl();
    if (!fileEl || !fileEl.files.length) {
      _setStatus("Please select an audio file.", "var(--error, #e53935)");
      return;
    }

    const file = fileEl.files[0];
    const mode = _modeEl()?.value || "melody";
    const bpm  = parseFloat(_bpmEl()?.value) || 120.0;

    const form = new FormData();
    form.append("file", file);
    form.append("mode", mode);
    form.append("bpm", bpm);

    const dlEl = _dlEl();
    if (dlEl) { dlEl.style.display = "none"; dlEl.href = "#"; }
    _infoEl() && (_infoEl().style.display = "none");
    _setStatus("Extracting…");
    document.getElementById("btn-midi-extract").disabled = true;

    try {
      const r = await fetch("/midi/extract", { method: "POST", body: form });

      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        _setStatus(`Error: ${err.error || r.statusText}`, "var(--error, #e53935)");
        return;
      }

      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);

      const noteCount  = r.headers.get("X-Note-Count") || "?";
      const pitchRange = r.headers.get("X-Pitch-Range") || "—";
      const duration   = r.headers.get("X-Duration") || "0";
      const modeBack   = r.headers.get("X-Mode") || mode;

      _showInfo({ mode: modeBack, note_count: noteCount, pitch_range: pitchRange, duration_s: duration });

      const stem = file.name.replace(/\.[^.]+$/, "");
      if (dlEl) {
        dlEl.href = url;
        dlEl.download = `${stem}_${mode}.mid`;
        dlEl.style.display = "inline-block";
        dlEl.textContent = `⬇ Download ${stem}_${mode}.mid`;
      }

      _setStatus(`Done — ${noteCount} notes extracted.`, "#4caf50");
    } catch (err) {
      _setStatus(`Failed: ${err}`, "var(--error, #e53935)");
    } finally {
      document.getElementById("btn-midi-extract").disabled = false;
    }
  });
})();
