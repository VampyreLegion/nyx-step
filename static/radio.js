// ── Nyx Radio ─────────────────────────────────────────────────────────────────
// Manual mode: user sets style; Ollama writes a full song with lyrics per segment
// Auto DJ: AI picks styles and writes complete songs autonomously

(function () {
  let _sse = null;
  let _playlist = [];    // {file, url, segment, song_name, style}
  let _playing = false;
  let _currentIdx = -1;
  let _active = false;
  let _mode = "manual";  // "manual" | "auto"
  let _bufferCount = 2;  // segments to queue before starting playback

  const btn      = () => document.getElementById("btn-radio-toggle");
  const stat     = () => document.getElementById("radio-status");
  const title    = () => document.getElementById("radio-now-playing");
  const styleEl  = () => document.getElementById("radio-style-display");
  const prog     = () => document.getElementById("radio-progress");
  const hist     = () => document.getElementById("radio-history");
  const audio    = () => document.getElementById("radio-audio");

  // ── Mode toggle ──────────────────────────────────────────────────────────────
  function _setMode(mode) {
    _mode = mode;
    const manualBtn  = document.getElementById("radio-mode-manual");
    const autoBtn    = document.getElementById("radio-mode-auto");
    const manualPanel = document.getElementById("radio-panel-manual");
    const autoPanel   = document.getElementById("radio-panel-auto");
    if (mode === "manual") {
      manualBtn.style.border  = "2px solid var(--accent)";
      manualBtn.style.color   = "var(--accent)";
      autoBtn.style.border    = "";
      autoBtn.style.color     = "";
      manualPanel.style.display = "";
      autoPanel.style.display   = "none";
    } else {
      autoBtn.style.border    = "2px solid var(--accent)";
      autoBtn.style.color     = "var(--accent)";
      manualBtn.style.border  = "";
      manualBtn.style.color   = "";
      autoPanel.style.display   = "";
      manualPanel.style.display = "none";
    }
  }

  // ── Status helpers ───────────────────────────────────────────────────────────
  function _setStatus(msg, col) {
    const el = stat();
    if (el) { el.textContent = msg; el.style.color = col || "var(--muted)"; }
  }

  function _setNowPlaying(songName, styleName) {
    const t = title();
    const s = styleEl();
    if (t) t.textContent = songName || "—";
    if (s) s.textContent = styleName || "";
  }

  function _addHistory(entry) {
    const el = hist();
    if (!el) return;
    const item = document.createElement("div");
    item.className = "radio-history-item";
    item.style.cssText = "font-size:11px;padding:5px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:flex-start";
    const label = entry.song_name
      ? `<span style="color:var(--text);font-weight:600">${entry.song_name}</span><br><span style="color:var(--muted);font-size:10px">${entry.file}</span>`
      : `<span style="color:var(--muted)">${entry.file}</span>`;
    item.innerHTML = `
      <span style="color:var(--muted);min-width:28px;padding-top:2px">S${String(entry.segment).padStart(3,"0")}</span>
      <div style="flex:1;overflow:hidden">${label}
        ${entry.style ? `<br><span style="color:var(--muted);font-size:10px;font-style:italic">${entry.style.slice(0,60)}${entry.style.length>60?"…":""}</span>` : ""}
      </div>
      <button onclick="playRadioFile('${entry.file}')" style="font-size:10px;padding:2px 6px;flex-shrink:0" title="Replay">▶</button>
      <a href="/download/${entry.file}" download style="font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:3px;color:var(--muted);text-decoration:none;flex-shrink:0" title="Download">⬇</a>
    `;
    el.prepend(item);
  }

  // ── Playback ─────────────────────────────────────────────────────────────────
  function _playIdx(idx) {
    const el = audio();
    if (!el || idx < 0 || idx >= _playlist.length) return;
    _currentIdx = idx;
    const seg = _playlist[idx];
    el.src = seg.url;
    el.play().catch(() => {});
    _setNowPlaying(seg.song_name || `Segment ${seg.segment}`, seg.style || "");
    _playing = true;
    const queued = _playlist.length - idx - 1;
    _setStatus(`▶ Playing${queued > 0 ? ` — ${queued} queued` : ""}`, "var(--accent)");
    _updateProgress();
  }

  function _onEnded() {
    const next = _currentIdx + 1;
    if (next < _playlist.length) {
      _playIdx(next);
    } else {
      _playing = false;
      if (_active) {
        _setStatus("⏳ Generating next segment…", "var(--muted)");
        _setNowPlaying("Generating next song…", "");
      } else {
        _setStatus("Stopped.", "var(--muted)");
        _setNowPlaying("—", "");
      }
    }
  }

  function _updateProgress() {
    const el = prog();
    const a = audio();
    if (!el || !a || !a.duration) { if (el) el.textContent = ""; return; }
    const cur = Math.floor(a.currentTime);
    const dur = Math.floor(a.duration);
    const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
    el.textContent = `${fmt(cur)} / ${fmt(dur)}`;
  }

  // ── SSE ───────────────────────────────────────────────────────────────────────
  function _connectSSE() {
    if (_sse) { _sse.close(); _sse = null; }
    _sse = new EventSource("/radio/events");

    _sse.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === "segment") {
        const entry = { file: msg.file, url: `/download/${msg.file}`, segment: msg.segment, song_name: msg.song_name || "", style: msg.style || "" };
        _playlist.push(entry);
        _addHistory(entry);
        if (!_playing) {
          if (_playlist.length >= _bufferCount) {
            _playIdx(0);
          } else {
            _setStatus(`⏳ Buffering… (${_playlist.length}/${_bufferCount} segments ready)`, "var(--muted)");
          }
        } else {
          const queued = _playlist.length - _currentIdx - 1;
          _setStatus(`▶ Playing — ${queued} queued`, "var(--accent)");
        }
      } else if (msg.type === "generating") {
        if (!_playing) _setStatus(`⏳ Writing song ${msg.segment}…`, "var(--muted)");
      } else if (msg.type === "stopped") {
        _active = false;
        btn().textContent = "📻 Start Radio";
        if (!_playing) { _setStatus("Stopped.", "var(--muted)"); _setNowPlaying("—", ""); }
        _sse.close(); _sse = null;
      } else if (msg.type === "error") {
        _setStatus("Error: " + msg.message, "var(--error)");
        _active = false;
        btn().textContent = "📻 Start Radio";
        _sse.close(); _sse = null;
      }
    };

    _sse.onerror = () => {
      if (_active) {
        _setStatus("Connection lost — reconnecting…", "var(--muted)");
        setTimeout(_connectSSE, 5000);
      }
    };
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────────
  async function _start() {
    _bufferCount = +(document.getElementById("radio-buffer")?.value) || 2;
    const bpm   = +(document.getElementById("radio-bpm")?.value)         || 90;
    const key   =  document.getElementById("radio-key")?.value           || "C";
    const scale =  document.getElementById("radio-scale")?.value         || "Major";
    const dur   = +(document.getElementById("radio-duration")?.value)    || 160;
    const steps = +(document.getElementById("radio-steps")?.value)       || 8;
    const timeSig =  document.getElementById("radio-timesig")?.value     || "4/4";
    const temp  = +(document.getElementById("radio-temperature")?.value) || 1.05;
    const s = mwState;

    const body = {
      mode: _mode,
      tags:           _mode === "manual" ? (document.getElementById("radio-tags")?.value || "") : "",
      style_override: _mode === "auto"   ? (document.getElementById("radio-style-override")?.value || "") : "",
      bpm, key, scale, duration: dur, steps,
      time_sig: timeSig,
      temperature: temp,
      top_p: 0.95,
      cfg:           s.cfg_scale    || 2.0,
      audio_format:  s.audio_format  || "mp3",
      audio_quality: s.audio_quality || "V0",
      dit_model:     s.dit_model     || "turbo",
      sampler_name:  s.sampler_name  || "er_sde",
      scheduler:     s.scheduler     || "linear_quadratic",
    };

    _setStatus("Asking Ollama to write the first song…", "var(--muted)");
    btn().disabled = true;

    try {
      const r = await fetch("/radio/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        _setStatus("Error: " + (data.error || r.status), "var(--error)");
        btn().disabled = false;
        return;
      }
      _active = true;
      _playlist = [];
      _currentIdx = -1;
      _playing = false;
      btn().disabled = false;
      btn().textContent = "⏹ Stop Radio";
      _setStatus(`⏳ Generating segment 0… (${(data.prompt_id||"").slice(0,8)}…)`, "var(--accent2)");
      _setNowPlaying(data.song_name || "Generating…", data.style || "");
      _connectSSE();
    } catch (err) {
      _setStatus("Error: " + err.message, "var(--error)");
      btn().disabled = false;
    }
  }

  async function _stop() {
    _active = false;
    try { await fetch("/radio/stop", { method: "POST" }); } catch {}
    btn().textContent = "📻 Start Radio";
    _setStatus("Stopping after current segment…", "var(--muted)");
    if (_sse) { _sse.close(); _sse = null; }
  }

  // ── Public replay helper ──────────────────────────────────────────────────────
  window.playRadioFile = function (file) {
    const el = audio();
    if (!el) return;
    el.src = `/download/${file}`;
    el.play().catch(() => {});
    _setNowPlaying("Replay: " + file, "");
    _playing = true;
  };

  // ── Init ──────────────────────────────────────────────────────────────────────
  // ── Genre picker ──────────────────────────────────────────────────────────────
  let _radioGenreMap = {};

  function _loadGenres() {
    fetch("/api/genres").then(r => r.json()).then(data => {
      const genres = data.genres || [];
      genres.forEach(g => { _radioGenreMap[g.name] = g; });
      const sel = document.getElementById("radio-genre-select");
      if (!sel) return;
      const byParent = {};
      genres.forEach(g => {
        if (!byParent[g.parent]) byParent[g.parent] = [];
        byParent[g.parent].push(g);
      });
      Object.keys(byParent).sort().forEach(cat => {
        const og = document.createElement("optgroup");
        og.label = cat;
        byParent[cat].forEach(g => {
          const opt = document.createElement("option");
          opt.value = g.name; opt.textContent = g.name;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      });
    }).catch(() => {});
  }

  function _onGenreChange(val) {
    const infoEl = document.getElementById("radio-genre-info");
    const inp    = document.getElementById("radio-style-override");
    if (!val) { if (infoEl) infoEl.textContent = ""; return; }
    const g = _radioGenreMap[val];
    if (!g) return;
    if (inp) inp.value = (g.tags || []).join(", ");
    const bpmEl = document.getElementById("radio-bpm");
    const keyEl = document.getElementById("radio-key");
    const scaleEl = document.getElementById("radio-scale");
    if (bpmEl) bpmEl.value = Math.round((g.bpm_min + g.bpm_max) / 2);
    if (keyEl) keyEl.value = g.default_key || "C";
    if (scaleEl) scaleEl.value = g.default_scale || "Major";
    if (infoEl) infoEl.textContent = g.description || "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const b = btn();
    if (!b) return;

    _loadGenres();

    b.addEventListener("click", () => (_active ? _stop() : _start()));

    document.getElementById("radio-mode-manual")?.addEventListener("click", () => _setMode("manual"));
    document.getElementById("radio-mode-auto")?.addEventListener("click",   () => _setMode("auto"));

    document.getElementById("radio-genre-select")?.addEventListener("change", e => _onGenreChange(e.target.value));

    document.getElementById("radio-dj-choice")?.addEventListener("click", async () => {
      const inp    = document.getElementById("radio-style-override");
      const genSel = document.getElementById("radio-genre-select");
      const djBtn  = document.getElementById("radio-dj-choice");
      if (!inp) return;
      djBtn.disabled = true;
      djBtn.textContent = "🎙 Thinking…";
      try {
        const r = await fetch("/radio/dj-choice");
        const d = await r.json();
        inp.value = d.style || "";
        if (genSel) genSel.value = "";
        const infoEl = document.getElementById("radio-genre-info");
        if (infoEl) infoEl.textContent = "AI DJ pick";
      } catch {}
      djBtn.disabled = false;
      djBtn.textContent = "🎙 DJ Choice";
    });

    document.getElementById("radio-random-style")?.addEventListener("click", async () => {
      const inp = document.getElementById("radio-style-override");
      const genSel = document.getElementById("radio-genre-select");
      if (!inp) return;
      try {
        const r = await fetch("/radio/random-style");
        const d = await r.json();
        inp.value = d.style || "";
        if (genSel) genSel.value = "";
        const infoEl = document.getElementById("radio-genre-info");
        if (infoEl) infoEl.textContent = "";
      } catch {}
    });

    document.getElementById("btn-radio-clear-history")?.addEventListener("click", () => {
      const el = hist();
      if (el) el.innerHTML = "";
    });

    const a = audio();
    if (a) {
      a.addEventListener("ended", _onEnded);
      a.addEventListener("timeupdate", _updateProgress);
    }

    // Restore if radio was running before page refresh
    fetch("/radio/status").then(r => r.json()).then(s => {
      if (s.active) {
        _active = true;
        btn().textContent = "⏹ Stop Radio";
        _setStatus("Radio running — reconnecting…", "var(--accent)");
        _setNowPlaying(s.current_song || "Generating…", s.current_style || "");
        (s.history || []).forEach((entry, i) => {
          const e = typeof entry === "string"
            ? { file: entry, url: `/download/${entry}`, segment: i + 1, song_name: "", style: "" }
            : { file: entry.file, url: `/download/${entry.file}`, segment: i + 1, song_name: entry.song_name || "", style: entry.style || "" };
          _addHistory(e);
          _playlist.push(e);
        });
        _connectSSE();
      }
    }).catch(() => {});
  });
})();
