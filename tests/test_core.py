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

@nyx_only
def test_build_workflow_negative_tags():
    from core.comfyui import ComfyUIClient
    client = ComfyUIClient()
    state = {"negative_tags": "vocals, drums", "bpm": 120, "duration": 30}
    result = client.build_workflow("ambient pad", "", state)
    assert "error" not in result
    wf = result["workflow"]
    assert "neg_encode" in wf
    assert wf["neg_encode"]["inputs"]["tags"] == "vocals, drums"
    assert wf["neg_encode"]["inputs"]["lyrics"] == ""
    ks_id = next(k for k, v in wf.items() if v.get("class_type") == "KSampler")
    assert wf[ks_id]["inputs"]["negative"] == ["neg_encode", 0]


@nyx_only
def test_build_workflow_no_negative_tags_unchanged():
    from core.comfyui import ComfyUIClient
    client = ComfyUIClient()
    result = client.build_workflow("ambient pad", "", {"bpm": 120, "duration": 30})
    assert "error" not in result
    assert "neg_encode" not in result["workflow"]


def test_infer_tags_parses_json():
    from unittest.mock import patch, MagicMock
    from core.ollama import infer_tags
    fake = MagicMock()
    fake.json.return_value = {"response": '{"tags":"jazz, swing, piano trio","genre":"jazz","mood":"relaxed"}'}
    with patch("core.ollama._post_with_retry", return_value=fake):
        result = infer_tags({"bpm": 110, "key": "Bb", "scale": "Major", "chords": "Bb - Gm - Cm - F"})
    assert result["tags"].startswith("jazz")
    assert result["genre"] == "jazz"


def test_infer_tags_handles_garbage():
    from unittest.mock import patch, MagicMock
    from core.ollama import infer_tags
    fake = MagicMock()
    fake.json.return_value = {"response": "I think this is jazz music!"}
    with patch("core.ollama._post_with_retry", return_value=fake):
        result = infer_tags({"bpm": 110})
    assert "error" in result


# ── Vocal-mixdown post-processing routing ────────────────────────────────────

def test_needs_vocalize_flag():
    from core.job_tracker import JobTracker, JobInfo
    plain = JobInfo(prompt_id="a", user_email="u@x", song_name="S", params={"engine": "ace_step_complete"})
    vocal = JobInfo(prompt_id="b", user_email="u@x", song_name="S", params={"engine": "jam_vocals"})
    done_vocal = JobInfo(prompt_id="c", user_email="u@x", song_name="S",
                         params={"engine": "jam_vocals", "vocalized": True})
    assert JobTracker._needs_vocalize(vocal) is True
    assert JobTracker._needs_vocalize(plain) is False
    assert JobTracker._needs_vocalize(done_vocal) is False


def test_start_vocalize_marks_param_and_drops_from_active():
    from core.job_tracker import JobTracker
    from datetime import datetime
    tracker = JobTracker.__new__(JobTracker)
    tracker.register("vpid", "u@x", "Song", params={"engine": "jam_vocals", "jam_filename": "tmp.mp3"})
    tracker._start_vocalize("vpid", ["lego_00009.mp3"])
    job = tracker.get("vpid")
    assert job.status == "mixing"
    assert job.params.get("vocalized") is True
    assert job.output_files == ["lego_00009.mp3"]
    active = [j.prompt_id for j in tracker.get_all_jobs() if j.status in ("queued", "running")]
    assert "vpid" not in active


def test_postprocess_vocalize_missing_jam():
    from core import vocalmix
    try:
        vocalmix.postprocess_vocalize_job(
            params={"jam_filename": "nope-nowhere.mp3"},
            output_files=["lego_00009.mp3"],
        )
        assert False, "expected FileNotFoundError"
    except FileNotFoundError as exc:
        assert "nope-nowhere.mp3" in str(exc)


def test_postprocess_vocalize_no_output():
    from core import vocalmix
    # The jam must exist for the empty-output check to be reached.
    jam = vocalmix.JAM_DIR / "exists_tmp.mp3"
    jam.parent.mkdir(parents=True, exist_ok=True)
    jam.write_bytes(b"fake")
    try:
        try:
            vocalmix.postprocess_vocalize_job(
                params={"jam_filename": jam.name}, output_files=[]
            )
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "No lego output files" in str(exc)
    finally:
        jam.unlink(missing_ok=True)


@nyx_only
def test_build_lyric_song_workflow_is_reference_free():
    """Jam vocals must not use ReferenceTimbreAudio — cover mode drops the LLM
    audio codes and returns instrumental (no singer). The workflow must carry
    the lyrics through the audio-codes path instead."""
    import types
    from pathlib import Path
    from routes.jam import _build_lyric_song_workflow

    req = types.SimpleNamespace(
        duration=30.0, bpm=120, key="F#", scale="Major", steps=20, cfg=2.0,
        seed=0, audio_format="mp3", audio_quality="V0", dit_model="sft",
        sampler_name="er_sde", scheduler="linear_quadratic",
        temperature=0.85, top_p=0.9, top_k=0, min_p=0.0,
    )
    result = _build_lyric_song_workflow(
        req, "188 BPM, F# major, Am - C - F", "[Verse]\nhello", Path("/nonexistent_jam.mp3")
    )
    assert "error" not in result
    wf = result["workflow"]
    assert not any(
        isinstance(v, dict) and v.get("class_type") == "ReferenceTimbreAudio"
        for v in wf.values()
    )
    enc = next(
        v for v in wf.values()
        if isinstance(v, dict) and v.get("class_type") == "TextEncodeAceStepAudio1.5"
    )
    assert enc["inputs"]["lyrics"] == "[Verse]\nhello"
    assert enc["inputs"]["generate_audio_codes"] is True
    assert "lead vocals singing the lyrics" in enc["inputs"]["tags"]
    ks = next(v for v in wf.values() if isinstance(v, dict) and v.get("class_type") == "KSampler")
    assert ks["inputs"]["denoise"] == 1.0
