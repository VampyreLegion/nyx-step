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
