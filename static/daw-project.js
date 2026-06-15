// ── DAW project state + persistence ───────────────────────────────────────────
// dawState is the in-memory current arrangement. Mutations update it, trigger a
// re-render, and schedule a debounced autosave.
let dawState = { id: null, name: "Untitled Project", tempo: 120, master_volume: 1.0, tracks: [] };

const _TRACK_COLORS = ["#7c65d9", "#00d4b6", "#e0884f", "#4caf50", "#e05f8a", "#3f9fe0", "#c9a227"];
let _dawSaveTimer = null;

function _dawUid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }

function _dawAfterMutate() {
  if (typeof renderTimeline === "function") renderTimeline();
  if (typeof dawRenderMixerIfOpen === "function") dawRenderMixerIfOpen();
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
  dawState = { id: r.id, name: r.name, tempo: 120, master_volume: 1.0, tracks: [] };
  if (typeof dawResetMixerForProject === "function") dawResetMixerForProject();
  dawAddTrack("Track 1");        // start with one empty track
  return r.id;
}

async function dawLoadProject(id) {
  const p = await fetch("/daw/projects/" + id).then(r => r.json());
  if (p.error) return false;
  // Explicit fields — don't spread p.data (it could carry an id/name and clobber identity)
  const d = p.data || {};
  dawState = { id: p.id, name: p.name, version: d.version || 1,
               tempo: d.tempo ?? 120, master_volume: d.master_volume ?? 1.0,
               tracks: (d.tracks || []).map(t => ({ volume: 1.0, pan: 0.0, ...t })) };
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
  const data = { version: 1, tempo: dawState.tempo, master_volume: dawState.master_volume, tracks: dawState.tracks };
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

function dawTrimClip(clipId, offset, duration) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  const sd = c.source_duration || duration;
  c.offset = Math.min(Math.max(0, offset), sd);
  c.duration = Math.min(Math.max(0.05, duration), sd - c.offset);
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
