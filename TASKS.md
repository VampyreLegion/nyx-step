# Nyx-Step Improvement Roadmap

Forked from MusicWeb. All improvements identified in the April 2026 codebase audit.

**Status legend:** 🔲 todo · 🔄 in progress · ✅ done

---

## Phase 1 — Quick Wins

| # | Area | Task | Status |
|---|------|------|--------|
| 1 | Backend | Extract `_SCALE_MAP` and `_FMT_MAP` to module constants in `core/comfyui.py` — currently copy-pasted 7x and 4x respectively | 🔲 |
| 2 | Backend | Extract `_find_node(workflow, class_type)` helper — node-finding loop repeated in every `build_*` method | 🔲 |
| 3 | Backend | Cache workflow templates on first load — currently re-read from disk on every generation | 🔲 |
| 4 | Backend | Add retry logic to Ollama calls (3 retries, 1s backoff) | 🔲 |
| 5 | Frontend | Reorder tabs by workflow priority; collapse rarely-used tabs under Tools | 🔲 |
| 6 | Frontend | Cap visible job cards at 5 with "View all in History" link | 🔲 |
| 7 | Frontend | Add progress indicators for long operations (Whisper, Ollama lookup) | 🔲 |
| 8 | Frontend | Add toast messages for all user actions (preset saved, copied, error) | 🔲 |
| 9 | Frontend | Improve error messages — distinguish error types, remove 120-char truncation | 🔲 |
| 10 | Backend | Add timeout protection to Whisper/LibROSA calls in analyze.py | 🔲 |

---

## Phase 2 — Medium Effort

| # | Area | Task | Status |
|---|------|------|--------|
| 11 | Backend | History pagination — `GET /api/history?limit=N&offset=M`, tail-read log | 🔲 |
| 12 | Backend | Async history file I/O with aiofiles | 🔲 |
| 13 | Backend | Centralize ThreadPoolExecutor — 3 separate pools currently | 🔲 |
| 14 | Frontend | Show tag token count on Style/Instruments/Vocals tabs | 🔲 |
| 15 | Frontend | History tab pagination UI — "Load older" button | 🔲 |

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
| — | Fork MusicWeb to Nyx-Step; rebrand throughout | initial |
