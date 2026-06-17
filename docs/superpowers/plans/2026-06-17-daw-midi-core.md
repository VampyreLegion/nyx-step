# DAW MIDI Core (Stage 2A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a MIDI track type that's transcribed from audio (melody/rhythm/piano), played by an internal Web-Audio synth or routed to a hardware synth over USB MIDI, rendered on the timeline, and bounced to WAV.

**Architecture:** Backend exposes note lists (`core/midi.py`) via a new `/daw/transcribe` JSON endpoint. The DAW gains `kind:"midi"` tracks with `notes/synth/midi_out`; the engine scheduler branches MIDI tracks to an oscillator+ADSR synth (through the track chain) or to a Web-MIDI output. Conversion, timeline rendering, and export follow.

**Tech Stack:** FastAPI, librosa (pyin/onset), mido; vanilla JS Web Audio (OscillatorNode/Gain) + Web MIDI API; Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-06-17-daw-midi-core-design.md`

**Conventions:** repo `/home/legion/legionprojects/nyx-step`, branch `master`. `node --check` JS. Restart `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health`. Tests `python3 -m pytest tests/ -q` (baseline **90**). Bump `?v=` in `templates/index.html` for changed JS. Commit per task (`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`); don't push.

**Existing anchors:** `core/midi.py` has `_notes_from_pyin`, `_write_midi`, `extract_melody_midi`, `extract_piano_midi`. `routes/daw.py` uses `safe_output_path`, `_user_owns_daw_file`, `get_user_email`. Engine `_dawScheduleAll` loops `dawState.tracks` then `track.clips`; globals `_dawActiveSources`, `_dawIsPlaying`, `_dawStartCtxTime`, `_dawPlayhead`, `_DAW_LOOKAHEAD`, `_dawEnsureCtx`, `_dawTrackChains`. `dawArrangementLength()` in `daw-project.js`. `dawRenderTrackHeaders()` + the `+ Add Track` button (`#daw-add-track`) in `daw-timeline.js`/`index.html`. Heavy work runs via `core.executor.get_audio_pool()` + `loop.run_in_executor`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `core/midi.py` | modify | `melody_notes`/`rhythm_notes`/`piano_notes`/`notes_to_json`/`_notes_from_midi_bytes` |
| `routes/daw.py` | modify | `POST /daw/transcribe` |
| `static/daw-project.js` | modify | `kind`/`notes`/`synth`/`midi_out` model+defaults; `dawAddMidiTrack`/`dawSetTrackNotes`/`dawSetTrackSynth`/`dawSetTrackMidiOut`; `dawArrangementLength` includes notes |
| `static/daw-midi.js` | **create** | Web-MIDI access (`dawInitMidi`/`dawMidiOutputs`/`dawMidiGetOutput`/`dawMidiAllNotesOff`); Convert-to-MIDI dialog/flow; `_dawNoteFreq` |
| `static/daw-engine.js` | modify | MIDI scheduling branch (synth + external), clock capture, stop all-notes-off |
| `static/daw-timeline.js` | modify | MIDI lane note rendering + MIDI header (wave/output) + `+ Add MIDI Track` |
| `static/daw-waveedit.js` | modify | clip-menu "🎹 Convert to MIDI…" |
| `static/daw-export.js` | modify | render MIDI tracks via internal synth; skip external |
| `templates/index.html` | modify | `daw-midi.js` script + cache-busts |
| `tests/test_daw.py` | modify | transcribe route + MIDI persistence |

Script order: `daw-midi.js` after `daw-engine.js`, before `daw.js`.

---

### Task 1: Backend — note extractors

**Files:** Modify `core/midi.py`, `tests/test_daw.py`

- [ ] **Step 1: Add note-list functions** to `core/midi.py` (after `_notes_from_pyin`/before/around the existing extractors; keep existing functions working):
```python
def melody_notes(audio_path: str) -> list[tuple[float, float, int, int]]:
    """Monophonic melody note list via librosa pyin."""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"), sr=sr)
    times = librosa.times_like(f0, sr=sr)
    voiced = voiced_flag & ~np.isnan(f0)
    f0_clean = np.where(voiced, f0, 0.0)
    return _notes_from_pyin(f0_clean, voiced, times)


def rhythm_notes(audio_path: str, pitch: int = 38) -> list[tuple[float, float, int, int]]:
    """Percussive onsets → short hits on a single pitch, velocity from onset strength."""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time")
    env_times = librosa.times_like(env, sr=sr)
    emax = float(env.max()) if len(env) else 1.0
    if emax <= 0:
        emax = 1.0
    notes = []
    for t in onsets:
        idx = int(np.argmin(np.abs(env_times - t))) if len(env_times) else 0
        s = float(env[idx]) if idx < len(env) else emax
        vel = int(max(40, min(120, 40 + (s / emax) * 80)))
        notes.append((float(t), float(t) + 0.12, int(pitch), vel))
    return notes


def _notes_from_midi_bytes(b: bytes) -> list[tuple[float, float, int, int]]:
    """Parse MIDI bytes → absolute-time note tuples."""
    import mido
    mid = mido.MidiFile(file=io.BytesIO(b))
    tempo = 500000
    abs_t = 0.0
    pending: dict[int, tuple[float, int]] = {}
    notes = []
    for msg in mido.merge_tracks(mid.tracks):
        abs_t += mido.tick2second(msg.time, mid.ticks_per_beat, tempo)
        if msg.type == "set_tempo":
            tempo = msg.tempo
        elif msg.type == "note_on" and msg.velocity > 0:
            pending[msg.note] = (abs_t, msg.velocity)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            if msg.note in pending:
                st, v = pending.pop(msg.note)
                notes.append((st, abs_t, int(msg.note), int(v)))
    return notes


def piano_notes(audio_path: str) -> list[tuple[float, float, int, int]]:
    """Polyphonic piano note list (runs the transcription model, parses its MIDI)."""
    midi_bytes, _ = extract_piano_midi(audio_path)
    return _notes_from_midi_bytes(midi_bytes)


def notes_to_json(notes: list[tuple[float, float, int, int]]) -> list[dict]:
    return [{"start": round(s, 4), "dur": round(max(0.0, e - s), 4),
             "pitch": int(p), "vel": int(v)} for (s, e, p, v) in notes]
```

