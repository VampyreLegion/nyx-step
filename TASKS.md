# Nyx-Step Improvement Roadmap

Forked from MusicWeb. All improvements identified in the April 2026 codebase audit.

**Status legend:** 🔲 todo · ✅ done

---

## Phase 1 — Quick Wins ✅

| # | Area | Task |
|---|------|------|
| 1 | Backend | Extract `_SCALE_MAP`/`_FMT_MAP`/`_DIT_MODELS` module constants in `core/comfyui.py` |
| 2 | Backend | Extract `_find_nodes()`, `_apply_*()` helpers — all 7 build methods refactored |
| 3 | Backend | Cache workflow templates on first load via `_load_template()` |
| 4 | Backend | `_post_with_retry()` in `core/ollama.py` — 3 retries / 1s backoff |
| 5 | Frontend | Tab reorder: Generate→Style→Instruments→Vocals→Parameters→Lyrics first; tools at end |
| 6 | Frontend | Job card cap at 5 + "View all in History" link |
| 7 | Frontend | Elapsed-time progress on Analyze and Ollama artist lookup |
| 8 | Frontend | `showToast()` system wired to preset save/load/delete and errors |
| 9 | Frontend | Full error messages — removed 120-char truncation |
| 10 | Backend | Whisper transcription wrapped with 120s `ThreadPoolExecutor` timeout |

---

## Phase 2 — Medium Effort ✅

| # | Area | Task |
|---|------|------|
| 11 | Backend | History pagination — `GET /api/history?limit=N&offset=M` |
| 12 | Backend | Async history file I/O via `aiofiles` (superseded by SQLite in Phase 3) |
| 13 | Backend | Centralized `ThreadPoolExecutor` via `core/executor.py` — shared 4-worker pool |
| 14 | Frontend | Tag token count badge on Style/Instruments/Vocals tab buttons |
| 15 | Frontend | "Load older" button in History tab |

---

## Phase 3 — Foundational ✅

| # | Area | Task |
|---|------|------|
| 16 | Backend | Streaming uploads — 64 KB chunked reads via `stream_upload()` in `core/executor.py` |
| 17 | Backend | Circuit breakers for ComfyUI / Ollama / Brave — `core/circuit_breaker.py` |
| 18 | Backend | SQLite-backed job state — `core/db.py` with WAL mode; jobs survive restarts |
| 19 | Backend | SQLite history log — replaces `.jsonl`; indexed, paginated, per-user delete |

---

## All 19 tasks complete — `github.com/VampyreLegion/nyx-step`
## Live at `music-ai.nyxstudios.net` (port 8001, systemd managed)
