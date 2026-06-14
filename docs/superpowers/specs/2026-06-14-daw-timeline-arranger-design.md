# Nyx-Step DAW — Phase 1: Timeline Arranger — Design

**Date:** 2026-06-14
**Status:** Approved (design)
**Component:** New 🎚 DAW tab in Nyx-Step (music-ai.nyxstudios.net)

---

## Context

Nyx-Step is a FastAPI + vanilla-JS web app for AI music generation via ComfyUI/ACE-Step.
It already produces audio clips (generated songs in `COMFYUI_OUTPUT_DIR`) and Demucs stems
(vocals/drums/bass/other in `DEMUCS_OUTPUT_DIR`), draws waveforms with WaveSurfer, and has
remix/extend/repaint and a SQLite job/history store (`core/db.py`, WAL).

The user wants a full DAW (FL Studio / Ableton style) added to the app. A full DAW is several
subsystems, so it is being built in phases:

| Phase | Capability |
|---|---|
| **1. Timeline Arranger** (this spec) | Tracks + lanes, drag clips/stems on, position/trim/move/delete, transport, mute/solo, autosave + project list |
| 1.5 | Beat grid + snapping (built on Phase 1's seconds-based model) |
| 2 | Mixer — per-track volume/pan faders + master bus |
| 3 | Wave editor — split, fade, gain, normalize per clip |
| 4 | Export / bounce — render arrangement to one file (server ffmpeg) |
| 5 | AI integration — generate onto a track, repaint a region, Demucs a clip into stems-as-tracks |
| 6 | FX (reverb/EQ/delay) + session/looper grid |

This document specs **Phase 1 only**. Each later phase gets its own spec → plan → implementation.

### Out of scope (and why)
- **MIDI / piano roll** — Nyx-Step works with rendered audio, not MIDI instruments. Note-level
  composition is a separate direction, not part of the DAW arrangement surface.
- **Uploads of external audio** — Phase 1 source material is the user's own generated clips and
  stems. Upload-in can be added later (the Stems tab already has an upload endpoint to reuse).
- Faders/pan (P2), split/fade/normalize (P3), export (P4), AI hooks (P5), FX & session grid (P6),
  grid snapping (P1.5) — all deferred per the phase table.

---

## Decisions (locked during brainstorming)

1. **Clip alignment:** free-form placement (seconds) in Phase 1; beat-grid snapping in Phase 1.5.
   The data model stores `start`/`duration` in seconds so snapping later only quantizes values.
2. **Source material:** generated clips + Demucs stems (no uploads).
3. **Persistence:** SQLite `daw_projects` table — autosave, project list, per-user ownership.
4. **Audio engine:** client-side Web Audio API (real-time, sample-accurate). Backend only stores
   projects and serves files. Server-side mixdown is deferred to Phase 4.

---

## Architecture

### Overview

```
Browser (DAW tab)                              Backend (FastAPI)
┌─────────────────────────────┐                ┌──────────────────────┐
│ daw-library.js  ──fetch──────┼──GET /daw/library──▶ routes/daw.py    │
│ daw-project.js  ──autosave───┼──PUT /daw/projects/{id}──▶  core/db.py│
│ daw-timeline.js (render/drag)│                │  daw_projects table   │
│ daw-engine.js (Web Audio)────┼──GET /daw/audio/{file}──▶ routes/daw.py│
│ daw.js (transport glue)      │                └──────────────────────┘
└─────────────────────────────┘
   AudioContext: BufferSource→trackGain→masterGain→destination
```

All playback, mixing, scheduling, and waveform peak rendering happen in the browser. The backend
stores the project JSON and serves audio bytes via a dedicated `GET /daw/audio/{file:path}` route
(ownership-aware for both generated clips and stems — see API section for why the existing
`/download` can't serve stems).

### File structure (matches the app's focused-module convention)

| File | Responsibility | Depends on |
|---|---|---|
| `routes/daw.py` | `/daw` API: project CRUD, library listing, ownership-aware audio fetch | `core/db.py`, `nyx_step.get_user_email`, `_safe_output_path` |
| `core/db.py` (extend) | `daw_projects` table + CRUD functions | sqlite3 |
| `static/daw-project.js` | in-memory project state, mutations, debounced autosave, load/new/list/delete | `/daw` API |
| `static/daw-engine.js` | AudioContext, buffer cache, scheduling, transport, playhead clock | `/download` |
| `static/daw-timeline.js` | render ruler/lanes/clips, drag-drop, trim, select, zoom, draw playhead | daw-project, daw-engine |
| `static/daw-library.js` | clip-library panel, fetch sources, drag handles | `/daw/library` |
| `static/daw.js` | DAW tab wiring + transport button glue | all of the above |
| `templates/index.html` (extend) | DAW tab markup + script tags + cache-bust versions | — |

---

## Data Model

### `daw_projects` table

```sql
CREATE TABLE IF NOT EXISTS daw_projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email  TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT 'Untitled Project',
    data        TEXT NOT NULL DEFAULT '{}',   -- arrangement JSON
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daw_user ON daw_projects(user_email);
```

Added via the same `ALTER`/`CREATE IF NOT EXISTS` migration pattern already used in `init_db`.

### Arrangement JSON (`data` column)

```json
{
  "version": 1,
  "tempo": 120,
  "tracks": [
    {
      "id": "t1",
      "name": "Vocals",
      "mute": false,
      "solo": false,
      "color": "#7c65d9",
      "clips": [
        {
          "id": "c1",
          "file": "Nyx_music_00074_.mp3",
          "name": "E2E-Confirm",
          "start": 0.0,
          "offset": 0.0,
          "duration": 12.5,
          "source_duration": 25.0
        }
      ]
    }
  ]
}
```

- **Non-destructive:** a clip references a source `file` plus `offset` (in-point within the source)
  and `duration` (trimmed length). Source files are never modified.
- **`start`** = position on the timeline (seconds). **`offset` + `duration`** = the slice played.
  **`source_duration`** = full file length, used to bound trimming.
- **`tempo`** is informational in Phase 1 (no grid); Phase 1.5 uses it for snapping.
- **`color`** assigned per track from a palette (DAW aesthetic; clips inherit track color).
- File paths are relative to `COMFYUI_OUTPUT_DIR`; stems live under the `separated/` subdir
  (`DEMUCS_OUTPUT_DIR = COMFYUI_OUTPUT_DIR/separated`) and are stored with that relative path
  (e.g. `separated/htdemucs/<song>/bass.wav`). Playback fetches via `GET /daw/audio/{file:path}`.

---

## API (`routes/daw.py`, prefix `/daw`)

All routes resolve the user via `get_user_email(request)` and scope every query to that user.

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET /daw/projects` | — | `{projects: [{id, name, updated_at}]}` | sorted by `updated_at` desc |
| `POST /daw/projects` | `{name}` | `{id, name}` | creates empty project (one default track) |
| `GET /daw/projects/{id}` | — | full row incl. parsed `data` | 404 if not owned |
| `PUT /daw/projects/{id}` | `{name?, data}` | `{saved: id, updated_at}` | autosave target; updates `updated_at`; 404 if not owned |
| `DELETE /daw/projects/{id}` | — | `{deleted: id}` | 404 if not owned |
| `GET /daw/library` | — | `{clips: [...], stems: [...]}` | source material for this user |
| `GET /daw/audio/{file:path}` | — | audio bytes | ownership-aware fetch for clips **and** stems |

### `GET /daw/library` detail

- **clips:** the user's completed generations. Source = `db.get_user_jobs(user_email)` filtered to
  `status == "done"`, each entry `{file, name, duration}` (one per output file). `duration` from
  the job params when present, else `null` (the client fills it after decode).
- **stems:** Demucs outputs under `DEMUCS_OUTPUT_DIR`. Each `{file (relative path), name, stem_type}`
  where `stem_type ∈ {vocals, drums, bass, other}`. Only stems whose parent song the user owns are
  listed (match the stem's parent-song folder name against the user's output filenames).

### Why a dedicated `GET /daw/audio/{file:path}` (not the existing `/download`)

The existing `/download` ownership check (`db.user_owns_file`) tests membership in a job's
`output_files`. Stem files (`separated/htdemucs/<song>/bass.wav`) are **not** in `output_files`, so
`/download` would 404 on every stem. `/daw/audio` resolves ownership for both cases:
1. `file` is in one of the user's job `output_files` (a generated clip), **or**
2. `file` is under `separated/` and its parent-song folder name matches a stem of a song the user owns.

It then serves from `COMFYUI_OUTPUT_DIR` using the same `_safe_output_path()` traversal guard already
in `routes/download.py` (extracted to a shared helper or imported). Range requests are not required
for Phase 1 — the client decodes whole buffers.

---

## Audio Engine (`daw-engine.js`)

- **Context:** one shared `AudioContext`, created lazily and `resume()`d on the first Play click
  (browser autoplay policy).
- **Buffer cache:** `Map(file → AudioBuffer)`. On clip add / project load, `fetch('/daw/audio/'+file)`
  → `arrayBuffer()` → `decodeAudioData()` → cache. Clips sharing a file share one buffer. Decode is
  lazy and parallel; a clip shows a loading state until its buffer is ready.
- **Graph (Phase 1):** `BufferSource → trackGain → masterGain → ctx.destination`.
  `trackGain` is unity (faders are Phase 2). **Mute** sets the track inaudible; **solo** makes only
  soloed tracks audible (if any track is soloed, non-soloed tracks are silenced).
- **Scheduling (Play):** capture `startAt = ctx.currentTime + LOOKAHEAD`. For each audible clip:
  - `clip.start >= playhead` → `source.start(startAt + (clip.start - playhead), clip.offset, clip.duration)`
  - clip straddles playhead → start at `startAt` from `clip.offset + (playhead - clip.start)` for the remainder
  - clip already ended (`clip.start + clip.duration <= playhead`) → skip
- **Playhead clock:** `requestAnimationFrame` loop sets `playhead = startPlayhead + (ctx.currentTime - startAt)`.
- **Transport:** Play / Pause (stop sources, remember playhead) / Stop (reset to 0) / Seek (ruler
  click sets playhead; reschedule if playing) / Loop-all (restart at arrangement end while enabled).
- **Active-source tracking:** keep a list; Stop/Pause/reschedule call `stop()` on all to avoid dangling
  sources. Changing mute/solo during playback reschedules from the current playhead.
- **Arrangement length:** max of `clip.start + clip.duration` across all clips (used for ruler width
  and loop point); minimum visible length is a sensible default (e.g. 60s) when empty.

### Waveform peaks
Computed client-side from the decoded `AudioBuffer` (downsample channel data to ~1–2 px-per-peak for
the clip's rendered width), cached per file in a `Map`. Drawn into each clip block on a `<canvas>`.
No server peak generation in Phase 1.

---

## UI Layout

New **🎚 DAW** tab. Dark, dense, FL/Ableton Arrangement-view aesthetic using the app's existing
theme variables; clips are color-coded per track with waveforms inside the blocks.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [My Project ▾]  ▶ ⏸ ⏹  ↻loop   0:12 / 2:30   🔍− 🔍+   ✓ autosaved        │  transport
├────────────┬─────────────────────────────────────────────────────────────┤
│            │ 0:00     0:30     1:00     1:30     2:00     2:30             │  ruler
│ TRACKS     │              ┃ playhead                                       │
│ ▾ Vocals   │ ┌─clipA────┐ ┃   ┌─clipB──────┐                              │
│   M S ✕    │ │∿∿∿∿∿∿∿∿∿│ ┃   │∿∿∿∿∿∿∿∿∿∿│                              │
│ ▾ Drums    │ ┌─drumloop─────────────────┐                                 │
│   M S ✕    │ │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│                                 │
│ + Add Track│                                                              │
├────────────┴─────────────────────────────────────────────────────────────┤
│ 📚 CLIP LIBRARY  [search…]                          generated │ stems     │  drag source
│ ⠿ E2E-Confirm.mp3   ⠿ heavy-metal.mp3   ⠿ vocals.stem  ⠿ drums.stem …     │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Transport bar:** project picker (New / Open / rename), play / pause / stop, loop toggle,
  current/total time, zoom −/+, live autosave indicator.
- **Track headers (left):** editable name, **M**ute, **S**olo, remove; "+ Add Track" at the bottom.
- **Timeline (center):** seconds ruler, one lane per track, moving playhead, horizontal scroll + zoom.
- **Clip library (bottom):** searchable list of generated clips + stems; each row a drag handle.
- **Clip gestures:** drag block sideways to move in time / up–down to change lanes; drag an edge to
  trim in/out; click to select; Delete to remove; Ctrl+D to duplicate.

---

## Scope — Phase 1 feature list

**In:**
- Tracks: add, remove, rename, mute, solo, per-track color.
- Clips: add (drag from library), move (time + lane), trim in/out, delete, duplicate.
- Transport: play, pause, stop, seek (ruler click), loop-all, zoom, current/total time.
- Library: list generated clips + Demucs stems, search, drag to lane.
- Persistence: SQLite per-user projects; New / Open / rename / delete; debounced autosave with indicator.
- Playback: client Web Audio, sample-accurate multi-track sync, mute/solo honored.

**Out (deferred to noted phase):** volume/pan faders & master metering (P2); split / crossfade /
fade / normalize / gain (P3); export / bounce (P4); generate-onto-track / repaint-region /
demucs-to-tracks (P5); FX & session/looper grid (P6); beat-grid + snapping (P1.5); uploads & MIDI (out).

---

## Edge Cases

| Case | Handling |
|---|---|
| Play with no clips | No-op; transport returns to idle |
| Source file deleted/missing | `/daw/audio` 404 → clip shown in a "missing" state, skipped in playback |
| `decodeAudioData` failure | Clip marked errored (red), skipped in playback, tooltip explains |
| Rapid play/stop/seek | Active-source list stopped before each reschedule — no dangling/overlapping audio |
| Autoplay policy | `AudioContext.resume()` on the first Play click |
| Trim beyond source bounds | Clamp `offset`/`duration` to `[0, source_duration]` |
| Autosave race / offline | Debounced PUT; on failure show "save failed", retry on next change; in-memory state is source of truth |
| Project opened in two tabs | Last write wins (acceptable single-user app); no locking in Phase 1 |
| Clip dragged left past 0 | Clamp `start` to 0 |

---

## Testing

**Backend (`pytest`, like existing route tests, TestClient + temp-DB conftest):**
- `daw_projects` CRUD: create → list → get → update → delete.
- Ownership: a project created as user A is not listed/gettable/updatable/deletable by user B (404).
- `GET /daw/library`: returns the user's done-job clips and their stems; excludes other users' files.
- `GET /daw/audio`: serves a generated clip the user owns; serves a stem whose parent song the user
  owns; 404s a file the user doesn't own and a traversal attempt (`../../etc/passwd`).
- Autosave path: `PUT` updates `data` and bumps `updated_at`.
- Malformed/oversized `data` rejected cleanly (clear 400, not a 500).

**Frontend (Playwright live on Nyx, per repo convention):**
- Open DAW tab → New project → a default track renders.
- Drag a library clip onto a lane → clip block appears with a waveform.
- Play → assert `AudioContext` state `running` and the playhead advances; Stop resets it.
- Trim a clip edge → `duration` changes; mute a track → it drops out of playback.
- Edit → wait for autosave indicator → reload page → reopen project → arrangement persists.

---

## Success Criteria

A user can, entirely inside Nyx-Step: create a DAW project, drag several generated clips and stems
onto multiple tracks, position and trim them on a free-form timeline, play the whole arrangement
back in sync with working mute/solo, and have the project autosave and reload intact. The data model
and engine are structured so Phases 1.5–6 (snapping, mixer, wave editor, export, AI hooks, FX) layer
on without reworking the foundation.