- [ ] **Step 2: Refactor `extract_melody_midi`** to reuse `melody_notes` (keep its return contract). Replace its body's pyin block + `_notes_from_pyin` call so it computes `notes = melody_notes(audio_path)` then builds `midi_bytes`/info from that. Concretely replace the function with:
```python
def extract_melody_midi(audio_path: str, bpm: float = 120.0) -> tuple[bytes, dict]:
    """Monophonic melody extraction using librosa pyin. Returns (midi_bytes, info_dict)."""
    notes = melody_notes(audio_path)
    midi_bytes = _write_midi(notes, tempo_bpm=bpm, program=0)
    midi_notes = [n[2] for n in notes]
    end = max((n[1] for n in notes), default=0.0)
    return midi_bytes, {
        "mode": "melody",
        "note_count": len(notes),
        "pitch_range": f"{librosa.midi_to_note(min(midi_notes))}–{librosa.midi_to_note(max(midi_notes))}" if midi_notes else "—",
        "duration_s": float(end),
    }
```

- [ ] **Step 3: Add tests** to `tests/test_daw.py` (top-level imports already include the app `client`; add `import math, struct, wave, tempfile, os`):
```python
def _write_sine_wav(path, freq=440.0, secs=1.0, sr=22050):
    import wave, struct, math
    with wave.open(path, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        frames = b"".join(struct.pack("<h", int(0.4 * 32767 * math.sin(2 * math.pi * freq * i / sr)))
                          for i in range(int(secs * sr)))
        w.writeframes(frames)

def test_melody_notes_detects_a4(tmp_path):
    from core.midi import melody_notes, notes_to_json
    p = str(tmp_path / "tone.wav"); _write_sine_wav(p, 440.0, 1.0)
    notes = melody_notes(p)
    assert notes, "expected at least one note from a 440Hz tone"
    pitches = [n[2] for n in notes]
    assert any(abs(pp - 69) <= 1 for pp in pitches)   # A4 = MIDI 69
    js = notes_to_json(notes)
    assert set(js[0].keys()) == {"start", "dur", "pitch", "vel"}

def test_notes_to_json_shape():
    from core.midi import notes_to_json
    assert notes_to_json([(0.0, 0.5, 60, 80)]) == [{"start": 0.0, "dur": 0.5, "pitch": 60, "vel": 80}]
```

- [ ] **Step 4: Run** `python3 -m pytest tests/test_daw.py -q -k "melody_notes or notes_to_json"` → PASS (the tone test may take a few seconds). Then full `python3 -m pytest tests/ -q` → 92 passed.

- [ ] **Step 5: Commit**
```bash
git add core/midi.py tests/test_daw.py
git commit -m "feat(midi): note-list extractors (melody/rhythm/piano) + notes_to_json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — /daw/transcribe route

**Files:** Modify `routes/daw.py`, `tests/test_daw.py`

- [ ] **Step 1: Add the route** to `routes/daw.py` (uses the same ownership + path pattern as `/daw/audio`; runs librosa off the event loop):
```python
class _Transcribe(BaseModel):
    file: str
    mode: str = "melody"


@router.post("/transcribe")
async def transcribe(req: _Transcribe, request: Request):
    import asyncio
    from core.executor import get_audio_pool
    user = get_user_email(request)
    if not _user_owns_daw_file(user, req.file):
        return JSONResponse({"error": "Not found or access denied"}, status_code=404)
    path = safe_output_path(req.file)
    if path is None or not path.exists():
        return JSONResponse({"error": "File not on disk"}, status_code=404)
    if req.mode not in ("melody", "rhythm", "piano"):
        return JSONResponse({"error": "Bad mode"}, status_code=400)

    def _work():
        from core.midi import melody_notes, rhythm_notes, piano_notes, notes_to_json
        fn = {"melody": melody_notes, "rhythm": rhythm_notes, "piano": piano_notes}[req.mode]
        notes = fn(str(path))
        return notes_to_json(notes)

    try:
        loop = asyncio.get_event_loop()
        notes = await loop.run_in_executor(get_audio_pool(), _work)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    duration = max((n["start"] + n["dur"] for n in notes), default=0.0)
    return {"notes": notes, "duration": round(duration, 4), "mode": req.mode, "count": len(notes)}
