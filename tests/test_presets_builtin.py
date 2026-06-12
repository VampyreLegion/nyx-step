import json
import pathlib

import config

BUILTIN = pathlib.Path(config._NYX_STEP) / "presets_builtin"


def test_builtin_presets_exist():
    files = list(BUILTIN.glob("*.nyx"))
    assert len(files) >= 16


def test_builtin_presets_valid():
    for p in BUILTIN.glob("*.nyx"):
        d = json.loads(p.read_text())
        assert d["_version"] == 1
        assert d["tags"], f"{p.name} missing tags"
        assert 40 <= d["bpm"] <= 300
        assert d["steps"] >= 1 and d["duration"] >= 30


def test_list_includes_builtin(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    names = client.get("/presets").json()["presets"]
    assert "Golden - Lo-Fi Study" in names


def test_load_builtin(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    d = client.get("/presets/Golden - Lo-Fi Study").json()
    assert d["tags"]


def test_delete_builtin_refused(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    resp = client.delete("/presets/Golden - Lo-Fi Study")
    assert resp.status_code == 403


def test_user_preset_shadows_builtin(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    (tmp_path / "Golden - Lo-Fi Study.nyx").write_text('{"_version": 1, "tags": "custom", "bpm": 100}')
    client = TestClient(app)
    names = client.get("/presets").json()["presets"]
    assert names.count("Golden - Lo-Fi Study") == 1
    d = client.get("/presets/Golden - Lo-Fi Study").json()
    assert d["tags"] == "custom"  # user preset wins


def test_delete_unknown_preset_404(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    assert client.delete("/presets/does-not-exist").status_code == 404
