import json
import core.db as db


def test_create_and_get_project():
    pid = db.create_daw_project("u@a.com", "Proj1")
    assert isinstance(pid, int)
    p = db.get_daw_project("u@a.com", pid)
    assert p["name"] == "Proj1"
    assert p["data"] == {"version": 1, "tempo": 120, "tracks": []}


def test_list_projects_sorted():
    db.create_daw_project("list@a.com", "old")
    newer = db.create_daw_project("list@a.com", "new")
    rows = db.list_daw_projects("list@a.com")
    assert [r["name"] for r in rows][:1] == ["new"]   # updated_at desc
    assert all(set(r.keys()) == {"id", "name", "updated_at"} for r in rows)
    assert rows[0]["id"] == newer


def test_update_project_data_and_name():
    pid = db.create_daw_project("u2@a.com", "P")
    data = {"version": 1, "tempo": 90, "tracks": [{"id": "t1", "name": "Drums",
            "mute": False, "solo": False, "color": "#fff", "clips": []}]}
    db.update_daw_project("u2@a.com", pid, name="Renamed", data=data)
    p = db.get_daw_project("u2@a.com", pid)
    assert p["name"] == "Renamed"
    assert p["data"]["tempo"] == 90
    assert p["data"]["tracks"][0]["name"] == "Drums"


def test_ownership_isolation():
    pid = db.create_daw_project("owner@a.com", "Secret")
    assert db.get_daw_project("intruder@a.com", pid) is None
    assert db.update_daw_project("intruder@a.com", pid, name="hax", data={}) is False
    assert db.delete_daw_project("intruder@a.com", pid) is False
    assert db.get_daw_project("owner@a.com", pid) is not None  # untouched


def test_delete_project():
    pid = db.create_daw_project("del@a.com", "Bye")
    assert db.delete_daw_project("del@a.com", pid) is True
    assert db.get_daw_project("del@a.com", pid) is None


import nyx_step  # noqa: E402  (ensures app + routers import)
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(nyx_step.app)  # requests resolve to dev@local


def test_route_create_list_get_update_delete():
    r = client.post("/daw/projects", json={"name": "RouteProj"})
    assert r.status_code == 200
    pid = r.json()["id"]

    names = [p["name"] for p in client.get("/daw/projects").json()["projects"]]
    assert "RouteProj" in names

    got = client.get(f"/daw/projects/{pid}").json()
    assert got["name"] == "RouteProj"
    assert got["data"]["tracks"] == []

    data = {"version": 1, "tempo": 100, "tracks": []}
    r = client.put(f"/daw/projects/{pid}", json={"name": "Renamed", "data": data})
    assert r.status_code == 200
    assert client.get(f"/daw/projects/{pid}").json()["name"] == "Renamed"

    assert client.delete(f"/daw/projects/{pid}").status_code == 200
    assert client.get(f"/daw/projects/{pid}").status_code == 404


def test_route_get_missing_404():
    assert client.get("/daw/projects/999999").status_code == 404


def test_route_update_rejects_non_dict_data():
    pid = client.post("/daw/projects", json={"name": "P"}).json()["id"]
    r = client.put(f"/daw/projects/{pid}", json={"data": "not-an-object"})
    # nyx_step.py has a custom RequestValidationError handler that returns 400
    assert r.status_code == 400


def test_library_lists_owned_clips_and_stems(tmp_path, monkeypatch):
    import config, pathlib
    out = tmp_path / "audio"
    (out / "separated" / "htdemucs" / "MySong").mkdir(parents=True)
    (out / "MySong.mp3").write_bytes(b"ID3")
    for stem in ("vocals", "drums", "bass", "other"):
        (out / "separated" / "htdemucs" / "MySong" / f"{stem}.wav").write_bytes(b"RIFF")
    monkeypatch.setattr(config, "COMFYUI_OUTPUT_DIR", out)
    monkeypatch.setattr(config, "DEMUCS_OUTPUT_DIR", out / "separated")

    db.upsert_job("jobX", "dev@local", "MySong")
    db.update_job("jobX", status="done", output_files=["MySong.mp3"])

    lib = client.get("/daw/library").json()
    clip_files = [c["file"] for c in lib["clips"]]
    assert "MySong.mp3" in clip_files
    stem_files = [s["file"] for s in lib["stems"]]
    assert "separated/htdemucs/MySong/vocals.wav" in stem_files
    assert {s["stem_type"] for s in lib["stems"]} == {"vocals", "drums", "bass", "other"}


