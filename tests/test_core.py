import pathlib
import pytest
import config

# These check the real ComfyUI/AceUser installation — only meaningful on Nyx.
nyx_only = pytest.mark.skipif(
    not config.WORKFLOW_TEMPLATE.parent.exists(),
    reason="requires Nyx-local ComfyUI/AceUser tree",
)

@nyx_only
def test_paths_exist():
    assert config.WORKFLOW_TEMPLATE.exists(), f"Missing: {config.WORKFLOW_TEMPLATE}"
    assert config.WORKFLOW_EXTRACT_TEMPLATE.exists(), f"Missing: {config.WORKFLOW_EXTRACT_TEMPLATE}"
    assert config.ACEUSER_HTML.exists(), f"Missing: {config.ACEUSER_HTML}"
    assert config.ACETALK_INSTRUMENTS.exists(), f"Missing: {config.ACETALK_INSTRUMENTS}"
    assert config.ACETALK_TEMPLATES.exists(), f"Missing: {config.ACETALK_TEMPLATES}"

@nyx_only
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

from core.job_tracker import JobTracker, JobInfo

def test_job_tracker_register_and_get():
    tracker = JobTracker.__new__(JobTracker)
    tracker._jobs = {}
    tracker._lock = __import__("threading").Lock()
    tracker.register("pid1", "user@a.com", "My Song")
    jobs = tracker.get_user_jobs("user@a.com")
    assert len(jobs) == 1
    assert jobs[0].prompt_id == "pid1"
    assert jobs[0].status == "queued"

def test_job_tracker_update_status():
    tracker = JobTracker.__new__(JobTracker)
    tracker._jobs = {}
    tracker._lock = __import__("threading").Lock()
    tracker.register("pid2", "user@a.com", "Song 2")
    tracker.update("pid2", status="running")
    assert tracker.get("pid2").status == "running"

def test_job_tracker_user_owns():
    tracker = JobTracker.__new__(JobTracker)
    tracker._jobs = {}
    tracker._lock = __import__("threading").Lock()
    tracker.register("pid3", "a@a.com", "Song")
    assert tracker.user_owns("a@a.com", "pid3") is True
    assert tracker.user_owns("b@b.com", "pid3") is False

from unittest.mock import patch, MagicMock
from core.ollama import list_models

def test_list_models_offline():
    with patch("requests.get", side_effect=Exception("offline")):
        models = list_models()
        assert isinstance(models, list)
        assert len(models) == 1
        assert "offline" in models[0].lower()

def test_list_models_success():
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"models": [{"name": "gemma4:latest"}]}
    mock_resp.raise_for_status = MagicMock()
    with patch("requests.get", return_value=mock_resp):
        models = list_models()
        assert "gemma4:latest" in models
