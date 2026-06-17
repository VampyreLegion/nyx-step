# Nyx-Step DAW — Snap-to-Grid + Time-Stretch — Design

**Date:** 2026-06-17
**Status:** Approved (design)
**Component:** Timeline snapping and clip time-stretch in the 🎚 DAW tab (music-ai.nyxstudios.net)
**Builds on:** DAW Phases 1–6 (timeline arranger, Web Audio per-clip scheduling, mixer/FX, session grid)

---

## Context

Clip placement flows through three points in `static/daw-timeline.js`: **drop** (`dawAddClip(track,src,start)`),
**move** (`dawMoveClip(clipId,destTrack,newStart)`), and right-edge **resize** (`dawTrimClip(clipId,offset,duration)`).
The engine schedules each clip in `_dawScheduleAll` via `src.start(when, bufOffset, playDur)` where `playDur`/`bufOffset`
are in **source-buffer seconds**. Tempo lives in `dawState.tempo`. Zoom is `_dawPxPerSec`.

This adds two related editing features:
- **Snap-to-grid** — snap clip start/edges to a tempo-derived grid, with a visible grid and resolution choice.
- **Time-stretch** — change a clip's timeline length independent of its source content, via varispeed
  (`playbackRate`, pitch changes) by default, or an optional per-clip pitch-preserving render (SoundTouch).

### Locked decisions (brainstorming)
1. **Snap:** toggle (default on) + resolution select (Bar/½/Beat/¼, default Bar); grid drawn on lanes; snaps
   drop/move/trim/stretch; Ctrl during a drag bypasses snap.
2. **Stretch methods:** both — varispeed (default) and pitch-lock (SoundTouch.js, per-clip toggle).
3. **Stretch gesture:** plain right-edge drag = trim (unchanged); **Alt + drag** = stretch; clip menu carries
   numeric Time-stretch…, Pitch-lock toggle, and Reset-stretch.

### Out of scope
Clip-edge magnetism (snapping to neighbor clips), global tempo-map/warp markers, transient detection,
pitch-shift independent of time, snapping the playhead/loop region (only clips snap).

---

## Data Model

### `dawState`
- `snap: boolean` — default `true`.
- `snap_res: "bar" | "half" | "beat" | "quarter"` — default `"bar"`.

Both serialized in `dawSaveNow`'s `data`; defaulted on load with `?? `.

### Clip (in `dawAddClip` + on load)
- `src_len: number` — seconds of **source** audio the clip uses. New clips: `src_len = duration`. Existing
  clips on load: `src_len = clip.src_len ?? clip.duration`. With `offset`, the clip uses source range
  `[offset, offset + src_len]`.
- `pitch_lock: boolean` — default `false`.

**Stretch ratio** `r = duration / src_len` (timeline ÷ source). `r = 1` → unstretched (byte-for-byte current
behavior). `r > 1` → longer/slower; `r < 1` → shorter/faster. `r` is clamped to `[0.25, 4]` wherever set.

`source_duration`, `offset`, `gain`, `fade_in`, `fade_out` are unchanged.

---

## Snap

### Helper (`daw-project.js`)
```javascript
function _dawSnapSec(sec, bypass) {
  if (bypass || !dawState.snap) return sec;
  const beat = 60 / (dawState.tempo || 120);
  const div = { bar: beat * 4, half: beat * 2, beat: beat, quarter: beat / 4 }[dawState.snap_res] || beat * 4;
  return Math.round(sec / div) * div;
}
function _dawSnapDiv() {
  const beat = 60 / (dawState.tempo || 120);
  return { bar: beat * 4, half: beat * 2, beat: beat, quarter: beat / 4 }[dawState.snap_res] || beat * 4;
}
```

### Applied (`daw-timeline.js`)
- **Drop:** `start = _dawSnapSec(rawStart, e.ctrlKey)` before `dawAddClip`.
- **Move:** `newStart = _dawSnapSec(rawStart, m.ctrlKey)` before `dawMoveClip`.
- **Trim/stretch:** snap the **edge position** (`start + newLen`) then derive the length:
  `newLen = _dawSnapSec(clip.start + rawLen, m.ctrlKey) - clip.start` (Ctrl bypasses).

### Grid lines
`#daw-lanes` background set to a vertical `repeating-linear-gradient` with period `_dawSnapDiv() * _dawPxPerSec`
px (e.g. `repeating-linear-gradient(90deg, #ffffff0d 0 1px, transparent 1px <period>px)`). Recomputed in
`renderTimeline` (so it tracks zoom) and when tempo/snap/res change. When snap is off, no grid (transparent).

### UI (`daw.js` + `index.html`)
Transport adds a **Snap** checkbox (`#daw-snap`) and a resolution `<select>` (`#daw-snap-res`, options
Bar/½/Beat/¼). Changing either updates `dawState.{snap,snap_res}`, calls `dawMarkDirty()`, and
`renderTimeline()` (to redraw the grid).

