# Nyx-Step MusicWeb — Deployment Reference

## What You Need on the New Server

Three things must be present and running:

| Service | Default Port | Purpose |
|---------|-------------|---------|
| **ComfyUI** | 8188 | Diffusion engine + ACE-Step nodes |
| **Ollama** | 11434 | LLM for tag expansion, lyrics, artist lookup |
| **MusicWeb** (this repo) | 8001 | Web UI + API |

---

## Directory Layout

### 1 — MusicWeb (this repo: `github.com/VampyreLegion/musicweb`)

```
musicweb/
├── musicweb.py               # FastAPI app entry point
├── config.py                 # Paths, URLs, limits — edit this first
├── requirements.txt          # Python deps
├── musicweb.service          # systemd unit template
├── history.jsonl             # Auto-created on first run
├── presets/                  # .nyx preset files (user-created)
│
├── core/
│   ├── comfyui.py            # ComfyUI HTTP client + workflow builders
│   ├── job_tracker.py        # In-memory job state + SSE polling
│   ├── analyze.py            # BPM / key / chord / LUFS / whisper analysis
│   ├── demucs.py             # Demucs stem separation wrapper
│   ├── midi.py               # MIDI extraction (pyin + piano-transcription)
│   ├── ollama.py             # Ollama streaming client
│   ├── brave_search.py       # Brave Search API (artist lookup grounding)
│   ├── prompt_builder.py     # Tag / caption assembly
│   ├── prompt_linter.py      # Tag validation rules
│   └── rate_limit.py         # Per-user sliding window rate limiter
│
├── routes/
│   ├── generate.py           # POST /generate  POST /events (SSE)
│   ├── queue.py              # GET /queue
│   ├── download.py           # GET /download/{path}  GET /guide/{id}  POST /download/zip
│   ├── remix.py              # POST /remix  POST /cover
│   ├── stems.py              # POST /stems/*  POST /stems/demucs/*
│   ├── extract.py            # POST /extract  POST /multirepaint
│   ├── lego.py               # POST /lego  POST /complete
│   ├── radio.py              # POST /radio/start|stop  GET /radio/events|status
│   ├── analyze.py            # POST /analyze  POST /transcribe
│   ├── midi.py               # POST /midi/extract
│   ├── lrc.py                # POST /lrc/generate  GET /lrc/download/{file}
│   ├── quality.py            # GET /quality/{path}
│   ├── history.py            # GET/DELETE /api/history
│   ├── presets.py            # GET/POST/DELETE /presets
│   ├── ollama_routes.py      # POST /ollama/*
│   └── train.py              # POST /train/start|stop  GET /train/events
│
├── static/
│   ├── style.css
│   ├── wavesurfer.min.js     # Bundled — no CDN needed
│   ├── state.js utils.js bindings.js tabs.js init.js app.js
│   ├── genres.js chips.js tags.js presets.js jobs.js
│   ├── easy.js quick.js lint.js voice.js
│   ├── analyze.js stems.js cover.js lego.js extract.js
│   ├── radio.js midi.js train.js history.js
│   ├── dropzone.js           # Shared drag-and-drop utility
│   └── images/               # Guide infographic PNGs
│
└── templates/
    └── index.html            # Single-page app shell
```

### 2 — AceUser (lives inside ComfyUI repo at `ComfyUI/AceUser/`)

```
AceUser/
├── workflow_template.json               # Standard generation
├── workflow_remix_template.json         # Variation / Extend
├── workflow_repaint_template.json       # Single-region repaint
├── workflow_multirepaint_template.json  # Multi-mask repaint (3 regions)
├── workflow_lego_template.json          # Lego / Complete mode
├── workflow_extract_template.json       # Stem extraction
├── workflow_radio_continue_template.json # Radio chaining (segments 1+)
├── Aceuser.html                         # Guide source HTML
│
└── acetalk/
    └── data/
        ├── instruments.json  # Instrument browser database
        ├── genres.json       # Genre database (150+ genres)
        ├── templates.json    # Song structure templates
        └── vocals.json       # Vocal tag categories
```

> MusicWeb's `config.py` points `_ACETALK` at this directory.
> The `acetalk/` subtree and `AceTalkBridge/` are AceTalk desktop app code —
> MusicWeb only uses the `data/` files and the workflow JSON templates.

### 3 — NyxNodes (ComfyUI custom node package)

```
ComfyUI/custom_nodes/NyxNodes/
├── __init__.py               # Registers all 5 nodes with ComfyUI
├── audio_nodes.py            # NyxsAudioConditioner, NyxBioInfusor
├── nyx_audio_codes.py        # NyxSaveAudioCodes, NyxLoadAudioCodes
├── nyx_audio_overlay.py      # NyxAudioOverlay (multi-repaint stitch)
├── nyx_bio_infusor.py        # NyxBioInfusor (standalone module)
├── nyx_smart_text_encoder.py # (unused in current workflows)
└── js/
    └── nyx_audio_upload.js   # ComfyUI frontend upload widget
```

Required by: `workflow_multirepaint_template.json` uses `NyxAudioOverlay`.
Optional for: `workflow_lego_template.json`, `workflow_extract_template.json` (use standard nodes).

---

## ACE-Step Models (go in `ComfyUI/models/`)