```
(`BaseModel`, `JSONResponse`, `safe_output_path`, `_user_owns_daw_file`, `get_user_email` are already imported in `routes/daw.py`.)

- [ ] **Step 2: Add a route test** to `tests/test_daw.py` (monkeypatch ownership + path + the extractor so it's fast and deterministic):
```python
def test_transcribe_route(monkeypatch, tmp_path):
    import routes.daw as daw_routes
    import core.midi as midi_mod
    f = tmp_path / "x.mp3"; f.write_bytes(b"stub")
    monkeypatch.setattr(daw_routes, "_user_owns_daw_file", lambda u, fn: True)
    monkeypatch.setattr(daw_routes, "safe_output_path", lambda fn: f)
    monkeypatch.setattr(midi_mod, "melody_notes", lambda p: [(0.0, 0.5, 60, 80), (0.5, 1.0, 62, 90)])
    r = client.post("/daw/transcribe", json={"file": "x.mp3", "mode": "melody"})
    assert r.status_code == 200
    d = r.json()
    assert d["count"] == 2 and d["mode"] == "melody"
    assert d["notes"][0] == {"start": 0.0, "dur": 0.5, "pitch": 60, "vel": 80}
    assert abs(d["duration"] - 1.0) < 1e-6

def test_transcribe_bad_mode(monkeypatch, tmp_path):
    import routes.daw as daw_routes
    f = tmp_path / "x.mp3"; f.write_bytes(b"stub")
    monkeypatch.setattr(daw_routes, "_user_owns_daw_file", lambda u, fn: True)
    monkeypatch.setattr(daw_routes, "safe_output_path", lambda fn: f)
    r = client.post("/daw/transcribe", json={"file": "x.mp3", "mode": "nope"})
    assert r.status_code == 400
```

- [ ] **Step 3: Run** `python3 -m pytest tests/test_daw.py -q -k transcribe` → PASS. Then `python3 -m pytest tests/ -q` → 94 passed.

- [ ] **Step 4: Commit**
```bash
git add routes/daw.py tests/test_daw.py
git commit -m "feat(daw): POST /daw/transcribe (melody/rhythm/piano → notes JSON)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Project model — MIDI tracks

**Files:** Modify `static/daw-project.js`, `tests/test_daw.py`. READ the file first; adapt snippets to real code.

- [ ] **Step 1: Default `kind` on audio tracks.** In `dawAddTrack`'s pushed object add `kind: "audio"` (keep all existing fields).

- [ ] **Step 2: Add MIDI defaults helper + `dawAddMidiTrack`** at the end of the file:
```javascript
function _dawDefaultSynth() { return { wave: "sawtooth", env: "pluck" }; }
function dawAddMidiTrack(name) {
  const i = dawState.tracks.length;
  const colors = (typeof _TRACK_COLORS !== "undefined") ? _TRACK_COLORS : ["#7c65d9"];
  dawState.tracks.push({
    id: _dawUid("t"), name: name || ("MIDI " + (i + 1)),
    mute: false, solo: false, color: colors[i % colors.length],
    volume: 1.0, pan: 0.0, fx: (typeof _dawDefaultFx === "function" ? _dawDefaultFx() : undefined),
    cells: (typeof _dawNormCells === "function" ? _dawNormCells([], dawState.scenes ?? 4) : []),
    kind: "midi", notes: [], synth: _dawDefaultSynth(), midi_out: null, clips: [],
  });
  _dawAfterMutate();
  return dawState.tracks[dawState.tracks.length - 1];
}
function dawSetTrackNotes(trackId, notes) {
  const t = dawState.tracks.find(t => t.id === trackId); if (!t) return;
  t.notes = notes || []; _dawAfterMutate();
}
function dawSetTrackSynth(trackId, patch) {
  const t = dawState.tracks.find(t => t.id === trackId); if (!t) return;
  t.synth = Object.assign({}, t.synth || _dawDefaultSynth(), patch);
  dawMarkDirty();
}
function dawSetTrackMidiOut(trackId, outId) {
  const t = dawState.tracks.find(t => t.id === trackId); if (!t) return;
  t.midi_out = outId || null; dawMarkDirty();
}
```

- [ ] **Step 3: Normalize on load.** In `dawLoadProject`, after `dawState` is assigned (where the clip-normalization loop from the snap/stretch work runs), add track normalization:
```javascript
for (const t of dawState.tracks) {
  t.kind = t.kind || "audio";
  if (t.kind === "midi") {
    t.notes = t.notes || [];
    t.synth = t.synth || _dawDefaultSynth();
    if (t.midi_out === undefined) t.midi_out = null;
  }
}
```