---

## Time-Stretch

### Gestures (`daw-timeline.js`, right-edge handle)
The handle `mousedown` reads `e.altKey` once at grab to pick the mode for that drag:
- **Trim (plain):** keep `r` constant. `newTimelineLen = snappedEdge - clip.start`; `newSrcLen =
  clamp(newTimelineLen / r, 0.05, source_duration - offset)`; call `dawTrimClip(id, offset, newSrcLen)`.
  (`dawTrimClip` continues to set `src_len`; it then sets `duration = src_len * r`.)
- **Stretch (Alt):** keep `src_len` constant. `newDuration = snappedEdge - clip.start`; call
  `dawStretchClip(id, newDuration)`.

A small visual cue (e.g. handle tint / cursor `ew-resize` vs `col-resize`) while Alt is held is nice-to-have,
not required.

### Clip menu (`daw-waveedit.js`)
- **⇔ Time stretch…** — `prompt` for target percent (default `Math.round(r*100)`); `dawStretchClip(id,
  clip.src_len * pct/100)`.
- **🔒 Pitch lock** — `dawSetClipPitchLock(id, !clip.pitch_lock)`; label reflects state.
- **↺ Reset stretch** — `dawResetStretch(id)` (sets `duration = src_len`, `r = 1`).

### Mutations (`daw-project.js`)
```javascript
function dawStretchClip(clipId, newDuration) {
  const c = _dawFindClip(clipId); if (!c) return;
  const srcLen = c.src_len ?? c.duration;
  const r = Math.min(4, Math.max(0.25, newDuration / srcLen));
  c.src_len = srcLen;
  c.duration = srcLen * r;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
function dawSetClipPitchLock(clipId, on) {
  const c = _dawFindClip(clipId); if (!c) return;
  c.pitch_lock = !!on;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
function dawResetStretch(clipId) {
  const c = _dawFindClip(clipId); if (!c) return;
  c.duration = c.src_len ?? c.duration;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
```
`dawTrimClip` is updated to set `src_len` (clamped to `source_duration - offset`) and `duration = src_len * r`,
where `r` is the clip's ratio before the trim (so trimming preserves the stretch).

---

## Engine Scheduling (`daw-engine.js`)

Per clip in `_dawScheduleAll`, replacing the fixed `bufOffset`/`playDur` block:
```javascript
const srcLen = clip.src_len ?? clip.duration;
const r = (srcLen > 0) ? (clip.duration / srcLen) : 1;   // timeline / source
const rate = 1 / r;
let when, srcStart, srcConsume, timelineDur;
if (clip.start >= _dawPlayhead) {
  when = _dawStartCtxTime + (clip.start - _dawPlayhead);
  srcStart = clip.offset; srcConsume = srcLen; timelineDur = clip.duration;
} else {
  const into = _dawPlayhead - clip.start;             // timeline seconds
  when = _dawStartCtxTime;
  srcStart = clip.offset + into / r; srcConsume = srcLen - into / r; timelineDur = clip.duration - into;
}
```
Then choose the buffer/rate:
- **Pitch-lock** (`clip.pitch_lock && Math.abs(r - 1) > 1e-3`): look up `dawStretchGet(clip)` (a ready cached
  AudioBuffer). If present → `src.buffer = locked; src.playbackRate.value = 1; src.start(when, into_or_0,
  timelineDur)` where `into_or_0 = clip.duration - timelineDur`. If **not** present → fall back to varispeed
  for this pass and call `dawRenderStretch(...)` to populate the cache for next time.
- **Varispeed** (default / `r === 1` / cache miss): `src.buffer = buf; src.playbackRate.value = rate;
  src.start(when, srcStart, srcConsume)`.

The fade envelope keeps using `timelineDur` (timeline seconds), unchanged. When `r === 1`, `rate === 1` and the
math is identical to current behavior.

---

## Pitch-Lock Render (`daw-stretch.js`, new) + vendored SoundTouch

- `static/vendor/soundtouch.js` — pinned UMD build of **soundtouchjs** exposing `SoundTouch`, `SimpleFilter`,
  `WebAudioBufferSource` as globals. Loaded before `daw-stretch.js`. No build step.
- `_dawStretchCache = Map<key, AudioBuffer>` and `_dawStretchPending = Set<key>`; key =
  `${clip.file}|${clip.offset}|${clip.src_len}|${clip.duration}`.
