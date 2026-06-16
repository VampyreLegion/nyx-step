# Nyx-Step DAW — Phase 6: FX + Session Grid — Design

**Date:** 2026-06-16
**Status:** Approved (design)
**Component:** Per-track FX and a clip-launch session grid in the 🎚 DAW tab (music-ai.nyxstudios.net)
**Builds on:** Phases 1–5 (Arranger, Mixer with persistent track chains, Wave Editor, Export, AI hooks)

---

## Context

Each track already runs through a persistent Web Audio chain built in `_dawSyncChains`:
`gain → pan → analyser → master`, with volume/pan/mute/solo applied via `_dawApplyMixState` and
metering off the analysers. Phase 6 adds two features, both reusing those chains:

- **6a — FX:** per-track insert effects (3-band EQ, Reverb, Delay), spliced into each track chain.
- **6b — Session grid:** a clip-launch grid for live loop layering — columns are the existing tracks,
  cells hold library clips, launching a cell loops it **through that track's chain** (so volume/pan/
  mute/FX all apply). Free-launch (no tempo quantization), independent of the timeline transport.

### Locked decisions (brainstorming)
1. **FX:** fixed EQ + Reverb + Delay per track, toggleable, edited from the mixer strip. Always in the
   chain; "off" = neutral params (no reconnection).
2. **Session launch:** free-launch loopers — a cell loops its clip's full length immediately; one
   active cell per track column; click active to stop; "Stop All". No bar quantization.
3. **Session routing:** columns = existing tracks; cells play through those track chains.

### Out of scope
Effect racks (add/remove/reorder), sidechain, automation, bar-quantized launch, scene-launch
(launching a whole row), recording the grid to the timeline, MIDI.

---

## 6a — FX

### Engine (`daw-engine.js`)
`_dawSyncChains` builds, per track:
```
gain → [EQ: low→mid→high] → [Reverb: dry+wet] → [Delay: dry+wet] → pan → analyser → master
```
All effects always present; disabled = neutral values. Node builders (module-level helpers):
- `_dawMakeEq(ctx)` → `{ input, output, low, mid, high }`: three `BiquadFilterNode`s in series —
  `lowshelf` (320 Hz), `peaking` (1 kHz, Q 1), `highshelf` (3.2 kHz); `input` = low, `output` = high.
  Each `.gain.value` in dB (0 = flat).
- `_dawMakeReverb(ctx)` → `{ input, output, wet, dry, conv }`: `input` fans to `dry` (GainNode) and
  `conv` (ConvolverNode) → `wet` (GainNode); both → `output` (GainNode). `conv.buffer` = a generated
  exponential-decay impulse (~2 s, stereo) from `_dawImpulse(ctx)`. `dry.gain = 1`; `wet.gain` = amount.
- `_dawMakeDelay(ctx)` → `{ input, output, delay, fb, wet, dry }`: `input` → `dry` → `output`; and
  `input` → `delay` (DelayNode, max 2 s) → `wet` → `output`, with `delay → fb (GainNode) → delay`
  feedback loop. `dry.gain = 1`; params: `delay.delayTime`, `fb.gain`, `wet.gain`.
- `_dawImpulse(ctx, seconds=2, decay=2.5)` → AudioBuffer (2-ch noise × `(1 - i/len)^decay`).

The chain object becomes `{ gain, pan, analyser, eq, reverb, delay }` (eq/reverb/delay = the helper
returns). Wiring: `gain.connect(eq.input); eq.output.connect(reverb.input); reverb.output.connect(delay.input);
delay.output.connect(pan); pan.connect(analyser); analyser.connect(_dawMaster)`. After building (and on
demand) apply `track.fx` via `dawEngineSetTrackFx`.

