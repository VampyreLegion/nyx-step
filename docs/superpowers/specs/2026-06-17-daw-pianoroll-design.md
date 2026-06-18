# Nyx-Step DAW — Piano-Roll Editor (Stage 2B) — Design

**Date:** 2026-06-17
**Status:** Approved (design)
**Component:** A note editor for MIDI tracks in the 🎚 DAW tab
**Builds on:** MIDI core (Stage 2A) — `track.kind==="midi"`, `track.notes:[{start,dur,pitch,vel}]`,
`track.synth`, internal synth, timeline note rendering, `dawState.snap/snap_res`, `_dawPxPerSec`.

---

## Goal

A scrollable pitch×time grid editor (bottom panel) to draw, move, resize, delete, select, and set
velocity on a MIDI track's notes, with audible preview. Edits update the timeline lane live and persist.

### Out of scope
Multi-note marquee selection, copy/paste of notes, quantize-existing, per-note CC/automation, a separate
velocity lane (toolbar slider only), MIDI recording.

### Locked decisions
- Bottom panel (`#daw-pianoroll-panel`), opened by double-clicking a MIDI lane or a header **🎹 Edit**.
- Velocity via a toolbar slider on the selected note + note brightness ∝ velocity.
- Preview blip through the track's synth on add / key-click / move-drop.
- Horizontal snap reuses `dawState.snap/snap_res` (Ctrl bypass); vertical snap = semitone.

---

## Data + mutations (`daw-project.js`)

Notes stay `{start, dur, pitch, vel}` (no ids); the panel holds **object references** into
`track.notes` and mutates fields in place. Mutations:
- `dawAddNote(trackId, note)` — push `note` onto the track's `notes`, `_dawAfterMutate()`, return it.
- `dawRemoveNote(trackId, note)` — splice that note object out, `_dawAfterMutate()`.
- `dawNoteEdited(trackId)` — called after in-place field edits (move/resize/velocity) →
  `_dawAfterMutate()` (re-render timeline + piano-roll + autosave). (`trackId` arg kept for symmetry/
  future use.)

`_dawAfterMutate` gains a `dawRenderPianoRollIfOpen()` call (defensive `typeof`), alongside the existing
timeline/mixer/session re-renders.

---

## Engine — preview (`daw-engine.js`)

`dawPreviewNote(trackId, pitch, vel)`:
- `_dawEnsureCtx()`; `_dawSyncChains()`; resolve the track's chain (so volume/pan/FX apply).
- Build `osc (synth.wave) → gain (short ADSR via the existing `_dawApplyAdsr`) → chain.gain`.
- `freq = _dawNoteFreq(pitch)`, peak from `vel`, fixed preview length ≈ 0.25 s; `osc.start(now);
  osc.stop(now + 0.3)`.
- If the track has no chain yet, fall back to a transient `osc → _dawMaster`. Never throws.

(Reuses `_dawApplyAdsr`, `_dawNoteFreq`, `_dawEnsureCtx`, `_dawSyncChains`, `_dawTrackChains`,
`_dawMaster` from Stage 2A.)

---

## Editor (`static/daw-pianoroll.js`, new)

### State
- `_dawPRTrackId` — track being edited (or null), `_dawPROpen` (bool), `_dawPRSelected` — selected note
  object (or null), `_dawPRLastDur` — last-used note length (default = one snap step).
- Constants: `_DAW_PR_ROW_H = 12` (px per semitone), pitch range `_DAW_PR_LO = 24` (C1) …
  `_DAW_PR_HI = 96` (C7) → 73 rows.

### Open/close
- `openPianoRoll(trackId)` — set track, `_dawPROpen = true`, show `#daw-pianoroll-panel`, render, scroll
  so existing notes (or middle C) are visible.
- `dawClosePianoRoll()` — hide panel, `_dawPROpen = false`.
- `dawRenderPianoRollIfOpen()` — re-render if open and the track still exists.

### Render (`dawRenderPianoRoll`)
- **Toolbar:** track name; **Vel** `<input range 0..127>` (disabled until a note is selected; reflects
  `_dawPRSelected.vel`, sets it on input → `dawNoteEdited`); note count; **Close** button.
- **Body:** a horizontally+vertically scrollable container.
  - **Keyboard gutter** (left, sticky): one cell per pitch row (`_DAW_PR_ROW_H` tall), label every C,
    black/white key tint; `mousedown` → `dawPreviewNote(trackId, pitch, 100)`.
  - **Grid**: width = `Math.max(panelW, (arrangementLen or 16s) * _dawPxPerSec)`, height = rows ×
    `_DAW_PR_ROW_H`. Light row lines + vertical grid lines at the snap interval (reuse `_dawSnapDiv`).
  - **Notes**: a block per note — `left = start*_dawPxPerSec`, `top = (_DAW_PR_HI - pitch)*_DAW_PR_ROW_H`,
    `width = max(4, dur*_dawPxPerSec)`, `height = _DAW_PR_ROW_H - 2`, background = track color with
    `opacity = 0.35 + 0.5*(vel/127)`; selected → accent outline. A right-edge resize handle.