def test_audio_serves_clip_and_stem_blocks_others(tmp_path, monkeypatch):
    import config
    out = tmp_path / "audio2"
    (out / "separated" / "htdemucs" / "Song2").mkdir(parents=True)
    (out / "Song2.mp3").write_bytes(b"ID3DATA")
    (out / "separated" / "htdemucs" / "Song2" / "bass.wav").write_bytes(b"RIFFDATA")
    (out / "NotMine.mp3").write_bytes(b"NOPE")
    monkeypatch.setattr(config, "COMFYUI_OUTPUT_DIR", out)
    monkeypatch.setattr(config, "DEMUCS_OUTPUT_DIR", out / "separated")

    db.upsert_job("jobY", "dev@local", "Song2")
    db.update_job("jobY", status="done", output_files=["Song2.mp3"])

    assert client.get("/daw/audio/Song2.mp3").status_code == 200
    assert client.get("/daw/audio/separated/htdemucs/Song2/bass.wav").status_code == 200
    assert client.get("/daw/audio/NotMine.mp3").status_code == 404
    assert client.get("/daw/audio/../../etc/passwd").status_code == 404


def test_project_persists_mixer_fields():
    pid = client.post("/daw/projects", json={"name": "MixProj"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 0.6,
            "tracks": [{"id": "t1", "name": "V", "mute": False, "solo": False,
                        "color": "#fff", "volume": 0.5, "pan": -0.3, "clips": []}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    got = client.get(f"/daw/projects/{pid}").json()["data"]
    assert got["master_volume"] == 0.6
    assert got["tracks"][0]["volume"] == 0.5
    assert got["tracks"][0]["pan"] == -0.3


def test_project_persists_clip_wave_fields():
    pid = client.post("/daw/projects", json={"name": "WaveProj"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 1.0,
            "tracks": [{"id": "t1", "name": "V", "mute": False, "solo": False, "color": "#fff",
                        "volume": 1.0, "pan": 0.0,
                        "clips": [{"id": "c1", "file": "x.mp3", "name": "x", "start": 0, "offset": 0,
                                   "duration": 10, "source_duration": 10,
                                   "gain": 0.5, "fade_in": 1.5, "fade_out": 2.0}]}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    c = client.get(f"/daw/projects/{pid}").json()["data"]["tracks"][0]["clips"][0]
    assert c["gain"] == 0.5 and c["fade_in"] == 1.5 and c["fade_out"] == 2.0


def test_daw_job_status_endpoint():
    nyx_step.tracker.register("dawjob1", "dev@local", "gen")
    nyx_step.tracker.update("dawjob1", status="done", output_files=["g.mp3"])
    r = client.get("/daw/job/dawjob1")
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "done"
    assert d["files"] == ["g.mp3"]

    assert client.get("/daw/job/nope-xyz").status_code == 404

    nyx_step.tracker.register("dawjob2", "other@x.com", "gen")
    assert client.get("/daw/job/dawjob2").status_code == 404


def test_project_persists_fx_and_session():
    pid = client.post("/daw/projects", json={"name": "P6"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 1.0, "scenes": 4,
            "tracks": [{"id": "t1", "name": "V", "mute": False, "solo": False, "color": "#fff",
                        "volume": 1.0, "pan": 0.0,
                        "fx": {"eq": {"on": True, "low": 3, "mid": -2, "high": 5},
                               "reverb": {"on": True, "wet": 0.4},
                               "delay": {"on": False, "time": 0.3, "feedback": 0.3, "wet": 0.3}},
                        "cells": [{"file": "a.mp3", "name": "a"}, None, None, None],
                        "clips": []}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    d = client.get(f"/daw/projects/{pid}").json()["data"]
    assert d["scenes"] == 4
    t = d["tracks"][0]
    assert t["fx"]["eq"]["on"] is True and t["fx"]["eq"]["low"] == 3
    assert t["fx"]["reverb"]["wet"] == 0.4
    assert t["cells"][0]["file"] == "a.mp3" and t["cells"][1] is None
