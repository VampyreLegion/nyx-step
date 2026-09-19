(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let _coverFile = null;
  let _authState = { configured: false, authed: false };
  let _pollTimers = [];

  function _statusEl(text, color) {
    const el = $("youtube-upload-status");
    if (el) {
      el.textContent = text;
      el.style.color = color || "var(--muted)";
    }
  }

  async function refreshAuth() {
    let status = {};
    try {
      const resp = await fetch("/youtube/auth/status");
      status = await resp.json();
    } catch (e) {
      status = {};
    }
    _authState = status;

    const area = $("youtube-auth-area");
    const setup = $("youtube-auth-setup");
    if (!area) return;

    if (!status.configured) {
      area.innerHTML = `<span style="font-size:12px;color:#e0a04a">⚠ Not configured — see setup below</span>`;
      if (setup) setup.style.display = "";
      return;
    }
    if (status.authed) {
      if (setup) setup.style.display = "none";
      const name = (status.channel && status.channel.title) || "YouTube";
      area.innerHTML = `
        <span style="font-size:12px;color:#7ec699">✓ Connected to ${name}</span>
        <button class="secondary small" id="youtube-auth-logout" style="font-size:11px;margin-left:8px">Disconnect</button>`;
      $("youtube-auth-logout")?.addEventListener("click", async () => {
        await fetch("/youtube/auth/logout", { method: "POST" });
        refreshAuth();
      });
    } else {
      if (setup) setup.style.display = "none";
      area.innerHTML = `
        <button class="small" id="youtube-auth-connect" style="background:var(--accent);color:#fff;padding:8px 14px;border:none;border-radius:6px">Connect YouTube</button>`;
      $("youtube-auth-connect")?.addEventListener("click", startAuth);
    }
  }

  async function startAuth() {
    _statusEl("Opening Google auth…", "#e0a04a");
    try {
      const resp = await fetch("/youtube/auth/url", { method: "POST" });
      const data = await resp.json();
      if (data.error) {
        _statusEl("Auth error: " + data.error, "#e06c5a");
        return;
      }
      window.open(data.url, "_blank", "noopener,width=700,height=650");
      _statusEl("Approve in the popup, then click “Verify” below.", "#e0a04a");
      setTimeout(verifyAuth, 2500);
    } catch (e) {
      _statusEl("Auth failed: " + e, "#e06c5a");
    }
  }

  async function verifyAuth() {
    setTimeout(async () => {
      await refreshAuth();
      if (_authState.authed) {
        _statusEl("Connected ✓", "#7ec699");
        $("youtube-auth-setup").style.display = "none";
        loadSongList();
      } else {
        _statusEl("Not connected yet — click Verify again if you approved.", "#e0a04a");
      }
    }, 1200);
  }

  async function loadSongList() {
    const sel = $("youtube-song-select");
    if (!sel) return;
    try {
      const data = await (await fetch("/api/library")).json();
      const files = (data.files || []).filter((f) => f.name.toLowerCase().endsWith(".mp3"));
      sel.innerHTML = "";
      if (!files.length) {
        sel.innerHTML = `<option value="">No MP3s found in library</option>`;
        return;
      }
      files.forEach((f) => {
        const opt = document.createElement("option");
        opt.value = f.name;
        opt.textContent = f.name;
        sel.selectedIndex = 0;
        sel.appendChild(opt);
      });
      sel.dispatchEvent(new Event("change"));
    } catch (e) {
      sel.innerHTML = `<option value="">Failed to load library</option>`;
    }
  }

  async function onSongChange() {
    const sel = $("youtube-song-select");
    const metaEl = $("youtube-song-meta");
    const descEl = $("youtube-description");
    if (!sel || !metaEl) return;
    const fname = sel.value;
    if (!fname) {
      metaEl.textContent = "";
      if (descEl) descEl.value = "";
      return;
    }
    const slug = fname.split("/").map(encodeURIComponent).join("/");
    try {
      const meta = await (await fetch(`/meta/${slug}`)).json();
      const params = meta.params || {};
      let parts = [];
      const name = meta.song_name || meta.caption ? "song" : "";
      const bpm = params.bpm ? `BPM ${params.bpm}` : "";
      const key = params.key ? `${params.key} ${params.scale || ""}`.trim() : "";
      parts = [name, bpm, key, meta.caption ? `tags: ${String(meta.caption).slice(0, 80)}` : ""].filter(Boolean);
      metaEl.textContent = parts.join(" · ");
      if (!$("youtube-title").value) $("youtube-title").value = meta.song_name || "";

      // Build rich description from lyrics + metadata
      if (descEl && meta.lyrics) {
        descEl.value = buildYouTubeDescription(meta.lyrics, params, meta.caption || "");
      } else if (descEl) {
        // Fallback: basic metadata
        let descParts = [];
        if (meta.caption) descParts.push(`Style: ${meta.caption}`);
        if (params.bpm) descParts.push(`BPM: ${params.bpm}`);
        if (params.key && params.scale) descParts.push(`Key: ${params.key} ${params.scale}`);
        if (params.genre) descParts.push(`Genre: ${params.genre}`);
        descParts.push("\nGenerated with Nyx-Step AI — https://nyxstudios.net");
        if (meta.seed) descParts.push(`Seed: ${meta.seed}`);
        descEl.value = descParts.join("\n");
      }
    } catch (e) {
      metaEl.textContent = "";
    }
  }

  function buildYouTubeDescription(lyrics, params, caption) {
    // Extract key visual/conceptual themes from lyrics (simplified version of artwork logic)
    const cleanLines = lyrics.split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("["))
      .map(l => l.replace(/\([^)]*\)/g, ""))
      .filter(l => l);

    const text = cleanLines.slice(0, 6).join(" ");

    // Detect genre/style from caption/params
    const genre = (params.genre || "").toLowerCase();
    const bpm = params.bpm ? `BPM ${params.bpm}` : "";
    const key = params.key && params.scale ? `Key: ${params.key} ${params.scale}` : "";
    const mood = params.mood || "";

    // Build description sections
    const sections = [];

    // Main description from lyrics
    if (text) {
      sections.push(text.slice(0, 300) + (text.length > 300 ? "…" : ""));
    }

    // Technical details
    const tech = [bpm, key, genre ? `Genre: ${params.genre}` : "", caption ? `Style: ${caption}` : ""].filter(Boolean);
    if (tech.length) sections.push(tech.join(" | "));

    // Links / credits
    sections.push("\n🎵 Generated with Nyx-Step AI");
    sections.push("🌐 https://nyxstudios.net");
    sections.push("🎨 Artwork: AI-generated from lyrics");

    if (params.seed) sections.push(`🔢 Seed: ${params.seed}`);
    if (params.dit_model) sections.push(`🤖 Model: ACE-Step ${params.dit_model}`);

    // Hashtags from key concepts
    const hashtags = extractHashtags(text, genre);
    if (hashtags) sections.push(`\n${hashtags}`);

    return sections.join("\n\n");
  }

  function extractHashtags(text, genre) {
    const tags = new Set();
    const genreTags = {
      "synthwave": ["synthwave", "retrowave", "outrun", "80s", "neon"],
      "cyberpunk": ["cyberpunk", "neon", "futuristic", "dystopian", "scifi"],
      "ambient": ["ambient", "atmospheric", "chill", "meditation", "soundscapes"],
      "lo-fi": ["lofi", "lofihiphop", "chillhop", "studybeats", "relax"],
      "hip hop": ["hiphop", "rap", "beats", "boombap"],
      "trap": ["trap", "808", "hardhitting"],
      "edm": ["edm", "electronic", "dance", "festival"],
      "house": ["house", "deephouse", "dancemusic"],
      "techno": ["techno", "underground", "warehouse", "minimal"],
      "trance": ["trance", "uplifting", "progressive", "euphoric"],
      "drum and bass": ["dnb", "drumandbass", "liquid", "jungle"],
      "dubstep": ["dubstep", "bassmusic", "heavybass"],
      "pop": ["pop", "popmusic", "catchy"],
      "rock": ["rock", "guitar", "band", "livemusic"],
      "metal": ["metal", "heavymetal", "headbanging"],
      "jazz": ["jazz", "smoothjazz", "improvisation"],
      "classical": ["classical", "orchestral", "cinematic"],
      "folk": ["folk", "acoustic", "singer-songwriter"],
      "country": ["country", "americana", "storytelling"],
      "r&b": ["rnb", "soul", "smooth"],
      "funk": ["funk", "groove", "bass"],
      "reggae": ["reggae", "dub", "islandvibes"],
      "latin": ["latin", "reggaeton", "afrobeat", "spanish"],
      "indie": ["indie", "alternative", "underground"],
      "experimental": ["experimental", "avantgarde", "noise"],
    };

    if (genre && genreTags[genre]) {
      genreTags[genre].forEach(t => tags.add(t));
    }

    // Extract from lyrics
    const visualKeywords = [
      "neon", "city", "night", "midnight", "rain", "fire", "water", "ocean",
      "space", "stars", "moon", "sun", "dawn", "dusk", "sunset", "sunrise",
      "dream", "memory", "love", "heart", "soul", "mind", "time", "journey",
      "road", "highway", "path", "mountain", "forest", "river", "sky", "cloud",
      "light", "dark", "shadow", "glow", "electric", "digital", "synthetic",
      "hope", "pain", "joy", "sorrow", "rage", "peace", "freedom", "freedom"
    ];

    const lower = text.toLowerCase();
    visualKeywords.forEach(kw => {
      if (lower.includes(kw)) tags.add(kw);
    });

    return Array.from(tags).slice(0, 12).map(t => `#${t}`).join(" ");
  }

  function setupImageInput() {
    const input = $("youtube-image-input");
    const clearBtn = $("youtube-cover-clear");
    const preview = $("youtube-cover-preview");
    if (!input) return;
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) return;
      _coverFile = f;
      if (clearBtn) clearBtn.style.display = "inline-block";
      if (preview) {
        const url = URL.createObjectURL(f);
        preview.innerHTML = `<img src="${url}" style="max-height:120px;border-radius:6px;border:1px solid var(--border)">`;
      }
    });
    clearBtn?.addEventListener("click", () => {
      _coverFile = null;
      input.value = "";
      clearBtn.style.display = "none";
      if (preview) preview.innerHTML = "";
    });
  }

  function startPolling(jobId) {
    const iv = setInterval(async () => {
      try {
        const data = await (await fetch(`/youtube/upload/${jobId}`)).json();
        if (data.status === "done") {
          clearInterval(iv);
          renderResult(data);
        } else if (data.status === "error") {
          clearInterval(iv);
          _statusEl("Upload failed: " + (data.error || "unknown error"), "#e06c5a");
          $("youtube-upload-btn").disabled = false;
        } else if (data.status === "running") {
          _statusEl(`Working… ${data.progress || 0}% ${data.note ? "— " + data.note : ""}`, "#e0a04a");
        }
      } catch (e) {
        // transient — keep polling
      }
    }, 2500);
    _pollTimers.push(iv);
  }

  function renderResult(data) {
    const box = $("youtube-result");
    if (!box) return;
    box.style.display = "block";
    const link = data.url ? `<a href="${data.url}" target="_blank" rel="noopener" style="color:#7ec699;font-weight:600">Open on YouTube →</a>` : "Uploaded";
    box.innerHTML = `
      <div style="font-weight:600;color:#7ec699;margin-bottom:6px">✓ Uploaded!</div>
      <div style="font-size:13px">${link} ${data.privacy ? "(<code>" + data.privacy + "</code>)" : ""}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">video id: ${data.video_id || "—"}</div>`;
    $("youtube-upload-btn").disabled = false;
  }

  async function doUpload() {
    const btn = $("youtube-upload-btn");
    const fname = $("youtube-song-select")?.value;
    if (!fname) {
      _statusEl("Pick a song first", "#e06c5a");
      return;
    }
    btn.disabled = true;
    _statusEl("Preparing upload…", "#e0a04a");
    $("youtube-result").style.display = "none";

    const form = new FormData();
    form.append("filename", fname);
    form.append("title", $("youtube-title")?.value || "");
    form.append("description", $("youtube-description")?.value || "");
    form.append("privacy", $("youtube-privacy")?.value || "private");
    form.append("karaoke", $("youtube-karaoke")?.checked ? "true" : "false");
    form.append("captions", $("youtube-captions")?.checked ? "true" : "false");
    form.append("ai_cover", $("youtube-ai-cover")?.checked ? "true" : "false");
    if (_coverFile) form.append("image", _coverFile);

    try {
      const resp = await fetch("/youtube/upload", { method: "POST", body: form });
      const data = await resp.json();
      if (data.error) {
        _statusEl("Upload failed: " + data.error, "#e06c5a");
        btn.disabled = false;
        return;
      }
      _statusEl("Queued — building video & uploading…", "#e0a04a");
      startPolling(data.job_id);
    } catch (e) {
      _statusEl("Request failed: " + e, "#e06c5a");
      btn.disabled = false;
    }
  }

  async function doDownload() {
    const btn = $("youtube-download-btn");
    const fname = $("youtube-song-select")?.value;
    if (!fname) {
      _statusEl("Pick a song first", "#e06c5a");
      return;
    }
    if (btn) btn.disabled = true;
    _statusEl("Building video… this can take a minute", "#e0a04a");
    $("youtube-result").style.display = "none";

    const form = new FormData();
    form.append("filename", fname);
    form.append("title", $("youtube-title")?.value || "");
    form.append("description", $("youtube-description")?.value || "");
    form.append("karaoke", $("youtube-karaoke")?.checked ? "true" : "false");
    form.append("ai_cover", $("youtube-ai-cover")?.checked ? "true" : "false");
    if (_coverFile) form.append("image", _coverFile);

    try {
      const resp = await fetch("/youtube/prepare", { method: "POST", body: form });
      if (!resp.ok) {
        let msg = "build failed";
        try { msg = (await resp.json()).error || msg; } catch (e) {}
        _statusEl("Build failed: " + msg, "#e06c5a");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = _downloadName(resp, fname);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      _statusEl("Video ready — download started. Upload it at studio.youtube.com.", "#7ec699");
    } catch (e) {
      _statusEl("Request failed: " + e, "#e06c5a");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function _downloadName(resp, fallback) {
    const cd = resp.headers.get("content-disposition") || "";
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
    if (m && m[1]) return decodeURIComponent(m[1]);
    return fallback.replace(/\.mp3$/i, ".mp4") || "nyx-step.mp4";
  }

  function wireEvents() {
    $("youtube-upload-btn")?.addEventListener("click", doUpload);
    $("youtube-download-btn")?.addEventListener("click", doDownload);
    $("youtube-song-select")?.addEventListener("change", onSongChange);
    setupImageInput();
    refreshAuth().then(loadSongList);
  }

  // Tab switch hook — refresh auth status each time the YouTube tab opens
  document.addEventListener("DOMContentLoaded", () => {
    wireEvents();
    const tabBtn = document.querySelector('[data-tab="youtube"]');
    tabBtn?.addEventListener("click", () => {
      refreshAuth();
      loadSongList();
    });
  });
})();