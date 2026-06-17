# Nyx-Step DAW — MIDI Core (Stage 2A) — Design

**Date:** 2026-06-17
**Status:** Approved (design)
**Component:** MIDI track type, audio→MIDI conversion, synth + external-MIDI playback, export in the 🎚 DAW tab
**Builds on:** DAW phases 1–6 + snap/stretch; `core/midi.py` (melody/piano transcription), librosa.

---

## Scope

**Stage 2A (this spec):** a MIDI track type with internal Web-Audio synth playback, external USB-MIDI
output, audio→MIDI conversion (melody / rhythm / piano), timeline note rendering, and WAV export.
**Stage 2B (separate, next):** full piano-roll note editor (draw/move/resize/velocity). Not in 2A.

### Out of scope (2A)
Piano-roll editing (2B), SoundFont/sampled instruments (future), MIDI input/recording, multiple MIDI
channels per track, per-note editing beyond what conversion produces.

### Locked decisions
- Internal synth now (oscillator + ADSR), SoundFonts later.
- External USB MIDI out via Web MIDI API, per-track output selector.
- Conversion modes: melody (pyin), rhythm (onset), piano (transcription).
- Full piano-roll editing deferred to Stage 2B.

---

## Data Model (`daw-project.js`)

A track gains `kind: "audio"` (default) or `"midi"`. Existing tracks load as `"audio"`.

A **MIDI track** carries (alongside the shared `id, name, mute, solo, color, volume, pan, fx, cells`):
```json
"kind": "midi",
"notes": [ {"start": 0.0, "dur": 0.5, "pitch": 60, "vel": 80}, ... ],
"synth": { "wave": "sawtooth", "env": "pluck" },
"midi_out": null
```
- `notes` — seconds / MIDI pitch 0–127 / velocity 0–127.
- `synth.wave` ∈ sine|triangle|sawtooth|square; `synth.env` ∈ pluck|pad.
- `midi_out` — `null` = internal synth, else a MIDI output **id** string.

Audio tracks keep `clips`; MIDI tracks ignore `clips` (empty). All persisted in the opaque project JSON
(defaults applied on load — no migration).

**Mutations:** `dawAddMidiTrack(name)`; `dawSetTrackNotes(trackId, notes)`; `dawSetTrackSynth(trackId,
patch)`; `dawSetTrackMidiOut(trackId, outId)`. Load normalizes: `kind ?? "audio"`, and for MIDI tracks
`notes ?? []`, `synth ?? {wave:"sawtooth",env:"pluck"}`, `midi_out ?? null`.

`dawArrangementLength()` must include MIDI tracks: `max(note.start + note.dur)`.

---

## Audio→MIDI Conversion

### Backend (`core/midi.py` + `routes/daw.py`)
Refactor `core/midi.py` to expose **note lists** (it already builds them internally):
- `melody_notes(audio_path) -> list[(start, end, pitch, vel)]` — extracted from current
  `extract_melody_midi` (the pyin + `_notes_from_pyin` path). `extract_melody_midi` now calls it.
- `rhythm_notes(audio_path) -> list[(start, end, pitch, vel)]` — **new**: `librosa.onset.onset_detect`
  (units="time") on the loaded mono signal; each onset → a short hit `(t, t+0.12, 38, vel)` where
  `vel` scales with onset strength (`librosa.onset.onset_strength`), clamped 40–120. Pitch 38 = a
  General-MIDI snare-ish default (purely a placeholder pitch for a percussion lane).
- `piano_notes(audio_path) -> list[(start, end, pitch, vel)]` — **new**: run the existing
  `extract_piano_midi` and parse its MIDI bytes via `mido` into absolute-time note tuples
  (`note_on`/`note_off` pairing, ticks→seconds using the file tempo). Slower (model + CUDA).

New helper `notes_to_json(notes) -> list[dict]`: `(start,end,pitch,vel)` → `{start, dur:end-start,
pitch, vel}`.

