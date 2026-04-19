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

from core.prompt_builder import build_caption, build_lyrics, build_prompt
from core.prompt_linter import PromptLinter, LintResult

# ── prompt_builder ────────────────────────────────────────────────────────────

def test_build_caption_empty():
    assert build_caption({}) == ""

def test_build_caption_genre_bpm():
    s = {"genre": "Psytrance", "bpm": 140, "key": "", "scale": "", "mode": "",
         "time_sig": "4/4", "instruments": [], "vocal_tags": []}
    cap = build_caption(s)
    assert "psytrance" in cap
    assert "140 BPM" in cap

def test_build_lyrics():
    s = {"lyrics": "[Verse]\nhello"}
    assert build_lyrics(s) == "[Verse]\nhello"

def test_build_prompt_tuple():
    s = {"genre": "EDM", "bpm": 128, "key": "", "scale": "", "mode": "",
         "time_sig": "4/4", "instruments": [], "vocal_tags": [], "lyrics": "[Chorus]\ndrop"}
    cap, lyr = build_prompt(s)
    assert "edm" in cap
    assert lyr == "[Chorus]\ndrop"

# ── prompt_linter ─────────────────────────────────────────────────────────────

def test_linter_brackets_in_tags():
    r = PromptLinter().lint("[Verse], ambient", "")
    assert any(res.severity == "error" and "racket" in res.message for res in r)

def test_linter_no_issues():
    r = PromptLinter().lint("ambient, slow, guitar, melodic, warm", "[Verse]\nhello\n[Chorus]\nyes")
    errors = [x for x in r if x.severity == "error"]
    assert not errors

def test_lint_result_fields():
    r = LintResult(severity="tip", field="tags", message="msg", suggestion="fix")
    assert r.severity == "tip"

from unittest.mock import patch, MagicMock
from core.comfyui import ComfyUIClient

def test_comfyui_ping_true():
    client = ComfyUIClient()
    with patch("requests.get") as mock_get:
        mock_get.return_value.raise_for_status = MagicMock()
        assert client.ping() is True

def test_comfyui_ping_false():
    client = ComfyUIClient()
    with patch("requests.get", side_effect=Exception("offline")):
        assert client.ping() is False

def test_build_workflow_missing_template():
    client = ComfyUIClient()
    import pathlib
    result = client.build_workflow("tags", "lyrics", {}, pathlib.Path("/nonexistent.json"))
    assert "error" in result

def test_get_queue_structure():
    client = ComfyUIClient()
    with patch("requests.get") as mock_get:
        mock_get.return_value.json.return_value = {"queue_running": [], "queue_pending": []}
        mock_get.return_value.raise_for_status = MagicMock()
        q = client.get_queue()
        assert "queue_running" in q
        assert "queue_pending" in q
