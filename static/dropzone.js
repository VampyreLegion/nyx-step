// ── Shared drag-and-drop for audio file inputs ─────────────────────────────────
// Wire any element with data-dropzone="<input-id>" to accept dragged audio files.
// Adds a visible drop-zone border on dragover; drops set the input files and
// fire both "change" and "input" events so existing handlers trigger normally.
(function () {
  function _wire(zone) {
    const inputId = zone.dataset.dropzone;
    const input   = document.getElementById(inputId);
    if (!input) return;

    zone.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      zone.classList.add("dz-over");
    });
    zone.addEventListener("dragleave", e => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("dz-over");
    });
    zone.addEventListener("drop", e => {
      e.preventDefault();
      zone.classList.remove("dz-over");
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("audio/") || /\.(mp3|flac|wav|ogg|m4a|opus|aac)$/i.test(f.name));
      if (!files.length) return;
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      // Update label if present
      const lbl = zone.querySelector(".dz-label");
      if (lbl) lbl.textContent = files[0].name;
    });
    // Also update label on normal file-picker selection
    input.addEventListener("change", () => {
      const lbl = zone.querySelector(".dz-label");
      if (lbl && input.files.length) lbl.textContent = input.files[0].name;
    });
  }

  document.querySelectorAll("[data-dropzone]").forEach(_wire);
})();
