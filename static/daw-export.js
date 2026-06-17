// ── DAW export (bounce arrangement to WAV) ────────────────────────────────────

// Render the whole arrangement offline through the same graph as playback.
// Returns an AudioBuffer, or null if there's nothing to export.
async function dawRenderArrangement() {
  const len = dawArrangementLength();
  if (len <= 0) return null;
  _dawEnsureCtx();
  const sr = _dawCtx.sampleRate;                 // match decoded buffers' rate exactly

  // Preload every referenced clip buffer.
  const files = new Set();
  for (const t of dawState.tracks) for (const c of t.clips) files.add(c.file);
  await Promise.all([...files].map(dawGetBuffer));

  // Pre-render any pitch-locked stretched clips so the offline pass can use them.
  if (typeof dawRenderStretch === "function") {
    const jobs = [];
    for (const t of dawState.tracks) for (const c of t.clips) {
      const sl = c.src_len ?? c.duration;
      const r = (sl > 0) ? (c.duration / sl) : 1;
      if (c.pitch_lock && Math.abs(r - 1) > 1e-3) jobs.push(dawRenderStretch(c));
    }
    await Promise.all(jobs);
  }

  const off = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const master = off.createGain();
  master.gain.value = dawState.master_volume ?? 1;
  master.connect(off.destination);

  const anySolo = dawState.tracks.some(t => t.solo);
  for (const track of dawState.tracks) {
    const audible = anySolo ? track.solo : !track.mute;
    const tg = off.createGain();
    tg.gain.value = audible ? (track.volume ?? 1) : 0;
    const pan = off.createStereoPanner();
    pan.pan.value = track.pan ?? 0;
    tg.connect(pan); pan.connect(master);
    for (const clip of track.clips) {
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;
      const srcLen = clip.src_len ?? clip.duration;
      const r = (srcLen > 0) ? (clip.duration / srcLen) : 1;
      const src = off.createBufferSource();
      const cg = off.createGain();
      src.connect(cg); cg.connect(tg);
      const stretched = (clip.pitch_lock && Math.abs(r - 1) > 1e-3 && typeof dawStretchGet === "function") ? dawStretchGet(clip) : null;
      if (stretched) {
        src.buffer = stretched;
        src.playbackRate.value = 1;
        _dawScheduleClipEnvelope(cg, clip.start, 0, clip.duration, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(clip.start, 0, clip.duration);
      } else {
        src.buffer = buf;
        src.playbackRate.value = 1 / r;
        _dawScheduleClipEnvelope(cg, clip.start, 0, clip.duration, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(clip.start, clip.offset, srcLen);
      }
    }
  }
  return await off.startRendering();
}

// Encode an AudioBuffer to a 16-bit PCM WAV Blob.
function _dawAudioBufferToWav(buf) {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const numFrames = buf.length;
  const blockAlign = numCh * 2;                  // 2 bytes/sample (16-bit)
  const dataSize = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);                  // fmt chunk size
  view.setUint16(20, 1, true);                   // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);     // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);                  // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(off, s, true); off += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

// Glue: render → encode → download, with status on #daw-save-status.
async function dawExportWav() {
  const btn = document.getElementById("daw-export");
  const status = document.getElementById("daw-save-status");
  if (btn) { btn.disabled = true; btn.textContent = "Rendering…"; }
  try {
    const rendered = await dawRenderArrangement();
    if (!rendered) {
      if (status) status.textContent = "Nothing to export — add clips first";
      return;
    }
    const blob = _dawAudioBufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (dawState.name || "mix").replace(/[^\w.\- ]/g, "_") + ".wav";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    if (status) status.textContent = "Exported ✓";
  } catch (e) {
    if (status) status.textContent = "Export failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬇ Export WAV"; }
  }
}
