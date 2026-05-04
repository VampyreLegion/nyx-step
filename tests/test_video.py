import pathlib
import config
import json
import numpy as np
import soundfile as sf
import tempfile
import pytest

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

def test_workflow_t2v_template_valid():
    import json
    import config
    assert config.WORKFLOW_VIDEO_T2V.exists(), "workflow_video_t2v.json missing"
    wf = json.loads(config.WORKFLOW_VIDEO_T2V.read_text())
    class_types = {v["class_type"] for v in wf.values() if isinstance(v, dict) and "class_type" in v}
    assert "UNETLoader" in class_types
    assert "WanImageToVideo" in class_types
    assert "VHS_VideoCombine" in class_types
    assert "LoadImage" not in class_types

def test_workflow_i2v_template_valid():
    import json
    import config
    assert config.WORKFLOW_VIDEO_I2V.exists(), "workflow_video_i2v.json missing"
    wf = json.loads(config.WORKFLOW_VIDEO_I2V.read_text())
    class_types = {v["class_type"] for v in wf.values() if isinstance(v, dict) and "class_type" in v}
    assert "LoadImage" in class_types
    assert "WanImageToVideo" in class_types


import pytest
from unittest.mock import patch, MagicMock

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
    assert scale_cfg(6.0, 0.9, "section_only") == 6.0
    result = scale_cfg(6.0, 1.0, "both")
    assert result == pytest.approx(8.0, abs=0.1)
    result = scale_cfg(6.0, 0.0, "both")
    assert result == pytest.approx(6.0, abs=0.1)


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
    assert resp.status_code == 200
    assert "job_id" in resp.json()