- [ ] **Step 4: Include MIDI notes in `dawArrangementLength`.** Replace it:
```javascript
function dawArrangementLength() {
  let max = 0;
  for (const t of dawState.tracks) {
    for (const c of (t.clips || [])) max = Math.max(max, c.start + c.duration);
    for (const n of (t.notes || [])) max = Math.max(max, n.start + n.dur);
  }
  return max;
}
```

- [ ] **Step 5: Persistence test** in `tests/test_daw.py`:
```python
def test_project_persists_midi_track():
    pid = client.post("/daw/projects", json={"name": "MID"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 1.0, "tracks": [
        {"id": "m1", "name": "Lead", "mute": False, "solo": False, "color": "#fff",
         "volume": 1.0, "pan": 0.0, "kind": "midi",
         "notes": [{"start": 0.0, "dur": 0.5, "pitch": 60, "vel": 80}],
         "synth": {"wave": "square", "env": "pad"}, "midi_out": "out-1", "clips": []}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    t = client.get(f"/daw/projects/{pid}").json()["data"]["tracks"][0]
    assert t["kind"] == "midi" and t["notes"][0]["pitch"] == 60
    assert t["synth"]["wave"] == "square" and t["midi_out"] == "out-1"
```

- [ ] **Step 6:** `node --check static/daw-project.js`; `python3 -m pytest tests/ -q -k midi_track` PASS; commit:
```bash
git add static/daw-project.js tests/test_daw.py
git commit -m "feat(daw): MIDI track model — kind/notes/synth/midi_out + mutations + length

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: daw-midi.js — Web MIDI access + convert flow

**Files:** Create `static/daw-midi.js`; modify `static/daw-waveedit.js`

- [ ] **Step 1: Create `static/daw-midi.js`:**
```javascript
// ── DAW MIDI: Web-MIDI access + audio→MIDI conversion ─────────────────────────
let _dawMidiAccess = null;
function _dawNoteFreq(p) { return 440 * Math.pow(2, (p - 69) / 12); }

async function dawInitMidi() {
  if (_dawMidiAccess) return _dawMidiAccess;
  if (!navigator.requestMIDIAccess) return null;
  try { _dawMidiAccess = await navigator.requestMIDIAccess({ sysex: false }); }
  catch (_) { _dawMidiAccess = null; }
  return _dawMidiAccess;
}
function dawMidiOutputs() {
  if (!_dawMidiAccess) return [];
  return [..._dawMidiAccess.outputs.values()].map(o => ({ id: o.id, name: o.name }));
}
function dawMidiGetOutput(id) {
  if (!_dawMidiAccess || !id) return null;
  for (const o of _dawMidiAccess.outputs.values()) if (o.id === id) return o;
  return null;
}
function dawMidiAllNotesOff() {
  if (typeof _dawMidiActiveOuts === "undefined") return;
  for (const o of _dawMidiActiveOuts) { try { o.send([0xB0, 123, 0]); } catch (_) {} }
  _dawMidiActiveOuts.clear();
}

// Convert an audio clip → a new MIDI track.
let _dawMidiDialogEl = null;
function _dawCloseMidiDialog() {
  if (_dawMidiDialogEl) { _dawMidiDialogEl.remove(); _dawMidiDialogEl = null; }
  document.removeEventListener("keydown", _dawMidiEsc);
}
function _dawMidiEsc(e) { if (e.key === "Escape") _dawCloseMidiDialog(); }

function openConvertToMidiDialog(clip, anchor) {
  _dawCloseMidiDialog();
  const m = document.createElement("div"); _dawMidiDialogEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:200px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 220) + "px"; m.style.top = (r.bottom + 4) + "px";
  const title = document.createElement("div");
  title.textContent = "🎹 Convert to MIDI"; title.style.cssText = "font-size:11px;color:#00d4b6;font-weight:bold";
  const modeRow = document.createElement("label");
  modeRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  modeRow.textContent = "Mode";
  const sel = document.createElement("select"); sel.style.cssText = "font-size:11px;width:auto;flex:0 0 auto";
  for (const [v, l] of [["melody","Melody"],["rhythm","Rhythm"],["piano","Piano"]]) {
    const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o);
  }
  modeRow.appendChild(sel);
  const btnRow = document.createElement("div"); btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const go = document.createElement("button"); go.className = "secondary small"; go.textContent = "Convert"; go.style.cssText = "font-size:11px";
  const cancel = document.createElement("button"); cancel.className = "secondary small"; cancel.textContent = "Cancel"; cancel.style.cssText = "font-size:11px";
  go.addEventListener("click", () => { const mode = sel.value; _dawCloseMidiDialog(); dawConvertToMidi(clip, mode); });
  cancel.addEventListener("click", _dawCloseMidiDialog);
  btnRow.appendChild(go); btnRow.appendChild(cancel);
  m.appendChild(title); m.appendChild(modeRow); m.appendChild(btnRow);
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("keydown", _dawMidiEsc), 0);
}

