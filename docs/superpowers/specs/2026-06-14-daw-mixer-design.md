# Nyx-Step DAW — Phase 2: Mixer — Design

**Date:** 2026-06-14
**Status:** Approved (design)
**Component:** Mixer for the 🎚 DAW tab in Nyx-Step (music-ai.nyxstudios.net)
**Builds on:** Phase 1 Timeline Arranger (`docs/superpowers/specs/2026-06-14-daw-timeline-arranger-design.md`)

---

## Context

Phase 1 shipped a working DAW tab: a Web Audio engine (`static/daw-engine.js`), a track/clip
state model with autosave (`static/daw-project.js`), timeline rendering (`static/daw-timeline.js`),
a clip library, and transport. Tracks currently support mute/solo and per-clip gain nodes that
connect straight to a master gain.

Phase 2 adds the **mixer**: per-track volume faders and pan, a master bus fader, and live peak
meters. The mixer appears in two synchronized places — a compact inline volume slider in each
arranger track header, and a dedicated FL/Ableton-style mixer panel of vertical channel strips.

### Locked decisions (from brainstorming)
1. **UI placement:** both — inline mini-volume in track headers AND a dedicated mixer panel (option C).
2. **Metering:** included — live peak meters per channel + master.
3. **Audio routing:** persistent per-track node chains (real-time faders without rescheduling).
4. **Pan:** `StereoPannerNode` (−1 left … +1 right).
5. **Fader scale:** dB in the UI (−∞ to +6 dB, 0 dB unity detent); linear gain stored in the model.
6. **Persistence:** `volume`/`pan`/`master_volume` ride inside the existing project `data` JSON
   (no API change; the PUT endpoint already persists `data` as an opaque object).

### Out of scope (later phases)
Wave editor (P3), export/bounce (P4), AI hooks (P5), FX sends/inserts and session grid (P6),
grid snapping (P1.5). No per-track FX, EQ, or sends in Phase 2 — just gain, pan, mute/solo, meter.

---

## Audio Architecture

### Current (Phase 1)
Each clip: `BufferSource → clipGain → _dawMaster → destination`. Clip gain is unity; mute/solo are
applied by *skipping scheduling* of inaudible tracks.

### Phase 2 — persistent per-track chains
The engine maintains a chain per track, reused across playback:

```
BufferSource(clip) ─┐
BufferSource(clip) ─┼─▶ trackGain ─▶ trackPan ─▶ trackAnalyser ─┐
BufferSource(clip) ─┘                                            │
                                                                 ▼
                                          masterGain ─▶ masterAnalyser ─▶ destination
```

- `_dawTrackChains: Map(trackId → { gain: GainNode, pan: StereoPannerNode, analyser: AnalyserNode })`.
- Master: persistent `_dawMaster` (GainNode, already exists) + new `_dawMasterAnalyser` (AnalyserNode)
  between master and destination.
- Chains are (re)built by `_dawSyncChains()` — called on play and whenever tracks are added/removed —
  which creates a chain for each `dawState.tracks` entry, wires `gain→pan→analyser→_dawMaster`, removes
  chains for deleted tracks, and sets each node from the track's stored `volume`/`pan`.
- In `_dawScheduleAll`, a clip connects `src → chain.gain` (instead of a throwaway clip gain → master).
- **Mute/solo become gain-based, not schedule-based.** `_dawScheduleAll` now schedules clips for
  **every** track regardless of mute/solo (it no longer calls `_dawAudibleTracks` to skip). Audibility
  is entirely controlled by `_dawApplyMixState()`, which sets each track's `chain.gain.value` to its
  `volume` when audible or `0` when muted/not-soloed. Because every track's clips are already running,
  toggling mute/solo or moving a fader mid-playback is instant (just a gain change) — no reschedule
  and no audio gap. `_dawApplyMixState` is called on play (after scheduling) and on any
  mute/solo/volume change. The Phase 1 `dawReschedule()` (used by the track-header M/S buttons) is
  redefined to call `_dawApplyMixState()` instead of stop-and-reschedule.

