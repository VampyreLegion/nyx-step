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
| 6 | Vocal Language Explicit Control | 🔲 todo | Add `vocal_language` ISO dropdown (en, zh, ja, ko, es, fr, de…) to Parameters tab |
| 7 | Output Metadata Download | 🔲 todo | Attach `.json` sidecar or ID3 tags to downloaded files with caption, lyrics, seed, parameters |
| 8 | Reset Parameters to Defaults | 🔲 todo | "Reset" button in Parameters tab restores all generation params to defaults |

---

## Medium Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 9 | History Browser Tab | 🔲 todo | `history.jsonl` already logs all jobs — new tab with search, date filter, "Re-load into state" |
| 10 | LM Controls (lm_temperature, CoT, use_cot_*) | 🔲 todo | Collapsible "LM / Thinking" section in Parameters: lm_temperature, lm_cfg_scale, lm_top_k, lm_top_p, use_cot_metas, use_cot_caption, thinking mode, lm_negative_prompt |
| 11 | Model Selector (DiT + LM) | 🔲 todo | Dropdown for DiT model (XL Turbo/SFT/Base, 2B Turbo/SFT/Base) + LM model (0.6B, 1.7B, 4B, None) |
| 12 | Batch Size Control | 🔲 todo | Add `batch_size` spinner (1–8) to Parameters; each result gets its own job card |
| 13 | Cover Mode | 🔲 todo | `task_type: cover` — upload reference audio, ACE-Step preserves melody but rewrites style; add to Stems/Remix tab |
| 14 | Audio Codes Cache (Fast Variation) | 🔲 todo | Store `audio_codes` from generation results; pass back as conditioning for instant variations (skips VAE re-encode) |
| 15 | LRC Synchronized Lyrics | 🔲 todo | `auto_lrc: true` in request → timestamp-aligned lyrics displayed in job card synced to audio player |
| 16 | Generation Quality Score | 🔲 todo | `auto_score: true` returns DiT Lyrics Alignment Score — show as badge on job card |
| 17 | Demucs Fine-Tuned Models | 🔲 todo | Add `htdemucs_ft` and `mdx_extra` to Demucs model dropdown; no backend changes needed |

---

## Major Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 18 | Lego Mode — Add Instrument Layer | 🔲 todo | `task_type: lego` + `instruction: "guitar"` — add new complementary instrument track to existing audio; needs XL Base/SFT model |
| 19 | Extract Mode — Single Stem Isolation | 🔲 todo | `task_type: extract` + `instruction: "vocals"` — neural stem isolation via diffusion model; add to Stems tab |
| 20 | Complete Mode — Generate Backing Track | 🔲 todo | `task_type: complete` — upload a stem, get full accompaniment; songwriter's core workflow |
| 21 | LoRA Browser + Loader | 🔲 todo | Browse community LoRAs (Chinese Rap, RapMachine, Lyric2Vocal, Text2Samples), load one, pass `lora_path` + `lora_scale` |
| 22 | LoRA Training UI | 🔲 todo | Training wizard tab: drop audio files + metadata, configure LoRA rank/alpha/LR/epochs, monitor training via SSE; uses `/v1/training/start` |
| 23 | Audio Understanding / Analyze | 🔲 todo | Feed audio → get back caption, BPM, key, time sig, lyrics with timestamps, vocal language; "Analyze Audio" button populates full state |
| 24 | Repaint Timeline Picker | 🔲 todo | Visual timeline bar with draggable region selector replacing free-form seconds inputs; waveform from Web Audio API |
| 25 | Waveform Player | 🔲 todo | Upgrade inline player with waveform visualization (Web Audio API or Wavesurfer.js); click-to-seek, playhead |

---

## Moonshots

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 26 | Voice Recorder → Whisper → Lyrics | 🔲 todo | Mic input in BioInfusor/Tagging tab → Whisper transcription → lyrics ready for generation |
| 27 | MIDI Extraction | 🔲 todo | Post-process generated audio through Basic Pitch (Spotify, open-source) → export MIDI for DAW use |
| 28 | Continuous AI Radio | 🔲 todo | Chain generations using audio codes from previous result as seed; continuous coherent stream; persistent mini-player |
| 29 | Sample Query / Simple Mode | 🔲 todo | `sample_query` parameter — single natural language description bypasses structured UI; "Simple Mode" toggle |
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