**Endpoint** `POST /daw/transcribe` in `routes/daw.py`:
- Body `{ "file": "<library path>", "mode": "melody"|"rhythm"|"piano" }`.
- Resolve `file` with the existing ownership-aware `safe_output_path` (same as `/daw/audio`); 404 if not
  found/denied.
- Dispatch to `melody_notes`/`rhythm_notes`/`piano_notes`; on exception return 500 `{error}`.
- Return `{ "notes": notes_to_json(...), "duration": <max end or 0>, "mode": mode, "count": n }`.
- Runs in the shared thread pool (librosa is blocking) like other heavy routes.

### Frontend trigger (`daw-midi.js`)
Audio-clip menu gains **🎹 Convert to MIDI…** → small dialog (Melody / Rhythm / Piano + Convert):
- POST `/daw/transcribe` with the clip's `file` and chosen mode.
- On success: `dawAddMidiTrack(clip.name.slice(0,14) + " · " + mode)`, offset every returned note's
  `start` by the clip's `start` (so the MIDI lines up under the audio), `dawSetTrackNotes(newId, notes)`.
- Status via `_dawSetSaveStatus` ("Transcribing…", "MIDI ready ✓" / failure). The source track stays.

---

## Playback

### Internal synth (`daw-engine.js`)
In `_dawScheduleAll`, branch per track: audio tracks schedule `clips` (unchanged); **MIDI tracks
schedule `notes`** through the same persistent chain (`chain.gain`), so volume/pan/mute/solo/FX apply.
For each note with `note.start + note.dur > _dawPlayhead`:
- `when` / `playDur` computed from `_dawStartCtxTime` and `_dawPlayhead` exactly like clips (handles
  mid-note starts).
- Create `osc = ctx.createOscillator(); osc.type = synth.wave; osc.frequency.value = 440*2**((pitch-69)/12)`.
- Create `g = ctx.createGain()` with an ADSR from `synth.env` (pluck = fast attack/short decay; pad =
  slow attack/release), peak scaled by `vel/127`. `osc → g → chain.gain`.
- `osc.start(when); osc.stop(when + playDur + release)`. Push `osc` to `_dawActiveSources` for stop.

### External USB MIDI (`daw-engine.js` / `daw-midi.js`)
- `dawInitMidi()` → `navigator.requestMIDIAccess()` once, caches `_dawMidiAccess`; `dawMidiOutputs()`
  returns `[{id,name}]`. Called when a track's Output selector is opened/changed.
- When a MIDI track has `midi_out` set to a present output: in `_dawScheduleAll`, instead of synth,
  schedule MIDI messages. Map clocks at play start: capture `_dawCtxAtStart = ctx.currentTime` and
  `_dawPerfAtStart = performance.now()`; a note at audio-time `T` → `perf = _dawPerfAtStart + (T -
  _dawCtxAtStart)*1000`. Send `out.send([0x90, pitch, vel], perfStart)` and `out.send([0x80, pitch,
  0], perfEnd)`. Track used outputs in `_dawMidiActiveOuts`.
- **Stop** (`dawStop`): for each output in `_dawMidiActiveOuts` send all-notes-off
  (`out.send([0xB0,123,0])`) and clear; oscillators stopped via existing `_dawActiveSources` teardown.
- If `requestMIDIAccess` is unsupported/denied, the Output selector shows only **Internal synth** and a
  note; playback always falls back to the synth.

### Timeline (`daw-timeline.js`)
A MIDI track's lane renders `notes` as small blocks (x = `start*pxPerSec`, width = `dur*pxPerSec`,
y mapped from pitch within the lane height, min/max pitch auto-ranged). No waveform/clip handles.
Track header for MIDI tracks shows: name, M/S, volume, a **wave** `<select>` (sine/tri/saw/square), and
an **Output** `<select>` (Internal + devices). A **+ Add MIDI Track** button sits beside **+ Add Track**.
Double-click a MIDI lane is reserved to open the piano-roll (Stage 2B) — no-op for now.

