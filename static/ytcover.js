document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-ytcover-submit");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const status = document.getElementById("ytcover-status");
    const result = document.getElementById("ytcover-result");
    const urlEl  = document.getElementById("ytcover-url");

    const url = urlEl.value.trim();
    if (!url) { status.textContent = "Enter a YouTube URL first."; return; }

    btn.disabled = true;
    btn.textContent = "Downloading…";
    status.textContent = "Downloading audio from YouTube…";
    status.style.color = "var(--muted)";
    result.innerHTML = "";

    const body = {
      url,
      tags:      document.getElementById("ytcover-tags").value.trim(),
      lyrics:    document.getElementById("ytcover-lyrics").value,
      song_name: document.getElementById("ytcover-song-name").value || "YouTube Cover",
      denoise:   parseFloat(document.getElementById("ytcover-denoise").value) || 0.75,
      steps:     parseInt(document.getElementById("ytcover-steps").value) || 20,
      cfg_scale: parseFloat(document.getElementById("ytcover-cfg").value) || 7.0,
      duration:  parseFloat(document.getElementById("ytcover-duration").value) || 30,
    };

    try {
      status.textContent = "Generating cover…";
      const resp = await fetch("/youtube/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        status.textContent = "Error: " + (data.error || resp.statusText);
        status.style.color = "var(--error)";
        return;
      }
      status.textContent = `Queued — prompt ${data.prompt_id.slice(0, 8)}… (position ${data.queue_position})`;
      status.style.color = "var(--accent2)";
    } catch (e) {
      status.textContent = "Error: " + e.message;
      status.style.color = "var(--error)";
    } finally {
      btn.disabled = false;
      btn.textContent = "Fetch & Cover";
    }
  });
});
