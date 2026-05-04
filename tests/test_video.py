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
