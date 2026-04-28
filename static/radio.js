// ── Nyx Radio ─────────────────────────────────────────────────────────────────
// SSE-driven infinite music stream. Each completed segment is queued;
// playback advances automatically when the current segment ends.

(function () {
  let _sse = null;
  let _playlist = [];    // {file, url, segment}
  let _playing = false;
  let _currentIdx = -1;
  let _active = false;

  const btn   = () => document.getElementById("btn-radio-toggle");
  const stat  = () => document.getElementById("radio-status");
  const title = () => document.getElementById("radio-now-playing");
  const prog  = () => document.getElementById("radio-progress");
  const hist  = () => document.getElementById("radio-history");
  const audio = () => document.getElementById("radio-audio");

  // ── State helpers ────────────────────────────────────────────────────────────
  function _setStatus(msg, col) {
    const el = stat();
    if (el) { el.textContent = msg; if (col) el.style.color = col; }
  }

  function _setTitle(msg) {
    const el = title();
    if (el) el.textContent = msg;
  }

  function _addHistory(file, seg) {
    const el = hist();
    if (!el) return;
    const item = document.createElement("div");
    item.className = "radio-history-item";
    item.style.cssText = "font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center";
    item.innerHTML = `
      <span style="color:var(--muted);min-width:24px">S${String(seg).padStart(3,"0")}</span>
      <a href="/download/${file}" target="_blank" download style="color:var(--accent);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${file}</a>
      <button onclick="playRadioFile('${file}')" style="font-size:10px;padding:2px 6px" title="Replay this segment">▶</button>
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
    _setTitle(`Segment ${seg.segment} — ${seg.file}`);
    _playing = true;
    _setStatus(`▶ Playing segment ${seg.segment}`, "var(--accent)");
    _updateProgress();
  }

  function _onEnded() {
    // Advance to next queued segment
    const next = _currentIdx + 1;
    if (next < _playlist.length) {
      _playIdx(next);
    } else {
      _playing = false;
      if (_active) {
        _setStatus("⏳ Generating next segment…", "var(--muted)");
        _setTitle("Waiting for next segment…");
      } else {
        _setStatus("Stopped.", "var(--muted)");
        _setTitle("—");
      }
    }
  }

  function _updateProgress() {
    const el = prog();
    const a = audio();
    if (!el || !a) return;
    if (!a.duration) { el.textContent = ""; return; }
    const cur = Math.floor(a.currentTime);
    const dur = Math.floor(a.duration);
    el.textContent = `${_fmt(cur)} / ${_fmt(dur)}`;
  }

  function _fmt(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // ── SSE ───────────────────────────────────────────────────────────────────────
  function _connectSSE() {
    if (_sse) { _sse.close(); _sse = null; }
    _sse = new EventSource("/radio/events");

    _sse.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === "segment") {
        const url = `/download/${msg.file}`;
        _playlist.push({ file: msg.file, url, segment: msg.segment });
        _addHistory(msg.file, msg.segment);
        // Auto-start playback if nothing is playing
        if (!_playing) _playIdx(_playlist.length - 1);
        else _setStatus(`▶ Playing — ${_playlist.length - _currentIdx - 1} queued`, "var(--accent)");
      } else if (msg.type === "stopped") {
        _active = false;
        btn().textContent = "📻 Start Radio";
        if (!_playing) _setStatus("Stopped.", "var(--muted)");
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
    const tags     = (document.getElementById("radio-tags")     || {}).value || "";
    const bpm      = +(document.getElementById("radio-bpm")      || {}).value || 120;
    const key      = (document.getElementById("radio-key")       || {}).value || "C";
    const scale    = (document.getElementById("radio-scale")     || {}).value || "Major";
    const dur      = +(document.getElementById("radio-duration") || {}).value || 30;
    const steps    = +(document.getElementById("radio-steps")    || {}).value || 20;
    const s = mwState;

    const body = {
      tags, bpm, key, scale, duration: dur, steps,
      cfg: s.cfg_scale || 2.0,
      audio_format:  s.audio_format  || "mp3",
      audio_quality: s.audio_quality || "V0",
      dit_model:     s.dit_model     || "turbo",
      sampler_name:  s.sampler_name  || "er_sde",
      scheduler:     s.scheduler     || "linear_quadratic",
    };

    _setStatus("Starting radio…", "var(--muted)");
    try {
      const r = await fetch("/radio/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { _setStatus("Error: " + (data.error || r.status), "var(--error)"); return; }
      _active = true;
      _playlist = [];
      _currentIdx = -1;
      _playing = false;
      btn().textContent = "⏹ Stop Radio";
      _setStatus(`⏳ Generating segment 0… (${data.prompt_id.slice(0, 8)}…)`, "var(--accent2)");
      _setTitle("Waiting for first segment…");
      _connectSSE();
    } catch (err) {
      _setStatus("Error: " + err.message, "var(--error)");
    }
  }

  async function _stop() {
    _active = false;
    try { await fetch("/radio/stop", { method: "POST" }); } catch {}
    btn().textContent = "📻 Start Radio";
    _setStatus("Stopping after current segment…", "var(--muted)");
    if (_sse) { _sse.close(); _sse = null; }
  }

  // ── Public helpers ────────────────────────────────────────────────────────────
  window.playRadioFile = function (file) {
    const el = audio();
    if (!el) return;
    el.src = `/download/${file}`;
    el.play().catch(() => {});
    _setTitle("Replay: " + file);
    _playing = true;
  };

  // ── Init ──────────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const b = btn();
    if (!b) return;

    b.addEventListener("click", () => (_active ? _stop() : _start()));

    const clearBtn = document.getElementById("btn-radio-clear-history");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const el = hist();
        if (el) el.innerHTML = "";
      });
    }

    const a = audio();
    if (a) {
      a.addEventListener("ended", _onEnded);
      a.addEventListener("timeupdate", _updateProgress);
    }

    // Restore state if radio is already active (page refresh)
    fetch("/radio/status").then(r => r.json()).then(s => {
      if (s.active) {
        _active = true;
        btn().textContent = "⏹ Stop Radio";
        _setStatus("Radio running — reconnecting…", "var(--accent)");
        s.history.forEach((f, i) => _addHistory(f, i + 1));
        _connectSSE();
      }
    }).catch(() => {});
  });
})();