### Export (`daw-export.js`)
The offline render adds MIDI tracks via the **internal synth** (oscillator+ADSR in the
OfflineAudioContext, same node math as live). Tracks with `midi_out` set are **skipped (silent)** in
export — hardware audio can't be captured; the export button tooltip / a one-line note states this.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `core/midi.py` | modify | `melody_notes`/`rhythm_notes`/`piano_notes`/`notes_to_json`; refactor existing extractors to reuse them |
| `routes/daw.py` | modify | `POST /daw/transcribe` (ownership-checked, thread-pooled) |
| `static/daw-project.js` | modify | `kind`/`notes`/`synth`/`midi_out` model + defaults + load-normalize; `dawAddMidiTrack`, `dawSetTrackNotes`, `dawSetTrackSynth`, `dawSetTrackMidiOut`; `dawArrangementLength` includes notes |
| `static/daw-engine.js` | modify | MIDI scheduling branch (internal synth + external MIDI), clock mapping, stop all-notes-off |
| `static/daw-midi.js` | **create** | Web MIDI access helpers; Convert-to-MIDI dialog/flow; synth/output header controls |
| `static/daw-timeline.js` | modify | MIDI lane note rendering + MIDI track header + "+ Add MIDI Track" |
| `static/daw-waveedit.js` | modify | clip-menu "🎹 Convert to MIDI…" |
| `static/daw-export.js` | modify | render MIDI tracks via internal synth; skip external |
| `templates/index.html` | modify | `daw-midi.js` script + cache-busts |
| `tests/test_daw.py` | modify | `/daw/transcribe` (mocked extractor) + MIDI-track persistence |

Script order: `daw-midi.js` after `daw-engine.js`, before `daw.js`.

---

## Edge Cases

| Case | Handling |
|---|---|
| Loaded track without `kind` | defaults to `"audio"` (current behaviour) |
| MIDI track with no notes | renders empty lane; schedules nothing |
| Web MIDI unsupported / denied | Output selector shows only Internal synth + note; synth used |
| Selected `midi_out` device unplugged | not found in outputs → fall back to internal synth |
| Stop / pause with external notes pending | all-notes-off sent to active outputs |
| Transcription returns 0 notes | MIDI track still created (empty); status notes "no notes detected" |
| Piano mode slow / model missing | 500 surfaced as a failure status; melody/rhythm unaffected |
| Mid-note playhead start | per-note `when`/`playDur` clamp like clips |
| Export with external-routed MIDI track | track silent in WAV; UI notes the limitation |
| FX/mixer on MIDI track | apply (notes route through the track chain) |

---

## Testing

**Backend (`pytest`):** (1) `POST /daw/transcribe` with `core.midi.melody_notes` monkeypatched to a
fixed note list → response has `notes` as `{start,dur,pitch,vel}` dicts and correct `duration`/`count`;
unknown file → 404; bad mode → 400/500 handled. (2) project persistence: a MIDI track with
`kind/notes/synth/midi_out` round-trips through PUT→GET.

**Frontend (Playwright live):**
- Convert: add an audio clip → "🎹 Convert to MIDI…" (Melody) → a MIDI track appears with `notes.length
  > 0` aligned to the clip start (stub `/daw/transcribe` to a known note set for determinism).
- Internal synth: play a MIDI track → its track analyser peak > 0 (audible); mute silences it.
- External MIDI: with Web MIDI present, `dawMidiOutputs()` returns a list; selecting one routes
  scheduling to `out.send` (assert via a stubbed `MIDIOutput.send` capturing messages); Stop sends
  all-notes-off. (If no device/API in headless, assert graceful fallback to Internal.)
- Timeline shows note blocks; **+ Add MIDI Track** adds a `kind:"midi"` track.
- Reload → `kind/notes/synth/midi_out` persist. No `pageerror`s; `pytest tests/ -q` green.

---

## Success Criteria

You can convert a wave clip to a MIDI track (melody or rhythm), the notes render on the timeline and
play through a built-in synth (with mixer/FX), you can route any MIDI track to a hardware synth over USB
MIDI, and the arrangement exports to WAV with internal-synth MIDI baked in (external-routed tracks
documented as silent). Existing audio tracks are unaffected. Piano-roll editing follows in Stage 2B.
