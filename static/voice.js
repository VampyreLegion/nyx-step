// ── Voice Recorder → Whisper → Lyrics ─────────────────────────────────────────
(function () {
  const btn    = document.getElementById("btn-voice-record");
  const status = document.getElementById("voice-record-status");
  const append = document.getElementById("voice-append");
  const editor = document.getElementById("lyrics-editor");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    btn.disabled = true;
    status.textContent = "Microphone not available in this browser or context.";
    return;
  }

  let _recorder = null;
  let _chunks   = [];
  let _stream   = null;
  let _timer    = null;
  let _elapsed  = 0;

  function _fmtTime(s) {
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  }

  btn.addEventListener("click", async () => {
    if (_recorder && _recorder.state === "recording") {
      // Stop recording
      _recorder.stop();
      return;
    }

    try {
      _stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      status.textContent = "Microphone access denied: " + e.message;
      return;
    }

    _chunks = [];
    _elapsed = 0;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    _recorder = new MediaRecorder(_stream, { mimeType });
    _recorder.ondataavailable = e => { if (e.data.size > 0) _chunks.push(e.data); };
    _recorder.onstop = _onStop;
    _recorder.start(100);

    btn.textContent = "⏹ Stop";
    btn.style.background = "var(--error)";
    _timer = setInterval(() => {
      _elapsed++;
      status.textContent = `🔴 Recording… ${_fmtTime(_elapsed)}`;
    }, 1000);
    status.textContent = "🔴 Recording… 0:00";
    status.style.color = "var(--error)";
  });

  async function _onStop() {
    clearInterval(_timer);
    btn.textContent = "🎙 Record";
    btn.style.background = "";
    status.style.color = "var(--muted)";
    status.textContent = "Transcribing…";
    _stream.getTracks().forEach(t => t.stop());

    const blob = new Blob(_chunks, { type: "audio/webm" });
    const modelSize = document.getElementById("voice-whisper-model").value || "base";
    const form = new FormData();
    form.append("audio", blob, "voice.webm");
    form.append("model_size", modelSize);

    try {
      const resp = await fetch("/transcribe", { method: "POST", body: form });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        status.textContent = "Error: " + (data.error || resp.statusText);
        status.style.color = "var(--error)";
        return;
      }
      const text = data.text.trim();
      if (!text) { status.textContent = "No speech detected."; return; }

      if (append.checked && editor.value.trim()) {
        editor.value = editor.value.trimEnd() + "\n" + text;
      } else {
        editor.value = text;
      }
      mwState.lyrics = editor.value;
      const overviewEl = document.getElementById("overview-lyrics");
      if (overviewEl) overviewEl.value = editor.value;
      updatePayloadPreview();

      status.textContent = `Transcribed (${data.language || "?"}) — ${text.length} chars`;
      status.style.color = "var(--accent2)";
    } catch (e) {
      status.textContent = "Error: " + e.message;
      status.style.color = "var(--error)";
    }
  }
})();
