# MusicWeb Feature Roadmap

**Status legend:** 🔲 todo · 🔄 in progress · ✅ done  
**Last updated:** 2026-04-26 (task #2 done)  
**Repo:** https://github.com/VampyreLegion/musicweb

---

## Quick Wins

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Built-in Audio Player | ✅ done | Inline `<audio controls>` per job card file |
| 2 | Fix Chords + Notes → Prompt | ✅ done | 9892e0f — Chord preset dropdown wasn't calling `buildCaption()`; overview tags stayed stale. Fixed in `static/bindings.js` |
| 3 | Live Token Counter on Tags | ✅ done | `#tag-token-count` span next to Tags label; green→orange at 12→red at 15; updates on every edit and state sync |
| 4 | Audio Format Selection | ✅ done | Format dropdown (MP3/FLAC/Opus) + quality selector in Parameters; swaps ComfyUI save node in `build_workflow()`; quality options change per format |
| 5 | Instrument Auto-Apply from Genre | ✅ done | `_selectGenre()` now sets `mwState.instruments`, updates textarea, and calls `_syncInstrumentChips()` |
| 6 | Vocal Language Explicit Control | ✅ done | `vocal_language` dropdown in Parameters (auto/en/zh/ja/ko/es/fr/de/pt/it/ru/ar/hi); wired through state→request→workflow `language` field |
| 7 | Output Metadata Download | ✅ done | `GET /meta/{filename}` endpoint; `{}` link per file downloads `_meta.json`; full params stored in `JobInfo.params` and `history.jsonl` |
| 8 | Reset Parameters to Defaults | ✅ done | "↺ Reset to Defaults" button at bottom of Parameters tab resets all 11 fields including format/quality/language |

---

## Medium Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 9 | History Browser Tab | ✅ done | New History tab with search, per-record cards, ⬇ download links, 📥 Load button to restore all params into state; `GET /api/history` endpoint |
| 10 | LM Controls (lm_temperature, CoT, use_cot_*) | ✅ done | "LM Stage" section in Parameters exposes `generate_audio_codes` toggle; advanced lm_* params are standalone-API-only and not in ComfyUI node schema |
| 11 | Model Selector (DiT + LM) | ✅ done | DiT Model dropdown (XL Turbo/SFT/Base) in Parameters; swaps UNETLoader `unet_name` in workflow; shows recommended steps per model; LM model selection is ComfyUI-FL only |
| 12 | Batch Size Control | ✅ done | `batch_size` spinner (1–8) in Parameters; wired to `EmptyAceStep1.5LatentAudio` `batch_size` input; each output file gets its own job card |
| 13 | Cover Mode | ✅ done | Dedicated Cover tab; upload reference audio, ACE-Step preserves melody while applying new style tags; `POST /cover` form endpoint; `build_cover_workflow` → `_build_remix_from_input` in ComfyUI client |
| 14 | Audio Codes Cache (Fast Variation) | ⏸ blocked | Requires ComfyUI node-level access to audio_codes tensor — not exposed via workflow JSON; revisit when custom node available |
| 15 | LRC Synchronized Lyrics | ⏸ blocked | `auto_lrc` is standalone-API-only param; not in ComfyUI TextEncodeAceStepAudio1.5 node schema |
| 16 | Generation Quality Score | ⏸ blocked | `auto_score` is standalone-API-only; no ComfyUI node exposes DiT Lyrics Alignment Score |
| 17 | Demucs Fine-Tuned Models | ✅ done | Added `htdemucs_ft` and `mdx_extra` to dropdown; model name passed directly to `-n` flag, no backend changes needed |

---

## Major Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 18 | Lego Mode — Add Instrument Layer | ⏸ blocked | Requires dedicated ComfyUI workflow template; `task_type`/`instruction` not exposed in TextEncodeAceStepAudio1.5 — needs new workflow JSON built in ComfyUI UI |
| 19 | Extract Mode — Single Stem Isolation | ⏸ blocked | Same — needs workflow template with ReferenceTimbreAudio node wired for diffusion-based extraction |
| 20 | Complete Mode — Generate Backing Track | ⏸ blocked | Same — no workflow template exists; needs ComfyUI workflow built and exported |
| 21 | LoRA Browser + Loader | 🔲 todo | Browse community LoRAs (Chinese Rap, RapMachine, Lyric2Vocal, Text2Samples), load one, pass `lora_path` + `lora_scale` |
| 22 | LoRA Training UI | 🔲 todo | Training wizard tab: drop audio files + metadata, configure LoRA rank/alpha/LR/epochs, monitor training via SSE; uses `/v1/training/start` |
| 23 | Audio Understanding / Analyze | ✅ done | POST /analyze; scipy onset detection → BPM, Krumhansl-Schmuckler chromagram → key/scale, faster-whisper → lyrics+language; Apply button populates BPM/key/scale/lyrics/language into state |
| 24 | Repaint Timeline Picker | ✅ done | Canvas timeline in repaint panel: drag two handles to set start/end region; syncs with number inputs both ways; uses WaveSurfer duration if available |
| 25 | Waveform Player | ✅ done | WaveSurfer.js v7 bundled locally; each job card shows waveform + ▶/⏸ button + live timestamp; falls back to `<audio>` if WaveSurfer unavailable |

---

## Moonshots

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 26 | Voice Recorder → Whisper → Lyrics | 🔲 todo | Mic input in BioInfusor/Tagging tab → Whisper transcription → lyrics ready for generation |
| 27 | MIDI Extraction | 🔲 todo | Post-process generated audio through Basic Pitch (Spotify, open-source) → export MIDI for DAW use |
| 28 | Continuous AI Radio | 🔲 todo | Chain generations using audio codes from previous result as seed; continuous coherent stream; persistent mini-player |
| 29 | Sample Query / Simple Mode | ✅ done | Quick Generate box on Overview tab; `POST /ollama/expand` uses Ollama to convert free-text description into tags, BPM, key, scale, instruments; model selector auto-populated |
| 30 | Multi-Mask Repaint | 🔲 todo | Define multiple time-window regions for repaint in one submit; multi-region timeline picker |

---

## Completed

| # | Feature | Completed | Commit |
|---|---------|-----------|--------|
| — | Retake button (same prompt, new seed) | 2026-04-25 | 434eb10 |
| — | Remix Repaint mode (time window) | 2026-04-25 | 434eb10 |
| — | Hover tooltips on all controls | 2026-04-25 | 434eb10 |
| — | About tab v3.0 update | 2026-04-25 | 434eb10 |
| 1 | Built-in Audio Player | 2026-04-26 | 5b920b0 |
