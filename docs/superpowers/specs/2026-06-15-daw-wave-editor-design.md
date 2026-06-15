# Nyx-Step DAW — Phase 3: Wave Editor — Design

**Date:** 2026-06-15
**Status:** Approved (design)
**Component:** Per-clip wave editing in the 🎚 DAW tab (music-ai.nyxstudios.net)
**Builds on:** Phase 1 Timeline Arranger + Phase 2 Mixer
(`docs/superpowers/specs/2026-06-14-daw-timeline-arranger-design.md`, `…-daw-mixer-design.md`)

---

## Context

The DAW has a working timeline arranger (clips on tracks, drag/move/trim, transport, Web Audio
scheduling) and a mixer (per-track gain/pan/meters via persistent node chains). Clips are
non-destructive: `{ id, file, name, start, offset, duration, source_duration }`. Each clip is
scheduled as `BufferSource → trackChain.gain → pan → analyser → master`.

Phase 3 adds **per-clip wave editing on the timeline** (FL/Ableton-style, edit clips in place — not
a separate Audacity zoom view): **fade-in/fade-out**, **per-clip gain**, **split at the playhead**,
and **normalize**. All non-destructive (clip metadata + split = two clips referencing the same file).

### Locked decisions (brainstorming)
1. **Editing surface:** on-clip corner fade handles (drag) with a drawn fade curve, plus a small ⋯
   action menu (and right-click) for Split / Normalize / Gain / Reset fades.
2. **Split point:** at the playhead.
3. **Fades:** linear only.
4. **Non-destructive:** edits are clip fields; split creates two clips from one; source files untouched.

### Out of scope (later phases)
Export/bounce (P4), AI hooks (P5), FX inserts/sends + session grid (P6), grid snapping (P1.5).
No fade curve shapes beyond linear, no crossfades between adjacent clips, no destructive render.

---

## Data Model

Three new clip fields, all defaulting to no-ops so existing/loaded clips are unaffected (read with
`?? ` defaults in engine and UI — no migration):

```json
{ "id": "c1", "file": "Nyx_music_00074_.mp3", "name": "E2E-Confirm",
  "start": 0.0, "offset": 0.0, "duration": 12.5, "source_duration": 25.0,
  "gain": 1.0, "fade_in": 0.0, "fade_out": 0.0 }
```

- `gain` — per-clip linear gain (default 1.0), independent of the track fader.
- `fade_in` — seconds; linear ramp 0 → `gain` over the first `fade_in` s.
- `fade_out` — seconds; linear ramp `gain` → 0 over the last `fade_out` s.
- Invariant enforced on edit: `fade_in + fade_out ≤ duration` (each clamped).

`dawAddClip` sets `gain: 1.0, fade_in: 0.0, fade_out: 0.0` on new clips. Persistence rides in the
existing project `data` JSON (no API change). Split copies `gain` to both halves and partitions the
fades (left keeps `fade_in`, right keeps `fade_out`).

---

## Audio Engine

### Per-clip gain + fade envelope
Today scheduling is `src.connect(chain.gain); src.start(when, bufOffset, playDur)`. Insert a per-clip
GainNode so each clip carries its own gain/fades independently of the track chain:

```
BufferSource → clipGain → trackChain.gain → pan → analyser → master
```

In `_dawScheduleAll`, per clip:
```js
const cg = ctx.createGain();
src.connect(cg); cg.connect(chain.gain);
const clipLocalStart = (clip.start >= _dawPlayhead) ? 0 : (_dawPlayhead - clip.start);
_dawScheduleClipEnvelope(cg, when, clipLocalStart, playDur, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
src.start(when, bufOffset, playDur);
_dawActiveSources.push(src);
```

