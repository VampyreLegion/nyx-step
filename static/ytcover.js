document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-ytcover-submit");
  if (!btn) return;

  function showYtPlayer(files) {
    const status = document.getElementById("ytcover-status");
    const result = document.getElementById("ytcover-result");
    status.textContent = "✓ Done — audio ready";
    status.style.color = "var(--accent2)";
    result.innerHTML = "";
    const bust = "?t=" + Date.now();

    files.forEach(f => {
      const row = document.createElement("div");
      row.style.cssText = "margin-top:8px";

      const a = document.createElement("a");
      a.href = "/download/" + encodeURIComponent(f) + bust;
      a.download = f;
      a.textContent = "⬇ " + f;
      a.style.cssText = "color:var(--accent2);font-size:13px;";

      const waveDiv = document.createElement("div");
      waveDiv.style.cssText = "width:100%;border-radius:4px;overflow:hidden;cursor:pointer;margin-top:6px;";

      const controls = document.createElement("div");
      controls.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;";

      const playBtn = document.createElement("button");
      playBtn.className = "secondary small";
      playBtn.textContent = "▶";
      playBtn.style.cssText = "font-size:13px;padding:2px 10px;min-width:36px;";

      const timeEl = document.createElement("span");
      timeEl.style.cssText = "font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;";
      timeEl.textContent = "0:00 / 0:00";

      controls.appendChild(playBtn);
      controls.appendChild(timeEl);
      row.appendChild(a);
      row.appendChild(waveDiv);
      row.appendChild(controls);
      result.appendChild(row);

      const audioSrc = "/download/" + encodeURIComponent(f) + bust;
      if (typeof WaveSurfer !== "undefined") {
        const cs = getComputedStyle(document.documentElement);
        const waveColor = cs.getPropertyValue("--border").trim() || "#444";
        const progressColor = cs.getPropertyValue("--accent").trim() || "#7c3aed";
        const ws = WaveSurfer.create({
          container: waveDiv,
          waveColor,
          progressColor,
          height: 40,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          url: audioSrc,
          interact: true,
        });
        const fmt = s => {
          const m = Math.floor(s / 60), sec = Math.floor(s % 60);
          return `${m}:${sec.toString().padStart(2, "0")}`;
        };
        ws.on("ready", () => { timeEl.textContent = `0:00 / ${fmt(ws.getDuration())}`; });
        ws.on("timeupdate", t => { timeEl.textContent = `${fmt(t)} / ${fmt(ws.getDuration())}`; });
        ws.on("play", () => { playBtn.textContent = "⏸"; });
        ws.on("pause", () => { playBtn.textContent = "▶"; });
        ws.on("finish", () => { playBtn.textContent = "▶"; });
        playBtn.addEventListener("click", () => ws.playPause());
      } else {
        const audioEl = document.createElement("audio");
        audioEl.controls = true;
        audioEl.src = audioSrc;
        audioEl.style.cssText = "width:100%;height:36px;";
        waveDiv.replaceWith(audioEl);
      }
    });
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
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
      status.textContent = "Downloading…";
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
      if (data.files && data.files.length > 0) {
        showYtPlayer(data.files);
      } else {
        status.textContent = "Error: No files returned";
        status.style.color = "var(--error)";
      }
    } catch (e) {
      status.textContent = "Error: " + e.message;
      status.style.color = "var(--error)";
    } finally {
      btn.disabled = false;
      btn.textContent = "Fetch & Cover";
    }
  });
});
