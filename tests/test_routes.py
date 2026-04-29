import json
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient
from nyx_step import app

client = TestClient(app, headers={"Cf-Access-Authenticated-User-Email": "test@test.com"})

def test_root_returns_html():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]

def test_queue_returns_json():
    resp = client.get("/queue")
    assert resp.status_code == 200
    data = resp.json()
    assert "my_jobs" in data
    assert "all_jobs" in data
    assert "comfyui" in data

def test_queue_structure():
    resp = client.get("/queue")
    assert resp.status_code == 200
    data = resp.json()
    assert "my_jobs" in data
    assert "comfyui" in data

def test_generate_missing_template():
    payload = {
        "tags": "ambient", "lyrics": "[Verse]\nhello",
        "bpm": 120, "steps": 8, "cfg_scale": 2.0, "duration": 30,
        "seed": 0, "lock_seed": False, "key": "C", "scale": "Major",
        "time_sig": "4/4", "temperature": 0.85, "top_p": 0.9,
        "top_k": 0, "min_p": 0.0, "song_name": "Test Song",
        "genre": "ambient", "mode": "", "instruments": [], "vocal_tags": []
    }
    with patch("core.comfyui.ComfyUIClient.build_workflow",
               return_value={"error": "No template"}):
        resp = client.post("/generate", json=payload)
        assert resp.status_code == 400

def test_download_unknown_file_returns_404():
    resp = client.get("/download/nonexistent_file.mp3")
    assert resp.status_code == 404

def test_guide_summary_returns_html():
    resp = client.get("/guide/summary")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]

def test_ollama_models_returns_list():
    from unittest.mock import patch
    with patch("core.ollama.list_models", return_value=["gemma4:latest"]):
        resp = client.get("/ollama/models")
        assert resp.status_code == 200
        assert "gemma4:latest" in resp.json()["models"]
