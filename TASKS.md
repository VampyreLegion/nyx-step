# Nyx-Step Improvement Roadmap

Forked from MusicWeb. All improvements identified in the April 2026 codebase audit.

**Status legend:** 🔲 todo · 🔄 in progress · ✅ done

---

## Phase 1 — Quick Wins

| # | Area | Task | Status |
|---|------|------|--------|
| 1 | Backend | Extract `_SCALE_MAP` and `_FMT_MAP` to module constants in `core/comfyui.py` | ✅ |
| 2 | Backend | Extract `_find_nodes()`, `_apply_*()` helpers — node-finding loops refactored out of all 7 build methods | ✅ |
| 3 | Backend | Cache workflow templates on first load via `_load_template()` | ✅ |
| 4 | Backend | Add retry logic to Ollama calls — `_post_with_retry()` with 3 retries / 1s backoff | ✅ |
| 5 | Frontend | Reorder tabs by workflow priority; tool tabs moved to end with separator | ✅ |
| 6 | Frontend | Cap visible job cards at 5 with "View all in History" link | ✅ |
| 7 | Frontend | Add progress indicators for long operations (Analyze, Ollama artist lookup) | ✅ |
| 8 | Frontend | Add toast system — `showToast()` with info/success/error/warning; wired to presets | ✅ |
| 9 | Frontend | Improve error messages — removed 120-char truncation | ✅ |
| 10 | Backend | Add timeout protection to Whisper transcription — 120s ThreadPoolExecutor timeout | ✅ |

---

## Phase 2 — Medium Effort

| # | Area | Task | Status |
|---|------|------|--------|
| 11 | Backend | History pagination — `GET /api/history?limit=N&offset=M`, tail-read log | ✅ |
| 12 | Backend | Async history file I/O with aiofiles | ✅ |
| 13 | Backend | Centralize ThreadPoolExecutor — 3 separate pools currently | 🔲 |
| 14 | Frontend | Show tag token count on Style/Instruments/Vocals tabs | 🔲 |
| 15 | Frontend | History tab pagination UI — "Load older" button | ✅ |

---

## Phase 3 — Foundational

| # | Area | Task | Status |
|---|------|------|--------|
| 16 | Backend | Streaming file uploads — replace .read() with request.stream() | 🔲 |
| 17 | Backend | Circuit breaker for ComfyUI/Ollama/Brave | 🔲 |
| 18 | Backend | SQLite-backed job state — replace in-memory dict | 🔲 |
| 19 | Backend | SQLite history log — replace append-only .jsonl | 🔲 |

---

## Completed

| # | Task | Commit |
|---|------|--------|
| 1–10 | Phase 1 quick wins — comfyui refactor, ollama retry, analyze timeout, tab reorder, job cap, toasts, error messages, progress indicators | 30370b1, a9122cd |
| 11–12, 15 | History pagination + async I/O + Load Older button | 4d3b117 |
| — | Fork MusicWeb → Nyx-Step; rebrand throughout | ea1ea04 |