async function dawConvertToMidi(clip, mode) {
  _dawSetSaveStatus("Transcribing…");
  try {
    const resp = await fetch("/daw/transcribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: clip.file, mode }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
    const offset = clip.start || 0;
    const notes = (data.notes || []).map(n => ({ start: n.start + offset, dur: n.dur, pitch: n.pitch, vel: n.vel }));
    const t = dawAddMidiTrack(clip.name.slice(0, 14) + " · " + mode);
    dawSetTrackNotes(t.id, notes);
    _dawSetSaveStatus(notes.length ? ("MIDI ready ✓ (" + notes.length + " notes)") : "No notes detected");
  } catch (e) {
    _dawSetSaveStatus("Transcribe failed: " + e.message);
  }
}
```

- [ ] **Step 2: Add the clip-menu item** in `static/daw-waveedit.js` — after the `⧉ Duplicate (after)` line add:
```javascript
  m.appendChild(mkBtn("🎹 Convert to MIDI…", () => { if (typeof openConvertToMidiDialog === "function") openConvertToMidiDialog(clip, anchor); }));
```

- [ ] **Step 3:** `node --check static/daw-midi.js static/daw-waveedit.js`; commit:
```bash
git add static/daw-midi.js static/daw-waveedit.js
git commit -m "feat(daw): Web-MIDI access + Convert-to-MIDI clip flow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Engine — MIDI scheduling (synth + external) + stop

**Files:** Modify `static/daw-engine.js`. READ `_dawScheduleAll` and the stop function first.

- [ ] **Step 1: Add engine MIDI state + helpers** (near the top globals, after `let _dawActiveSources = [];`):
```javascript
let _dawMidiActiveOuts = new Set();
let _dawCtxAtStart = 0, _dawPerfAtStart = 0;
function _dawApplyAdsr(gainParam, when, dur, peak, env) {
  gainParam.setValueAtTime(0.0001, when);
  if (env === "pad") {
    const a = 0.15, r = 0.4;
    gainParam.linearRampToValueAtTime(peak, when + Math.min(a, dur));
    gainParam.setValueAtTime(peak, when + dur);
    gainParam.linearRampToValueAtTime(0.0001, when + dur + r);
  } else {
    const a = 0.005, d = Math.min(0.12, dur);
    gainParam.linearRampToValueAtTime(peak, when + a);
    gainParam.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.25), when + a + d);
    gainParam.linearRampToValueAtTime(0.0001, when + dur + 0.08);
  }
}
function _dawScheduleMidiTrack(track, chain, ctx) {
  const out = (track.midi_out && typeof dawMidiGetOutput === "function") ? dawMidiGetOutput(track.midi_out) : null;
  const synth = track.synth || { wave: "sawtooth", env: "pluck" };
  for (const n of (track.notes || [])) {
    const nEnd = n.start + n.dur;
    if (nEnd <= _dawPlayhead) continue;
    const startT = Math.max(n.start, _dawPlayhead);
    const when = _dawStartCtxTime + (startT - _dawPlayhead);
    const dur = Math.max(0.02, nEnd - startT);
    if (out) {
      const onMs = _dawPerfAtStart + (when - _dawCtxAtStart) * 1000;
      const offMs = onMs + dur * 1000;
      try {
        out.send([0x90, n.pitch & 127, n.vel & 127], onMs);
        out.send([0x80, n.pitch & 127, 0], offMs);
        _dawMidiActiveOuts.add(out);
      } catch (_) {}
    } else {
      const osc = ctx.createOscillator(); osc.type = synth.wave || "sawtooth";
      osc.frequency.value = (typeof _dawNoteFreq === "function") ? _dawNoteFreq(n.pitch) : 440;
      const g = ctx.createGain();
      const peak = Math.max(0.001, (n.vel / 127) * 0.3);
      _dawApplyAdsr(g.gain, when, dur, peak, synth.env || "pluck");
      osc.connect(g); g.connect(chain.gain);
      const rel = (synth.env === "pad") ? 0.4 : 0.08;
      osc.start(when); osc.stop(when + dur + rel);
      _dawActiveSources.push(osc);
    }
  }
}
```

- [ ] **Step 2: Capture clocks + branch MIDI tracks** in `_dawScheduleAll`. After the line `_dawStartPlayhead = _dawPlayhead;` add:
```javascript
  _dawCtxAtStart = ctx.currentTime;
  _dawPerfAtStart = (typeof performance !== "undefined") ? performance.now() : 0;
```
Then inside `for (const track of dawState.tracks) {` right after the `const chain = _dawTrackChains.get(track.id); if (!chain) continue;` lines, add:
```javascript
    if (track.kind === "midi") { _dawScheduleMidiTrack(track, chain, ctx); continue; }
```

- [ ] **Step 3: All-notes-off on stop.** In the stop teardown (the block doing `for (const s of _dawActiveSources) { try { s.stop(); } catch (_) {} } _dawActiveSources = [];`), add right after it:
```javascript
  if (typeof dawMidiAllNotesOff === "function") dawMidiAllNotesOff();
```

- [ ] **Step 4:** `node --check static/daw-engine.js`; commit:
```bash
git add static/daw-engine.js
git commit -m "feat(daw): schedule MIDI tracks — internal synth + external Web-MIDI; all-notes-off on stop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Timeline — MIDI lane + header + Add MIDI Track

**Files:** Modify `static/daw-timeline.js`, `templates/index.html`

- [ ] **Step 1: Render MIDI lanes.** In `renderTimeline`, where each track's lane is built and clips are drawn, branch on `track.kind === "midi"` to draw notes instead of clips. Find the per-track lane loop (after `lane.dataset.trackId = track.id;` and the dragover/drop wiring) and, for MIDI tracks, replace the clip-drawing with note blocks. Add this block inside the track loop (guard so audio tracks keep current behaviour):
```javascript
    if (track.kind === "midi") {
      const notes = track.notes || [];
      const pitches = notes.map(n => n.pitch);
      const lo = pitches.length ? Math.min(...pitches) : 48;
      const hi = pitches.length ? Math.max(...pitches) : 72;
      const span = Math.max(1, hi - lo);
      const h = _DAW_LANE_H - 6;
      for (const n of notes) {
        const b = document.createElement("div");
        const y = 3 + (1 - (n.pitch - lo) / span) * (h - 4);
        b.style.cssText = `position:absolute;left:${n.start * _dawPxPerSec}px;top:${y}px;` +
          `width:${Math.max(2, n.dur * _dawPxPerSec)}px;height:3px;background:${track.color};border-radius:1px;opacity:0.9`;
        lane.appendChild(b);
      }
      lanes.appendChild(lane);
      continue;   // skip clip rendering for MIDI lanes
    }
```
(Place this immediately before the existing code that iterates `track.clips` to build clip elements. Ensure `lanes` and `lane` names match the surrounding code; if clips are appended via a different container variable, mirror it.)

- [ ] **Step 2: MIDI track header controls.** In `dawRenderTrackHeaders`, after the volume slider is appended (`row.appendChild(vol);`), add MIDI-only controls:
```javascript
    if (t.kind === "midi") {
      const wave = document.createElement("select");
      wave.title = "Synth waveform"; wave.style.cssText = "font-size:10px;width:100%;margin-top:2px";
      for (const w of ["sine","triangle","sawtooth","square"]) {
        const o = document.createElement("option"); o.value = w; o.textContent = w; if ((t.synth||{}).wave === w) o.selected = true; wave.appendChild(o);
      }
      wave.addEventListener("change", () => dawSetTrackSynth(t.id, { wave: wave.value }));
      const outSel = document.createElement("select");
      outSel.title = "MIDI output (Internal synth or hardware over USB)"; outSel.style.cssText = "font-size:10px;width:100%;margin-top:2px";
      const rebuild = () => {
        outSel.innerHTML = "";
        const oi = document.createElement("option"); oi.value = ""; oi.textContent = "Internal synth"; outSel.appendChild(oi);
        for (const o of (typeof dawMidiOutputs === "function" ? dawMidiOutputs() : [])) {
          const op = document.createElement("option"); op.value = o.id; op.textContent = o.name; if (t.midi_out === o.id) op.selected = true; outSel.appendChild(op);
        }
        if (t.midi_out) outSel.value = t.midi_out;
      };
      rebuild();
      outSel.addEventListener("focus", async () => { if (typeof dawInitMidi === "function") { await dawInitMidi(); rebuild(); } });
      outSel.addEventListener("change", () => dawSetTrackMidiOut(t.id, outSel.value || null));
      row.appendChild(wave); row.appendChild(outSel);
    }
```

- [ ] **Step 3: "+ Add MIDI Track" button.** In `templates/index.html`, next to `#daw-add-track`, add:
```html
        <button class="secondary small" id="daw-add-midi-track" style="margin:0 6px 6px;width:calc(100% - 12px)">+ Add MIDI Track</button>
```
Wire it in `daw-timeline.js` where `#daw-add-track` is wired (or in `daw.js` `_dawWireTransport` if that's where add-track lives — search for `daw-add-track`). Add:
```javascript
  const amt = document.getElementById("daw-add-midi-track");
  if (amt) amt.addEventListener("click", () => dawAddMidiTrack());
```
(Put it adjacent to the existing `daw-add-track` listener so it's wired once.)

- [ ] **Step 4:** `node --check static/daw-timeline.js`; restart + check the button serves:
```bash
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/ | grep -c 'id="daw-add-midi-track"'   # 1
```
Commit:
```bash
git add static/daw-timeline.js templates/index.html
git commit -m "feat(daw): MIDI lane note rendering + header (wave/output) + Add MIDI Track

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Export — render MIDI via internal synth

**Files:** Modify `static/daw-export.js`. READ `dawRenderArrangement` first.

- [ ] **Step 1:** Inside the per-track loop (after the track gain/pan `tg`/`pan` nodes are created, before/around the `for (const clip of track.clips)` loop), add a MIDI branch that renders notes through an offline oscillator+ADSR and skips external-routed tracks:
```javascript
    if (track.kind === "midi") {
      if (track.midi_out) continue;   // hardware-routed → silent in export
      const synth = track.synth || { wave: "sawtooth", env: "pluck" };
      for (const n of (track.notes || [])) {
        const osc = off.createOscillator(); osc.type = synth.wave || "sawtooth";
        osc.frequency.value = 440 * Math.pow(2, (n.pitch - 69) / 12);
        const g = off.createGain();
        const peak = Math.max(0.001, (n.vel / 127) * 0.3);
        const when = n.start, dur = Math.max(0.02, n.dur);
        g.gain.setValueAtTime(0.0001, when);
        if (synth.env === "pad") {
          g.gain.linearRampToValueAtTime(peak, when + Math.min(0.15, dur));
          g.gain.setValueAtTime(peak, when + dur);
          g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.4);
        } else {
          g.gain.linearRampToValueAtTime(peak, when + 0.005);
          g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.25), when + 0.005 + Math.min(0.12, dur));
          g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.08);
        }
        osc.connect(g); g.connect(tg);
        const rel = (synth.env === "pad") ? 0.4 : 0.08;
        osc.start(when); osc.stop(when + dur + rel);
      }
      continue;   // skip clip loop for MIDI tracks
    }
