// ── Voice-to-Prompt ─────────────────────────────────────────────────────────
let _voiceMediaRecorder = null;
let _voiceChunks = [];

function startVoiceRecording() {
  const statusEl = document.getElementById('voice-status');
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    _voiceMediaRecorder = new MediaRecorder(stream);
    _voiceChunks = [];
    _voiceMediaRecorder.ondataavailable = e => _voiceChunks.push(e.data);
    _voiceMediaRecorder.onstop = async () => {
      const blob = new Blob(_voiceChunks, { type: 'audio/webm' });
      stream.getTracks().forEach(t => t.stop());
      await uploadVoiceNote(blob);
    };
    _voiceMediaRecorder.start();
    if (statusEl) statusEl.textContent = 'Recording... click again to stop';
    document.getElementById('voice-btn')?.classList.add('recording');
  }).catch(e => {
    if (statusEl) statusEl.textContent = 'Mic access denied: ' + e.message;
  });
}

function stopVoiceRecording() {
  if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
    _voiceMediaRecorder.stop();
    document.getElementById('voice-btn')?.classList.remove('recording');
  }
}

async function uploadVoiceNote(blob) {
  const statusEl = document.getElementById('voice-status');
  if (statusEl) statusEl.textContent = 'Transcribing...';
  const fd = new FormData();
  fd.append('file', blob, 'voice-note.webm');
  try {
    const res = await fetch('/voice-to-prompt', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.suggested_tags) {
      const tagInput = document.getElementById('caption-input') || document.getElementById('tags');
      if (tagInput) tagInput.value = data.suggested_tags;
      if (statusEl) statusEl.textContent = `Applied: ${data.suggested_tags.substring(0, 80)}...`;
    } else {
      if (statusEl) statusEl.textContent = 'Transcript: ' + (data.transcript || 'no result');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}