### Interactions
- **Add note:** `mousedown` on empty grid → `pitch = _DAW_PR_HI - floor(offsetY/_DAW_PR_ROW_H)`,
  `start = _dawSnapSec(offsetX/_dawPxPerSec, e.ctrlKey)`, `dur = _dawPRLastDur`,
  `vel = velSlider value or 100`; `dawAddNote`, select it, `dawPreviewNote`. (If the mousedown is on an
  existing note, that note's handlers take over instead.)
- **Select:** `mousedown` on a note → `_dawPRSelected = note`, refresh toolbar/outline.
- **Move:** drag note body → `start = _dawSnapSec(orig + dx, ctrl)` (≥0), `pitch` from row under cursor
  (clamped to range); on drop → `dawPreviewNote` + `dawNoteEdited`. During drag, update live + `dawNoteEdited`
  throttled (call on each move; autosave debounce already coalesces).
- **Resize:** drag right handle → `dur = max(snapStep, _dawSnapSec(start+rawDur, ctrl) - start)`;
  set `_dawPRLastDur = dur`; `dawNoteEdited`.
- **Delete:** Delete/Backspace with a selection, or double-click a note → `dawRemoveNote`, clear selection.
- **Velocity:** toolbar slider → `_dawPRSelected.vel = value; dawNoteEdited()`.
- Document-level `keydown` for Delete/Backspace only fires when the panel is open and focus isn't in an
  input.

### Timeline hooks (`daw-timeline.js`)
- A MIDI lane gets a `dblclick` listener → `openPianoRoll(track.id)`.
- A **🎹 Edit** button in MIDI track headers → `openPianoRoll(t.id)`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-pianoroll.js` | **create** | panel render, grid, all note interactions, open/close, preview wiring |
| `static/daw-project.js` | modify | `dawAddNote`/`dawRemoveNote`/`dawNoteEdited`; `dawRenderPianoRollIfOpen` in `_dawAfterMutate` |
| `static/daw-engine.js` | modify | `dawPreviewNote(trackId, pitch, vel)` |
| `static/daw-timeline.js` | modify | MIDI lane `dblclick` + header **🎹 Edit** button |
| `templates/index.html` | modify | `#daw-pianoroll-panel` container + `daw-pianoroll.js` script + cache-busts |

Script order: `daw-pianoroll.js` after `daw-midi.js`, before `daw.js`. No backend change.

---

## Edge Cases

| Case | Handling |
|---|---|
| Open on an audio track | guarded — only MIDI lanes wire dblclick / show Edit |
| Track deleted while open | `dawRenderPianoRollIfOpen` closes the panel if the track is gone |
| Add note past visible pitch range | pitch clamped to `[_DAW_PR_LO, _DAW_PR_HI]` |
| Snap off | uses raw times (still semitone-quantized vertically) |
| Ctrl during drag | bypasses horizontal snap |
| Resize below one step | clamped to one snap step (or 0.05 s if snap off) |
| Click empty vs on note | hit-test: note handlers stop propagation so empty-grid add doesn't also fire |
| Delete key while typing in toolbar | ignored (focus check) |
| Preview before any playback | `dawPreviewNote` ensures ctx/chain first; resumes a suspended ctx |
| Velocity changes | note brightness updates immediately |

---

## Testing

**Frontend (Playwright live):**
- Open: create a MIDI track, double-click its lane → `#daw-pianoroll-panel` visible, keyboard + grid present.
- Add: simulate a grid click (or call the add path) → `track.notes.length` increases; the note has the
  snapped start + row pitch; it's selected.
- Velocity: move the toolbar slider → selected note `vel` changes and its element opacity changes.
- Move/resize: drag updates `start`/`pitch`/`dur` (assert via state after a synthetic drag, or by calling
  the same mutations the handlers use); timeline MIDI lane re-renders (note block count matches).
- Delete: select + Delete → `notes.length` decreases.
- Preview: `dawPreviewNote(trackId, 60, 100)` raises the track analyser peak > 0 (audible), no error.
- Persist: reload → edited notes survive. No `pageerror`s; `python3 -m pytest tests/ -q` stays green
  (no backend change → 95).

---

## Success Criteria

Double-clicking a MIDI track opens a piano-roll where you can draw notes, move/resize/delete them, set
velocity (with visible brightness + audible preview), all snapping to the project grid; edits reflect on
the timeline and persist. This completes the MIDI feature (Stages 2A + 2B).
