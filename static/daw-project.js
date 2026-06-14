// ── DAW project state + persistence ───────────────────────────────────────────
// dawState is the in-memory current arrangement. Mutations update it, trigger a
// re-render, and schedule a debounced autosave.
let dawState = { id: null, name: "Untitled Project", tempo: 120, tracks: [] };

const _TRACK_COLORS = ["#7c65d9", "#00d4b6", "#e0884f", "#4caf50", "#e05f8a", "#3f9fe0", "#c9a227"];
let _dawSaveTimer = null;

function _dawUid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }

function _dawAfterMutate() {
  if (typeof renderTimeline === "function") renderTimeline();
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
  dawState = { id: r.id, name: r.name, tempo: 120, tracks: [] };
  dawAddTrack("Track 1");        // start with one empty track
  return r.id;
}

async function dawLoadProject(id) {
  const p = await fetch("/daw/projects/" + id).then(r => r.json());
  if (p.error) return false;
  // Explicit fields — don't spread p.data (it could carry an id/name and clobber identity)
  const d = p.data || {};
  dawState = { id: p.id, name: p.name, version: d.version || 1,
               tempo: d.tempo ?? 120, tracks: d.tracks || [] };
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
  const data = { version: 1, tempo: dawState.tempo, tracks: dawState.tracks };
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
    mute: false, solo: false, color: _TRACK_COLORS[i % _TRACK_COLORS.length], clips: [],
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
