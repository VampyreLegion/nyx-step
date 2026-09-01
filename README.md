# Nyx-Step

A FastAPI web UI for AI music generation powered by [ACE-Step](https://github.com/ace-step/ACE-Step) via ComfyUI. Runs at `music-ai.nyxstudios.net` (port 8001).

---

## What It Does

Nyx-Step is a single-page app that wraps ACE-Step's diffusion model with a full production toolkit:

| Area | Description |
|------|-------------|
| **Generate** | Text-to-music: tags + lyrics → MP3/FLAC/Opus; batch up to 8 |
| **Remix** | Variation, Extend, or Repaint from an existing audio file |
| **Cover** | Preserve melody from uploaded audio, apply new style tags |
| **Lego** | Overdub a new instrument layer onto existing audio |
| **Extract** | Isolate a single stem from a mix |
| **Stems** | Full Demucs stem separation (vocals/drums/bass/other) |
| **Radio** | Continuous AI radio — chained generations via timbre reference |
| **Analyze** | BPM, key, chords, LUFS, Whisper transcription |
| **MIDI** | Extract melody (librosa pyin) or piano roll (piano-transcription) |
| **Train** | LoRA training UI with real-time loss chart |
| **History** | Browse, replay, and restore past generations |
| **DAW** | Multi-track timeline arranger — clip placement, trim, loop, mix; byte-range streaming; waveform editor; MIDI tracks/piano roll; Hum→MIDI; FX session |
| **GrooveLab** | Built-in 16-step TR-808/TR-909 style drum machine (Web Audio synth, Web MIDI pads, BPM/swing) — bounce a pattern straight to a DAW clip; plus upload imported grooves to the DAW clip library |
| **Comfy Status** | Live ComfyUI hardware telemetry — GPU util/temp/power, VRAM, RAM, CPU load, and the ComfyUI queue |
| **MiniMax** | MiniMax Music3 engine selector (local song generation with vocals) |
| **Video** | Text-to-video / image-to-video via ComfyUI (Wan2.1) |
| **Library / Favorites** | Generated-clip library, favorites, collections |
| **Versions** | Save/restore song versions from history |

Additional features: LRC synchronized lyrics, per-file quality scores (0–10), LoRA browser, Ollama tag/lyrics assistant (model auto-discovery, prompt expansion, artist lookup), Brave Search artist lookup, prompt linter, offline genre database, `.nyx` preset manager. All generated audio files carry ID3 tags (BPM, key, genre, title, artist) written at creation time.

> Note: GrooveLab also surfaces an external TB-303 sequencer as an embedded iframe (`templates/tb303.html`) pointing at a separately-hosted app (`acid.<host>` / `localhost:7870`); that app's `/assets/*` bundle is not vendored in this repo. The 16-step drum machine described above is fully in-repo (`static/groovedrum.js`).

---

## Stack

```
Cloudflare Tunnel → Nyx-Step :8001
                          │
                     ComfyUI :8188   (diffusion engine + ACE-Step nodes)
                     Ollama  :11434  (tag expansion, lyrics generation)
```

**Models (in `ComfyUI/models/`)**

| File | Purpose |
|------|---------|
| `acestep_v1.5_xl_turbo_bf16.safetensors` | Fast generation (8 steps, default) |
| `acestep_v1.5_xl_sft_bf16.safetensors` | Quality generation (50 steps) |
| `acestep_v1.5_xl_base_bf16.safetensors` | Base model (Lego / Extract) |
| `ace_1.5_vae.safetensors` | VAE |
| `qwen_0.6b_ace15.safetensors` | Text encoder (CLIP 1) |
| `qwen_4b_ace15.safetensors` | Text encoder (CLIP 2) |

Video: `wan2.1_t2v_1.3B_bf16.safetensors`, `umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `wan_2.1_vae.safetensors`.

---

## Repo Layout

```
nyx-step/
├── nyx_step.py        # FastAPI app entry point (uvicorn nyx_step:app)
├── config.py          # Paths + URLs — edit before first run
├── requirements.txt
├── nyx-step.service   # systemd unit
├── core/              # ComfyUI client, job tracker, audio analysis, Ollama, MIDI, etc.
├── routes/            # One file per feature tab
├── static/            # JS modules + WaveSurfer (no CDN)
├── templates/         # index.html SPA shell (+ guide/)
├── presets_builtin/   # Built-in .nyx presets (auto-synced on startup)
├── presets/           # User-created .nyx presets (runtime)
├── tests/             # pytest suite
└── docs/              # Planning/spec docs
```

Workflow templates and instrument/genre/vocal data live in `ComfyUI/AceUser/` — path configured in `config.py`.

---

## Dependencies

**ComfyUI custom nodes**

| Package | Required for |
|---------|-------------|
| `comfyui-ace-nodes` | Core ACE-Step generation nodes |
| `comfyui-audio-nodes` | LoadAudio, VAEEncodeAudio, SaveAudioMP3, etc. |
| `comfyui-FL-AceStep` | LoRA training only |
| `NyxNodes` | `NyxAudioOverlay` (multi-repaint), audio codes cache |

**Python**

```bash
pip install -r requirements.txt
```

Key packages: `fastapi`, `uvicorn`, `librosa`, `pyloudnorm`, `faster-whisper`, `demucs`, `pretty-midi`, `mido`.

---

## Setup

```bash
# 1. Edit config.py — set _ACETALK, _COMFYUI
# 2. Optional: create .env with BRAVE_API_KEY=<key>
# 3. Ensure ComfyUI and Ollama are running
# 4. Start
python3 -m uvicorn nyx_step:app --host 0.0.0.0 --port 8001
```

Verify nodes are loaded:
```bash
curl http://localhost:8188/object_info/TextEncodeAceStepAudio1.5
curl http://localhost:8188/object_info/NyxAudioOverlay
```

Verify the app, Ollama, and ComfyUI:
```bash
curl http://localhost:8001/health
curl http://localhost:8001/ollama/models
curl http://localhost:8001/queue        # comfyui.running/pending
```

**systemd**
```bash
sudo cp nyx-step.service /etc/systemd/system/
# Edit WorkingDirectory and User in the unit file
sudo systemctl enable --now nyx-step
```

---

## Configuration

`config.py` — the only file that needs site-specific edits:

```python
COMFYUI_URL = "http://127.0.0.1:8188"
OLLAMA_URL  = "http://localhost:11434"

_ACETALK = pathlib.Path("/path/to/ComfyUI/AceUser")   # workflow templates + data
_COMFYUI = pathlib.Path("/path/to/ComfyUI")           # output/input dirs
```

`.env` (optional, gitignored):
```bash
BRAVE_API_KEY=your_key     # enables artist-grounded tag expansion
RADIO_HOST=127.0.0.1       # radio segment host bind
RADIO_PORT=8001            # radio segment port
```

Rate limiting defaults: 20 requests / 60 s per user (Cloudflare Access email header).

---

## API

Interactive docs at `/api/docs` (Swagger) and `/api/redoc`.

Key endpoints (non-exhaustive — see Swagger for the full list):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | App status + version |
| `POST` | `/generate` | Submit a generation job |
| `GET` | `/events` | SSE stream for job progress |
| `GET` | `/queue` | Active job list (+ ComfyUI queue counts) |
| `POST` | `/remix` | Variation / Extend / Repaint |
| `POST` | `/lego` | Add instrument layer |
| `POST` | `/extract` | Isolate a stem |
| `POST` | `/stems/extract` | Demucs separation |
| `POST` | `/radio/start` | Start continuous radio |
| `POST` | `/analyze` | BPM / key / LUFS analysis |
| `POST` | `/midi/extract` | MIDI extraction |
| `POST` | `/lrc/generate` | Synchronized lyrics |
| `GET` | `/quality/{file}` | Quality score |
| `POST` | `/train/start` | Start LoRA training |
| `GET` | `/train/events` | SSE training progress |
| `GET` | `/api/history` | Generation history |
| `POST` | `/lint` | Validate tags + lyrics |
| `GET` | `/ollama/models` | List local Ollama models |
| `POST` | `/ollama/expand` | Expand a short prompt into structured params |
| `POST` | `/ollama/expand-deep` | Full song package + lyrics |
| `GET`/`POST` | `/daw/projects` | DAW project CRUD |
| `GET` | `/daw/library` / `/library/audio/{path}` | Clip library + byte-range streaming |
| `POST` | `/groovelab/upload` | Upload a groove bounce to the library |
| `GET` | `/api/comfy/status` | Live ComfyUI telemetry — GPU util/temp/power, VRAM, RAM, CPU load ✓ |
| `GET` | `/api/comfy/queue` | ComfyUI running/pending prompt queue ✓ |
| GET/POST/DELETE | `/presets` | `.nyx` preset manager |
