// ── DAW project state + persistence ───────────────────────────────────────────
// dawState is the in-memory current arrangement. Mutations update it, trigger a
// re-render, and schedule a debounced autosave.
let dawState = { id: null, name: "Untitled Project", tempo: 120, master_volume: 1.0, scenes: 4, tracks: [], snap: true, snap_res: "bar" };

function _dawSnapDiv() {
  const beat = 60 / (dawState.tempo || 120);
  return { bar: beat * 4, half: beat * 2, beat: beat, quarter: beat / 4 }[dawState.snap_res] || beat * 4;
}
function _dawSnapSec(sec, bypass) {
  if (bypass || !dawState.snap) return sec;
  const div = _dawSnapDiv();
  return Math.round(sec / div) * div;
}

const _TRACK_COLORS = ["#7c65d9", "#00d4b6", "#e0884f", "#4caf50", "#e05f8a", "#3f9fe0", "#c9a227"];
let _dawSaveTimer = null;

function _dawUid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }

function _dawDefaultFx() {
  return { eq: { on: false, low: 0, mid: 0, high: 0 },
           reverb: { on: false, wet: 0.3 },
           delay: { on: false, time: 0.3, feedback: 0.3, wet: 0.3 } };
}

function _dawNormCells(cells, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((cells && cells[i]) || null);
  return out;
}

function _dawAfterMutate() {
  if (typeof renderTimeline === "function") renderTimeline();
  if (typeof dawRenderMixerIfOpen === "function") dawRenderMixerIfOpen();
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
  dawMarkDirty();
}

function _dawSetSaveStatus(text) {
  const el = document.getElementById("daw-save-status");
  if (el) el.textContent = text;
}

// ── Persistence (API) ──────────────────────────────────────────────────────────
async function dawListProjects() {
  return (await fetch("/daw/projects").then(r => r.json())).projects || [];
}

async function dawNewProject(name) {
  const r = await fetch("/daw/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || "Untitled Project" }),
  }).then(r => r.json());
  dawState = { id: r.id, name: r.name, tempo: 120, master_volume: 1.0, scenes: 4, tracks: [], snap: true, snap_res: "bar" };
  if (typeof dawResetMixerForProject === "function") dawResetMixerForProject();
  dawAddTrack("Track 1");        // start with one empty track
  return r.id;
}

async function dawLoadProject(id) {
  const p = await fetch("/daw/projects/" + id).then(r => r.json());
  if (p.error) return false;
  // Explicit fields — don't spread p.data (it could carry an id/name and clobber identity)
  const d = p.data || {};
  const scenes = d.scenes ?? 4;
  dawState = { id: p.id, name: p.name, version: d.version || 1,
               tempo: d.tempo ?? 120, master_volume: d.master_volume ?? 1.0, scenes,
               snap: d.snap ?? true, snap_res: d.snap_res ?? "bar",
               tracks: (d.tracks || []).map(t => {
                 const tt = { volume: 1.0, pan: 0.0, ...t };
                 tt.fx = t.fx || _dawDefaultFx();
                 tt.cells = _dawNormCells(t.cells, scenes);
                 return tt;
               }) };
  for (const t of dawState.tracks) for (const c of (t.clips || [])) {
    c.src_len = c.src_len ?? c.duration;
    c.pitch_lock = c.pitch_lock ?? false;
  }
  if (typeof dawResetMixerForProject === "function") dawResetMixerForProject();
  if (typeof renderTimeline === "function") renderTimeline();
  _dawSetSaveStatus("✓ saved");
  return true;
}

async function dawDeleteProject(id) {
  await fetch("/daw/projects/" + id, { method: "DELETE" });
}

function dawMarkDirty() {
  _dawSetSaveStatus("saving…");
  clearTimeout(_dawSaveTimer);
  _dawSaveTimer = setTimeout(dawSaveNow, 800);   // debounce
}

