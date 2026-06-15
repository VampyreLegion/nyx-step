# Nyx-Step DAW — Phase 5b+5c: Clip AI Operations — Design

**Date:** 2026-06-15
**Status:** Approved (design)
**Component:** Clip-level AI operations in the 🎚 DAW tab (music-ai.nyxstudios.net)
**Builds on:** Phases 1–4 + 5a (Generate onto Track — `dawRunJob`, `GET /daw/job/{id}`, clip ⋯ menu)

---

## Context

5a established the DAW's async-AI foundation: `dawRunJob(promptId)` polls `GET /daw/job/{prompt_id}`
to completion, and clips already have a ⋯ actions menu (`openClipMenu` in `daw-waveedit.js`). Phase
5b+5c add two clip-level AI operations, both triggered from that menu, both non-destructive:

- **5b — AI Remix:** Variation or Extend of a clip via the existing `POST /remix`; the result is added
  as a new clip on the same track right after the source.
- **5c — Split to Stems:** Demucs the clip's file via the existing `GET /stems/demucs/stream` SSE;
  create four stem tracks (vocals/drums/bass/other) and mute the source track.

Backends confirmed:
- `POST /remix` — `RemixRequest{ source_file, mode (variation|extend|repaint), tags, duration, bpm,
  repaint_start/end, … }` → `{prompt_id}` (async ComfyUI job, tracker-registered; reuse `dawRunJob`).
- `GET /stems/demucs/stream?filename=<f>&model=htdemucs` — resolves `COMFYUI_OUTPUT_DIR/<f>`, runs
  demucs, streams `log` events (lines incl. `[done]`/`[error]`), then a final `done` event. Output:
  `separated/htdemucs/<basename>/{vocals,drums,bass,other}.wav` (basename = `<f>` minus extension).
- `GET /daw/audio/{file:path}` already serves those stems (ownership passes via the parent song).

### Locked decisions (brainstorming)
1. **5b modes:** Variation + Extend only (repaint-region deferred — no in-clip selection yet).
2. **5b result:** added as a **new clip on the same track** at `start = source.start + source.duration`.
   Non-destructive.
3. **5c:** Demucs → four new stem tracks at the source clip's start; **mute the source track**.
   Non-destructive.
4. **Trigger:** the existing clip ⋯ menu — "🤖 AI Remix…" and "🎛 Split to Stems".

### Out of scope
Repaint of a sub-region (needs in-clip selection), cover mode, stem model choice (htdemucs only),
re-stemming a stem, replacing-in-place.

---

## Architecture

All in the frontend (`daw-ai.js` for flows, `daw-waveedit.js` for the menu items). No backend change.

```
clip ⋯ menu (daw-waveedit.js)
  ├─ "🤖 AI Remix…"   → openRemixDialog(clip, anchor)  → dawRemixClip(clip, mode, tags, dur)
  │     → POST /remix {source_file, mode, tags, duration, bpm, song_name}  → {prompt_id}
  │     → dawRunJob(prompt_id)   (5a poller)
  │     → dawAddClip(track, {file…}, source.start + source.duration)  + correct duration
  └─ "🎛 Split to Stems" → dawSplitToStems(clip)
        → EventSource /stems/demucs/stream?filename=clip.file&model=htdemucs
        → on "done": for vocals/drums/bass/other → dawAddTrack + dawAddClip(stemFile, at clip.start)
        → mute the source track
```