```
(`off` = the OfflineAudioContext, `tg` = the track gain node — match the names in `dawRenderArrangement`.)

- [ ] **Step 2:** `node --check static/daw-export.js`; commit:
```bash
git add static/daw-export.js
git commit -m "feat(daw): export MIDI tracks via internal synth (external-routed skipped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Glue + live verification

**Files:** Modify `templates/index.html`; create `/tmp/daw_midi_verify.py`

- [ ] **Step 1: Script tag + cache-busts.** In `templates/index.html` add `<script src="/static/daw-midi.js?v=1"></script>` immediately after the `daw-engine.js` tag. Bump: `daw-project.js` v9→v10, `daw-engine.js` v8→v9, `daw-timeline.js` v7→v8, `daw-waveedit.js` v4→v5, `daw-export.js` v2→v3. Restart:
```bash
node --check static/daw.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-midi.js?v=1"   # 200
```

- [ ] **Step 2: Driver** (`/tmp/daw_midi_verify.py`) — stubs `/daw/transcribe` for determinism, then exercises track creation, synth playback, and persistence:
```python
from playwright.sync_api import sync_playwright
BASE="http://127.0.0.1:8001"; HDR={"Cf-Access-Authenticated-User-Email":"steve.j.petry@gmail.com"}
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(viewport={"width":1400,"height":950},extra_http_headers=HDR)
    page=ctx.new_page(); errs=[]; page.on("pageerror",lambda e:errs.append(str(e)))
    page.goto(BASE,wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate",timeout=15000)
    try: page.wait_for_load_state("networkidle",timeout=20000)
    except Exception: pass
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2500)
    page.evaluate("async()=>{ await dawNewProject('MidiCheck'); }"); page.wait_for_timeout(800)
    # + Add MIDI Track
    page.click("#daw-add-midi-track"); page.wait_for_timeout(300)
    midi=page.evaluate("()=>dawState.tracks.filter(t=>t.kind==='midi').length")
    tid=page.evaluate("()=>dawState.tracks.find(t=>t.kind==='midi').id")
    print("midi tracks:", midi)
    # Put notes on it (simulate transcription result) and play
    page.evaluate(f"""()=>dawSetTrackNotes('{tid}', [
      {{start:0.0,dur:0.4,pitch:60,vel:100}},{{start:0.5,dur:0.4,pitch:64,vel:100}},
      {{start:1.0,dur:0.4,pitch:67,vel:100}},{{start:1.5,dur:0.6,pitch:72,vel:110}}])""")
    page.wait_for_timeout(200)
    notecount=page.evaluate(f"()=>_dawFindClipTrack ? 0 : dawState.tracks.find(t=>t.id==='{tid}').notes.length")
    print("notes set:", page.evaluate(f"()=>dawState.tracks.find(t=>t.id==='{tid}').notes.length"))
    page.evaluate("()=>{ dawSeek(0); dawPlay(); }"); page.wait_for_timeout(1200)
    pk=page.evaluate(f"()=>dawEngineTrackPeak('{tid}')"); page.evaluate("()=>dawStop()")
    print("synth track peak:", round(pk,4), "| AUDIBLE:", pk>0.001)
    # arrangement length includes notes
    al=page.evaluate("()=>dawArrangementLength()")
    print("arrangement length:", round(al,2), "| INCLUDES NOTES:", al>=2.0)
    # Web MIDI presence (informational; headless usually has none)
    outs=page.evaluate("async()=>{ if(typeof dawInitMidi==='function'){ await dawInitMidi(); return dawMidiOutputs().length;} return -1; }")
    print("midi outputs:", outs)
    # Convert-to-MIDI via stub
    page.evaluate("""()=>{ const of=window.fetch; window.fetch=(u,o)=>{ if(typeof u==='string'&&u.startsWith('/daw/transcribe')){
        return Promise.resolve(new Response(JSON.stringify({notes:[{start:0,dur:0.5,pitch:62,vel:90}],duration:0.5,mode:'melody',count:1}),{status:200,headers:{'Content-Type':'application/json'}})); } return of(u,o); }; }""")
    # add an audio clip then convert it
    page.evaluate("()=>{ const at=dawState.tracks.find(t=>t.kind!=='midi')||dawAddTrack(); }")
    aid=page.evaluate("()=>{ const t=dawState.tracks.find(t=>t.kind!=='midi'); const c=dawAddClip(t.id,{file:_dawLibItems[0].file,name:_dawLibItems[0].name,source_duration:8},0); return c.id; }")
    page.wait_for_timeout(200)
    before=page.evaluate("()=>dawState.tracks.filter(t=>t.kind==='midi').length")
    page.evaluate(f"async()=>{{ const c=_dawFindClip('{aid}').clip; await dawConvertToMidi(c,'melody'); }}")
    page.wait_for_timeout(500)
    after=page.evaluate("()=>dawState.tracks.filter(t=>t.kind==='midi').length")
    print("convert added midi track:", after>before)
    # persistence
    page.wait_for_timeout(1200); pid=page.evaluate("()=>dawState.id")
    page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate",timeout=15000); page.wait_for_timeout(800)
    page.click('[data-tab="daw"]'); page.wait_for_timeout(1500)
    per=page.evaluate(f"""async()=>{{ await dawLoadProject({pid}); const t=dawState.tracks.find(x=>x.kind==='midi');
        return {{kind:t.kind, notes:t.notes.length, wave:t.synth.wave}}; }}""")
    print("persisted:", per)
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_midi.png", full_page=True)
    ctx.close(); b.close()
print("MIDI VERIFY DONE")
```