`dawEngineSetTrackFx(trackId, fx)`:
- `chain.eq.low/mid/high.gain.value =` `fx.eq.on ? fx.eq.{low,mid,high} : 0`
- `chain.reverb.wet.gain.value =` `fx.reverb.on ? fx.reverb.wet : 0`
- `chain.delay.delay.delayTime.value = fx.delay.time; chain.delay.fb.gain.value = fx.delay.on ? fx.delay.feedback : 0;
   chain.delay.wet.gain.value = fx.delay.on ? fx.delay.wet : 0`

### Data model (`daw-project.js`)
Track gains:
```json
"fx": { "eq": {"on": false, "low": 0, "mid": 0, "high": 0},
        "reverb": {"on": false, "wet": 0.3},
        "delay": {"on": false, "time": 0.3, "feedback": 0.3, "wet": 0.3} }
```
Defaulted in `dawAddTrack` and merged with `?? ` defaults on load (no migration). `dawSetTrackFx(trackId, fx)`
updates `track.fx`, calls `dawEngineSetTrackFx`, `dawMarkDirty()`. `dawSaveNow` already serializes the
whole track, so `fx` persists.

### UI (`daw-mixer.js`)
Each channel strip gets an **FX** button → `openFxPanel(trackId, anchor)` popup:
- **EQ:** on-toggle + Low/Mid/High sliders (−12…+12 dB)
- **Reverb:** on-toggle + Wet slider (0…1)
- **Delay:** on-toggle + Time (0…1 s) / Feedback (0…0.9) / Wet (0…1) sliders
Each control calls `dawSetTrackFx(trackId, fx)` with the updated object. The FX button shows an active
accent when any section is on.

---

## 6b — Session Grid

### Data model (`daw-project.js`)
- `dawState.scenes` — number of rows (default 4).
- Each track gains `cells: (CellRef|null)[]` of length `scenes`, where `CellRef = { file, name }`
  (a library clip reference). Defaulted to `Array(scenes).fill(null)` for new tracks; on load,
  normalized to length `scenes`. Persisted.
- `dawSetCell(trackId, sceneIdx, ref|null)` — set/clear a cell; `dawMarkDirty()`.
- `dawAddScene()` — `scenes++`; push `null` to every track's `cells`; `dawMarkDirty()`.

### Engine — session looper (`daw-engine.js`)
Independent of the timeline transport; reuses the track chains so loops get volume/pan/mute/FX.
- `_dawGridActive = Map(trackId → { src, sceneIdx })`.
- `async function dawLaunchCell(trackId, sceneIdx)`:
  - Resolve the cell ref from `dawState`; if null → no-op.
  - `_dawEnsureCtx(); _dawSyncChains(); _dawApplyMixState();` (ensure the chain + gains exist).
  - If a cell is active in this column, stop it first (`dawStopCell(trackId)`).
  - `const buf = await dawGetBuffer(ref.file); if (!buf) return;`
  - `const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;` connect to the track
    chain's `gain` (so FX/vol/pan apply); `src.start();` store `{src, sceneIdx}` in `_dawGridActive`.
  - Re-render the grid so the launched cell shows active.
- `dawStopCell(trackId)`: stop+drop the column's active source; re-render.
- `dawStopAllCells()`: stop every active source; clear the map; re-render.
- `dawCellActive(trackId)` → the active `sceneIdx` or `-1` (for highlight).

(Grid loops route to `chain.gain` exactly like timeline clips, so muting/soloing/FX/fader all apply.
Grid playback does not touch the timeline playhead and can run with the timeline stopped.)

### UI (`daw-session.js`, new)
A **🎛 Session** toggle in the DAW transport shows a panel (`#daw-session-panel`, like the mixer panel):
- A grid: one **column per track** (header = track name/color), `scenes` **rows**.
- Each cell: empty (dashed drop target) or filled (clip name). Cells accept the existing library drag
  payload (`application/x-daw-clip`) → `dawSetCell`. Click a filled cell → `dawLaunchCell` (toggles: if
  it's the column's active cell, `dawStopCell`). The active cell is highlighted (accent border + ▶).
