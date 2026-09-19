(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function _statusEl(text, color) {
    const el = $("artwork-status");
    if (el) {
      el.textContent = text;
      el.style.color = color || "var(--muted)";
    }
  }

  function _showResult(data) {
    const box = $("artwork-result");
    const preview = $("artwork-preview");
    const meta = $("artwork-meta");
    const downloadBtn = $("artwork-download-btn");

    if (!box || !preview || !meta) return;

    box.style.display = "block";
    preview.innerHTML = `<img src="/download/${encodeURIComponent(data.filename)}" style="max-width:256px;border-radius:8px;border:1px solid var(--border)">`;
    meta.innerHTML = `
      <div>Prompt: ${data.prompt.slice(0, 120)}${data.prompt.length > 120 ? "…" : ""}</div>
      <div>Model: ${data.model || "sdxl"} | ${data.dimensions || "1024x1024"} | Steps: ${data.steps || "?"} | Seed: ${data.seed || "random"}</div>
    `;

    downloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = `/download/${encodeURIComponent(data.filename)}`;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  }

  function _buildPayload() {
    const mode = $("artwork-mode").value;
    const model = $("artwork-model").value;
    const width = parseInt($("artwork-width").value, 10) || 1024;
    const height = parseInt($("artwork-height").value, 10) || 1024;
    const steps = parseInt($("artwork-steps").value, 10) || 20;
    const cfg = parseFloat($("artwork-cfg").value) || 7.0;
    const seed = parseInt($("artwork-seed").value, 10) || 0;

    if (mode === "lyrics") {
      const lyrics = $("artwork-lyrics").value.trim();
      if (!lyrics) {
        _statusEl("Enter lyrics first", "#e06c5a");
        return null;
      }
      const style = $("artwork-style").value.trim() || "album cover art, vibrant, professional, evocative, no text";
      const genre = $("artwork-genre").value.trim();
      const mood = $("artwork-mood").value.trim();
      return {
        lyrics,
        song_name: "Artwork",
        style,
        genre,
        mood,
        width,
        height,
        steps,
        cfg,
        seed,
      };
    } else {
      const prompt = $("artwork-prompt").value.trim();
      if (!prompt) {
        _statusEl("Enter a prompt first", "#e06c5a");
        return null;
      }
      const negative = $("artwork-negative").value.trim();
      return {
        prompt,
        song_name: "Artwork",
        width,
        height,
        steps,
        cfg,
        seed,
        model,
        negative_prompt: negative,
      };
    }
  }

  async function generateArtwork() {
    const btn = $("artwork-generate-btn");
    const payload = _buildPayload();
    if (!payload) return;

    btn.disabled = true;
    _statusEl("Generating artwork… this may take 30s–3min depending on model", "#e0a04a");
    $("artwork-result").style.display = "none";

    const endpoint = payload.lyrics ? "/api/artwork/from-lyrics" : "/api/artwork/generate";
    const body = payload.lyrics ? {
      lyrics: payload.lyrics,
      song_name: payload.song_name,
      style: payload.style,
      genre: payload.genre,
      mood: payload.mood,
      width: payload.width,
      height: payload.height,
      steps: payload.steps,
      cfg: payload.cfg,
      seed: payload.seed,
    } : {
      prompt: payload.prompt,
      song_name: payload.song_name,
      width: payload.width,
      height: payload.height,
      steps: payload.steps,
      cfg: payload.cfg,
      seed: payload.seed,
      model: payload.model,
      negative_prompt: payload.negative_prompt,
    };

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.error) {
        _statusEl("Generation failed: " + data.error, "#e06c5a");
        return;
      }
      _statusEl("Artwork generated ✓", "#7ec699");
      _showResult(data);
    } catch (e) {
      _statusEl("Request failed: " + e, "#e06c5a");
    } finally {
      btn.disabled = false;
    }
  }

  function useCurrentLyrics() {
    const lyricsEl = $("lyrics-editor");
    const artworkLyricsEl = $("artwork-lyrics");
    if (lyricsEl && artworkLyricsEl) {
      artworkLyricsEl.value = lyricsEl.value;
      _statusEl("Copied lyrics from Lyrics tab", "#7ec699");
    }
  }

  function togglePanels() {
    const mode = $("artwork-mode").value;
    $("artwork-lyrics-panel").style.display = mode === "lyrics" ? "" : "none";
    $("artwork-prompt-panel").style.display = mode === "prompt" ? "" : "none";

    if (mode === "prompt") {
      $("artwork-model").value = "sdxl_turbo";
      $("artwork-steps").value = "4";
      $("artwork-cfg").value = "1.0";
    } else {
      $("artwork-model").value = "sdxl";
      $("artwork-steps").value = "20";
      $("artwork-cfg").value = "7.0";
    }
  }

  function wireEvents() {
    $("artwork-generate-btn")?.addEventListener("click", generateArtwork);
    $("artwork-use-lyrics-btn")?.addEventListener("click", useCurrentLyrics);
    $("artwork-mode")?.addEventListener("change", togglePanels);
  }

  document.addEventListener("DOMContentLoaded", wireEvents);
})();