async function dawSaveNow() {
  if (dawState.id == null) return;
  const data = { version: 1, tempo: dawState.tempo, master_volume: dawState.master_volume, scenes: dawState.scenes, tracks: dawState.tracks, snap: dawState.snap, snap_res: dawState.snap_res };
  try {
    const r = await fetch("/daw/projects/" + dawState.id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: dawState.name, data }),
    });
    _dawSetSaveStatus(r.ok ? "✓ saved" : "save failed");
  } catch (_) { _dawSetSaveStatus("save failed"); }
}

// ── Track mutations ─────────────────────────────────────────────────────────────
function dawAddTrack(name) {
  const i = dawState.tracks.length;
  dawState.tracks.push({
    id: _dawUid("t"), name: name || ("Track " + (i + 1)),
    mute: false, solo: false, color: _TRACK_COLORS[i % _TRACK_COLORS.length],
    volume: 1.0, pan: 0.0, clips: [],
    fx: _dawDefaultFx(), cells: _dawNormCells([], dawState.scenes ?? 4),
  });
  _dawAfterMutate();
}

function dawRemoveTrack(trackId) {
  dawState.tracks = dawState.tracks.filter(t => t.id !== trackId);
  _dawAfterMutate();
}

function dawRenameTrack(trackId, name) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (t) { t.name = name; _dawAfterMutate(); }
}

function dawToggleMute(trackId) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (t) { t.mute = !t.mute; _dawAfterMutate(); }
}

function dawToggleSolo(trackId) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (t) { t.solo = !t.solo; _dawAfterMutate(); }
}

// ── Clip mutations ──────────────────────────────────────────────────────────────
function _dawFindClip(clipId) {
  for (const t of dawState.tracks) {
    const c = t.clips.find(c => c.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}

function dawAddClip(trackId, src, start) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return null;
  const dur = src.source_duration || src.duration || 0;
  const clip = {
    id: _dawUid("c"), file: src.file, name: src.name || src.file,
    start: Math.max(0, start || 0), offset: 0,
    duration: dur, source_duration: dur,
    src_len: dur, pitch_lock: false,
    gain: 1.0, fade_in: 0.0, fade_out: 0.0,
  };
  t.clips.push(clip);
  _dawAfterMutate();
  return clip;
}

function dawMoveClip(clipId, newTrackId, newStart) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const { track, clip } = found;
  clip.start = Math.max(0, newStart);
  if (newTrackId && newTrackId !== track.id) {
    track.clips = track.clips.filter(c => c.id !== clipId);
    const dest = dawState.tracks.find(t => t.id === newTrackId);
    if (dest) dest.clips.push(clip);
  }
  _dawAfterMutate();
}

function dawTrimClip(clipId, offset, srcLen) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  const sd = c.source_duration || srcLen;
  const prevSrc = c.src_len ?? c.duration;
  const r = (prevSrc > 0) ? (c.duration / prevSrc) : 1;
  c.offset = Math.min(Math.max(0, offset), sd);
  c.src_len = Math.min(Math.max(0.05, srcLen), sd - c.offset);
  c.duration = c.src_len * r;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}

function dawDeleteClip(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  found.track.clips = found.track.clips.filter(c => c.id !== clipId);
  _dawAfterMutate();
}

function dawDuplicateClip(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  found.track.clips.push({ ...c, id: _dawUid("c"), start: c.start + c.duration });
  _dawAfterMutate();
}

// ── Clip copy / paste ────────────────────────────────────────────────────────
let _dawClipboard = null;
function dawCopyClip(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return false;
  _dawClipboard = { ...found.clip };
  return true;
}
function dawPasteClip(trackId, start) {
  if (!_dawClipboard) return null;
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return null;
  const s = (typeof _dawSnapSec === "function") ? _dawSnapSec(Math.max(0, start)) : Math.max(0, start);
  const clip = { ..._dawClipboard, id: _dawUid("c"), start: s };
  t.clips.push(clip);
  _dawAfterMutate();
  return clip;
}

function dawArrangementLength() {
  let max = 0;
  for (const t of dawState.tracks)
    for (const c of t.clips) max = Math.max(max, c.start + c.duration);
  return max;
}

