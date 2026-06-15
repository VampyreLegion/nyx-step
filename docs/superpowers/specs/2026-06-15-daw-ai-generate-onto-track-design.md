# Nyx-Step DAW — Phase 5a: Generate onto Track — Design

**Date:** 2026-06-15
**Status:** Approved (design)
**Component:** AI generate-into-arrangement in the 🎚 DAW tab (music-ai.nyxstudios.net)
**Builds on:** Phases 1–4 (Arranger, Mixer, Wave Editor, Export)

---

## Context

Phase 5 ("AI hooks") is three independent features sharing one foundation — a way for the DAW to
submit an async AI job, wait for it, and resolve the output file. It is decomposed into:

- **5a — Generate onto track** (this spec): builds the shared "DAW job runner" + a single-job status
  endpoint, then the generate flow. Foundational.
- **5b — Repaint/Extend a region** (later): reuses the runner against `/remix`.
- **5c — Demucs → stems-as-tracks** (later): reuses the demucs SSE.

The generate backend already exists: `POST /generate` (in `routes/generate.py`) takes tags, duration,
bpm, etc., submits to ComfyUI, registers the job in the shared `tracker` (a `JobTracker`), and returns
`{prompt_id, queue_position}`. The job completes asynchronously; when done, the tracker records
`status="done"` and `output_files=[...]`. There is `GET /queue` (all jobs) and `DELETE /queue/{id}`,
but **no single-job status endpoint** — 5a adds one.

### Locked decisions (brainstorming)
1. **Params source:** a minimal in-DAW dialog — **Tags** + **Duration** only; everything else uses
   `/generate` server defaults (turbo model, 8 steps, CFG 2.0, mp3), with `bpm = dawState.tempo`.
2. **Trigger + placement:** a per-track **🎵** button in each track header; the finished clip lands on
   *that* track at the current playhead.
3. **Async UX:** non-blocking — submit, poll, drop the clip when ready; the track's button shows ⏳
   meanwhile and the user keeps working.

### Out of scope (5b/5c and beyond)
Repaint/extend, demucs-to-tracks, full param control (lyrics/key/LoRA/etc. — use the main Overview
tab and drag from the library), batch generation, regenerate-in-place.

---

## Architecture

One new backend endpoint, one new frontend module, a button in the track header. All generation reuses
the existing `/generate` pipeline and `tracker`.

```
track 🎵 button (daw-timeline.js)
  → openGenerateDialog(trackId, anchor)        (daw-ai.js)
     → dawGenerateOntoTrack(trackId, tags, dur)
        → POST /generate {tags, duration, bpm, song_name}   → {prompt_id}
        → dawRunJob(prompt_id, onProgress)
             → poll GET /daw/job/{prompt_id} every 2s  (routes/daw.py → tracker)
             → resolves output filename on status "done"
        → dawAddClip(trackId, {file, name, source_duration}, dawGetPlayhead())
        → dawGetBuffer(file) → correct source_duration to real length → renderTimeline
```

### Backend — `GET /daw/job/{prompt_id}` (`routes/daw.py`)
```python
from nyx_step import tracker   # shared JobTracker (already imported pattern in routes/generate.py)

@router.get("/job/{prompt_id}")
async def job_status(prompt_id: str, request: Request):
    user = get_user_email(request)
    if not tracker.user_owns(user, prompt_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    job = tracker.get(prompt_id)
    if not job:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"status": job.status, "files": job.output_files, "error": job.error_msg}
```
`JobInfo` fields used: `.status` (`queued|running|done|error`), `.output_files` (list), `.error_msg`.
`tracker.user_owns(user, prompt_id)` and `tracker.get(prompt_id)` already exist (used by
`routes/queue.py`). User scoping prevents reading other users' jobs.

### Frontend — `daw-ai.js`
- `const _dawGenTracks = new Set();` — track ids with a generation in flight (so the ⏳ button state
  survives re-renders).
- `async function dawRunJob(promptId, onProgress)`:
  - Poll `GET /daw/job/${promptId}` every 2000 ms, up to a cap (`MAX_POLLS = 90` ≈ 3 min).
  - On each poll call `onProgress(status)`; on `status === "done"` resolve `job.files[0]`; on
    `status === "error"` reject with `job.error`; on timeout reject "timed out".