### Real-time setters (in `daw-engine.js`)
- `dawEngineSetTrackVolume(trackId, gain)` — if the chain exists and the track is audible, set
  `chain.gain.value = gain` immediately; no-op if muted/soloed-out (audibility recomputed by
  `_dawApplyMixState`).
- `dawEngineSetTrackPan(trackId, pan)` — set `chain.pan.pan.value = pan`.
- `dawEngineSetMasterVolume(gain)` — set `_dawMaster.gain.value = gain`.
- `dawEngineTrackPeak(trackId)` / `dawEngineMasterPeak()` — read the analyser's current peak
  amplitude (0–1) via `getFloatTimeDomainData` (max abs sample); used by the meter loop.
- `_dawApplyMixState()` — recompute audible set (existing solo/mute logic) and set every chain's gain.

### dB ↔ linear
UI faders operate in dB; the model stores linear gain. Conversions (in `daw-mixer.js`):
- `gainToDb(g) = g <= 0.0001 ? -Infinity : 20*log10(g)`
- `dbToGain(db) = db === -Infinity ? 0 : 10**(db/20)`
- Fader range: −60 dB (treated as −∞/silent at the bottom) to +6 dB; unity (0 dB) detent at gain 1.0.

---

## Data Model

Extends the Phase 1 arrangement JSON (no schema migration — new fields default in code):

```json
{
  "version": 1,
  "tempo": 120,
  "master_volume": 1.0,
  "tracks": [
    { "id": "t1", "name": "Vocals", "mute": false, "solo": false, "color": "#7c65d9",
      "volume": 1.0, "pan": 0.0, "clips": [ ... ] }
  ]
}
```

- New track fields: `volume` (linear gain, default 1.0), `pan` (−1…1, default 0.0).
- New top-level field: `master_volume` (linear gain, default 1.0).
- **Backward compatibility:** projects saved in Phase 1 lack these fields. Loading code defaults
  `volume`→1.0, `pan`→0.0, `master_volume`→1.0 when absent (in `dawAddTrack` for new tracks and in
  `dawLoadProject`/chain-sync for loaded ones). No DB migration needed.

### Mutations (in `daw-project.js`)
Each updates `dawState`, calls the matching engine setter for the live node, and marks dirty (autosave):
- `dawSetTrackVolume(trackId, gain)` → set `track.volume`, `dawEngineSetTrackVolume`, `dawMarkDirty`,
  refresh both UI views.
- `dawSetTrackPan(trackId, pan)` → set `track.pan`, `dawEngineSetTrackPan`, mark dirty, refresh.
- `dawSetMasterVolume(gain)` → set `dawState.master_volume`, `dawEngineSetMasterVolume`, mark dirty.
- `dawAddTrack` gains `volume: 1.0, pan: 0.0` in the pushed track object.

---

## UI Layout

### Inline (arranger track headers — `daw-timeline.js`)
Within the existing 64px header (must stay ≤ lane height for alignment), below the M/S/✕ row, add a
compact horizontal volume slider bound to `dawSetTrackVolume`. Volume only — pan/meter live in the
panel. The slider reflects the track's current gain and updates live as the panel fader moves.

### Dedicated mixer panel (`daw-mixer.js`)
A `🎚 Mixer` toggle button in the DAW transport bar shows/hides a panel docked below the clip
library. Layout:

```
┌─ 🎚 MIXER ─────────────────────────────────────────────────┐
│  Vocals    Drums     Bass     Synth    ┊   MASTER           │
│  ▕▏meter   ▕▏        ▕▏       ▕▏        ┊   ▕▏ meter         │
│  █ fader   █         █        █         ┊   █  fader         │
│  0.0 dB   -3.0 dB   -2.1 dB  +1.0 dB    ┊  -0.5 dB           │
│  pan ◐     pan ●     pan ●    pan ◑      ┊                    │
│  M  S      M  S      M  S     M  S       ┊   M                │
└────────────────────────────────────────────────────────────┘
```

Each **channel strip** (one per `dawState.tracks` entry): track name (color-accented), vertical peak
meter, vertical fader (range input styled vertical) with a dB readout, pan slider (−1…1), and M/S
buttons (reuse `dawToggleMute`/`dawToggleSolo` + `dawReschedule`→now `_dawApplyMixState`). The
**master strip** (right, separated by a divider): master meter, master fader + dB readout, master
mute.