// ── Mixer mutations ─────────────────────────────────────────────────────────────
function dawSetTrackVolume(trackId, gain) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return;
  t.volume = gain;
  if (typeof dawEngineSetTrackVolume === "function") dawEngineSetTrackVolume(trackId, gain);
  if (typeof dawReflectVolume === "function") dawReflectVolume(trackId, gain);
  dawMarkDirty();
}

function dawSetTrackPan(trackId, pan) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return;
  t.pan = pan;
  if (typeof dawEngineSetTrackPan === "function") dawEngineSetTrackPan(trackId, pan);
  dawMarkDirty();
}

function dawSetMasterVolume(gain) {
  dawState.master_volume = gain;
  if (typeof dawEngineSetMasterVolume === "function") dawEngineSetMasterVolume(gain);
  dawMarkDirty();
}

// ── Wave-edit mutations ─────────────────────────────────────────────────────────
function dawSetClipGain(clipId, gain) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  f.clip.gain = Math.max(0, gain);
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

function dawSetClipFadeIn(clipId, sec) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const c = f.clip;
  c.fade_in = Math.min(Math.max(0, sec), c.duration - (c.fade_out ?? 0));
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

function dawSetClipFadeOut(clipId, sec) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const c = f.clip;
  c.fade_out = Math.min(Math.max(0, sec), c.duration - (c.fade_in ?? 0));
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

function dawSplitClipAtPlayhead(clipId) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const { track, clip } = f;
  const p = (typeof dawGetPlayhead === "function") ? dawGetPlayhead() : 0;
  if (p <= clip.start || p >= clip.start + clip.duration) return;
  const leftDur = p - clip.start;
  const rightDur = clip.duration - leftDur;
  const gain = clip.gain ?? 1;
  const left = { ...clip, id: _dawUid("c"), duration: leftDur, gain,
                 fade_in: Math.min(clip.fade_in ?? 0, leftDur), fade_out: 0 };
  const right = { ...clip, id: _dawUid("c"), start: p, offset: clip.offset + leftDur,
                  duration: rightDur, gain, fade_in: 0,
                  fade_out: Math.min(clip.fade_out ?? 0, rightDur) };
  const idx = track.clips.findIndex(c => c.id === clipId);
  track.clips.splice(idx, 1, left, right);
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

async function dawNormalizeClip(clipId) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const c = f.clip;
  if (typeof dawGetBuffer === "function") await dawGetBuffer(c.file);
  const peak = (typeof dawEngineClipPeak === "function") ? dawEngineClipPeak(c.file, c.offset, c.duration) : 0;
  if (peak > 0) {
    c.gain = Math.min(8, 1 / peak);   // NORM_CAP = 8 (≈ +18 dB)
    if (typeof dawRescheduleClips === "function") dawRescheduleClips();
    _dawAfterMutate();
  }
}

// ── FX + session mutations ──────────────────────────────────────────────────────
function dawSetTrackFx(trackId, fx) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return;
  t.fx = fx;
  if (typeof dawEngineSetTrackFx === "function") dawEngineSetTrackFx(trackId, fx);
  if (typeof dawRenderMixerIfOpen === "function") dawRenderMixerIfOpen();
  dawMarkDirty();
}

function dawSetCell(trackId, sceneIdx, ref) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t || !t.cells) return;
  t.cells[sceneIdx] = ref;
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
  dawMarkDirty();
}

function dawAddScene() {
  dawState.scenes = (dawState.scenes ?? 4) + 1;
  for (const t of dawState.tracks) { (t.cells = t.cells || []).push(null); }
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
  dawMarkDirty();
}

// ── Stretch mutations ───────────────────────────────────────────────────────────
function dawStretchClip(clipId, newDuration) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  const srcLen = c.src_len ?? c.duration;
  const r = Math.min(4, Math.max(0.25, newDuration / srcLen));
  c.src_len = srcLen;
  c.duration = srcLen * r;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
function dawSetClipPitchLock(clipId, on) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  found.clip.pitch_lock = !!on;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(found.clip);
  _dawAfterMutate();
}
function dawResetStretch(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  c.duration = c.src_len ?? c.duration;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