`_dawScheduleClipEnvelope(cg, when, localStart, playDur, gain, fadeIn, fadeOut)` schedules a linear
envelope in **clip-local time** (so it's correct even when playback begins mid-clip). Let
`dur = localStart + playDur` (the clip's full logical duration; equals `clip.duration` in both the
from-start and straddle cases):
- Clamp: if `fadeIn + fadeOut > dur`, scale both down proportionally.
- Envelope value at any clip-local time `u`:
  `env(u) = gain * (fadeIn > 0 && u < fadeIn ? u/fadeIn : (fadeOut > 0 && u > dur - fadeOut ? (dur - u)/fadeOut : 1))`
  (so `env = gain` when both fades are 0).
- Schedule: `cg.gain.setValueAtTime(env(localStart), when)`; then for each breakpoint time
  `bp ∈ {fadeIn, dur - fadeOut, dur}` with `bp > localStart`,
  `cg.gain.linearRampToValueAtTime(env(bp), when + (bp - localStart))`.
- This yields: ramp up to `gain` by `fadeIn`, hold, ramp down to 0 by `dur`; partial when starting
  mid-fade.

### Split at playhead
`dawSplitClipAtPlayhead(clipId)` (in `daw-project.js`):
- `p = _dawPlayhead` (read via `dawGetPlayhead()`). If `p <= clip.start || p >= clip.start + clip.duration` → no-op.
- `leftDur = p - clip.start`, `rightDur = clip.duration - leftDur`.
- Left clip: `{...clip, id: new, duration: leftDur, fade_out: 0}` (keeps `fade_in`, clamps fade_in ≤ leftDur).
- Right clip: `{...clip, id: new, start: p, offset: clip.offset + leftDur, duration: rightDur, fade_in: 0}` (keeps `fade_out`, clamps fade_out ≤ rightDur).
- Replace the original clip in its track with `[left, right]`; both keep `gain`. Mutate → re-render → reschedule → autosave.

### Normalize
`dawNormalizeClip(clipId)` (async, in `daw-project.js`):
- Ensure buffer: `await dawGetBuffer(clip.file)`; if null (missing/errored) → no-op.
- `peak = dawEngineClipPeak(clip.file, clip.offset, clip.duration)` (new engine fn: max abs sample
  across channels over the `[offset, offset+duration]` window).
- If `peak > 0`: `clip.gain = Math.min(NORM_CAP, 1 / peak)` where `NORM_CAP = 8` (≈ +18 dB cap, so a
  near-silent clip doesn't explode). Mutate → reschedule → autosave.

### Reschedule on edit
New engine fn `dawRescheduleClips()`: if playing, recompute the playhead, stop active sources, and
re-run `_dawScheduleAll()` from the current playhead — so gain/fade/split/normalize edits are heard
immediately. (This is the true reschedule; Phase 2's `dawReschedule` is gain-only via
`_dawApplyMixState` and stays as-is for mute/solo.) Clip-edit mutations call `dawRescheduleClips()`
(guarded) in addition to the normal render+autosave.

---

## UI

### Clip element (extends `_dawBuildClipEl` in `daw-timeline.js`)
- **Fade handles:** small grips (~9×9px) at the top-left and top-right corners.
  - Top-left drag right → `dawSetClipFadeIn(clip.id, dx / pxPerSec)`.
  - Top-right drag left → `dawSetClipFadeOut(clip.id, (rightEdge - x) / pxPerSec)`.
  - Both clamp to `[0, duration − otherFade]`. `e.stopPropagation()` so the clip doesn't move.
- **Trim handle:** the existing right-edge handle stays but starts ~10px below the top so it doesn't
  overlap the top-right fade grip.
- **Fade curve:** after drawing the waveform on the clip canvas, draw two lines — `(0,h)→(fadeIn·px,0)`
  and `(w−fadeOut·px,0)→(w,h)` — in a light stroke with faint shading, the classic fade ramp.
- **⋯ button:** a small button inset at the clip top (clear of the corner grips), and `contextmenu`
  (right-click) on the clip body — both call `openClipMenu(clip, anchorEl)`.

### Clip menu (`daw-waveedit.js`)
`openClipMenu(clip, anchor)` renders a small popup positioned near the anchor:
- **✂ Split at playhead** → `dawSplitClipAtPlayhead(clip.id)`; closes menu. (Disabled/greyed hint if
  the playhead isn't over the clip — still callable, just no-ops.)
- **📊 Normalize** → `dawNormalizeClip(clip.id)`; closes.
- **Gain (dB):** number input, range −24…+12, value `gainToDb(clip.gain ?? 1)`; on change
  `dawSetClipGain(clip.id, dbToGain(value))`. (`gainToDb`/`dbToGain` already exist in `daw-mixer.js`.)
- **Reset fades** → set `fade_in = fade_out = 0` via the setters; closes.
- Closes on outside-click or Esc; only one menu open at a time.

### Mutations (`daw-project.js`)
`dawSetClipGain(id, gain)`, `dawSetClipFadeIn(id, sec)`, `dawSetClipFadeOut(id, sec)` — each updates
the clip field (with clamping), calls `dawRescheduleClips()` (guarded), and `_dawAfterMutate()`
(render + mixer-refresh + autosave). `dawSplitClipAtPlayhead` and `dawNormalizeClip` as above.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-engine.js` | modify | per-clip `clipGain` + `_dawScheduleClipEnvelope`; `dawEngineClipPeak`; `dawRescheduleClips` |
| `static/daw-project.js` | modify | clip defaults in `dawAddClip`; `dawSetClipGain/FadeIn/FadeOut`, `dawSplitClipAtPlayhead`, `dawNormalizeClip` |
| `static/daw-timeline.js` | modify | fade corner handles, fade-curve drawing, ⋯ button + contextmenu |
| `static/daw-waveedit.js` | **create** | `openClipMenu` popup + Split/Normalize/Gain/Reset wiring |
| `templates/index.html` | modify | `daw-waveedit.js` script tag + cache-busts |
| `tests/test_daw.py` | modify | clip gain/fade fields persistence test |

`daw-waveedit.js` loads after `daw-mixer.js` (uses `gainToDb`/`dbToGain`) and before `daw.js`.

---

## Edge Cases

| Case | Handling |
|---|---|
| Loaded clip without new fields | Engine/UI read `clip.gain ?? 1`, `fade_in ?? 0`, `fade_out ?? 0`; no migration |
| `fade_in + fade_out > duration` | Setters clamp each to `duration − other`; envelope scales proportionally as a safety net |
| Split with playhead not over clip | No-op |
| Split at exact clip edge | No-op (`p <= start` or `p >= end`) — avoids zero-length clips |
| Normalize a near-silent/loaded-as-error clip | `peak` 0 or buffer null → no-op (no divide-by-zero, no explosion); otherwise capped at `NORM_CAP` |
| Playback starts mid-clip (straddle) | Envelope computed in clip-local time from `clipLocalStart` |
| Edit during playback | `dawRescheduleClips()` re-schedules from current playhead so the change is heard |
| Trim shorter than existing fades | Existing `dawTrimClip` already clamps duration; fades exceeding new duration are clamped by the envelope's proportional scale (and clamp on next fade edit) |
| Fade handle vs clip-move drag | Fade/trim handles `stopPropagation`; clip body drag unaffected |

---

## Testing

**Backend (`pytest`):** one test — a project whose clip carries `gain`/`fade_in`/`fade_out` round-trips
through PUT→GET (confirms the fields persist in `data`).

**Frontend (Playwright live on Nyx):**
- Set `fade_in` (via `dawSetClipFadeIn` or handle drag) → `clip.fade_in` updates; play from clip
  start and sample the track analyser: peak is near-zero at the very start and rises after the fade
  (audible ramp), proving the envelope reaches the graph.
- Position the playhead inside a clip → `dawSplitClipAtPlayhead` → the track now has two clips with
  correct `start`/`offset`/`duration` (left.duration + right.duration = original; right.offset =
  offset + left.duration).
- `dawNormalizeClip` on a clip → `clip.gain` becomes peak-based (≠ 1, ≤ NORM_CAP).
- Set clip gain via the menu field → `clip.gain` matches `dbToGain(value)`.
- Open the ⋯ menu → Split / Normalize / Gain / Reset controls present; closes on outside click.
- Edit → autosave → reload → reopen → `gain`/`fade_in`/`fade_out` and the post-split clip count persist.

---

## Success Criteria

A user can fade clips in/out by dragging their corners (seeing the fade curve), split a clip at the
playhead into two non-destructive halves, set per-clip gain and normalize a clip — all on the
timeline, heard immediately during playback, and persisted with the project. The per-clip GainNode
sits cleanly before the track chain, leaving Phase 6 (FX inserts/sends) unaffected.
