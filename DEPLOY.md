# Nyx-Step — Deployment Reference

## What You Need on the New Server

Three things must be present and running:

| Service | Default Port | Purpose |
|---------|-------------|---------|
| **ComfyUI** | 8188 | Diffusion engine + ACE-Step nodes |
| **Ollama** | 11434 | LLM for tag expansion, lyrics, artist lookup |
| **Nyx-Step** (this repo) | 8001 | Web UI + API |

---

## Directory Layout

### 1 — Nyx-Step (this repo: `github.com/VampyreLegion/nyx-step`)

```
nyx-step/
├── nyx_step.py               # FastAPI app entry point
├── config.py                 # Paths, URLs, limits — edit this first
├── requirements.txt          # Python deps
├── nyx-step.service          # systemd unit template
├── presets_builtin/          # Built-in .nyx presets (auto-synced on startup)
├── presets/                  # .nyx preset files (user-created, runtime)
│
├── core/
│   ├── comfyui.py            # ComfyUI HTTP client + workflow builders
│   ├── job_tracker.py        # In-memory job state + SSE polling
│   ├── analyze.py            # BPM / key / chord / LUFS / whisper analysis
│   ├── demucs.py             # Demucs stem separation wrapper
│   ├── midi.py               # MIDI extraction (pyin + piano-transcription)
│   ├── ollama.py             # Ollama streaming client + model auto-discovery
│   ├── brave_search.py       # Brave Search API (artist lookup grounding)
│   ├── prompt_builder.py     # Tag / caption assembly
│   ├── prompt_linter.py      # Tag validation rules (offline)
│   ├── minimax_music3.py     # MiniMax Music3 engine (local)
│   ├── youtube.py            # YouTube integration
│   └── rate_limit.py         # Per-user sliding window rate limiter
│
├── routes/                   # One file per feature tab
├── static/                   # JS modules + WaveSurfer (no CDN)
├── templates/                # index.html SPA shell (+ guide/)
└── docs/                     # Planning/spec docs
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

> Nyx-Step's `config.py` points `_ACETALK` at this directory.
> The `acetalk/` subtree and `AceTalkBridge/` are AceTalk desktop app code —
> Nyx-Step only uses the `data/` files and the workflow JSON templates.

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

## Python Requirements

> Source of truth: `requirements.txt`. Key packages: `fastapi`, `uvicorn[standard]`, `jinja2`, `python-multipart`, `requests`, `httpx`, `librosa`, `soundfile`, `pyloudnorm`, `mutagen`, `faster-whisper`, `demucs`, `pretty-midi`, `mido`, `pytest`.

> **`piano-transcription-inference`** requires CUDA. Comment it out if no GPU.
> **`faster-whisper`** downloads its own CUDA libraries; works CPU-only but is slow.

---

## Environment / Config

### `.env` (place in repo root, gitignored)

```bash
BRAVE_API_KEY=your_brave_search_api_key   # Optional — artist lookup grounding
RADIO_HOST=127.0.0.1                      # Optional — radio segment host bind
RADIO_PORT=8001                           # Optional — radio segment port
```

### `config.py` — paths to update for new server

```python
COMFYUI_URL  = "http://127.0.0.1:8188"   # ComfyUI API
OLLAMA_URL   = "http://localhost:11434"   # Ollama API

_ACETALK = pathlib.Path("/path/to/ComfyUI/AceUser")   # ← update
_COMFYUI = pathlib.Path("/path/to/ComfyUI")           # ← update

PRESETS_DIR  = pathlib.Path("/path/to/nyx-step/presets")  # ← update (defaults to <repo>/presets)
```

`_ACETALK` and `_COMFYUI` are the only two paths that must be set per-site. `PRESETS_DIR`, `DB_PATH`, and the output/video dirs default to repo-relative locations and are only overridden if you need to relocate them.

---

## systemd Service

```ini
# /etc/systemd/system/nyx-step.service
[Unit]
Description=Nyx-Step Generator
After=network.target

[Service]
User=your_user
WorkingDirectory=/path/to/nyx-step
ExecStart=/usr/bin/python3 -m uvicorn nyx_step:app --host 0.0.0.0 --port 8001
Restart=on-failure
RestartSec=5
# Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable nyx-step
sudo systemctl start nyx-step
```

---

## Ollama Models

Nyx-Step auto-discovers available models (via `/ollama/models`). You need at least one capable of JSON generation:

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
# 1. Clone Nyx-Step
git clone https://github.com/VampyreLegion/nyx-step
cd nyx-step
pip install -r requirements.txt

# 2. Clone / copy AceUser into your ComfyUI tree
#    (or symlink: ln -s /path/to/AceUser /path/to/ComfyUI/AceUser)

# 3. Copy NyxNodes into ComfyUI custom_nodes
cp -r /path/to/NyxNodes /path/to/ComfyUI/custom_nodes/

# 4. Edit config.py — update _ACETALK, _COMFYUI

# 5. Create .env with BRAVE_API_KEY if desired

# 6. Start ComfyUI (must be running before Nyx-Step)
# 7. Start Ollama and pull a model

# 8. Start Nyx-Step
python3 -m uvicorn nyx_step:app --host 0.0.0.0 --port 8001
```