- Controls: **⏹ Stop All** → `dawStopAllCells`; **+ Scene** → `dawAddScene`.
- `dawRenderSession()` rebuilds the grid from `dawState`; `dawRenderSessionIfOpen()` re-renders when
  open (called after track/cell mutations); panel toggle starts/stops nothing (no meter loop needed).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-engine.js` | modify | FX node builders + chain splice + `dawEngineSetTrackFx`; session looper (`dawLaunchCell`/`dawStopCell`/`dawStopAllCells`/`dawCellActive`, `_dawGridActive`) |
| `static/daw-project.js` | modify | `fx` track default + `dawSetTrackFx`; `cells`/`scenes` defaults + `dawSetCell`/`dawAddScene` |
| `static/daw-mixer.js` | modify | per-strip **FX** button + `openFxPanel` popup |
| `static/daw-session.js` | **create** | session grid panel: `dawRenderSession`, `dawRenderSessionIfOpen`, drag-to-cell, launch/stop wiring |
| `static/daw.js` | modify | **🎛 Session** transport toggle; render session on track add/remove |
| `templates/index.html` | modify | Session toggle button + `#daw-session-panel` container + `daw-session.js` script tag + cache-busts |
| `tests/test_daw.py` | modify | persistence test: a project with `fx` + `cells` + `scenes` round-trips |

`daw-session.js` loads after `daw-engine.js`/`daw-project.js` and before `daw.js`.

---

## Edge Cases

| Case | Handling |
|---|---|
| Loaded track without `fx`/`cells` | `?? ` defaults (FX neutral/off; cells normalized to `scenes` nulls) — no migration |
| FX toggled off | Neutral values (EQ 0 dB, wet 0, feedback 0) — audible bypass, no reconnection |
| FX changed during playback | Live node values set immediately by `dawEngineSetTrackFx` |
| Launch a cell with a missing/errored clip file | `dawGetBuffer` null → no-op (no crash) |
| Launch second cell in same column | Previous column source stopped first (one active per column) |
| Click the active cell again | `dawStopCell` (toggle off) |
| Grid loop + timeline both playing the track | Both route through the chain and mix — intended (user controls) |
| Track removed while its cell loops | Source kept in `_dawGridActive`; `dawStopAllCells`/leaving handles cleanup; engine guards null chain |
| Mute/solo applies to grid loops | Yes — they route through `chain.gain` governed by `_dawApplyMixState` |
| Drag non-clip payload onto a cell | Ignored (only `application/x-daw-clip` parsed) |
| Stem clip in a cell | Allowed (it's a valid file via `/daw/audio`) |

---

## Testing

**Backend (`pytest`):** one test — a project whose track carries an `fx` object and `cells`, plus
top-level `scenes`, round-trips through PUT→GET (confirms they persist in `data`).

**Frontend (Playwright live on Nyx):**
- **FX:** open Mixer → a strip's FX button → enable Reverb (wet 0.8) and EQ (+6 high); play a clip on
  that track and confirm the track analyser peak/region differs from FX-off (or at minimum: `track.fx`
  state updates, the engine chain has the FX nodes, audio still renders, no errors); toggle off →
  neutral. Reload → `fx` persists.
- **Session grid:** open 🎛 Session → drag a library clip into a cell → `dawSetCell` recorded; click the
  cell → `dawCellActive(track) === sceneIdx` and audio is producing (analyser peak > 0 after a moment);
  launch a second cell in the same column → first stops, second active; **Stop All** → no active cells;
  reload → cells/scenes persist.
- No `pageerror`s; `python3 -m pytest tests/ -q` stays green.

---

## Success Criteria

Each track has working insert FX (EQ/Reverb/Delay) edited from the mixer and persisted; and a session
grid lets the user drag library clips into per-track cells and launch them as live loops through the
same track chains (with volume/pan/mute/FX applied), free-launched and independent of the timeline,
with one active cell per column and a Stop All. This completes the DAW roadmap (Phases 1–6).