- `dawStretchGet(clip)` → cached AudioBuffer or `null`.
- `dawInvalidateStretch(clip)` → delete cache entries whose key prefix matches `clip.file|clip.offset|` (drops
  stale renders for that clip's source slice).
- `async dawRenderStretch(clip)`: guard via `_dawStretchPending`; get the decoded source via `dawGetBuffer
  (clip.file)`; slice channels `[offset, offset+src_len]` into a sub-AudioBuffer; run SoundTouch with `tempo =
  src_len / duration` (= `1/r`; `<1` lengthens); extract into a new AudioBuffer (~`duration` long at ctx
  sampleRate); store in cache; trigger `dawRescheduleClips()` if currently playing so the lock takes effect.

`r` is already clamped to `[0.25, 4]`, bounding render size.

---

## Export (`daw-export.js`)

The OfflineAudioContext render loop uses the same per-clip logic so exports match playback:
- Varispeed: set `playbackRate` and `start(when, srcStart, srcConsume)`.
- Pitch-lock: `await dawRenderStretch(clip)` (or reuse cache) before scheduling, then play the locked buffer at
  rate 1. Export awaits all pending stretch renders before `startRendering()`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-project.js` | modify | snap state + `_dawSnapSec`/`_dawSnapDiv`; clip `src_len`/`pitch_lock` defaults; `dawStretchClip`/`dawSetClipPitchLock`/`dawResetStretch`; `dawTrimClip` keeps `r` |
| `static/daw-engine.js` | modify | scheduling `r`/`rate`, varispeed + pitch-lock buffer selection |
| `static/daw-stretch.js` | **create** | `dawRenderStretch`/`dawStretchGet`/`dawInvalidateStretch` + cache (SoundTouch) |
| `static/vendor/soundtouch.js` | **create** | pinned soundtouchjs UMD build |
| `static/daw-timeline.js` | modify | grid background; snap in drop/move/trim; Alt-drag stretch; Ctrl bypass |
| `static/daw-waveedit.js` | modify | clip menu: Time stretch… / Pitch lock / Reset stretch |
| `static/daw-export.js` | modify | offline render honors `r` + pitch-lock |
| `static/daw.js` | modify | Snap checkbox + resolution select wiring |
| `templates/index.html` | modify | snap controls + `vendor/soundtouch.js` + `daw-stretch.js` scripts + cache-busts |
| `tests/test_daw.py` | modify | persistence of `snap`/`snap_res`/`src_len`/`pitch_lock` |

Script order: `vendor/soundtouch.js` → `daw-stretch.js` after `daw-engine.js`, before `daw.js`.

---

## Edge Cases

| Case | Handling |
|---|---|
| Snap off | `_dawSnapSec` returns raw value; grid background transparent |
| Ctrl held during drag | `bypass=true` → no snap (fine adjust) |
| Tempo changed | grid + snap re-derive from `dawState.tempo` on next render/drag |
| Loaded clip without `src_len`/`pitch_lock` | `src_len = duration` (`r=1`), `pitch_lock=false` — no migration |
| Trim a stretched clip | keeps `r`; `src_len` clamped to `source_duration - offset` |
| Stretch ratio extremes | `r` clamped `[0.25, 4]` in every mutation |
| Pitch-lock buffer not ready | varispeed this pass; render async; reschedule when ready |
| Pitch-lock + `r≈1` | treated as unstretched (no render) |
| SoundTouch fails / unavailable | catch → fall back to varispeed, clip still plays |
| Export with pending locks | export awaits renders before `startRendering()` |
| Very short clip | handle still grabbable (min width preserved); `src_len` min 0.05 |
| Playhead mid-stretched-clip | `srcStart`/`srcConsume` derived via `into/r`; pitch-lock offsets into locked buffer by `duration - timelineDur` |

---

## Testing

**Backend (`pytest`):** one test — a project whose track clip carries `src_len` + `pitch_lock` and top-level
`snap`/`snap_res` round-trips through PUT→GET.

**Frontend (Playwright live on Nyx):**
- **Snap:** with snap on / Bar, drop a clip at an arbitrary x → `clip.start` is a multiple of bar-seconds
  (`60/tempo*4`); move it → snapped; toggle snap off → raw start; grid background present when on.
- **Stretch (varispeed):** Alt-drag the right edge (or `dawStretchClip`) to ~2× → `clip.duration ≈ 2*src_len`,
  `src_len` unchanged, `r≈2`; play → track peak > 0 and clip occupies the stretched span; **Reset stretch** →
  `duration === src_len`.
- **Pitch-lock:** enable pitch lock on a stretched clip → `dawStretchGet` becomes non-null after a moment;
  play → audio renders (peak > 0) at rate 1; no errors.
- Reload → `snap`, `snap_res`, `src_len`, `pitch_lock` persist. No `pageerror`s; `pytest tests/ -q` green.

---

## Success Criteria

Clips snap to a visible, tempo-derived grid (resolution-selectable, Ctrl to bypass) on drop/move/trim/stretch;
clips can be time-stretched by Alt-dragging the edge or via the clip menu, defaulting to varispeed and
optionally pitch-preserving per clip; playback and WAV export both honor stretch and pitch-lock; all new state
persists. Existing unstretched clips behave exactly as before.
