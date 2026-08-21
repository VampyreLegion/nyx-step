// ── Groove Lab tab ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("groovelab-send");
  const fileInput = document.getElementById("groovelab-file");
  const nameInput = document.getElementById("groovelab-name");
  const status = document.getElementById("groovelab-status");

  if (!btn) return;

  btn.addEventListener("click", async () => {
    const file = fileInput?.files?.[0];
    if (!file) {
      status.textContent = "Select a groove audio file first.";
      status.style.color = "var(--error, #f38ba8)";
      return;
    }

    const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, "");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);

    btn.disabled = true;
    status.textContent = "Uploading to DAW library…";
    status.style.color = "var(--muted)";

    try {
      const res = await fetch("/groovelab/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.ok) {
        status.innerHTML = `✓ <strong>"${name}"</strong> added to DAW Clip Library — <a href="#" id="groovelab-goto-daw" style="color:var(--accent2,#00d4b6)">switch to DAW tab →</a>`;
        status.style.color = "var(--accent2, #00d4b6)";
        fileInput.value = "";
        nameInput.value = "";
        // Wire "switch to DAW" link
        const gotoDaw = document.getElementById("groovelab-goto-daw");
        if (gotoDaw) {
          gotoDaw.addEventListener("click", e => {
            e.preventDefault();
            const dawBtn = document.querySelector('.tab-btn[data-tab="daw"]');
            if (dawBtn) dawBtn.click();
          });
        }
      } else {
        status.textContent = "Error: " + (data.error || "upload failed");
        status.style.color = "var(--error, #f38ba8)";
      }
    } catch (e) {
      status.textContent = "Upload failed: " + e.message;
      status.style.color = "var(--error, #f38ba8)";
    } finally {
      btn.disabled = false;
    }
  });
});
