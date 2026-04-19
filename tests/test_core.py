import pathlib
import config

def test_paths_exist():
    assert config.WORKFLOW_TEMPLATE.exists(), f"Missing: {config.WORKFLOW_TEMPLATE}"
    assert config.WORKFLOW_EXTRACT_TEMPLATE.exists(), f"Missing: {config.WORKFLOW_EXTRACT_TEMPLATE}"
    assert config.ACEUSER_HTML.exists(), f"Missing: {config.ACEUSER_HTML}"
    assert config.ACETALK_INSTRUMENTS.exists(), f"Missing: {config.ACETALK_INSTRUMENTS}"
    assert config.ACETALK_TEMPLATES.exists(), f"Missing: {config.ACETALK_TEMPLATES}"

def test_comfyui_output_dir_exists():
    assert config.COMFYUI_OUTPUT_DIR.exists()
