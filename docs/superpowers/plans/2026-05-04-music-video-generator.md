# Music Video Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Video tab to the Nyx-Step web app (music-ai.nyxstudios.net) that generates beat-synced music videos using Wan 2.1 T2V/I2V 1.3B running locally in ComfyUI.

**Architecture:** Audio is analysed with librosa to produce a schedule (BPM, beat times, chunk boundaries, per-chunk motion weights). ComfyUI jobs are queued sequentially per chunk — the first chunk uses Wan T2V, subsequent chunks use Wan I2V with the last frame of the previous chunk as the start image. All chunks are stitched with ffmpeg into a final MP4.

**Tech Stack:** FastAPI (nyx-step), librosa, opencv-python, websockets, Wan 2.1 1.3B (ComfyUI local), VHS_VideoCombine (VideoHelperSuite), ffmpeg

---

## Models already downloaded (pre-requisite complete)

- `ComfyUI/models/diffusion_models/wan2.1_t2v_1.3B_bf16.safetensors` (2.7 GB)
- `ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` (6.3 GB)
- `ComfyUI/models/vae/wan_2.1_vae.safetensors` (243 MB)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `nyx-step/config.py` | Modify | Add VIDEO_* and WAN_* path constants |
| `nyx-step/core/beat_analyser.py` | Create | librosa beat analysis → schedule JSON |
| `nyx-step/core/video_orchestrator.py` | Create | Async chunk loop, last-frame extract, ffmpeg stitch |
| `nyx-step/routes/video.py` | Create | FastAPI router for all /api/video/* endpoints |
| `nyx-step/nyx_step.py` | Modify | Register video_router |
| `nyx-step/workflow_video_t2v.json` | Create | Wan T2V ComfyUI workflow template (chunk 0) |
| `nyx-step/workflow_video_i2v.json` | Create | Wan I2V ComfyUI workflow template (chunk N) |
| `nyx-step/static/video.js` | Create | Video tab JavaScript |
| `nyx-step/templates/index.html` | Modify | Add Video tab button + panel |
| `nyx-step/tests/test_video.py` | Create | Unit tests for beat_analyser and orchestrator |
| `ComfyUI/custom_nodes/NyxNodes/nyx_beat_scheduler.py` | Create | ComfyUI node (standalone use) |
| `ComfyUI/custom_nodes/NyxNodes/nyx_section_prompt_router.py` | Create | ComfyUI node (standalone use) |
| `ComfyUI/custom_nodes/NyxNodes/__init__.py` | Modify | Register two new nodes |

---

## Task 1: Config additions

**Files:**
- Modify: `nyx-step/config.py`
- Test: `nyx-step/tests/test_video.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_video.py
import pathlib
import config

def test_video_config_paths():
    assert hasattr(config, "VIDEO_OUTPUT_DIR")
    assert hasattr(config, "VIDEO_CHUNK_DIR")
    assert hasattr(config, "WAN_MODEL")
    assert hasattr(config, "WAN_TEXT_ENCODER")
    assert hasattr(config, "WAN_VAE")
    assert hasattr(config, "WORKFLOW_VIDEO_T2V")
    assert hasattr(config, "WORKFLOW_VIDEO_I2V")
    assert hasattr(config, "COMFYUI_INPUT_DIR")

def test_video_dirs_created():
    config.VIDEO_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.VIDEO_CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    assert config.VIDEO_OUTPUT_DIR.exists()
    assert config.VIDEO_CHUNK_DIR.exists()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_video_config_paths -v
```
Expected: `AttributeError: module 'config' has no attribute 'VIDEO_OUTPUT_DIR'`

- [ ] **Step 3: Add config constants**

Append to `/home/legion/legionprojects/nyx-step/config.py`:

```python
# ── Video generation ──────────────────────────────────────────────────────────
_NYX_STEP = pathlib.Path("/home/legion/legionprojects/nyx-step")

WORKFLOW_VIDEO_T2V = _NYX_STEP / "workflow_video_t2v.json"
WORKFLOW_VIDEO_I2V = _NYX_STEP / "workflow_video_i2v.json"

VIDEO_OUTPUT_DIR = _COMFYUI / "output" / "video"
VIDEO_CHUNK_DIR  = VIDEO_OUTPUT_DIR / "chunks"
VIDEO_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
VIDEO_CHUNK_DIR.mkdir(parents=True, exist_ok=True)

WAN_MODEL        = "wan2.1_t2v_1.3B_bf16.safetensors"
WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN_VAE          = "wan_2.1_vae.safetensors"
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py -v
```
Expected: 2 PASSED

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add config.py tests/test_video.py
git commit -m "feat(video): add video config constants and test"
```

---

## Task 2: Beat analyser

**Files:**
- Create: `nyx-step/core/beat_analyser.py`
- Test: `nyx-step/tests/test_video.py`

The analyser reads an audio file, uses librosa for beat tracking, then divides the song into chunks. It returns a schedule dict with per-chunk metadata.

**Schedule JSON structure:**
```json
{
  "audio_file": "/path/to/song.mp3",
  "bpm": 128.0,
  "duration": 180.0,
  "beat_times": [0.47, 0.94, 1.41, ...],
  "chunks": [
    {
      "index": 0,
      "start": 0.0,
      "end": 6.0,
      "section": "Intro",
      "frame_count": 97,
      "mean_beat_weight": 0.6
    },
    ...
  ]
}
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_video.py`:

```python
import json
import pathlib
import numpy as np
import soundfile as sf
import tempfile

def _make_sine_wav(duration=10.0, sr=22050, freq=440.0) -> pathlib.Path:
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    audio = (np.sin(2 * np.pi * freq * t) * 0.5).astype(np.float32)
    tmp = pathlib.Path(tempfile.mktemp(suffix=".wav"))
    sf.write(str(tmp), audio, sr)
    return tmp

def test_beat_analyser_returns_schedule():
    from core.beat_analyser import analyse
    wav = _make_sine_wav(duration=12.0)
    try:
        schedule = analyse(str(wav), chunk_seconds=4.0, fps=16, sync_mode="both",
                           lyrics="[Verse]\nhello\n[Chorus]\ndrop", bpm_hint=None)
        assert "bpm" in schedule
        assert "chunks" in schedule
        assert len(schedule["chunks"]) >= 2
        chunk = schedule["chunks"][0]
        assert "index" in chunk
        assert "start" in chunk
        assert "end" in chunk
        assert "section" in chunk
        assert "frame_count" in chunk
        assert "mean_beat_weight" in chunk
        assert 0.0 <= chunk["mean_beat_weight"] <= 1.0
    finally:
        wav.unlink(missing_ok=True)

def test_beat_analyser_section_only_weights_uniform():
    from core.beat_analyser import analyse
    wav = _make_sine_wav(duration=8.0)
    try:
        schedule = analyse(str(wav), chunk_seconds=4.0, fps=16,
                           sync_mode="section_only", lyrics="", bpm_hint=120)
        for chunk in schedule["chunks"]:
            assert chunk["mean_beat_weight"] == 0.5
    finally:
        wav.unlink(missing_ok=True)

def test_beat_analyser_frame_count_aligned():
    from core.beat_analyser import analyse
    wav = _make_sine_wav(duration=8.0)
    try:
        schedule = analyse(str(wav), chunk_seconds=4.0, fps=16,
                           sync_mode="both", lyrics="", bpm_hint=120)
        for chunk in schedule["chunks"]:
            n = chunk["frame_count"]
            # must satisfy: (n-1) % 4 == 0 (Wan latent alignment)
            assert (n - 1) % 4 == 0, f"frame_count {n} not Wan-aligned"
    finally:
        wav.unlink(missing_ok=True)

def test_parse_lyrics_sections():
    from core.beat_analyser import parse_sections
    lyrics = "[Intro]\nhello\n[Verse]\nworld\n[Chorus]\ndrop"
    sections = parse_sections(lyrics)
    assert sections == ["Intro", "Verse", "Chorus"]

def test_parse_lyrics_sections_empty():
    from core.beat_analyser import parse_sections
    assert parse_sections("") == ["Main"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_beat_analyser_returns_schedule -v
```
Expected: `ModuleNotFoundError: No module named 'core.beat_analyser'`

- [ ] **Step 3: Write beat_analyser.py**

Create `/home/legion/legionprojects/nyx-step/core/beat_analyser.py`:

```python
from __future__ import annotations
import json
import logging
import re
from pathlib import Path

import librosa
import numpy as np

logger = logging.getLogger(__name__)

_SECTION_RE = re.compile(r"^\[([^\]]+)\]", re.MULTILINE)


def parse_sections(lyrics: str) -> list[str]:
    """Return ordered list of section names from lyrics [Tag] markers."""
    names = [m.group(1).split(":")[0].strip() for m in _SECTION_RE.finditer(lyrics)]
    return names if names else ["Main"]


def _wan_align(frame_count: int) -> int:
    """Round frame_count down to nearest (4k+1) for Wan latent alignment."""
    if frame_count <= 1:
        return 1
    k = (frame_count - 1) // 4
    return max(1, k * 4 + 1)


def _per_frame_weights(beat_times: np.ndarray, total_frames: int, fps: float,
                       sync_mode: str) -> np.ndarray:
    """Return normalised per-frame weight array (0–1). Peaks at beat frames."""
    weights = np.full(total_frames, 0.5)
    if sync_mode == "section_only":
        return weights
    for bt in beat_times:
        frame = int(bt * fps)
        if 0 <= frame < total_frames:
            weights[frame] = 1.0
    # Gaussian spread around each beat (±3 frames)
    from scipy.ndimage import gaussian_filter1d
    weights = gaussian_filter1d(weights, sigma=2.0)
    mn, mx = weights.min(), weights.max()
    if mx > mn:
        weights = (weights - mn) / (mx - mn)
    return weights


def analyse(
    audio_file: str,
    chunk_seconds: float,
    fps: float,
    sync_mode: str,
    lyrics: str,
    bpm_hint: float | None,
) -> dict:
    """
    Analyse audio file and return a schedule dict for the video orchestrator.

    sync_mode: "section_only" | "beat_only" | "both"
    """
    path = Path(audio_file)
    y, sr = librosa.load(str(path), sr=None, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    if bpm_hint and bpm_hint > 0:
        bpm = float(bpm_hint)
        beat_times = np.arange(0, duration, 60.0 / bpm)
    else:
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    total_frames = int(duration * fps)
    weights = _per_frame_weights(beat_times, total_frames, fps, sync_mode)

    sections = parse_sections(lyrics)
    n_chunks = max(1, int(np.ceil(duration / chunk_seconds)))
    section_duration = duration / len(sections) if sections else duration

    chunks = []
    for i in range(n_chunks):
        start = i * chunk_seconds
        end = min(start + chunk_seconds, duration)
        raw_frames = int((end - start) * fps)
        frame_count = _wan_align(raw_frames)

        section_idx = min(int(start / section_duration), len(sections) - 1)
        section = sections[section_idx]

        start_frame = int(start * fps)
        end_frame = min(int(end * fps), total_frames)
        chunk_weights = weights[start_frame:end_frame]
        mean_weight = float(chunk_weights.mean()) if len(chunk_weights) else 0.5

        chunks.append({
            "index": i,
            "start": round(start, 3),
            "end": round(end, 3),
            "section": section,
            "frame_count": frame_count,
            "mean_beat_weight": round(mean_weight, 4),
        })

    return {
        "audio_file": str(path),
        "bpm": round(bpm, 2),
        "duration": round(duration, 3),
        "beat_times": [round(float(t), 4) for t in beat_times.tolist()],
        "chunks": chunks,
    }
```

- [ ] **Step 4: Run all beat_analyser tests**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_beat_analyser_returns_schedule \
  tests/test_video.py::test_beat_analyser_section_only_weights_uniform \
  tests/test_video.py::test_beat_analyser_frame_count_aligned \
  tests/test_video.py::test_parse_lyrics_sections \
  tests/test_video.py::test_parse_lyrics_sections_empty -v
```
Expected: 5 PASSED

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add core/beat_analyser.py tests/test_video.py
git commit -m "feat(video): add beat_analyser with librosa beat tracking"
```

---

## Task 3: ComfyUI workflow templates

**Files:**
- Create: `nyx-step/workflow_video_t2v.json`
- Create: `nyx-step/workflow_video_i2v.json`
- Test: `nyx-step/tests/test_video.py`

Templates are ComfyUI API-format JSON. Placeholder strings (`"{{key}}"`) are replaced by the orchestrator before POST. Node IDs are strings "1"–"9" for T2V, "1"–"10" for I2V (adds `LoadImage` node "10").

**Node wiring:**
```
UNETLoader(1) ──────────────────────────────────────────→ KSamplerAdvanced(7)[model]
CLIPLoader(2) → CLIPTextEncode(4)[pos] ─→ WanImageToVideo(6)[pos] → KSamplerAdvanced(7)[pos]
CLIPLoader(2) → CLIPTextEncode(5)[neg] ─→ WanImageToVideo(6)[neg] → KSamplerAdvanced(7)[neg]
VAELoader(3) ───────────────────────────→ WanImageToVideo(6)[vae]
                                           WanImageToVideo(6)[latent] → KSamplerAdvanced(7)[latent]
VAELoader(3) ───────────────────────────────────────────→ VAEDecode(8)[vae]
KSamplerAdvanced(7)[samples] ───────────────────────────→ VAEDecode(8)[samples]
VAEDecode(8)[images] ───────────────────────────────────→ VHS_VideoCombine(9)[images]
LoadImage(10)[image] ───────────────────────────────────→ WanImageToVideo(6)[start_image]  ← I2V only
```

- [ ] **Step 1: Write the failing test**

Add to `tests/test_video.py`:

```python
def test_workflow_t2v_template_valid():
    import json
    import config
    assert config.WORKFLOW_VIDEO_T2V.exists(), "workflow_video_t2v.json missing"
    wf = json.loads(config.WORKFLOW_VIDEO_T2V.read_text())
    class_types = {v["class_type"] for v in wf.values() if isinstance(v, dict) and "class_type" in v}
    assert "UNETLoader" in class_types
    assert "WanImageToVideo" in class_types
    assert "VHS_VideoCombine" in class_types
    # T2V must NOT have LoadImage
    assert "LoadImage" not in class_types

def test_workflow_i2v_template_valid():
    import json
    import config
    assert config.WORKFLOW_VIDEO_I2V.exists(), "workflow_video_i2v.json missing"
    wf = json.loads(config.WORKFLOW_VIDEO_I2V.read_text())
    class_types = {v["class_type"] for v in wf.values() if isinstance(v, dict) and "class_type" in v}
    assert "LoadImage" in class_types
    assert "WanImageToVideo" in class_types
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_workflow_t2v_template_valid -v
```
Expected: FAIL (file not found)

- [ ] **Step 3: Create workflow_video_t2v.json**

Create `/home/legion/legionprojects/nyx-step/workflow_video_t2v.json`:

```json
{
  "1": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "{{model_name}}",
      "weight_dtype": "bf16"
    }
  },
  "2": {
    "class_type": "CLIPLoader",
    "inputs": {
      "clip_name": "{{text_encoder_name}}",
      "type": "wan"
    }
  },
  "3": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "{{vae_name}}"
    }
  },
  "4": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{positive_prompt}}",
      "clip": ["2", 0]
    }
  },
  "5": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{negative_prompt}}",
      "clip": ["2", 0]
    }
  },
  "6": {
    "class_type": "WanImageToVideo",
    "inputs": {
      "positive": ["4", 0],
      "negative": ["5", 0],
      "vae": ["3", 0],
      "width": "{{width}}",
      "height": "{{height}}",
      "length": "{{frame_count}}",
      "batch_size": 1
    }
  },
  "7": {
    "class_type": "KSamplerAdvanced",
    "inputs": {
      "model": ["1", 0],
      "add_noise": "enable",
      "noise_seed": "{{seed}}",
      "steps": "{{steps}}",
      "cfg": "{{cfg_scale}}",
      "sampler_name": "euler",
      "scheduler": "simple",
      "positive": ["6", 0],
      "negative": ["6", 1],
      "latent_image": ["6", 2],
      "start_at_step": 0,
      "end_at_step": 10000,
      "return_with_leftover_noise": "disable"
    }
  },
  "8": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["7", 0],
      "vae": ["3", 0]
    }
  },
  "9": {
    "class_type": "VHS_VideoCombine",
    "inputs": {
      "images": ["8", 0],
      "frame_rate": "{{fps}}",
      "loop_count": 0,
      "filename_prefix": "{{output_prefix}}",
      "format": "video/h264-mp4",
      "pingpong": false,
      "save_output": true
    }
  }
}
```

- [ ] **Step 4: Create workflow_video_i2v.json**

Create `/home/legion/legionprojects/nyx-step/workflow_video_i2v.json` — identical to T2V but adds node "10" and connects it to `WanImageToVideo`:

```json
{
  "1": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "{{model_name}}",
      "weight_dtype": "bf16"
    }
  },
  "2": {
    "class_type": "CLIPLoader",
    "inputs": {
      "clip_name": "{{text_encoder_name}}",
      "type": "wan"
    }
  },
  "3": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "{{vae_name}}"
    }
  },
  "4": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{positive_prompt}}",
      "clip": ["2", 0]
    }
  },
  "5": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{negative_prompt}}",
      "clip": ["2", 0]
    }
  },
  "6": {
    "class_type": "WanImageToVideo",
    "inputs": {
      "positive": ["4", 0],
      "negative": ["5", 0],
      "vae": ["3", 0],
      "width": "{{width}}",
      "height": "{{height}}",
      "length": "{{frame_count}}",
      "batch_size": 1,
      "start_image": ["10", 0]
    }
  },
  "7": {
    "class_type": "KSamplerAdvanced",
    "inputs": {
      "model": ["1", 0],
      "add_noise": "enable",
      "noise_seed": "{{seed}}",
      "steps": "{{steps}}",
      "cfg": "{{cfg_scale}}",
      "sampler_name": "euler",
      "scheduler": "simple",
      "positive": ["6", 0],
      "negative": ["6", 1],
      "latent_image": ["6", 2],
      "start_at_step": 0,
      "end_at_step": 10000,
      "return_with_leftover_noise": "disable"
    }
  },
  "8": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["7", 0],
      "vae": ["3", 0]
    }
  },
  "9": {
    "class_type": "VHS_VideoCombine",
    "inputs": {
      "images": ["8", 0],
      "frame_rate": "{{fps}}",
      "loop_count": 0,
      "filename_prefix": "{{output_prefix}}",
      "format": "video/h264-mp4",
      "pingpong": false,
      "save_output": true
    }
  },
  "10": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "{{start_image_filename}}"
    }
  }
}
```

- [ ] **Step 5: Run workflow tests**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_workflow_t2v_template_valid \
  tests/test_video.py::test_workflow_i2v_template_valid -v
```
Expected: 2 PASSED

- [ ] **Step 6: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add workflow_video_t2v.json workflow_video_i2v.json tests/test_video.py
git commit -m "feat(video): add Wan T2V and I2V ComfyUI workflow templates"
```

---

## Task 4: Video orchestrator

**Files:**
- Create: `nyx-step/core/video_orchestrator.py`
- Test: `nyx-step/tests/test_video.py`

The orchestrator fills workflow templates, queues ComfyUI jobs sequentially, waits for each via WebSocket, extracts the last frame, and stitches the final MP4. A global `_video_jobs` dict tracks in-memory state per `job_id`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_video.py`:

```python
from unittest.mock import patch, MagicMock, AsyncMock
import asyncio

def test_fill_t2v_template():
    from core.video_orchestrator import fill_template
    import json, config
    wf = fill_template(config.WORKFLOW_VIDEO_T2V, {
        "model_name": "wan2.1_t2v_1.3B_bf16.safetensors",
        "text_encoder_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "vae_name": "wan_2.1_vae.safetensors",
        "positive_prompt": "dark forest, cinematic",
        "negative_prompt": "blurry, ugly",
        "width": 832, "height": 480, "frame_count": 97,
        "fps": 16, "steps": 20, "cfg_scale": 6.5,
        "seed": 42, "output_prefix": "video/chunks/test_000",
    })
    # Should not contain any unfilled placeholders
    wf_str = json.dumps(wf)
    assert "{{" not in wf_str
    assert wf["4"]["inputs"]["text"] == "dark forest, cinematic"
    assert wf["7"]["inputs"]["noise_seed"] == 42
    assert wf["6"]["inputs"]["width"] == 832

def test_fill_i2v_template():
    from core.video_orchestrator import fill_template
    import json, config
    wf = fill_template(config.WORKFLOW_VIDEO_I2V, {
        "model_name": "wan2.1_t2v_1.3B_bf16.safetensors",
        "text_encoder_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "vae_name": "wan_2.1_vae.safetensors",
        "positive_prompt": "bright sunrise, motion",
        "negative_prompt": "blurry",
        "width": 832, "height": 480, "frame_count": 65,
        "fps": 16, "steps": 20, "cfg_scale": 7.0,
        "seed": 99, "output_prefix": "video/chunks/test_001",
        "start_image_filename": "chunk_abc_000_last.png",
    })
    wf_str = json.dumps(wf)
    assert "{{" not in wf_str
    assert wf["10"]["inputs"]["image"] == "chunk_abc_000_last.png"

def test_video_job_state():
    from core.video_orchestrator import create_job, get_job
    job_id = create_job(total_chunks=5, user_email="test@test.com")
    state = get_job(job_id)
    assert state["status"] == "queued"
    assert state["chunks_total"] == 5
    assert state["chunks_done"] == 0

def test_scale_cfg():
    from core.video_orchestrator import scale_cfg
    # section_only: always return base
    assert scale_cfg(6.0, 0.9, "section_only") == 6.0
    # beat_only / both: scales between base and base+2
    result = scale_cfg(6.0, 1.0, "both")
    assert result == pytest.approx(8.0, abs=0.1)
    result = scale_cfg(6.0, 0.0, "both")
    assert result == pytest.approx(6.0, abs=0.1)
```

Don't forget `import pytest` at the top of test_video.py.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_fill_t2v_template -v
```
Expected: `ModuleNotFoundError: No module named 'core.video_orchestrator'`

- [ ] **Step 3: Create video_orchestrator.py**

Create `/home/legion/legionprojects/nyx-step/core/video_orchestrator.py`:

```python
from __future__ import annotations
import asyncio
import copy
import json
import logging
import pathlib
import random
import shutil
import subprocess
import tempfile
import uuid
from contextlib import suppress
from typing import Any

import cv2
import requests

import config

logger = logging.getLogger(__name__)

# ── In-memory job state ────────────────────────────────────────────────────────
# Keyed by video job_id (uuid str). Lost on restart — acceptable for generation jobs.
_video_jobs: dict[str, dict] = {}


def create_job(total_chunks: int, user_email: str) -> str:
    job_id = str(uuid.uuid4())
    _video_jobs[job_id] = {
        "job_id": job_id,
        "user_email": user_email,
        "status": "queued",
        "chunks_total": total_chunks,
        "chunks_done": 0,
        "output_file": None,
        "error": None,
    }
    return job_id


def get_job(job_id: str) -> dict | None:
    return _video_jobs.get(job_id)


def _update_job(job_id: str, **kwargs: Any) -> None:
    if job_id in _video_jobs:
        _video_jobs[job_id].update(kwargs)


def scale_cfg(base: float, mean_beat_weight: float, sync_mode: str) -> float:
    """Return CFG scale for this chunk. Beat-reactive modes scale base to base+2."""
    if sync_mode == "section_only":
        return base
    return base + 2.0 * mean_beat_weight


# ── Template filling ───────────────────────────────────────────────────────────

def fill_template(template_path: pathlib.Path, values: dict) -> dict:
    """Load template JSON and replace all {{key}} placeholders with values."""
    raw = template_path.read_text()
    for key, val in values.items():
        raw = raw.replace(f"{{{{{key}}}}}", json.dumps(val) if not isinstance(val, str) else val)
    return json.loads(raw)


# ── ComfyUI interaction ────────────────────────────────────────────────────────

def _post_prompt(workflow: dict) -> str:
    """POST workflow to ComfyUI /prompt. Returns prompt_id."""
    resp = requests.post(
        f"{config.COMFYUI_URL}/prompt",
        json={"prompt": workflow},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"ComfyUI error: {data['error']}")
    return data["prompt_id"]


async def _wait_for_prompt(prompt_id: str, timeout: int = 600) -> list[str]:
    """
    Wait for a ComfyUI prompt to finish via WebSocket.
    Returns list of output filenames from the executed node outputs.
    """
    import websockets

    ws_url = config.COMFYUI_URL.replace("http://", "ws://").replace("https://", "wss://")
    ws_url = f"{ws_url}/ws?clientId=nyx_video_{prompt_id[:8]}"

    async with websockets.connect(ws_url) as ws:
        async def _recv():
            async for raw in ws:
                msg = json.loads(raw) if isinstance(raw, str) else {}
                mtype = msg.get("type", "")
                data = msg.get("data", {})
                if mtype == "executed" and data.get("prompt_id") == prompt_id:
                    outputs = data.get("output", {})
                    files = []
                    for node_out in outputs.values():
                        for item in node_out.get("gifs", []):
                            files.append(item.get("filename", ""))
                        for item in node_out.get("videos", []):
                            files.append(item.get("filename", ""))
                    return [f for f in files if f]
                if mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                    raise RuntimeError(data.get("exception_message", "ComfyUI execution error"))
        return await asyncio.wait_for(_recv(), timeout=timeout)


# ── Last frame extraction ──────────────────────────────────────────────────────

def extract_last_frame(video_path: pathlib.Path, dest: pathlib.Path) -> pathlib.Path:
    """Extract the last frame of video_path as a PNG to dest."""
    cap = cv2.VideoCapture(str(video_path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError(f"Could not read last frame from {video_path}")
    cv2.imwrite(str(dest), frame)
    return dest


def _copy_to_comfyui_input(src: pathlib.Path) -> str:
    """Copy a file to ComfyUI input dir and return just the filename."""
    dest = config.COMFYUI_INPUT_DIR / src.name
    shutil.copy2(src, dest)
    return src.name


# ── ffmpeg stitch ──────────────────────────────────────────────────────────────

def ffmpeg_stitch(chunk_paths: list[pathlib.Path], audio_file: str, job_id: str) -> pathlib.Path:
    """Concatenate chunk videos and mux with original audio → final MP4."""
    concat_list = pathlib.Path(tempfile.mktemp(suffix=".txt"))
    concat_list.write_text(
        "\n".join(f"file '{p}'" for p in chunk_paths)
    )
    out_path = config.VIDEO_OUTPUT_DIR / f"{job_id}.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-i", audio_file,
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "aac", "-shortest",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    concat_list.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-500:]}")
    return out_path


# ── Main orchestration loop ────────────────────────────────────────────────────

async def run_video_job(
    job_id: str,
    schedule: dict,
    section_prompts: dict,
    settings: dict,
) -> None:
    """
    Main async orchestration. Queues ComfyUI chunks sequentially, extracts
    last frames for I2V continuity, then stitches the final MP4.

    settings keys: style, sync_mode, width, height, fps, steps, cfg_base,
                   model_name, text_encoder_name, vae_name, negative_prompt, seed
    """
    _update_job(job_id, status="running")
    chunk_paths: list[pathlib.Path] = []

    style_prefixes = {
        "abstract": "abstract art, flowing geometric shapes, colorful particles, ",
        "cinematic": "cinematic scene, film still, dramatic lighting, ",
        "artistic": "oil painting, artistic illustration, detailed brushwork, ",
    }
    style_prefix = style_prefixes.get(settings.get("style", "cinematic"), "")
    neg = settings.get("negative_prompt", "blurry, low quality, watermark, text, static")
    seed_base = settings.get("seed", random.randint(0, 2**32 - 1))
    loop = asyncio.get_event_loop()

    try:
        for chunk in schedule["chunks"]:
            i = chunk["index"]
            section = chunk["section"]
            raw_prompt = section_prompts.get(section, section_prompts.get("Main", "abstract motion"))
            positive = style_prefix + raw_prompt
            cfg = scale_cfg(settings["cfg_base"], chunk["mean_beat_weight"], settings["sync_mode"])

            values = {
                "model_name": settings.get("model_name", config.WAN_MODEL),
                "text_encoder_name": settings.get("text_encoder_name", config.WAN_TEXT_ENCODER),
                "vae_name": settings.get("vae_name", config.WAN_VAE),
                "positive_prompt": positive,
                "negative_prompt": neg,
                "width": settings["width"],
                "height": settings["height"],
                "frame_count": chunk["frame_count"],
                "fps": settings["fps"],
                "steps": settings["steps"],
                "cfg_scale": round(cfg, 2),
                "seed": seed_base + i,
                "output_prefix": f"video/chunks/{job_id}_{i:03d}",
            }

            if i == 0:
                workflow = fill_template(config.WORKFLOW_VIDEO_T2V, values)
            else:
                last_frame_src = config.VIDEO_CHUNK_DIR / f"{job_id}_{i-1:03d}_last.png"
                last_frame_filename = _copy_to_comfyui_input(last_frame_src)
                values["start_image_filename"] = last_frame_filename
                workflow = fill_template(config.WORKFLOW_VIDEO_I2V, values)

            prompt_id = await loop.run_in_executor(None, _post_prompt, workflow)
            output_files = await _wait_for_prompt(prompt_id)

            if not output_files:
                raise RuntimeError(f"Chunk {i}: ComfyUI returned no output files")

            chunk_video = config.VIDEO_CHUNK_DIR / output_files[0]
            if not chunk_video.exists():
                # Try ComfyUI output dir root
                chunk_video = config.VIDEO_OUTPUT_DIR / output_files[0]
            chunk_paths.append(chunk_video)

            # Extract last frame for next chunk's I2V start_image
            if i < len(schedule["chunks"]) - 1:
                dest = config.VIDEO_CHUNK_DIR / f"{job_id}_{i:03d}_last.png"
                await loop.run_in_executor(None, extract_last_frame, chunk_video, dest)

            _update_job(job_id, chunks_done=i + 1)

        final = await loop.run_in_executor(
            None, ffmpeg_stitch, chunk_paths, schedule["audio_file"], job_id
        )
        _update_job(job_id, status="done", output_file=str(final))

    except Exception as exc:
        logger.exception("Video job %s failed: %s", job_id, exc)
        _update_job(job_id, status="error", error=str(exc))
```

- [ ] **Step 4: Run orchestrator tests**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_fill_t2v_template \
  tests/test_video.py::test_fill_i2v_template \
  tests/test_video.py::test_video_job_state \
  tests/test_video.py::test_scale_cfg -v
```
Expected: 4 PASSED

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add core/video_orchestrator.py tests/test_video.py
git commit -m "feat(video): add video_orchestrator with chunk loop and ffmpeg stitch"
```

---

## Task 5: FastAPI video routes

**Files:**
- Create: `nyx-step/routes/video.py`
- Test: `nyx-step/tests/test_video.py`

Five endpoints:
- `POST /api/video/analyse` — beat analysis, returns schedule
- `POST /api/video/suggest-prompts` — Ollama prompt per section
- `POST /api/video/generate` — kicks off orchestration, returns job_id
- `GET  /api/video/status/{job_id}` — returns job state
- `GET  /api/video/download/{job_id}` — streams final MP4

- [ ] **Step 1: Write the failing route tests**

Add to `tests/test_video.py`:

```python
import pytest
from fastapi.testclient import TestClient

@pytest.fixture
def vclient():
    from nyx_step import app
    return TestClient(app, headers={"Cf-Access-Authenticated-User-Email": "test@test.com"})

def test_video_status_unknown_job(vclient):
    resp = vclient.get("/api/video/status/nonexistent-job-id")
    assert resp.status_code == 404

def test_video_download_unknown_job(vclient):
    resp = vclient.get("/api/video/download/nonexistent-job-id")
    assert resp.status_code == 404

def test_video_analyse_no_file(vclient):
    resp = vclient.post("/api/video/analyse", json={
        "audio_file": "/nonexistent/file.mp3",
        "chunk_seconds": 6.0, "fps": 16,
        "sync_mode": "both", "lyrics": "", "bpm_hint": None
    })
    assert resp.status_code in (400, 422, 500)

def test_video_generate_missing_schedule(vclient):
    resp = vclient.post("/api/video/generate", json={
        "schedule": {"chunks": [], "audio_file": "/nonexistent.mp3",
                     "bpm": 120, "duration": 0, "beat_times": []},
        "section_prompts": {},
        "settings": {
            "style": "cinematic", "sync_mode": "both",
            "width": 832, "height": 480, "fps": 16,
            "steps": 20, "cfg_base": 6.0,
            "model_name": "wan2.1_t2v_1.3B_bf16.safetensors",
            "text_encoder_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
            "vae_name": "wan_2.1_vae.safetensors",
            "negative_prompt": "blurry", "seed": 0
        }
    })
    # Empty chunks → returns job_id but job completes immediately with no output
    assert resp.status_code == 200
    assert "job_id" in resp.json()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_video_status_unknown_job -v
```
Expected: FAIL (route not registered)

- [ ] **Step 3: Create routes/video.py**

Create `/home/legion/legionprojects/nyx-step/routes/video.py`:

```python
from __future__ import annotations
import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import config
from core.beat_analyser import analyse
from core.executor import get_audio_pool
from core.video_orchestrator import create_job, get_job, run_video_job
from nyx_step import get_user_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/video")


class AnalyseRequest(BaseModel):
    audio_file: str
    chunk_seconds: float = Field(default=6.0, ge=1.0, le=30.0)
    fps: float = Field(default=16.0, ge=8.0, le=30.0)
    sync_mode: str = "both"
    lyrics: str = ""
    bpm_hint: float | None = None


class GenerateRequest(BaseModel):
    schedule: dict
    section_prompts: dict
    settings: dict


class SuggestPromptsRequest(BaseModel):
    sections: list[str]
    genre: str = ""
    caption: str = ""
    style: str = "cinematic"
    ollama_model: str = "gemma4:latest"


@router.post("/analyse")
async def analyse_audio(request: Request, body: AnalyseRequest):
    get_user_email(request)
    loop = asyncio.get_event_loop()
    try:
        schedule = await loop.run_in_executor(
            get_audio_pool(),
            lambda: analyse(
                body.audio_file,
                chunk_seconds=body.chunk_seconds,
                fps=body.fps,
                sync_mode=body.sync_mode,
                lyrics=body.lyrics,
                bpm_hint=body.bpm_hint,
            )
        )
    except FileNotFoundError:
        return JSONResponse({"error": f"Audio file not found: {body.audio_file}"}, status_code=400)
    except Exception as exc:
        logger.exception("Beat analysis failed")
        return JSONResponse({"error": str(exc)}, status_code=500)
    return schedule


@router.post("/suggest-prompts")
async def suggest_prompts(request: Request, body: SuggestPromptsRequest):
    get_user_email(request)
    from core.ollama import generate as ollama_generate

    results: dict[str, str] = {}
    style_desc = {
        "abstract": "abstract art with flowing shapes and colors",
        "cinematic": "cinematic film scene with dramatic lighting",
        "artistic": "detailed oil painting illustration",
    }.get(body.style, "cinematic film scene")

    for section in body.sections:
        prompt_text = (
            f"Write a 20-word visual scene description for a music video. "
            f"Style: {style_desc}. Genre: {body.genre}. Section: {section}. "
            f"Caption: {body.caption[:200]}. Be specific and visual. No lyrics."
        )
        try:
            result = await asyncio.get_event_loop().run_in_executor(
                get_audio_pool(),
                lambda p=prompt_text: ollama_generate(body.ollama_model, p),
            )
            results[section] = result.strip()[:200] if result else section
        except Exception:
            results[section] = f"{section} visual scene"

    return {"prompts": results}


@router.post("/generate")
async def generate_video(
    request: Request,
    body: GenerateRequest,
    background_tasks: BackgroundTasks,
):
    user_email = get_user_email(request)
    chunks = body.schedule.get("chunks", [])
    job_id = create_job(total_chunks=len(chunks), user_email=user_email)

    async def _run():
        await run_video_job(job_id, body.schedule, body.section_prompts, body.settings)

    background_tasks.add_task(_run)
    return {"job_id": job_id, "chunks_total": len(chunks)}


@router.get("/status/{job_id}")
async def video_status(request: Request, job_id: str):
    get_user_email(request)
    state = get_job(job_id)
    if state is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    return state


@router.get("/download/{job_id}")
async def download_video(request: Request, job_id: str):
    get_user_email(request)
    state = get_job(job_id)
    if state is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    if state["status"] != "done" or not state.get("output_file"):
        return JSONResponse({"error": "Video not ready"}, status_code=404)
    out = Path(state["output_file"])
    if not out.exists():
        return JSONResponse({"error": "Output file missing"}, status_code=404)
    return FileResponse(
        str(out),
        media_type="video/mp4",
        filename=f"nyx_video_{job_id[:8]}.mp4",
    )
```

- [ ] **Step 4: Run route tests**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py::test_video_status_unknown_job \
  tests/test_video.py::test_video_download_unknown_job \
  tests/test_video.py::test_video_analyse_no_file \
  tests/test_video.py::test_video_generate_missing_schedule -v
```
Expected: 4 PASSED

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add routes/video.py tests/test_video.py
git commit -m "feat(video): add /api/video/* FastAPI routes"
```

---

## Task 6: Register video router + check ollama.generate

**Files:**
- Modify: `nyx-step/nyx_step.py`
- Check: `nyx-step/core/ollama.py`

- [ ] **Step 1: Check ollama.py has a generate() function**

```bash
grep -n "def generate\|def list_models" /home/legion/legionprojects/nyx-step/core/ollama.py
```

If `generate()` exists (returns str), proceed. If it's named differently, update the import in `routes/video.py` `suggest_prompts` to match the actual function name.

- [ ] **Step 2: Register the video router in nyx_step.py**

Open `/home/legion/legionprojects/nyx-step/nyx_step.py`. Find the block of `from routes.xxx import xxx_router` imports and `app.include_router(xxx_router)` calls. Add:

```python
from routes.video import router as video_router
```

And in the router registration block:

```python
app.include_router(video_router)
```

- [ ] **Step 3: Verify server starts**

```bash
cd /home/legion/legionprojects/nyx-step
python -c "from nyx_step import app; print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Verify route is registered**

```bash
python -c "
from nyx_step import app
routes = [r.path for r in app.routes]
print([r for r in routes if 'video' in r])
"
```
Expected: list including `/api/video/analyse`, `/api/video/generate`, etc.

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add nyx_step.py
git commit -m "feat(video): register video router in nyx_step app"
```

---

## Task 7: HTML Video tab

**Files:**
- Modify: `nyx-step/templates/index.html`

- [ ] **Step 1: Add tab button**

In `templates/index.html`, find the tab button section. After the `analyze` tab button line, add:

```html
  <button class="tab-btn" data-tab="video" title="Video — generate a music video from your song using Wan AI">🎬 Video</button>
```

- [ ] **Step 2: Add tab panel**

Find the last `</div>` before the closing `</main>` or `</body>` in the tab panels section. Add before it:

```html
  <!-- ── Video Tab ──────────────────────────────────────────────────────────── -->
  <div class="tab-panel" id="tab-video">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;padding:1rem">

      <!-- Left: Scene Prompts -->
      <div>
        <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:1rem">
          <h3 style="margin:0">Scene Prompts</h3>
          <button id="video-regen-prompts" class="btn-sm">↻ Regenerate All</button>
        </div>

        <div style="margin-bottom:1rem">
          <label style="font-weight:600;display:block;margin-bottom:0.4rem">Style</label>
          <div style="display:flex;gap:1rem">
            <label><input type="radio" name="video-style" value="abstract"> Abstract</label>
            <label><input type="radio" name="video-style" value="cinematic" checked> Cinematic</label>
            <label><input type="radio" name="video-style" value="artistic"> Artistic</label>
          </div>
        </div>

        <div style="margin-bottom:1rem">
          <label style="font-weight:600;display:block;margin-bottom:0.4rem">Sync Mode</label>
          <div style="display:flex;gap:1rem">
            <label><input type="radio" name="video-sync" value="section_only"> A — Section-based</label>
            <label><input type="radio" name="video-sync" value="beat_only"> B — Beat-reactive</label>
            <label><input type="radio" name="video-sync" value="both" checked> C — Both</label>
          </div>
        </div>

        <div id="video-section-prompts">
          <!-- populated by video.js from lyrics sections -->
          <p style="color:var(--text-muted)">Generate or load a song first, then open this tab.</p>
        </div>
      </div>

      <!-- Right: Settings + Actions -->
      <div>
        <h3 style="margin:0 0 1rem">Video Settings</h3>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">Resolution</td>
              <td><select id="video-resolution">
                <option value="832x480" selected>832×480 (480p)</option>
                <option value="1280x720">1280×720 (720p)</option>
                <option value="1024x576">1024×576</option>
              </select></td></tr>
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">Chunk Duration</td>
              <td><select id="video-chunk-seconds">
                <option value="4">4 seconds</option>
                <option value="6" selected>6 seconds</option>
                <option value="8">8 seconds</option>
              </select></td></tr>
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">FPS</td>
              <td><select id="video-fps">
                <option value="16" selected>16</option>
                <option value="24">24</option>
              </select></td></tr>
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">Steps</td>
              <td><input type="number" id="video-steps" value="20" min="5" max="50" style="width:5rem"></td></tr>
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">CFG Base</td>
              <td><input type="number" id="video-cfg" value="6.0" min="1" max="15" step="0.5" style="width:5rem"></td></tr>
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">Negative Prompt</td>
              <td><input type="text" id="video-negative" value="blurry, low quality, watermark, text, static, noise" style="width:100%"></td></tr>
          <tr><td style="padding:0.4rem 0.6rem;color:var(--text-muted)">Wan Model</td>
              <td><input type="text" id="video-model" value="wan2.1_t2v_1.3B_bf16.safetensors" style="width:100%"></td></tr>
        </table>

        <div style="margin-top:1.5rem;display:flex;flex-direction:column;gap:0.8rem">
          <button id="video-analyse-btn" class="btn-primary">🔍 Analyse Audio</button>
          <div id="video-analyse-result" style="color:var(--text-muted);font-size:0.9em"></div>

          <button id="video-generate-btn" class="btn-primary" disabled>🎬 Generate Video</button>

          <div id="video-progress-wrap" style="display:none">
            <progress id="video-progress-bar" max="100" value="0" style="width:100%"></progress>
            <div id="video-progress-label" style="color:var(--text-muted);font-size:0.85em;margin-top:0.3rem"></div>
            <button id="video-cancel-btn" style="margin-top:0.4rem">✕ Cancel</button>
          </div>

          <div id="video-download-wrap" style="display:none">
            <a id="video-download-link" class="btn-primary" style="text-decoration:none;text-align:center">
              ⬇ Download MP4
            </a>
          </div>

          <div id="video-error" style="color:var(--accent3);display:none"></div>
        </div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Verify HTML is valid (no unclosed tags)**

```bash
python3 -c "
from html.parser import HTMLParser
class V(HTMLParser): pass
v = V()
with open('/home/legion/legionprojects/nyx-step/templates/index.html') as f:
    v.feed(f.read())
print('HTML parsed OK')
"
```

- [ ] **Step 4: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add templates/index.html
git commit -m "feat(video): add Video tab HTML (panel + controls)"
```

---

## Task 8: video.js frontend

**Files:**
- Create: `nyx-step/static/video.js`

- [ ] **Step 1: Create video.js**

Create `/home/legion/legionprojects/nyx-step/static/video.js`:

```javascript
// ── Video Tab ─────────────────────────────────────────────────────────────────

let _videoSchedule = null;
let _videoJobId = null;
let _videoPollTimer = null;

// ── Section prompt editors ────────────────────────────────────────────────────

function parseLyricsSections(lyrics) {
  const re = /^\[([^\]]+)\]/gm;
  const sections = [];
  let m;
  while ((m = re.exec(lyrics)) !== null) {
    const name = m[1].split(":")[0].trim();
    if (!sections.includes(name)) sections.push(name);
  }
  return sections.length ? sections : ["Main"];
}

function buildSectionPromptEditors(sections) {
  const container = document.getElementById("video-section-prompts");
  if (!container) return;
  container.innerHTML = "";
  sections.forEach(section => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:0.8rem";
    wrap.innerHTML = `
      <label style="font-weight:600;display:block;margin-bottom:0.3rem">${section}</label>
      <textarea id="video-prompt-${section}" rows="2"
        style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:0.5rem;font-size:0.9em;resize:vertical"
        placeholder="Visual scene description for ${section}..."></textarea>`;
    container.appendChild(wrap);
  });
}

function getSectionPrompts() {
  const prompts = {};
  document.querySelectorAll("[id^='video-prompt-']").forEach(el => {
    const section = el.id.replace("video-prompt-", "");
    prompts[section] = el.value.trim();
  });
  return prompts;
}

function setSectionPrompts(promptsMap) {
  Object.entries(promptsMap).forEach(([section, text]) => {
    const el = document.getElementById(`video-prompt-${section}`);
    if (el) el.value = text;
  });
}

// ── Tab open hook ─────────────────────────────────────────────────────────────

function onVideoTabOpen() {
  const lyrics = (typeof mwState !== "undefined" && mwState.lyrics) ? mwState.lyrics : "";
  const sections = parseLyricsSections(lyrics);
  buildSectionPromptEditors(sections);

  // Auto-suggest prompts if sections changed
  if (sections.length && lyrics) {
    suggestVideoPrompts(sections);
  }
}

// ── Suggest prompts ───────────────────────────────────────────────────────────

async function suggestVideoPrompts(sections) {
  const style = document.querySelector("input[name='video-style']:checked")?.value || "cinematic";
  const genre = (typeof mwState !== "undefined") ? (mwState.genre || "") : "";
  const caption = (typeof mwState !== "undefined") ? (mwState.caption || "") : "";

  try {
    const resp = await fetch("/api/video/suggest-prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections, genre, caption, style }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    setSectionPrompts(data.prompts || {});
  } catch (_) {}
}

// ── Analyse ───────────────────────────────────────────────────────────────────

async function analyseVideoAudio() {
  const btn = document.getElementById("video-analyse-btn");
  const result = document.getElementById("video-analyse-result");
  const genBtn = document.getElementById("video-generate-btn");

  // Find last audio file from ComfyUI output dir
  const audioFile = (typeof mwState !== "undefined" && mwState.lastAudioFile)
    ? mwState.lastAudioFile : null;

  if (!audioFile) {
    result.textContent = "⚠ No audio file found. Generate a song first.";
    return;
  }

  btn.disabled = true;
  result.textContent = "Analysing…";

  const lyrics = (typeof mwState !== "undefined") ? (mwState.lyrics || "") : "";
  const bpm = (typeof mwState !== "undefined") ? (mwState.bpm || null) : null;
  const chunkSeconds = parseFloat(document.getElementById("video-chunk-seconds").value);
  const fps = parseFloat(document.getElementById("video-fps").value);
  const syncMode = document.querySelector("input[name='video-sync']:checked")?.value || "both";

  try {
    const resp = await fetch("/api/video/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_file: audioFile,
        chunk_seconds: chunkSeconds,
        fps, sync_mode: syncMode,
        lyrics, bpm_hint: bpm,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { result.textContent = `Error: ${data.error}`; return; }

    _videoSchedule = data;
    result.textContent = `✓ ${data.bpm.toFixed(1)} BPM · ${data.chunks.length} chunks · ${data.duration.toFixed(1)}s`;
    genBtn.disabled = false;
  } catch (err) {
    result.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Generate ──────────────────────────────────────────────────────────────────

async function generateVideo() {
  if (!_videoSchedule) return;

  const genBtn = document.getElementById("video-generate-btn");
  const progressWrap = document.getElementById("video-progress-wrap");
  const progressBar = document.getElementById("video-progress-bar");
  const progressLabel = document.getElementById("video-progress-label");
  const downloadWrap = document.getElementById("video-download-wrap");
  const errorDiv = document.getElementById("video-error");

  genBtn.disabled = true;
  progressWrap.style.display = "block";
  downloadWrap.style.display = "none";
  errorDiv.style.display = "none";
  progressBar.value = 0;
  progressLabel.textContent = "Starting…";

  const res = document.getElementById("video-resolution").value.split("x");
  const settings = {
    style: document.querySelector("input[name='video-style']:checked")?.value || "cinematic",
    sync_mode: document.querySelector("input[name='video-sync']:checked")?.value || "both",
    width: parseInt(res[0]),
    height: parseInt(res[1]),
    fps: parseFloat(document.getElementById("video-fps").value),
    steps: parseInt(document.getElementById("video-steps").value),
    cfg_base: parseFloat(document.getElementById("video-cfg").value),
    model_name: document.getElementById("video-model").value.trim(),
    text_encoder_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    vae_name: "wan_2.1_vae.safetensors",
    negative_prompt: document.getElementById("video-negative").value.trim(),
    seed: Math.floor(Math.random() * 2 ** 32),
  };

  try {
    const resp = await fetch("/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedule: _videoSchedule,
        section_prompts: getSectionPrompts(),
        settings,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { throw new Error(data.error || "Generate failed"); }

    _videoJobId = data.job_id;
    pollVideoStatus(data.chunks_total);
  } catch (err) {
    errorDiv.textContent = `Error: ${err.message}`;
    errorDiv.style.display = "block";
    progressWrap.style.display = "none";
    genBtn.disabled = false;
  }
}

// ── Status polling ────────────────────────────────────────────────────────────

function pollVideoStatus(total) {
  const progressBar = document.getElementById("video-progress-bar");
  const progressLabel = document.getElementById("video-progress-label");
  const downloadWrap = document.getElementById("video-download-wrap");
  const downloadLink = document.getElementById("video-download-link");
  const errorDiv = document.getElementById("video-error");
  const genBtn = document.getElementById("video-generate-btn");

  clearInterval(_videoPollTimer);
  _videoPollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/video/status/${_videoJobId}`);
      const state = await resp.json();

      const done = state.chunks_done || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      progressBar.value = pct;
      progressLabel.textContent = `Chunk ${done} of ${total} · ${pct}%`;

      if (state.status === "done") {
        clearInterval(_videoPollTimer);
        downloadLink.href = `/api/video/download/${_videoJobId}`;
        downloadWrap.style.display = "block";
        progressLabel.textContent = `✓ Done — ${total} chunks`;
        genBtn.disabled = false;
      } else if (state.status === "error") {
        clearInterval(_videoPollTimer);
        errorDiv.textContent = `Error: ${state.error}`;
        errorDiv.style.display = "block";
        genBtn.disabled = false;
      }
    } catch (_) {}
  }, 3000);
}

// ── Wire up event listeners ───────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("video-analyse-btn")?.addEventListener("click", analyseVideoAudio);
  document.getElementById("video-generate-btn")?.addEventListener("click", generateVideo);
  document.getElementById("video-regen-prompts")?.addEventListener("click", () => {
    const lyrics = (typeof mwState !== "undefined") ? (mwState.lyrics || "") : "";
    suggestVideoPrompts(parseLyricsSections(lyrics));
  });
  document.getElementById("video-cancel-btn")?.addEventListener("click", () => {
    clearInterval(_videoPollTimer);
    document.getElementById("video-progress-wrap").style.display = "none";
    document.getElementById("video-generate-btn").disabled = false;
  });
});

// Hook into tab switching (tabs.js calls functions named `on<TabName>TabOpen`)
// tabs.js already has: if (btn.dataset.tab === "history") { ... }
// We wire our hook via the tab-btn click listener:
document.querySelectorAll(".tab-btn").forEach(btn => {
  if (btn.dataset.tab === "video") {
    btn.addEventListener("click", onVideoTabOpen);
  }
});
```

- [ ] **Step 2: Add script tag to index.html**

In `templates/index.html`, find the block of `<script src="/static/...js">` tags near the bottom. Add:

```html
<script src="/static/video.js"></script>
```

- [ ] **Step 3: Add lastAudioFile tracking to app.js**

In `nyx-step/static/app.js`, find where generation completion is handled (the place where output filenames are received from the WebSocket or SSE). Add tracking of the last audio file path, e.g.:

```javascript
// After extracting the output filename from a completed generation:
if (typeof mwState !== "undefined" && outputFiles.length) {
    mwState.lastAudioFile = outputFiles[0];  // full path to last generated audio
}
```

The exact location depends on how `app.js` currently handles completion. Search for `output_files` or `done` in `app.js` and add the assignment there.

- [ ] **Step 4: Verify script loads without errors**

```bash
cd /home/legion/legionprojects/nyx-step
python3 -c "
import ast, pathlib
# Basic JS syntax check via Node if available
import subprocess, shutil
js = pathlib.Path('static/video.js').read_text()
print(f'video.js: {len(js)} bytes')
if shutil.which('node'):
    r = subprocess.run(['node', '--check', 'static/video.js'], capture_output=True, text=True)
    print('node --check:', r.returncode, r.stderr[:200] if r.stderr else 'OK')
"
```

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/nyx-step
git add static/video.js templates/index.html static/app.js
git commit -m "feat(video): add video.js tab with analyse, generate, progress, download"
```

---

## Task 9: ComfyUI custom nodes

**Files:**
- Create: `ComfyUI/custom_nodes/NyxNodes/nyx_beat_scheduler.py`
- Create: `ComfyUI/custom_nodes/NyxNodes/nyx_section_prompt_router.py`
- Modify: `ComfyUI/custom_nodes/NyxNodes/__init__.py`

These expose the beat analysis and prompt routing logic as standalone ComfyUI nodes for use in manual workflows (separate from the nyx-step pipeline).

- [ ] **Step 1: Create nyx_beat_scheduler.py**

Create `/home/legion/legionprojects/ComfyUI/custom_nodes/NyxNodes/nyx_beat_scheduler.py`:

```python
import json
import sys
import pathlib

# nyx-step's beat_analyser is the canonical implementation
_NYX_STEP = pathlib.Path("/home/legion/legionprojects/nyx-step")
if str(_NYX_STEP) not in sys.path:
    sys.path.insert(0, str(_NYX_STEP))


class NyxBeatScheduler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "fps": ("FLOAT", {"default": 16.0, "min": 8.0, "max": 30.0, "step": 0.5}),
                "sync_mode": (["section_only", "beat_only", "both"], {"default": "both"}),
                "chunk_seconds": ("FLOAT", {"default": 6.0, "min": 1.0, "max": 30.0, "step": 0.5}),
                "lyrics": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("schedule_json", "chunk_count", "beat_times_json")
    FUNCTION = "schedule"
    CATEGORY = "NyxNodes"

    def schedule(self, audio, fps, sync_mode, chunk_seconds, lyrics):
        import tempfile, torchaudio, pathlib
        from core.beat_analyser import analyse

        waveform = audio["waveform"]
        sr = audio["sample_rate"]
        tmp = pathlib.Path(tempfile.mktemp(suffix=".wav"))
        try:
            torchaudio.save(str(tmp), waveform[0], sr)
            result = analyse(str(tmp), chunk_seconds=chunk_seconds, fps=fps,
                             sync_mode=sync_mode, lyrics=lyrics, bpm_hint=None)
        finally:
            tmp.unlink(missing_ok=True)

        schedule_json = json.dumps(result)
        chunk_count = len(result["chunks"])
        beat_times_json = json.dumps(result["beat_times"])
        return (schedule_json, chunk_count, beat_times_json)


NODE_CLASS_MAPPINGS = {"NyxBeatScheduler": NyxBeatScheduler}
NODE_DISPLAY_NAME_MAPPINGS = {"NyxBeatScheduler": "Nyx Beat Scheduler"}
```

- [ ] **Step 2: Create nyx_section_prompt_router.py**

Create `/home/legion/legionprojects/ComfyUI/custom_nodes/NyxNodes/nyx_section_prompt_router.py`:

```python
import json
import sys
import pathlib

_NYX_STEP = pathlib.Path("/home/legion/legionprojects/nyx-step")
if str(_NYX_STEP) not in sys.path:
    sys.path.insert(0, str(_NYX_STEP))

_STYLE_PREFIXES = {
    "abstract": "abstract art, flowing geometric shapes, colorful particles, ",
    "cinematic": "cinematic scene, film still, dramatic lighting, ",
    "artistic": "oil painting, artistic illustration, detailed brushwork, ",
}


class NyxSectionPromptRouter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "schedule_json": ("STRING", {"default": "{}"}),
                "section_prompts_json": ("STRING", {"default": "{}", "multiline": True}),
                "style": (["abstract", "cinematic", "artistic"], {"default": "cinematic"}),
                "chunk_index": ("INT", {"default": 0, "min": 0, "max": 9999}),
                "cfg_base": ("FLOAT", {"default": 6.0, "min": 1.0, "max": 15.0, "step": 0.5}),
                "sync_mode": (["section_only", "beat_only", "both"], {"default": "both"}),
            }
        }

    RETURN_TYPES = ("STRING", "FLOAT", "BOOLEAN")
    RETURN_NAMES = ("positive_prompt", "cfg_scale", "is_first_chunk")
    FUNCTION = "route"
    CATEGORY = "NyxNodes"

    def route(self, schedule_json, section_prompts_json, style, chunk_index, cfg_base, sync_mode):
        from core.video_orchestrator import scale_cfg

        schedule = json.loads(schedule_json) if schedule_json.strip() else {}
        prompts = json.loads(section_prompts_json) if section_prompts_json.strip() else {}
        chunks = schedule.get("chunks", [])

        if chunk_index < len(chunks):
            chunk = chunks[chunk_index]
            section = chunk.get("section", "Main")
            mean_weight = chunk.get("mean_beat_weight", 0.5)
        else:
            section = "Main"
            mean_weight = 0.5

        raw_prompt = prompts.get(section, prompts.get("Main", f"{section} visual scene"))
        prefix = _STYLE_PREFIXES.get(style, "")
        positive = prefix + raw_prompt

        cfg = scale_cfg(cfg_base, mean_weight, sync_mode)
        is_first = chunk_index == 0

        return (positive, round(cfg, 2), is_first)


NODE_CLASS_MAPPINGS = {"NyxSectionPromptRouter": NyxSectionPromptRouter}
NODE_DISPLAY_NAME_MAPPINGS = {"NyxSectionPromptRouter": "Nyx Section Prompt Router"}
```

- [ ] **Step 3: Register both nodes in __init__.py**

Open `/home/legion/legionprojects/ComfyUI/custom_nodes/NyxNodes/__init__.py`. Add:

```python
from .nyx_beat_scheduler import NyxBeatScheduler
from .nyx_section_prompt_router import NyxSectionPromptRouter
```

And extend both dicts:

```python
NODE_CLASS_MAPPINGS = {
    "NyxsAudioConditioner":    NyxsAudioConditioner,
    "NyxBioInfusor":           NyxBioInfusor,
    "NyxSaveAudioCodes":       NyxSaveAudioCodes,
    "NyxLoadAudioCodes":       NyxLoadAudioCodes,
    "NyxAudioOverlay":         NyxAudioOverlay,
    "NyxBeatScheduler":        NyxBeatScheduler,
    "NyxSectionPromptRouter":  NyxSectionPromptRouter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NyxsAudioConditioner":    "Nyx's Audio Conditioner",
    "NyxBioInfusor":           "Nyx's Bio Infusor",
    "NyxSaveAudioCodes":       "Nyx Save Audio Codes",
    "NyxLoadAudioCodes":       "Nyx Load Audio Codes",
    "NyxAudioOverlay":         "Nyx Audio Overlay",
    "NyxBeatScheduler":        "Nyx Beat Scheduler",
    "NyxSectionPromptRouter":  "Nyx Section Prompt Router",
}
```

- [ ] **Step 4: Verify nodes import cleanly**

```bash
cd /home/legion/legionprojects/ComfyUI/custom_nodes/NyxNodes
python3 -c "from nyx_beat_scheduler import NyxBeatScheduler; print('NyxBeatScheduler OK')"
python3 -c "from nyx_section_prompt_router import NyxSectionPromptRouter; print('NyxSectionPromptRouter OK')"
```
Expected: both print OK

- [ ] **Step 5: Commit**

```bash
cd /home/legion/legionprojects/ComfyUI
git add custom_nodes/NyxNodes/nyx_beat_scheduler.py \
        custom_nodes/NyxNodes/nyx_section_prompt_router.py \
        custom_nodes/NyxNodes/__init__.py
git commit -m "feat(NyxNodes): add NyxBeatScheduler and NyxSectionPromptRouter"
```

---

## Task 10: Smoke test + restart

**Final verification that the full stack is wired correctly.**

- [ ] **Step 1: Run full test suite**

```bash
cd /home/legion/legionprojects/nyx-step
python -m pytest tests/test_video.py -v
```
Expected: all tests pass.

- [ ] **Step 2: Restart nyx-step to pick up new routes**

```bash
sudo systemctl restart nyx-step 2>/dev/null || \
  (pkill -f "nyx_step:app" || true; sleep 2; echo "Restart nyx-step manually")
```

Check it's running:
```bash
curl -s http://127.0.0.1:8001/health | python3 -m json.tool
```
Expected: `{"status": "ok", ...}`

- [ ] **Step 3: Verify video routes respond**

```bash
curl -s -X POST http://127.0.0.1:8001/api/video/status/nonexistent \
  -H "Cf-Access-Authenticated-User-Email: dev@local" | python3 -m json.tool
```
Expected: `{"error": "Job not found"}`

```bash
curl -s http://127.0.0.1:8001/api/video/status/nonexistent \
  -H "Cf-Access-Authenticated-User-Email: dev@local" | python3 -m json.tool
```
Expected: `{"error": "Job not found"}` (404)

- [ ] **Step 4: Restart ComfyUI to pick up new NyxNodes**

```bash
sudo systemctl restart comfyui
```

Wait 15s then verify nodes registered:
```bash
curl -s http://127.0.0.1:8188/object_info/NyxBeatScheduler | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'NyxBeatScheduler' in d else 'MISSING')"
```
Expected: `OK`

- [ ] **Step 5: Commit docs**

```bash
cd /home/legion/legionprojects/nyx-step
git add docs/
git commit -m "docs: add music video generator implementation plan"
```

- [ ] **Step 6: Open the app and test the Video tab manually**

Navigate to `https://music-ai.nyxstudios.net`, load or generate a song, open the Video tab, click "Analyse Audio", verify chunk count appears, fill scene prompts, click "Generate Video", watch progress.

---

## Self-review notes

- All `{{placeholder}}` strings in templates are filled by `fill_template()` using exact dict keys — checked for consistency across Tasks 3 and 4.
- `mwState.lastAudioFile` is set in Task 8 Step 3 by finding the completion handler in `app.js` — this is the only loosely-specified step; the exact location in app.js must be found by the implementer using `grep -n "done\|output_files" static/app.js`.
- `ollama_generate()` function name is verified against live `core/ollama.py` in Task 6 Step 1.
- Frame count alignment `(n-1) % 4 == 0` is enforced in `beat_analyser._wan_align()` and tested in `test_beat_analyser_frame_count_aligned`.
- The `nyx-step` service name for systemctl may differ — check with `systemctl list-units | grep nyx` if restart fails.

## Follow-up: diffusion model selection + zoom rate (2026-06-19)

Shipped in `349013c` (origin + backup `master`) to address "covers look too Asian-inspired" and "uploaded image doesn't get used":

- **Selectable diffusion model.** The YouTube/AI-cover tab now has a model dropdown (`routes/youtube_upload.py` + `youtube_upload_router` form field `model`, threaded through `_build_job_payload` → `core/youtube_uploader.py`). Valid checkpoints come from `MODEL_PRESETS`, verified byte-exact against **both** disk names and ComfyUI's live `CheckpointLoaderSimple` object_info:
  1. `majicmixRealistic_v7.safetensors` — photoreal, but reads Asian-influenced (old default; still the flash-drive-era blow-up default)
  2. **`sd_xl_base_1.0.safetensors` — NEW DEFAULT** (least-Asian, neutral photoreal)
  3. `ponyDiffusionV6XL_v6.safetensors` — quantized pony/art range, higher variance
- The chosen preset is passed as `ckpt_name` to `CheckpointLoaderSimple`; custom node `mym9_set_cover_payload` / fallbacks never downgrade a selected model back to the photoreal checkpoint.
- **Zoom rate (Ken Burns).** `zoom_rate` (HTML range in the same tab, default 0.5, higher = faster drift) is threaded into the ffmpeg `zoompan` filter via core file `core/youtube_uploader.py`:
  ```python
  zoom_expr = f"1+{zoom_rate}*on"
  "zoompan=z='{zoom_expr}':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':"
  ```
  Bug fixed from `349013c` parent: the old literal `z='zoom_expr'` (variable *name*, not value) made `zoompan` evaluate to a non-number and the visual stream collapsed — song played with no visuals. Now the interpolated expression drives the scale; `d={int(dur*30)}:fps=30:s=1920x1080`.

- **Uploaded-image cover path** (`ai_cover=false` in the same form): your uploaded PNG is saved to the media mount, checked with `user_owns_file`, and used directly as the still — the ComfyUI model dropdown is bypassed entirely. Both paths now produce visible, zooming Ken Burns output.