```
models/
├── unet/
│   ├── acestep_v1.5_xl_turbo_bf16.safetensors   # Fast (8 steps)
│   ├── acestep_v1.5_xl_sft_bf16.safetensors     # Quality (50 steps)
│   └── acestep_v1.5_xl_base_bf16.safetensors    # Base (Lego/Extract)
├── vae/
│   └── ace_1.5_vae.safetensors
├── clip/
│   ├── qwen_0.6b_ace15.safetensors
│   └── qwen_4b_ace15.safetensors
└── loras/                                        # Optional — user LoRA files
```

---

## ComfyUI Custom Nodes Required

Install via ComfyUI Manager or clone into `ComfyUI/custom_nodes/`:

| Node Package | Why Needed |
|-------------|------------|
| `comfyui-ace-nodes` (or built-in `comfy_extras/nodes_ace.py`) | `TextEncodeAceStepAudio1.5`, `EmptyAceStep1.5LatentAudio`, `ReferenceTimbreAudio` |
| `comfyui-audio-nodes` (or equivalent) | `LoadAudio`, `VAEEncodeAudio`, `VAEDecodeAudio`, `SaveAudioMP3`, `TrimAudioDuration` |
| `comfyui-FL-AceStep` | Required for LoRA training only |
| `NyxNodes` (this repo) | `NyxAudioOverlay` for multi-repaint; `NyxSaveAudioCodes`/`NyxLoadAudioCodes` for audio codes cache |

Verify all nodes are live after ComfyUI restart:
```bash
curl http://localhost:8188/object_info/TextEncodeAceStepAudio1.5
curl http://localhost:8188/object_info/NyxAudioOverlay
```

---

## MusicWeb Python Requirements

```
# requirements.txt

# Web framework
fastapi
uvicorn[standard]
jinja2
python-multipart
requests
httpx

# Audio analysis
librosa>=0.11.0
soundfile>=0.13.0
pyloudnorm>=0.2.0
mutagen>=1.47.0

# Speech-to-text (lyrics transcription + analyze)
faster-whisper>=1.0.0

# Stem separation
demucs>=4.0.0

# MIDI extraction
pretty-midi>=0.2.10
mido>=1.3.0
# piano-transcription-inference   # optional — GPU required; polyphonic piano only

# Dev / test
pytest
```

> **`piano-transcription-inference`** requires CUDA. Comment it out if no GPU.
> **`faster-whisper`** downloads its own CUDA libraries; works CPU-only but is slow.

---

## Environment / Config

### `.env` (place in musicweb root, gitignored)

```bash
BRAVE_API_KEY=your_brave_search_api_key   # Optional — artist lookup grounding
```

### `config.py` — paths to update for new server

```python
COMFYUI_URL  = "http://127.0.0.1:8188"   # ComfyUI API
OLLAMA_URL   = "http://localhost:11434"   # Ollama API

_ACETALK = pathlib.Path("/path/to/ComfyUI/AceUser")   # ← update
_COMFYUI = pathlib.Path("/path/to/ComfyUI")           # ← update

PRESETS_DIR  = pathlib.Path("/path/to/musicweb/presets")  # ← update
HISTORY_LOG  = pathlib.Path("/path/to/musicweb/history.jsonl")  # ← update
```

---

## systemd Service

```ini
# /etc/systemd/system/musicweb.service
[Unit]
Description=MusicWeb Nyx-Step Generator
After=network.target

[Service]
User=your_user
WorkingDirectory=/path/to/musicweb
ExecStart=/usr/bin/python3 -m uvicorn musicweb:app --host 0.0.0.0 --port 8001
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable musicweb
sudo systemctl start musicweb
```

---

## Ollama Models

MusicWeb auto-discovers available models. You need at least one capable of JSON generation:

```bash
ollama pull qwen2.5:7b      # Good balance — tag expansion + lyrics
ollama pull llama3.2:3b     # Lighter option
```

---

## What Is NOT Needed on the New Server

- AceTalk desktop app (`acetalk.py`, `acetalk/tabs/`, `acetalk/ui/`) — desktop-only PyQt6 GUI
- `AceTalkBridge/` — ComfyUI web extension for the desktop app
- `docs/` inside AceUser — internal planning docs
- ComfyUI's web UI (port 8188 only needs to be accessible locally; not exposed externally)

---

## Quick Install Checklist

```bash
# 1. Clone MusicWeb
git clone https://github.com/VampyreLegion/musicweb
cd musicweb
pip install -r requirements.txt

# 2. Clone / copy AceUser into your ComfyUI tree
#    (or symlink: ln -s /path/to/AceUser /path/to/ComfyUI/AceUser)

# 3. Copy NyxNodes into ComfyUI custom_nodes
cp -r /path/to/NyxNodes /path/to/ComfyUI/custom_nodes/

# 4. Edit config.py — update _ACETALK, _COMFYUI, PRESETS_DIR, HISTORY_LOG

# 5. Create .env with BRAVE_API_KEY if desired

# 6. Start ComfyUI (must be running before MusicWeb)
# 7. Start Ollama and pull a model

# 8. Start MusicWeb
python3 -m uvicorn musicweb:app --host 0.0.0.0 --port 8001
```