- **Meters:** vertical bars sized from the analyser peak (0–1 → 0–100% height), colored green up to
  ~70%, yellow to ~90%, red above. A single `requestAnimationFrame` loop (`_dawMeterLoop`) runs while
  the panel is visible, updating all strip meters + master; it stops when the panel is hidden or the
  DAW tab is left.
- **Sync:** moving the inline slider or the panel fader both call `dawSetTrackVolume`, which updates
  state, the live node, and re-renders the other control. The mixer panel re-renders its strips when
  tracks are added/removed (it subscribes by being re-rendered from `renderTimeline`'s mutation path
  or via an explicit `dawRenderMixer()` call after track mutations).

### Toggle + open behavior
`🎚 Mixer` toggles `#daw-mixer-panel` visibility. On show: `dawRenderMixer()` builds strips from
current state and starts `_dawMeterLoop`. On hide: stop the loop.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-engine.js` | modify | persistent track chains, master analyser, real-time setters, peak readers, gain-based mute/solo (`_dawApplyMixState`, `_dawSyncChains`) |
| `static/daw-project.js` | modify | `volume`/`pan`/`master_volume` defaults + `dawSetTrackVolume/Pan/MasterVolume` mutations |
| `static/daw-mixer.js` | **create** | mixer panel: channel strips + master, faders/pan/meters, dB conversions, meter rAF loop, `dawRenderMixer()` |
| `static/daw-timeline.js` | modify | inline volume slider in track headers |
| `static/daw.js` | modify | `🎚 Mixer` toggle wiring; call `dawRenderMixer()` on track add; stop meter loop on tab leave |
| `templates/index.html` | modify | Mixer toggle button, `#daw-mixer-panel` container, `daw-mixer.js` script tag, cache-bust bumps |
| `tests/test_daw.py` | modify | one persistence test: project with volume/pan/master round-trips |

---

## Edge Cases

| Case | Handling |
|---|---|
| Phase 1 project (no volume/pan/master) | Defaults applied on load (1.0 / 0.0 / 1.0); autosave writes them on first change |
| Fader moved while stopped | State + node value updated; takes effect on next play (node persists) |
| Mute/solo toggled mid-playback | `_dawApplyMixState` sets gains instantly — no reschedule, no audio gap |
| Track removed while mixer open | Its chain disposed in `_dawSyncChains`; `dawRenderMixer` drops the strip |
| Meter loop with panel hidden | Loop not running (started on show, stopped on hide / tab leave) |
| Fader at bottom (−60 dB) | Treated as gain 0 (silent) |
| AudioContext not yet created (never played) | Setters update state only; chains built on first play; meters read 0 |
| Master volume 0 | Whole mix silent; meters still read pre-master track levels (track analysers are pre-master) |

---

## Testing

**Backend (`pytest`):**
- One test: create a project, PUT `data` containing `master_volume` and a track with `volume`/`pan`,
  GET it back, assert the values round-trip (proves the existing `data` JSON carries the new fields).

**Frontend (Playwright live on Nyx):**
- Open DAW → open Mixer panel → a channel strip per track + master render.
- Move a track fader → `dawState.tracks[i].volume` changes and the underlying node gain matches;
  the inline header slider for that track reflects the same value (sync).
- Toggle mute in the mixer mid-playback → track drops out instantly; untoggle → returns.
- Move master fader → `dawState.master_volume` changes; node value matches.
- Play with clips → meter bars move (peak > 0) during playback; return to 0 after stop.
- Edit fader → wait autosave → reload → reopen project → volume/pan/master persisted.

---

## Success Criteria

Inside the DAW tab the user can open an FL/Ableton-style mixer, set per-track volume and pan, mute/
solo, and a master level, with live peak meters on every channel and the master — all reflected by a
compact inline volume slider in the arranger and persisted with the project. Fader and mute changes
take effect instantly during playback. The engine's persistent-chain routing leaves room for Phase 6
FX inserts/sends without another rework.