- `async function dawGenerateOntoTrack(trackId, tags, duration)`:
  - `const at = dawGetPlayhead();` — **capture the playhead at submit time** so the clip lands where the
    user triggered it, even if they move the playhead during the render.
  - `_dawGenTracks.add(trackId); renderTimeline();` (button → ⏳).
  - `setSaveStatus("Generating… queued")`.
  - `POST /generate` with `{ tags, duration, bpm: dawState.tempo, song_name: "DAW: " + tags.slice(0,40) }`;
    if response has `error` → fail.
  - `const file = await dawRunJob(prompt_id, s => setSaveStatus("Generating… " + s))`.
  - `const clip = dawAddClip(trackId, { file, name: "gen: " + tags.slice(0,24), source_duration: duration }, at);`
  - `const buf = await dawGetBuffer(file); if (buf && clip) { clip.source_duration = clip.duration = buf.duration; dawMarkDirty(); }`
  - `renderTimeline(); setSaveStatus("Generated ✓");`
  - `finally { _dawGenTracks.delete(trackId); renderTimeline(); }` and on any error
    `setSaveStatus("Generation failed: " + msg)`.
- `function openGenerateDialog(trackId, anchor)`: a small popup (same pattern as `openClipMenu`):
  Tags input, Duration number (default 15, min 5, max 300), Generate (disabled while Tags empty) +
  Cancel; closes on Cancel/outside-click/Esc; Generate calls `dawGenerateOntoTrack` then closes.
- `setSaveStatus(text)` helper writes to `#daw-save-status`.

### Frontend — track header button (`daw-timeline.js`)
In `dawRenderTrackHeaders`, add a 4th button to the M/S/✕ row:
- If `typeof _dawGenTracks !== "undefined" && _dawGenTracks.has(t.id)` → render "⏳", disabled.
- Else render "🎵" (title "Generate onto this track") → on click `openGenerateDialog(t.id, button)`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `routes/daw.py` | modify | `GET /daw/job/{prompt_id}` (tracker-backed, user-scoped) |
| `static/daw-ai.js` | **create** | `_dawGenTracks`, `dawRunJob`, `openGenerateDialog`, `dawGenerateOntoTrack`, `setSaveStatus` |
| `static/daw-timeline.js` | modify | per-track 🎵 / ⏳ button |
| `templates/index.html` | modify | `daw-ai.js` script tag (after engine/project, before daw.js) + cache-busts |
| `tests/test_daw.py` | modify | `/daw/job` status endpoint test |

---

## Edge Cases

| Case | Handling |
|---|---|
| Empty tags | Generate button disabled; dialog can't submit |
| `/generate` returns error (e.g. ComfyUI down, 400/429) | Status "Generation failed: <msg>"; track removed from `_dawGenTracks`; button restored |
| Job ends in `error` | `dawRunJob` rejects with `job.error`; same failure handling |
| Poll never completes | `MAX_POLLS` cap (~3 min) → reject "timed out"; button restored |
| Job not owned / unknown id | `/daw/job` returns 404; poller treats as failure |
| Multiple tracks generating | Each has its own prompt_id + poller; `_dawGenTracks` holds all; independent |
| Re-render mid-generation (e.g. clip added elsewhere) | ⏳ state preserved via `_dawGenTracks` Set |
| Track removed while generating | On completion `dawAddClip` no-ops if the track id is gone (`_dawFindClip`/track lookup returns nothing); status still settles |
| Generated file shorter/longer than requested | `source_duration`/`duration` corrected from the decoded buffer after load |
| Playhead position | Captured at submit time (`at`); clip lands there even if the playhead moves during the render |

---

## Testing

**Backend (`pytest`):** register a job through the shared tracker as `dev@local`
(`tracker.register(pid, "dev@local", "x")`, then `tracker.update(pid, status="done", output_files=["g.mp3"])`),
`GET /daw/job/{pid}` → `{status:"done", files:["g.mp3"]}`; an unknown prompt_id → 404; a job owned by
another user → 404. (The test imports `tracker` from `nyx_step`; the conftest temp DB isolates it.)

**Frontend (Playwright live on Nyx; ComfyUI is up):**
- Open DAW (fresh project, one track). Click the track's 🎵 → dialog opens.
- Empty Tags → Generate disabled. Enter tags + duration 12 → Generate.
- Button shows ⏳; poll until the clip appears on that track (allow ~60 s). Assert: the track now has a
  clip, its duration ≈ 12 s (± tolerance, corrected from the decoded buffer), and `#daw-save-status`
  reads "Generated ✓".
- No `pageerror`s. (This exercises the full chain: dialog → /generate → /daw/job polling → clip placed.)

---

## Success Criteria

From the DAW, a user clicks a track's 🎵, types a few tags and a duration, and — without leaving the
arrangement — a freshly generated clip appears on that lane at the playhead when it's done, with live
"Generating…" feedback and no blocking. The shared `dawRunJob` + `/daw/job/{id}` foundation is in place
for 5b (repaint/extend) and 5c (demucs-to-tracks) to reuse.