### 5b — `dawRemixClip(clip, mode, tags, duration)` (in `daw-ai.js`)
1. Resolve the clip's track via `_dawFindClip(clip.id)`; if gone, abort.
2. `_dawGenTracks.add(track.id); renderTimeline();` (track header → ⏳); `_dawSetSaveStatus("Remixing…")`.
3. `POST /remix` with `{ source_file: clip.file, mode, tags, duration,
   bpm: dawState.tempo ?? 120, song_name: "DAW remix" }`; on `error`/!ok → fail.
   (Variation/Extend don't need `repaint_start/end` — server defaults are fine.)
4. `const file = await dawRunJob(prompt_id, s => _dawSetSaveStatus("Remixing… " + s));`
5. `const at = clip.start + clip.duration;`
   `const nc = dawAddClip(track.id, { file, name: mode + ": " + (tags || clip.name).slice(0,20), source_duration: duration }, at);`
6. `const buf = await dawGetBuffer(file); if (buf && nc) { nc.source_duration = nc.duration = buf.duration; dawMarkDirty(); } renderTimeline();`
7. `_dawSetSaveStatus("Remixed ✓");` `finally { _dawGenTracks.delete(track.id); renderTimeline(); }`;
   on error `_dawSetSaveStatus("Remix failed: " + msg)`.

`openRemixDialog(clip, anchor)`: popup (same pattern as the generate dialog) — **Mode** select
(`variation`/`extend`), **Tags** text (optional), **Duration** number (default `Math.round(clip.duration)`,
min 5, max 300), Generate/Cancel; Generate calls `dawRemixClip` then closes; closes on Cancel/outside/Esc.

### 5c — `dawSplitToStems(clip)` (in `daw-ai.js`)
1. If `clip.file.startsWith("separated/")` → `_dawSetSaveStatus("Already a stem"); return;`.
2. Resolve the track via `_dawFindClip`; `_dawGenTracks.add(track.id); renderTimeline();`
   `_dawSetSaveStatus("Splitting to stems…")`.
3. `const base = clip.file.replace(/\.[^.]+$/, "");` (e.g. `Nyx_music_00075_`).
4. Open `const es = new EventSource("/stems/demucs/stream?filename=" + encodeURIComponent(clip.file) + "&model=htdemucs");`
   - `es.addEventListener("log", e => { const l = JSON.parse(e.data).line; if (l.includes("[error]")) failed = true; _dawSetSaveStatus("Stems: " + l.slice(0,40)); });`
   - `es.addEventListener("done", () => { es.close(); finish(); });`
   - `es.onerror = () => { es.close(); finish(true); };`
5. `finish(errored)`:
   - On error/`failed` → `_dawSetSaveStatus("Stem split failed"); cleanup; return;`.
   - For each `t of ["vocals","drums","bass","other"]`: `const f = "separated/htdemucs/" + base + "/" + t + ".wav";`
     `const buf = await dawGetBuffer(f); if (!buf) continue;` `dawAddTrack(clip.name.slice(0,14) + " — " + t);`
     then add a clip on that new track: `dawAddClip(newTrackId, { file: f, name: t, source_duration: buf.duration }, clip.start);`
     (the new track is the last in `dawState.tracks`; capture its id from `dawState.tracks[dawState.tracks.length-1].id`).
   - Mute the source track: if `!track.mute` then set `track.mute = true` (via `dawToggleMute(track.id)` so it re-renders + reschedules).
   - `_dawSetSaveStatus("Stems ready ✓");`
   - `finally`: `_dawGenTracks.delete(track.id); renderTimeline();` `dawMarkDirty();`

`dawAddTrack`/`dawAddClip`/`dawToggleMute`/`dawGetBuffer`/`_dawFindClip`/`_dawSetSaveStatus`/
`_dawGenTracks`/`renderTimeline`/`dawMarkDirty` are existing globals.

### Menu items (`daw-waveedit.js`, in `openClipMenu` after the wave-edit items)
```javascript
m.appendChild(mkBtn("🤖 AI Remix…", () => { if (typeof openRemixDialog === "function") openRemixDialog(clip, anchor); }));
m.appendChild(mkBtn("🎛 Split to Stems", () => { if (typeof dawSplitToStems === "function") dawSplitToStems(clip); }));
```
`mkBtn` already closes the menu after running its fn; `anchor` (the clip's ⋯ button) is in scope and
stays in the DOM, so the remix dialog can anchor to it.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-ai.js` | modify | `openRemixDialog`, `dawRemixClip`, `dawSplitToStems` |
| `static/daw-waveedit.js` | modify | "🤖 AI Remix…" + "🎛 Split to Stems" menu items |
| `templates/index.html` | modify | cache-busts: `daw-ai.js` v1→v2, `daw-waveedit.js` v1→v2 |

No backend change; no new pytest.

---

## Edge Cases

| Case | Handling |
|---|---|
| `/remix` error / job error / timeout | `dawRunJob` rejects → status "Remix failed: …"; ⏳ cleared; nothing added |
| Demucs `[error]` log or SSE error | `finish(true)` → status "Stem split failed"; ⏳ cleared; no tracks added |
| Split a clip that is already a stem | Skipped with "Already a stem" |
| A stem file 404s after demucs | `dawGetBuffer` returns null → that stem's track skipped; others still added |
| Source clip/track removed mid-op | `_dawFindClip` returns null at place time → op aborts gracefully; status settles |
| Source track already muted (5c) | Left muted (no toggle); stems still added |
| Remix result duration differs from requested | Corrected from the decoded buffer |
| Concurrent ops | Each marks its own track ⏳ via `_dawGenTracks`; independent |
| Remix on a stem clip | Allowed to try; `/remix` may error → handled by the failure path |

---

## Testing

No backend changes → no new pytest (suite stays 88). Frontend verified live with Playwright on Nyx
(real `/remix` + real demucs — both available; allow generous waits ~90 s each):

- **5b — AI Remix:** add a library clip to a track → open ⋯ → AI Remix → Mode Variation + tags →
  Generate → poll until the track has a **second clip** whose `start ≈ source.start + source.duration`
  with a real file; status "Remixed ✓". No `pageerror`s.
- **5c — Split to Stems:** add a generated-file clip → ⋯ → Split to Stems → poll until **4 new tracks**
  exist (names ending vocals/drums/bass/other), each with a clip at the source clip's `start`, and the
  **source track is muted**; status "Stems ready ✓". No `pageerror`s.
- `python3 -m pytest tests/ -q` → 88 passed (unchanged).

---

## Success Criteria

From a clip's ⋯ menu the user can generate a Variation/Extension of that clip (added alongside it,
non-destructively) and split a clip into vocals/drums/bass/other tracks (with the original muted) —
both reusing the existing remix and demucs backends and the 5a job machinery, with live status and no
blocking. Completing 5b+5c finishes the Phase 5 "AI hooks" set: generate, remix/extend, and stem-split
all live inside the DAW.
