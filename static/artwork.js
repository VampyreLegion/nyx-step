(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let _pollTimer = null;

  function _statusEl(text, color) {
    const el = $("artwork-status");
    if (el) {
      el.textContent = text;
      el.style.color = color || "var(--muted)";
    }
  }

  function _cancelPoll() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  function _selectedSongName() {
    const sel = $("artwork-song-select");
    if (sel && sel.selectedIndex > 0) {
      return sel.options[sel.selectedIndex].textContent.trim();
    }
    return "Artwork";
  }

  function _showResult(data, promptId) {
    const box = $("artwork-result");
    const preview = $("artwork-preview");
    const meta = $("artwork-meta");
    const downloadBtn = $("artwork-download-btn");

    if (!box || !preview || !meta) return;

    box.style.display = "block";
    const src = `/api/artwork/image/${encodeURIComponent(promptId)}?t=${Date.now()}`;
    const dlName = data.filename || filenameFromId(promptId);
    preview.innerHTML = `<img src="${src}" style="max-width:256px;border-radius:8px;border:1px solid var(--border)">`;
    meta.innerHTML = `
      <div>Prompt: ${(data.prompt || "").slice(0, 120)}${(data.prompt || "").length > 120 ? "…" : ""}</div>
      <div>Model: ${data.model || "sdxl"} | ${data.dimensions || "1024x1024"} | Steps: ${data.steps || "?"} | Seed: ${data.seed || "random"}</div>
    `;

    downloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = src;
      a.download = dlName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  }

  function filenameFromId(promptId) {
    return `cover_${(promptId || "artwork").slice(0, 8)}.png`;
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
        _statusEl("Enter lyrics (or select a song above) first", "#e06c5a");
        return null;
      }
      const style = $("artwork-style").value.trim() || "album cover art, vibrant, professional, evocative, no text";
      const genre = $("artwork-genre").value.trim();
      const mood = $("artwork-mood").value.trim();
      return {
        lyrics,
        song_name: _selectedSongName(),
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
        song_name: _selectedSongName(),
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
    if (_pollTimer) return; // already generating

    const btn = $("artwork-generate-btn");
    const payload = _buildPayload();
    if (!payload) return;

    btn.disabled = true;
    _statusEl("Submitting artwork job…", "#e0a04a");
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

      let data = {};
      try {
        data = await resp.json();
      } catch (jsonErr) {
        const text = await resp.text().catch(() => "");
        const friendly = text.includes("<!DOCTYPE")
          ? `the server/proxy returned an HTML page (HTTP ${resp.status}) — the job may have been submitted but this tab couldn't read it. Switch to a saved song flow or refresh and retry.`
          : (text || resp.statusText);
        _statusEl(`Request failed: ${friendly}`, "#e06c5a");
        btn.disabled = false;
        return;
      }

      if (data.error) {
        _statusEl("Generation failed: " + data.error, "#e06c5a");
        btn.disabled = false;
        return;
      }
      if (!data.prompt_id) {
        _statusEl("Generation failed: no prompt_id returned", "#e06c5a");
        btn.disabled = false;
        return;
      }
      startPoll(data);
    } catch (e) {
      _statusEl("Request failed: " + e, "#e06c5a");
      btn.disabled = false;
    }
  }

  function startPoll(data) {
    const promptId = data.prompt_id;
    const btn = $("artwork-generate-btn");
    const modelLabel = $("artwork-model")?.selectedOptions?.[0]?.textContent || "SDXL";
    const t0 = Date.now();

    _statusEl(
      `Artwork queued — generating on ${modelLabel}… (can take 1–4 min). Keep this tab open — it now runs in the background and won't time out.`,
      "#e0a04a"
    );

    _pollTimer = setInterval(async () => {
      try {
        const resp = await fetch(`/api/artwork/status/${encodeURIComponent(promptId)}`);
        const st = await resp.json();
        if (st.status === "done") {
          _cancelPoll();
          _statusEl("Artwork generated ✓", "#7ec699");
          _showResult(st, promptId);
          btn.disabled = false;
        } else if (st.status === "error" || st.status === "timeout") {
          _cancelPoll();
          _statusEl("Generation failed: " + (st.error || st.status), "#e06c5a");
          btn.disabled = false;
        } else if (Date.now() - t0 > 8 * 60 * 1000) {
          _cancelPoll();
          _statusEl("Still waiting on ComfyUI — leaving this tab open lets it finish.", "#e0a04a");
          btn.disabled = false;
        }
      } catch (e) {
        // transient network hiccup — keep polling
      }
    }, 2500);
  }

  // ── Song selection — pull lyrics from a generated song ────────────────────
  async function loadSongList() {
    const sel = $("artwork-song-select");
    if (!sel) return;
    try {
      const data = await (await fetch("/api/library")).json();
      const files = (data.files || []).filter((f) => f.name.toLowerCase().endsWith(".mp3"));
      sel.innerHTML = `<option value="">— Select a song to pull its lyrics —</option>`;
      files.forEach((f) => {
        const opt = document.createElement("option");
        opt.value = f.name;
        opt.textContent = f.name;
        sel.appendChild(opt);
      });
    } catch (e) {
      sel.innerHTML = `<option value="">Failed to load songs</option>`;
    }
  }

  async function onArtworkSongChange() {
    const sel = $("artwork-song-select");
    if (!sel) return;
    const fname = sel.value;
    if (!fname) return;

    const slug = fname.split("/").map(encodeURIComponent).join("/");
    try {
      const meta = await (await fetch(`/meta/${slug}`)).json();
      if (!meta || meta.error) throw new Error((meta && meta.error) || "no metadata");

      const lyrics = (meta.lyrics || "").trim();
      const lyricsEl = $("artwork-lyrics");
      if (lyricsEl) lyricsEl.value = lyrics;

      // Pull style hints from the song's generation metadata where available
      const params = meta.params || {};
      if (params.genre && $("artwork-genre")) {
        const g = String(params.genre).toLowerCase().trim();
        const known = Array.from($("artwork-genre").options).some((o) => o.value === g);
        $("artwork-genre").value = known ? g : "";
      }
      if (params.mood && $("artwork-mood")) {
        const m = String(params.mood).toLowerCase().trim();
        const known = Array.from($("artwork-mood").options).some((o) => o.value === m);
        $("artwork-mood").value = known ? m : "";
      }
      if (params.caption && $("artwork-style") && !$("artwork-style").value.trim()) {
        $("artwork-style").value = params.caption;
      }

      const caption = meta.caption || params.caption || "";
      _statusEl(
        lyrics
          ? `Lyrics loaded from ${fname} (${lyrics.split("\n").length} lines)`
          : `No saved lyrics for ${fname} — ${caption ? "will base cover on its tags (" + String(caption).slice(0, 60) + ")" : "trying anyway"}`,
        "#7ec699"
      );

      const auto = $("artwork-auto-gen") && $("artwork-auto-gen").checked;
      if (auto) setTimeout(generateArtwork, 400);
    } catch (e) {
      _statusEl("Could not load song: " + e.message, "#e06c5a");
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
    $("artwork-song-select")?.addEventListener("change", onArtworkSongChange);
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireEvents();
    loadSongList();
    // Refresh the song list each time the Artwork tab is opened
    document.querySelector('[data-tab="artwork"]')?.addEventListener("click", loadSongList);
  });
})();