// ── DAW pitch-preserving time-stretch (SoundTouch) ────────────────────────────
const _dawStretchCache = new Map();      // key → AudioBuffer
const _dawStretchPending = new Set();    // key

function _dawStretchKey(clip) {
  return clip.file + "|" + clip.offset + "|" + (clip.src_len ?? clip.duration) + "|" + clip.duration;
}
function dawStretchGet(clip) { return _dawStretchCache.get(_dawStretchKey(clip)) || null; }
function dawInvalidateStretch(clip) {
  const prefix = clip.file + "|" + clip.offset + "|";
  for (const k of [..._dawStretchCache.keys()]) if (k.startsWith(prefix)) _dawStretchCache.delete(k);
}

async function dawRenderStretch(clip) {
  const key = _dawStretchKey(clip);
  if (_dawStretchCache.has(key)) return _dawStretchCache.get(key);
  if (_dawStretchPending.has(key)) return null;
  if (typeof SoundTouch === "undefined" || typeof SimpleFilter === "undefined" || typeof WebAudioBufferSource === "undefined") return null;
  _dawStretchPending.add(key);
  try {
    const ctx = _dawEnsureCtx();
    const buf = await dawGetBuffer(clip.file);
    if (!buf) return null;
    const sr = buf.sampleRate;
    const srcLen = clip.src_len ?? clip.duration;
    const o = Math.max(0, Math.floor(clip.offset * sr));
    const n = Math.min(buf.length - o, Math.floor(srcLen * sr));
    if (n <= 0 || clip.duration <= 0) return null;
    const nch = buf.numberOfChannels;
    const sub = ctx.createBuffer(nch, n, sr);
    for (let ch = 0; ch < nch; ch++) sub.getChannelData(ch).set(buf.getChannelData(ch).subarray(o, o + n));

    const st = new SoundTouch();
    st.tempo = srcLen / clip.duration;        // <1 lengthens, >1 shortens
    const source = new WebAudioBufferSource(sub);
    const filter = new SimpleFilter(source, st);

    const outLen = Math.ceil(clip.duration * sr);
    const out = ctx.createBuffer(nch, outLen, sr);
    const ch0 = out.getChannelData(0);
    const ch1 = nch > 1 ? out.getChannelData(1) : null;
    const BLOCK = 8192;
    const interleaved = new Float32Array(BLOCK * 2);
    let pos = 0, got = 0;
    do {
      got = filter.extract(interleaved, BLOCK);
      for (let i = 0; i < got && pos + i < outLen; i++) {
        ch0[pos + i] = interleaved[i * 2];
        if (ch1) ch1[pos + i] = interleaved[i * 2 + 1];
      }
      pos += got;
    } while (got > 0 && pos < outLen);

    _dawStretchCache.set(key, out);
    if (typeof dawRescheduleClips === "function") dawRescheduleClips();
    return out;
  } catch (e) {
    return null;
  } finally {
    _dawStretchPending.delete(key);
  }
}