- [ ] **Step 3:** Run `cd /tmp && python3 daw_midi_verify.py`. Expected: midi tracks ≥1; notes set 4; synth track peak > 0 (AUDIBLE True); arrangement length ≥ 2.0 (INCLUDES NOTES True); midi outputs is a number (≥0 or -1 in headless — both fine, just no crash); convert added a MIDI track True; persisted shows kind midi + notes ≥1; `PAGE ERRORS: []`.

- [ ] **Step 4:** Inspect `/tmp/daw_midi.png` — a MIDI lane with note blocks, header wave/output selects, "+ Add MIDI Track" button.

- [ ] **Step 5: Regression** `python3 -m pytest tests/ -q` (94 passed) and `for f in daw-project daw-engine daw-midi daw-timeline daw-waveedit daw-export daw; do node --check static/$f.js; done`. Commit:
```bash
git add templates/index.html
git commit -m "feat(daw): wire daw-midi.js + cache-busts for MIDI core

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model `kind/notes/synth/midi_out` + defaults + load-normalize + mutations + `dawArrangementLength` → Task 3 ✓
- Conversion: `melody_notes`/`rhythm_notes`/`piano_notes`/`notes_to_json` → Task 1; `/daw/transcribe` → Task 2; Convert-to-MIDI dialog/flow + clip-menu → Task 4 ✓
- Internal synth playback (osc+ADSR through chain) → Task 5 ✓
- External Web-MIDI (access, per-track output, clock-mapped send, all-notes-off) → Tasks 4 (access) + 5 (scheduling/stop) + 6 (output selector) ✓
- Timeline note rendering + MIDI header + Add MIDI Track → Task 6 ✓
- Export via internal synth, external skipped → Task 7 ✓
- Glue + cache-busts + verification → Task 8 ✓
- Edge cases (no kind→audio, Web MIDI absent→Internal only, unplugged device→fallback, stop all-notes-off, 0 notes, mid-note start, FX on MIDI, external silent in export) → Tasks 3/4/5/6/7; verified Task 8 ✓

**Placeholder scan:** none — complete code + commands. Piano mode reuses the existing model path (heavier) but melody/rhythm are dependency-light.

**Type/name consistency:** `melody_notes/rhythm_notes/piano_notes/notes_to_json/_notes_from_midi_bytes` (Task 1) ↔ `/daw/transcribe` dispatch (Task 2). JS: `kind/notes/synth/midi_out`, `dawAddMidiTrack/dawSetTrackNotes/dawSetTrackSynth/dawSetTrackMidiOut`, `_dawDefaultSynth` (Task 3) ↔ `dawInitMidi/dawMidiOutputs/dawMidiGetOutput/dawMidiAllNotesOff/_dawNoteFreq/openConvertToMidiDialog/dawConvertToMidi` (Task 4) ↔ `_dawMidiActiveOuts/_dawCtxAtStart/_dawPerfAtStart/_dawApplyAdsr/_dawScheduleMidiTrack` (Task 5) ↔ header `wave/outSel` + `#daw-add-midi-track` (Task 6) ↔ export branch (Task 7). Note shape `{start,dur,pitch,vel}` consistent across Tasks 1–8. Reuses `_dawFindClip().clip`, `dawAddClip`, `dawEngineTrackPeak`, `_dawLibItems`, `dawSeek/dawPlay/dawStop` in Task 8.
```
