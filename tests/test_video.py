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
