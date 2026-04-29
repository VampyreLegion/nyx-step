# MusicWeb — Nyx-Step

A FastAPI web UI for AI music generation powered by [ACE-Step](https://github.com/ace-step/ACE-Step) via ComfyUI. Runs at `music-ai.nyxstudios.net` (port 8001).

---

## What It Does

MusicWeb is a single-page app that wraps ACE-Step's diffusion model with a full production toolkit:

| Tab | Description |
|-----|-------------|
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

Additional features: LRC synchronized lyrics, per-file quality scores (0–10), LoRA browser, Ollama tag/lyrics assistant, Brave Search artist lookup, prompt linter, presets.

---

## Stack

```
Cloudflare Tunnel → MusicWeb :8001
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

---

## Repo Layout

```
musicweb/
├── musicweb.py          # FastAPI app entry point
├── config.py            # Paths + URLs — edit before first run
├── requirements.txt
├── musicweb.service     # systemd unit template
├── core/                # ComfyUI client, job tracker, audio analysis, Ollama, MIDI, etc.
├── routes/              # One file per feature tab
├── static/              # JS modules + WaveSurfer (no CDN)
├── templates/           # index.html SPA shell
└── presets/             # .nyx preset files (user-created)
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
| `NyxNodes` (this repo) | `NyxAudioOverlay` (multi-repaint), audio codes cache |

**Python**

```bash
pip install -r requirements.txt
```

Key packages: `fastapi`, `uvicorn`, `librosa`, `pyloudnorm`, `faster-whisper`, `demucs`, `pretty-midi`.

---

## Setup

```bash
# 1. Edit config.py — set _ACETALK, _COMFYUI, PRESETS_DIR, HISTORY_LOG
# 2. Optional: create .env with BRAVE_API_KEY=<key>
# 3. Ensure ComfyUI and Ollama are running
# 4. Start MusicWeb
python3 -m uvicorn musicweb:app --host 0.0.0.0 --port 8001
```

Verify nodes are loaded:
```bash
curl http://localhost:8188/object_info/TextEncodeAceStepAudio1.5
curl http://localhost:8188/object_info/NyxAudioOverlay
```

**systemd**
```bash
sudo cp musicweb.service /etc/systemd/system/
# Edit WorkingDirectory and User in the unit file
sudo systemctl enable --now musicweb
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
BRAVE_API_KEY=your_key   # enables artist-grounded tag expansion
```

Rate limiting defaults: 20 requests / 60 s per authenticated user (Cloudflare Access email header).

---

## API

Interactive docs at `/api/docs` (Swagger) and `/api/redoc`.

Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/generate` | Submit a generation job |
| `GET` | `/events` | SSE stream for job progress |
| `GET` | `/queue` | Active job list |
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
