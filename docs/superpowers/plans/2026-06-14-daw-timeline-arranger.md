# DAW Phase 1 — Timeline Arranger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 🎚 DAW tab to Nyx-Step where a user drags their generated clips and Demucs stems onto multi-track lanes, arranges/trims them on a free-form timeline, plays the arrangement back in sync (Web Audio) with mute/solo, and has the project autosave to SQLite and reload intact.

**Architecture:** Client-side Web Audio engine for all playback/mixing/scheduling; FastAPI backend stores per-user projects in a new `daw_projects` SQLite table and serves audio via an ownership-aware `/daw/audio` route (the existing `/download` can't serve stems). Frontend is split into focused vanilla-JS modules following the app's existing convention.

**Tech Stack:** FastAPI, SQLite (WAL), vanilla JS (no build step), Web Audio API, Canvas 2D, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-14-daw-timeline-arranger-design.md`

**Conventions:**
- Work from `/home/legion/legionprojects/nyx-step` on `master` (live service deploys from this tree).
- Tests: `python3 -m pytest tests/ -q` (system python, NO venv). Current baseline: 75 passing.
- After backend changes: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo).
- After JS/HTML changes: bump the `?v=N` cache-bust on that file's `<script>` tag in `templates/index.html`.
- `tests/conftest.py` already redirects the DB to a temp file, so route/DB tests are isolated.
- TestClient requests resolve to user `dev@local` (host `testclient` is not a trusted proxy); to test as a specific user pass header `Cf-Access-Authenticated-User-Email`. **Note:** that header is only honored from trusted proxies; for tests that need two distinct users, the simplest path is to call the `core/db.py` functions directly (they take `user_email`), and use TestClient only for `dev@local` flows. Plan tasks below follow this.
- Commit after each task. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `core/db.py` | Modify | `daw_projects` table + CRUD functions |
| `routes/download.py` | Modify | export `safe_output_path` (rename `_safe_output_path`, keep alias) for reuse |
| `routes/daw.py` | Create | `/daw` API: project CRUD, `/daw/library`, `/daw/audio` |
| `nyx_step.py` | Modify | register the daw router |
| `tests/test_daw.py` | Create | backend tests (DB CRUD, routes, ownership, library, audio) |
| `templates/index.html` | Modify | DAW tab button + panel markup + script tags |
| `static/daw-project.js` | Create | in-memory project state, mutations, autosave, API calls |
| `static/daw-library.js` | Create | clip-library panel + drag sources |
| `static/daw-engine.js` | Create | AudioContext, buffer cache, scheduling, transport, playhead |
| `static/daw-timeline.js` | Create | render ruler/lanes/clips, drag/trim/select, playhead, zoom |
| `static/daw.js` | Create | tab-open hook, transport glue, autosave indicator |
| `static/tabs.js` | Modify | call `onDawTabOpen()` when the DAW tab opens |

---

### Task 1: `daw_projects` table + DB CRUD

**Files:**
- Modify: `core/db.py`
- Test: `tests/test_daw.py` (create)

- [ ] **Step 1: Write failing tests**

Create `tests/test_daw.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_daw.py -q`
Expected: FAIL — `module 'core.db' has no attribute 'create_daw_project'`.

- [ ] **Step 3: Add the table to `init_db`**

In `core/db.py`, inside `init_db`'s `conn.executescript("""...""")`, add this table after the `history` table's indexes (before the closing `""")`):

```python
            CREATE TABLE IF NOT EXISTS daw_projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT 'Untitled Project',
                data        TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_daw_user ON daw_projects(user_email);
```

- [ ] **Step 4: Add CRUD functions**

Append to the end of `core/db.py`:

```python
# ── DAW projects ────────────────────────────────────────────────────────────

_DAW_EMPTY = {"version": 1, "tempo": 120, "tracks": []}


def create_daw_project(user_email: str, name: str) -> int:
    now = utcnow().isoformat()
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO daw_projects (user_email, name, data, created_at, updated_at) "
            "VALUES (?,?,?,?,?)",
            (user_email, name, json.dumps(_DAW_EMPTY), now, now),
        )
        return int(cur.lastrowid)


def list_daw_projects(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at FROM daw_projects WHERE user_email=? "
            "ORDER BY updated_at DESC", (user_email,),
        ).fetchall()
    return [{"id": r["id"], "name": r["name"], "updated_at": r["updated_at"]} for r in rows]


def get_daw_project(user_email: str, project_id: int) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM daw_projects WHERE id=? AND user_email=?",
            (project_id, user_email),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["data"] = json.loads(d["data"])
    return d


def update_daw_project(user_email: str, project_id: int, name: str | None = None,
                       data: dict | None = None) -> bool:
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if data is not None:
        sets.append("data=?"); vals.append(json.dumps(data))
    sets.append("updated_at=?"); vals.append(utcnow().isoformat())
    vals.extend([project_id, user_email])
    with _get_conn() as conn:
        cur = conn.execute(
            f"UPDATE daw_projects SET {', '.join(sets)} WHERE id=? AND user_email=?", vals,
        )
        return cur.rowcount > 0


def delete_daw_project(user_email: str, project_id: int) -> bool:
    with _get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM daw_projects WHERE id=? AND user_email=?", (project_id, user_email),
        )
        return cur.rowcount > 0
```

Note: `utcnow()` and `json` are already defined/imported at the top of `core/db.py`.

- [ ] **Step 5: Run tests to verify pass**

Run: `python3 -m pytest tests/test_daw.py -q`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add core/db.py tests/test_daw.py
git commit -m "feat(daw): daw_projects table + per-user CRUD

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Export `safe_output_path` for reuse

**Files:**
- Modify: `routes/download.py`

The DAW audio route needs the same traversal guard. Promote the private helper to a public name without breaking existing callers.

- [ ] **Step 1: Rename with a back-compat alias**

In `routes/download.py`, change the definition:

```python
def safe_output_path(filename: str) -> Path | None:
    """Resolve filename inside COMFYUI_OUTPUT_DIR, rejecting traversal outside it."""
    base = config.COMFYUI_OUTPUT_DIR.resolve()
    resolved = (base / filename).resolve()
    return resolved if resolved.is_relative_to(base) else None


# Backwards-compatible alias (existing internal callers)
_safe_output_path = safe_output_path
```

(The two existing internal references `_safe_output_path(...)` keep working via the alias.)

- [ ] **Step 2: Verify nothing broke**

Run: `python3 -m pytest tests/ -q`
Expected: 80 passed (75 baseline + 5 from Task 1).

- [ ] **Step 3: Commit**

```bash
git add routes/download.py
git commit -m "refactor(download): expose safe_output_path for reuse by DAW

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `/daw` project CRUD routes

**Files:**
- Create: `routes/daw.py`
- Modify: `nyx_step.py` (register router)
- Test: `tests/test_daw.py` (extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/test_daw.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_daw.py -q -k route`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Create `routes/daw.py` (CRUD portion)**

Create `routes/daw.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/daw")


class _CreateProject(BaseModel):
    name: str = "Untitled Project"


class _UpdateProject(BaseModel):
    name: str | None = None
    data: dict | None = None


@router.get("/projects")
async def list_projects(request: Request):
    user = get_user_email(request)
    return {"projects": db.list_daw_projects(user)}


@router.post("/projects")
async def create_project(req: _CreateProject, request: Request):
    user = get_user_email(request)
    pid = db.create_daw_project(user, req.name.strip() or "Untitled Project")
    return {"id": pid, "name": req.name.strip() or "Untitled Project"}


@router.get("/projects/{project_id}")
async def get_project(project_id: int, request: Request):
    user = get_user_email(request)
    p = db.get_daw_project(user, project_id)
    if p is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    p.pop("user_email", None)
    return p


@router.put("/projects/{project_id}")
async def update_project(project_id: int, req: _UpdateProject, request: Request):
    user = get_user_email(request)
    if req.name is None and req.data is None:
        return JSONResponse({"error": "Nothing to update"}, status_code=400)
    ok = db.update_daw_project(user, project_id, name=req.name, data=req.data)
    if not ok:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"saved": project_id}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, request: Request):
    user = get_user_email(request)
    if not db.delete_daw_project(user, project_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": project_id}
```

- [ ] **Step 4: Register the router**

In `nyx_step.py`, add the import alongside the other route imports (after `from routes.video import router as video_router`):

```python
from routes.daw import router as daw_router
```

And register it after `app.include_router(video_router)`:

```python
app.include_router(daw_router)
```

- [ ] **Step 5: Run tests to verify pass**

Run: `python3 -m pytest tests/test_daw.py -q`
Expected: all pass (Task 1 + Task 3 tests).

- [ ] **Step 6: Commit**

```bash
git add routes/daw.py nyx_step.py tests/test_daw.py
git commit -m "feat(daw): project CRUD API (/daw/projects)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `/daw/library` — list clips + stems

**Files:**
- Modify: `routes/daw.py`
- Test: `tests/test_daw.py` (extend)

- [ ] **Step 1: Write failing test**

Append to `tests/test_daw.py`:

```python
def test_library_lists_owned_clips_and_stems(tmp_path, monkeypatch):
    import config, pathlib
    # Point output dir at a temp tree with a clip and a stem set
    out = tmp_path / "audio"
    (out / "separated" / "htdemucs" / "MySong").mkdir(parents=True)
    (out / "MySong.mp3").write_bytes(b"ID3")
    for stem in ("vocals", "drums", "bass", "other"):
        (out / "separated" / "htdemucs" / "MySong" / f"{stem}.wav").write_bytes(b"RIFF")
    monkeypatch.setattr(config, "COMFYUI_OUTPUT_DIR", out)
    monkeypatch.setattr(config, "DEMUCS_OUTPUT_DIR", out / "separated")

    # dev@local owns MySong.mp3 via a done job
    db.upsert_job("jobX", "dev@local", "MySong")
    db.update_job("jobX", status="done", output_files=["MySong.mp3"])

    lib = client.get("/daw/library").json()
    clip_files = [c["file"] for c in lib["clips"]]
    assert "MySong.mp3" in clip_files
    stem_files = [s["file"] for s in lib["stems"]]
    assert "separated/htdemucs/MySong/vocals.wav" in stem_files
    assert {s["stem_type"] for s in lib["stems"]} == {"vocals", "drums", "bass", "other"}
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_daw.py -q -k library`
Expected: FAIL — 404 (no `/daw/library`).

- [ ] **Step 3: Implement `/daw/library`**

Add to `routes/daw.py` (imports at top: add `import config`):

```python
import config

_STEM_TYPES = {"vocals", "drums", "bass", "other"}


@router.get("/library")
async def library(request: Request):
    user = get_user_email(request)

    # Generated clips: this user's done jobs, one entry per output file.
    clips = []
    for job in db.get_user_jobs(user):
        if job.get("status") != "done":
            continue
        params = job.get("params", {}) or {}
        for f in job.get("output_files", []):
            clips.append({
                "file": f,
                "name": job.get("song_name") or f,
                "duration": params.get("duration"),
            })

    # The set of song stems this user owns: a stem folder name matches one of the
    # user's output-file stems (filename without extension).
    owned_song_names = set()
    for c in clips:
        owned_song_names.add(c["file"].rsplit(".", 1)[0])

    stems = []
    sep = config.DEMUCS_OUTPUT_DIR
    if sep.exists():
        for model_dir in sep.iterdir():
            if not model_dir.is_dir():
                continue
            for song_dir in model_dir.iterdir():
                if not song_dir.is_dir() or song_dir.name not in owned_song_names:
                    continue
                for stem_file in song_dir.glob("*.*"):
                    stem_type = stem_file.stem.lower()
                    if stem_type not in _STEM_TYPES:
                        continue
                    rel = stem_file.relative_to(config.COMFYUI_OUTPUT_DIR).as_posix()
                    stems.append({
                        "file": rel,
                        "name": f"{song_dir.name} — {stem_type}",
                        "stem_type": stem_type,
                    })

    return {"clips": clips, "stems": stems}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `python3 -m pytest tests/test_daw.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add routes/daw.py tests/test_daw.py
git commit -m "feat(daw): /daw/library lists owned clips and stems

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `/daw/audio/{file:path}` — ownership-aware fetch

**Files:**
- Modify: `routes/daw.py`
- Test: `tests/test_daw.py` (extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/test_daw.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_daw.py -q -k audio`
Expected: FAIL — 404 on the clip (route missing).

- [ ] **Step 3: Implement `/daw/audio`**

Add to `routes/daw.py` (imports at top: add `from fastapi.responses import FileResponse` and `from routes.download import safe_output_path`):

```python
from fastapi.responses import FileResponse
from routes.download import safe_output_path


def _user_owns_daw_file(user: str, filename: str) -> bool:
    # Generated clip the user owns?
    if db.user_owns_file(user, filename):
        return True
    # Stem whose parent-song folder matches a song the user owns?
    parts = filename.split("/")
    if len(parts) >= 4 and parts[0] == "separated":
        song_folder = parts[-2]
        for job in db.get_user_jobs(user):
            for f in job.get("output_files", []):
                if f.rsplit(".", 1)[0] == song_folder:
                    return True
    return False


@router.get("/audio/{file:path}")
async def audio(file: str, request: Request):
    user = get_user_email(request)
    if not _user_owns_daw_file(user, file):
        return JSONResponse({"error": "Not found or access denied"}, status_code=404)
    path = safe_output_path(file)
    if path is None or not path.exists():
        return JSONResponse({"error": "File not on disk"}, status_code=404)
    ext = path.suffix.lower().lstrip(".")
    media = {"mp3": "audio/mpeg", "flac": "audio/flac", "wav": "audio/wav",
             "opus": "audio/ogg", "ogg": "audio/ogg"}.get(ext, "application/octet-stream")
    return FileResponse(str(path), media_type=media)
```

- [ ] **Step 4: Run full suite**

Run: `python3 -m pytest tests/ -q`
Expected: all pass (baseline 75 + DAW tests).

- [ ] **Step 5: Restart + live smoke**

```bash
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s -H "Cf-Access-Authenticated-User-Email: steve.j.petry@gmail.com" http://127.0.0.1:8001/daw/library | python3 -m json.tool | head -20
```
Expected: health 3.10.0; library returns JSON with `clips`/`stems` keys.

- [ ] **Step 6: Commit**

```bash
git add routes/daw.py tests/test_daw.py
git commit -m "feat(daw): /daw/audio ownership-aware fetch for clips and stems

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: DAW tab markup + script tags

**Files:**
- Modify: `templates/index.html`

- [ ] **Step 1: Add the tab button**

In `templates/index.html`, the tab bar has buttons like `<button class="tab-btn" data-tab="about" ...>About</button>` (around line 38). Add a DAW button right after the `video` tab button (search `data-tab="video"` in the tab bar near the top, ~line 27-38):

```html
  <button class="tab-btn" data-tab="daw" title="DAW — multi-track timeline arranger for your clips and stems">🎚 DAW</button>
```

- [ ] **Step 2: Add the tab panel**

Add a new panel near the other `<div class="tab-panel" id="tab-...">` blocks (e.g. after the `tab-about` panel's closing `</div>`). Use this exact skeleton:

```html
  <!-- DAW -->
  <div class="tab-panel" id="tab-daw">
    <div id="daw-root">
      <!-- transport bar -->
      <div id="daw-transport" style="display:flex;align-items:center;gap:10px;padding:6px 8px;background:#15171f;border:1px solid #2d3041;border-radius:6px;flex-wrap:wrap">
        <select id="daw-project-select" style="font-size:12px;min-width:140px"></select>
        <button class="secondary small" id="daw-new">+ New</button>
        <button class="secondary small" id="daw-rename">✎ Rename</button>
        <button class="secondary small" id="daw-delete">🗑</button>
        <span style="width:1px;height:18px;background:#2d3041"></span>
        <button class="secondary small" id="daw-play">▶</button>
        <button class="secondary small" id="daw-pause">⏸</button>
        <button class="secondary small" id="daw-stop">⏹</button>
        <button class="secondary small" id="daw-loop" title="Loop arrangement">↻</button>
        <span id="daw-time" style="font-family:monospace;font-size:12px;color:var(--muted)">0:00 / 0:00</span>
        <span style="width:1px;height:18px;background:#2d3041"></span>
        <button class="secondary small" id="daw-zoom-out">🔍−</button>
        <button class="secondary small" id="daw-zoom-in">🔍+</button>
        <span id="daw-save-status" style="font-size:11px;color:var(--muted);margin-left:auto">—</span>
      </div>

      <!-- arranger: track headers + timeline -->
      <div id="daw-arranger" style="display:flex;border:1px solid #2d3041;border-top:none;height:420px;overflow:hidden">
        <div id="daw-track-headers" style="width:150px;flex:0 0 150px;background:#101218;overflow-y:auto;border-right:1px solid #2d3041">
          <div id="daw-tracks-head"></div>
          <button class="secondary small" id="daw-add-track" style="margin:6px;width:calc(100% - 12px)">+ Add Track</button>
        </div>
        <div id="daw-timeline-scroll" style="flex:1;overflow:auto;position:relative;background:#0b0c10">
          <canvas id="daw-ruler" height="22" style="display:block;position:sticky;top:0;z-index:2;background:#15171f"></canvas>
          <div id="daw-lanes" style="position:relative"></div>
          <div id="daw-playhead" style="position:absolute;top:0;width:2px;background:#00d4b6;pointer-events:none;z-index:3;display:none"></div>
        </div>
      </div>

      <!-- clip library -->
      <div id="daw-library" style="border:1px solid #2d3041;border-top:none;border-radius:0 0 6px 6px;padding:6px 8px;max-height:140px;overflow-y:auto">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <strong style="font-size:12px;color:var(--accent2)">📚 Clip Library</strong>
          <input id="daw-lib-search" placeholder="search…" style="font-size:11px;flex:1;max-width:200px">
          <button class="secondary small" id="daw-lib-refresh">↻</button>
        </div>
        <div id="daw-lib-list" style="display:flex;flex-wrap:wrap;gap:6px"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add script tags**

In `templates/index.html`, near the other `<script src="/static/...">` tags (~line 2014-2040), add these **before** `init.js` (order matters — daw.js uses the others):

```html
<script src="/static/daw-project.js?v=1"></script>
<script src="/static/daw-engine.js?v=1"></script>
<script src="/static/daw-library.js?v=1"></script>
<script src="/static/daw-timeline.js?v=1"></script>
<script src="/static/daw.js?v=1"></script>
```

- [ ] **Step 4: Verify markup loads (no JS yet)**

```bash
sudo systemctl restart nyx-step && sleep 2
curl -s http://127.0.0.1:8001/ | grep -c 'data-tab="daw"'
```
Expected: `1`. (The tab will be empty/non-functional until the JS tasks land — that's fine.)

- [ ] **Step 5: Commit**

```bash
git add templates/index.html
git commit -m "feat(daw): DAW tab markup, transport, arranger, library skeleton

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `daw-project.js` — state model, mutations, autosave

**Files:**
- Create: `static/daw-project.js`

This module owns `dawState` (the current arrangement) and all mutations. After any mutation it calls two globals that later tasks define: `renderTimeline()` (Task 10) and `dawMarkDirty()` (debounced autosave, defined here). For Task 7 it is acceptable that `renderTimeline` may not yet exist — guard the calls with `typeof`.

- [ ] **Step 1: Create the module**

Create `static/daw-project.js`:

```javascript
// ── DAW project state + persistence ───────────────────────────────────────────
// dawState is the in-memory current arrangement. Mutations update it, trigger a
// re-render, and schedule a debounced autosave.
let dawState = { id: null, name: "Untitled Project", tempo: 120, tracks: [] };

const _TRACK_COLORS = ["#7c65d9", "#00d4b6", "#e0884f", "#4caf50", "#e05f8a", "#3f9fe0", "#c9a227"];
let _dawSaveTimer = null;

function _dawUid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }

function _dawAfterMutate() {
  if (typeof renderTimeline === "function") renderTimeline();
  dawMarkDirty();
}

function _dawSetSaveStatus(text) {
  const el = document.getElementById("daw-save-status");
  if (el) el.textContent = text;
}

// ── Persistence (API) ──────────────────────────────────────────────────────────
async function dawListProjects() {
  return (await fetch("/daw/projects").then(r => r.json())).projects || [];
}

async function dawNewProject(name) {
  const r = await fetch("/daw/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || "Untitled Project" }),
  }).then(r => r.json());
  dawState = { id: r.id, name: r.name, tempo: 120, tracks: [] };
  dawAddTrack("Track 1");        // start with one empty track
  return r.id;
}

async function dawLoadProject(id) {
  const p = await fetch("/daw/projects/" + id).then(r => r.json());
  if (p.error) return false;
  dawState = { id: p.id, name: p.name, ...p.data };
  dawState.tracks = dawState.tracks || [];
  if (typeof renderTimeline === "function") renderTimeline();
  _dawSetSaveStatus("✓ saved");
  return true;
}

async function dawDeleteProject(id) {
  await fetch("/daw/projects/" + id, { method: "DELETE" });
}

function dawMarkDirty() {
  _dawSetSaveStatus("saving…");
  clearTimeout(_dawSaveTimer);
  _dawSaveTimer = setTimeout(dawSaveNow, 800);   // debounce
}

async function dawSaveNow() {
  if (dawState.id == null) return;
  const data = { version: 1, tempo: dawState.tempo, tracks: dawState.tracks };
  try {
    const r = await fetch("/daw/projects/" + dawState.id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: dawState.name, data }),
    });
    _dawSetSaveStatus(r.ok ? "✓ saved" : "save failed");
  } catch (_) { _dawSetSaveStatus("save failed"); }
}

// ── Track mutations ─────────────────────────────────────────────────────────────
function dawAddTrack(name) {
  const i = dawState.tracks.length;
  dawState.tracks.push({
    id: _dawUid("t"), name: name || ("Track " + (i + 1)),
    mute: false, solo: false, color: _TRACK_COLORS[i % _TRACK_COLORS.length], clips: [],
  });
  _dawAfterMutate();
}

function dawRemoveTrack(trackId) {
  dawState.tracks = dawState.tracks.filter(t => t.id !== trackId);
  _dawAfterMutate();
}

function dawRenameTrack(trackId, name) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (t) { t.name = name; _dawAfterMutate(); }
}

function dawToggleMute(trackId) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (t) { t.mute = !t.mute; _dawAfterMutate(); }
}

function dawToggleSolo(trackId) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (t) { t.solo = !t.solo; _dawAfterMutate(); }
}

// ── Clip mutations ──────────────────────────────────────────────────────────────
function _dawFindClip(clipId) {
  for (const t of dawState.tracks) {
    const c = t.clips.find(c => c.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}

function dawAddClip(trackId, src, start) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return null;
  const dur = src.source_duration || src.duration || 0;
  const clip = {
    id: _dawUid("c"), file: src.file, name: src.name || src.file,
    start: Math.max(0, start || 0), offset: 0,
    duration: dur, source_duration: dur,
  };
  t.clips.push(clip);
  _dawAfterMutate();
  return clip;
}

function dawMoveClip(clipId, newTrackId, newStart) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const { track, clip } = found;
  clip.start = Math.max(0, newStart);
  if (newTrackId && newTrackId !== track.id) {
    track.clips = track.clips.filter(c => c.id !== clipId);
    const dest = dawState.tracks.find(t => t.id === newTrackId);
    if (dest) dest.clips.push(clip);
  }
  _dawAfterMutate();
}

function dawTrimClip(clipId, offset, duration) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  const sd = c.source_duration || duration;
  c.offset = Math.min(Math.max(0, offset), sd);
  c.duration = Math.min(Math.max(0.05, duration), sd - c.offset);
  _dawAfterMutate();
}

function dawDeleteClip(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  found.track.clips = found.track.clips.filter(c => c.id !== clipId);
  _dawAfterMutate();
}

function dawDuplicateClip(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  found.track.clips.push({ ...c, id: _dawUid("c"), start: c.start + c.duration });
  _dawAfterMutate();
}

function dawArrangementLength() {
  let max = 0;
  for (const t of dawState.tracks)
    for (const c of t.clips) max = Math.max(max, c.start + c.duration);
  return max;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/daw-project.js`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add static/daw-project.js
git commit -m "feat(daw): project state model, mutations, debounced autosave

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `daw-engine.js` — Web Audio playback engine

**Files:**
- Create: `static/daw-engine.js`

Reads the global `dawState`. Exposes transport functions and a `dawEnginePlayhead` value the timeline polls. Calls `dawOnPlayhead(t)` (defined in Task 10/11) each frame if present.

- [ ] **Step 1: Create the module**

Create `static/daw-engine.js`:

```javascript
// ── DAW Web Audio engine ──────────────────────────────────────────────────────
let _dawCtx = null;
const _dawBufferCache = new Map();     // file → AudioBuffer (or "error")
let _dawMaster = null;
let _dawActiveSources = [];
let _dawIsPlaying = false;
let _dawPlayhead = 0;                   // seconds
let _dawStartCtxTime = 0;              // ctx.currentTime when playback began
let _dawStartPlayhead = 0;            // playhead when playback began
let _dawRaf = null;
let _dawLoop = false;
const _DAW_LOOKAHEAD = 0.08;

function _dawEnsureCtx() {
  if (!_dawCtx) {
    _dawCtx = new (window.AudioContext || window.webkitAudioContext)();
    _dawMaster = _dawCtx.createGain();
    _dawMaster.gain.value = 1.0;
    _dawMaster.connect(_dawCtx.destination);
  }
  return _dawCtx;
}

async function dawGetBuffer(file) {
  if (_dawBufferCache.has(file)) {
    const v = _dawBufferCache.get(file);
    return v === "error" ? null : v;
  }
  try {
    const ctx = _dawEnsureCtx();
    const ab = await fetch("/daw/audio/" + encodeURI(file)).then(r => {
      if (!r.ok) throw new Error("fetch " + r.status);
      return r.arrayBuffer();
    });
    const buf = await ctx.decodeAudioData(ab);
    _dawBufferCache.set(file, buf);
    return buf;
  } catch (e) {
    _dawBufferCache.set(file, "error");
    return null;
  }
}

function _dawAudibleTracks() {
  const soloed = dawState.tracks.filter(t => t.solo);
  const active = soloed.length ? soloed : dawState.tracks.filter(t => !t.mute);
  return new Set(active.map(t => t.id));
}

function _dawScheduleAll() {
  const ctx = _dawEnsureCtx();
  _dawStartCtxTime = ctx.currentTime + _DAW_LOOKAHEAD;
  _dawStartPlayhead = _dawPlayhead;
  const audible = _dawAudibleTracks();
  for (const track of dawState.tracks) {
    if (!audible.has(track.id)) continue;
    for (const clip of track.clips) {
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= _dawPlayhead) continue;          // already past
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;          // not loaded / errored
      let when, bufOffset, playDur;
      if (clip.start >= _dawPlayhead) {
        when = _dawStartCtxTime + (clip.start - _dawPlayhead);
        bufOffset = clip.offset;
        playDur = clip.duration;
      } else {                                         // straddles playhead
        const into = _dawPlayhead - clip.start;
        when = _dawStartCtxTime;
        bufOffset = clip.offset + into;
        playDur = clip.duration - into;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      src.connect(g); g.connect(_dawMaster);
      src.start(when, bufOffset, playDur);
      _dawActiveSources.push(src);
    }
  }
}

function _dawStopSources() {
  for (const s of _dawActiveSources) { try { s.stop(); } catch (_) {} }
  _dawActiveSources = [];
}

function _dawTick() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  const len = dawArrangementLength();
  if (len > 0 && _dawPlayhead >= len) {
    if (_dawLoop) { dawSeek(0); }
    else { dawStop(); if (typeof dawOnPlayhead === "function") dawOnPlayhead(0); return; }
  }
  if (typeof dawOnPlayhead === "function") dawOnPlayhead(_dawPlayhead);
  _dawRaf = requestAnimationFrame(_dawTick);
}

async function dawPlay() {
  const ctx = _dawEnsureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  // Preload all referenced buffers before scheduling
  const files = new Set();
  for (const t of dawState.tracks) for (const c of t.clips) files.add(c.file);
  await Promise.all([...files].map(dawGetBuffer));
  if (_dawIsPlaying) _dawStopSources();
  _dawIsPlaying = true;
  _dawScheduleAll();
  cancelAnimationFrame(_dawRaf);
  _dawRaf = requestAnimationFrame(_dawTick);
}

function dawPause() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  _dawIsPlaying = false;
  cancelAnimationFrame(_dawRaf);
  _dawStopSources();
}

function dawStop() {
  _dawIsPlaying = false;
  cancelAnimationFrame(_dawRaf);
  _dawStopSources();
  _dawPlayhead = 0;
  if (typeof dawOnPlayhead === "function") dawOnPlayhead(0);
}

function dawSeek(t) {
  _dawPlayhead = Math.max(0, t);
  if (_dawIsPlaying) { _dawStopSources(); _dawScheduleAll(); }
  if (typeof dawOnPlayhead === "function") dawOnPlayhead(_dawPlayhead);
}

function dawSetLoop(on) { _dawLoop = on; }
function dawGetPlayhead() { return _dawPlayhead; }
function dawIsPlaying() { return _dawIsPlaying; }

// Re-schedule mid-playback after a mute/solo change.
function dawReschedule() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  _dawStopSources();
  _dawScheduleAll();
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/daw-engine.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add static/daw-engine.js
git commit -m "feat(daw): Web Audio engine — buffer cache, scheduling, transport

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: `daw-library.js` — clip library panel

**Files:**
- Create: `static/daw-library.js`

- [ ] **Step 1: Create the module**

Create `static/daw-library.js`:

```javascript
// ── DAW clip library ──────────────────────────────────────────────────────────
let _dawLibItems = [];   // {file, name, duration, kind}

async function dawLoadLibrary() {
  const list = document.getElementById("daw-lib-list");
  if (list) list.textContent = "loading…";
  try {
    const d = await fetch("/daw/library").then(r => r.json());
    _dawLibItems = [
      ...(d.clips || []).map(c => ({ ...c, kind: "clip" })),
      ...(d.stems || []).map(s => ({ ...s, duration: s.duration || 0, kind: "stem" })),
    ];
    dawRenderLibrary();
  } catch (e) {
    if (list) list.textContent = "Library failed: " + e.message;
  }
}

function dawRenderLibrary() {
  const list = document.getElementById("daw-lib-list");
  const q = (document.getElementById("daw-lib-search")?.value || "").toLowerCase();
  list.innerHTML = "";
  const items = _dawLibItems.filter(i => i.name.toLowerCase().includes(q) || i.file.toLowerCase().includes(q));
  if (!items.length) { list.textContent = "No clips. Generate some music or run Demucs first."; return; }
  for (const it of items) {
    const chip = document.createElement("div");
    chip.draggable = true;
    chip.className = "daw-lib-chip";
    chip.style.cssText = "display:flex;align-items:center;gap:4px;font-size:11px;background:#1a1c26;border:1px solid #2d3041;border-radius:4px;padding:3px 6px;cursor:grab;color:#e2e4ed";
    const dot = it.kind === "stem" ? "🎛" : "🎵";
    chip.textContent = `⠿ ${dot} ${it.name}`;
    chip.title = it.file;
    chip.addEventListener("dragstart", e => {
      e.dataTransfer.setData("application/x-daw-clip", JSON.stringify({
        file: it.file, name: it.name,
        source_duration: it.duration || 0,
      }));
      e.dataTransfer.effectAllowed = "copy";
    });
    list.appendChild(chip);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const s = document.getElementById("daw-lib-search");
  if (s) s.addEventListener("input", dawRenderLibrary);
  const r = document.getElementById("daw-lib-refresh");
  if (r) r.addEventListener("click", dawLoadLibrary);
});
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/daw-library.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add static/daw-library.js
git commit -m "feat(daw): clip library panel with draggable sources

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: `daw-timeline.js` — render lanes, clips, drag/trim, playhead

**Files:**
- Create: `static/daw-timeline.js`

Defines `renderTimeline()`, `dawOnPlayhead(t)`, and `dawRenderTrackHeaders()`. Uses globals from Tasks 7–9.

- [ ] **Step 1: Create the module**

Create `static/daw-timeline.js`:

```javascript
// ── DAW timeline rendering + interaction ──────────────────────────────────────
let _dawPxPerSec = 12;          // zoom
const _DAW_LANE_H = 64;
const _DAW_MIN_LEN = 60;        // seconds of empty ruler
let _dawSelectedClip = null;
const _dawPeakCache = new Map(); // file → Float32Array peaks

function dawZoom(factor) {
  _dawPxPerSec = Math.min(120, Math.max(3, _dawPxPerSec * factor));
  renderTimeline();
}

function _dawTimelineWidth() {
  return Math.max(_DAW_MIN_LEN, dawArrangementLength() + 10) * _dawPxPerSec;
}

function _dawComputePeaks(file, buf, targetPx) {
  const key = file + "@" + targetPx;
  if (_dawPeakCache.has(key)) return _dawPeakCache.get(key);
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / targetPx));
  const peaks = new Float32Array(targetPx);
  for (let i = 0; i < targetPx; i++) {
    let peak = 0;
    const start = i * step;
    for (let j = 0; j < step && start + j < ch.length; j++) {
      const v = Math.abs(ch[start + j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
  }
  _dawPeakCache.set(key, peaks);
  return peaks;
}

function _dawDrawClipWave(canvas, clip, color) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const buf = _dawBufferCache.get(clip.file);
  if (!buf || buf === "error") {
    ctx.fillStyle = buf === "error" ? "#e05f5f" : "#8a8f9e";
    ctx.font = "10px sans-serif";
    ctx.fillText(buf === "error" ? "⚠ failed" : "loading…", 4, 14);
    return;
  }
  const w = canvas.width, h = canvas.height, mid = h / 2;
  // Peaks for the trimmed window
  const sr = buf.sampleRate;
  const startS = Math.floor(clip.offset * sr);
  const lenS = Math.floor(clip.duration * sr);
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(lenS / w));
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let peak = 0;
    const s = startS + x * step;
    for (let j = 0; j < step && s + j < ch.length; j++) {
      const v = Math.abs(ch[s + j]); if (v > peak) peak = v;
    }
    ctx.moveTo(x, mid - peak * mid);
    ctx.lineTo(x, mid + peak * mid);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function _dawDrawRuler() {
  const scroll = document.getElementById("daw-timeline-scroll");
  const canvas = document.getElementById("daw-ruler");
  const w = _dawTimelineWidth();
  canvas.width = w; canvas.style.width = w + "px";
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, canvas.height);
  ctx.fillStyle = "#8a8f9e"; ctx.font = "10px monospace";
  ctx.strokeStyle = "#2d3041";
  const stepSec = _dawPxPerSec < 8 ? 30 : _dawPxPerSec < 20 ? 10 : 5;
  for (let s = 0; s * _dawPxPerSec < w; s += stepSec) {
    const x = s * _dawPxPerSec;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    const m = Math.floor(s / 60), sec = s % 60;
    ctx.fillText(`${m}:${String(sec).padStart(2, "0")}`, x + 2, 14);
  }
}

function dawRenderTrackHeaders() {
  const head = document.getElementById("daw-tracks-head");
  head.innerHTML = "";
  for (const t of dawState.tracks) {
    const row = document.createElement("div");
    row.style.cssText = `height:${_DAW_LANE_H}px;border-bottom:1px solid #2d3041;padding:4px 6px;display:flex;flex-direction:column;gap:2px;border-left:3px solid ${t.color}`;
    const name = document.createElement("input");
    name.value = t.name;
    name.style.cssText = "background:transparent;border:none;color:#e2e4ed;font-size:12px;width:100%";
    name.addEventListener("change", () => dawRenameTrack(t.id, name.value));
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:4px";
    const mk = (label, on, fn, title) => {
      const b = document.createElement("button");
      b.className = "secondary small"; b.textContent = label; b.title = title;
      b.style.cssText = "font-size:10px;padding:1px 6px;" + (on ? "background:#7c65d9;color:#fff" : "");
      b.addEventListener("click", fn);
      return b;
    };
    btns.appendChild(mk("M", t.mute, () => { dawToggleMute(t.id); dawReschedule(); }, "Mute"));
    btns.appendChild(mk("S", t.solo, () => { dawToggleSolo(t.id); dawReschedule(); }, "Solo"));
    btns.appendChild(mk("✕", false, () => { if (confirm("Remove track?")) dawRemoveTrack(t.id); }, "Remove"));
    row.appendChild(name); row.appendChild(btns);
    head.appendChild(row);
  }
}

function renderTimeline() {
  dawRenderTrackHeaders();
  _dawDrawRuler();
  const lanes = document.getElementById("daw-lanes");
  const w = _dawTimelineWidth();
  lanes.innerHTML = "";
  lanes.style.width = w + "px";
  for (const track of dawState.tracks) {
    const lane = document.createElement("div");
    lane.dataset.trackId = track.id;
    lane.style.cssText = `position:relative;height:${_DAW_LANE_H}px;border-bottom:1px solid #1a1c26`;
    lane.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    lane.addEventListener("drop", e => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/x-daw-clip");
      if (!raw) return;
      const src = JSON.parse(raw);
      const rect = lane.getBoundingClientRect();
      const start = Math.max(0, (e.clientX - rect.left) / _dawPxPerSec);
      const clip = dawAddClip(track.id, src, start);
      if (clip) dawGetBuffer(clip.file).then(renderTimeline);  // load + redraw waveform
    });
    for (const clip of track.clips) lane.appendChild(_dawBuildClipEl(track, clip));
    lanes.appendChild(lane);
  }
}

function _dawBuildClipEl(track, clip) {
  const el = document.createElement("div");
  el.className = "daw-clip";
  el.style.cssText = `position:absolute;top:2px;height:${_DAW_LANE_H - 6}px;left:${clip.start * _dawPxPerSec}px;width:${Math.max(8, clip.duration * _dawPxPerSec)}px;background:${track.color}22;border:1px solid ${track.color};border-radius:3px;overflow:hidden;cursor:grab;` + (clip === _dawSelectedClip ? "box-shadow:0 0 0 2px #00d4b6" : "");
  const label = document.createElement("div");
  label.textContent = clip.name;
  label.style.cssText = "font-size:9px;color:#e2e4ed;padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none";
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, clip.duration * _dawPxPerSec); canvas.height = _DAW_LANE_H - 22;
  canvas.style.cssText = "display:block;width:100%;pointer-events:none";
  el.appendChild(label); el.appendChild(canvas);
  _dawDrawClipWave(canvas, clip, track.color);

  // Trim handle (right edge)
  const handle = document.createElement("div");
  handle.style.cssText = "position:absolute;right:0;top:0;width:6px;height:100%;cursor:ew-resize;background:linear-gradient(90deg,transparent,#00d4b6)";
  el.appendChild(handle);

  _dawWireClipDrag(el, handle, track, clip);
  return el;
}

function _dawWireClipDrag(el, handle, track, clip) {
  el.addEventListener("mousedown", e => {
    if (e.target === handle) return;
    _dawSelectedClip = clip; renderTimeline();
    const startX = e.clientX, origStart = clip.start, laneTop0 = e.clientY;
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      let newStart = Math.max(0, origStart + dx);
      // vertical lane change
      const laneEls = [...document.querySelectorAll("#daw-lanes > div")];
      let destTrack = track.id;
      for (const le of laneEls) {
        const r = le.getBoundingClientRect();
        if (m.clientY >= r.top && m.clientY <= r.bottom) { destTrack = le.dataset.trackId; break; }
      }
      dawMoveClip(clip.id, destTrack, newStart);
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  handle.addEventListener("mousedown", e => {
    const startX = e.clientX, origDur = clip.duration;
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      dawTrimClip(clip.id, clip.offset, Math.max(0.1, origDur + dx));
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    e.stopPropagation(); e.preventDefault();
  });
}

// Keyboard: Delete removes selected clip, Ctrl+D duplicates
document.addEventListener("keydown", e => {
  if (!document.getElementById("tab-daw")?.classList.contains("active")) return;
  if (!_dawSelectedClip) return;
  if (e.key === "Delete" || e.key === "Backspace") { dawDeleteClip(_dawSelectedClip.id); _dawSelectedClip = null; e.preventDefault(); }
  if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey)) { dawDuplicateClip(_dawSelectedClip.id); e.preventDefault(); }
});

// Playhead drawing + ruler seek
function dawOnPlayhead(t) {
  const ph = document.getElementById("daw-playhead");
  const scroll = document.getElementById("daw-timeline-scroll");
  if (!ph) return;
  ph.style.display = "block";
  ph.style.left = (t * _dawPxPerSec) + "px";
  ph.style.height = scroll.scrollHeight + "px";
  const len = dawArrangementLength();
  const cur = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const tot = `${Math.floor(len / 60)}:${String(Math.floor(len % 60)).padStart(2, "0")}`;
  const timeEl = document.getElementById("daw-time");
  if (timeEl) timeEl.textContent = `${cur} / ${tot}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const ruler = document.getElementById("daw-ruler");
  if (ruler) ruler.addEventListener("click", e => {
    const rect = ruler.getBoundingClientRect();
    dawSeek(Math.max(0, (e.clientX - rect.left + ruler.parentElement.scrollLeft) / _dawPxPerSec));
  });
});
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/daw-timeline.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add static/daw-timeline.js
git commit -m "feat(daw): timeline render, clip drag/trim/select, playhead, zoom

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: `daw.js` — tab hook + transport glue, and wire tabs.js

**Files:**
- Create: `static/daw.js`
- Modify: `static/tabs.js`
- Modify: `templates/index.html` (cache-bust bump)

- [ ] **Step 1: Create the glue module**

Create `static/daw.js`:

```javascript
// ── DAW tab glue ──────────────────────────────────────────────────────────────
let _dawInitialized = false;

async function onDawTabOpen() {
  if (!_dawInitialized) { _dawInitialized = true; _dawWireTransport(); }
  await dawRefreshProjectList();
  // Open the most recent project, or create one if none exist.
  const projects = await dawListProjects();
  if (dawState.id == null) {
    if (projects.length) await dawLoadProject(projects[0].id);
    else { await dawNewProject("My First Project"); await dawRefreshProjectList(); }
  }
  await dawLoadLibrary();
  renderTimeline();
}

async function dawRefreshProjectList() {
  const sel = document.getElementById("daw-project-select");
  if (!sel) return;
  const projects = await dawListProjects();
  sel.innerHTML = projects.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  if (dawState.id != null) sel.value = dawState.id;
}

function _dawWireTransport() {
  document.getElementById("daw-play").addEventListener("click", () => dawPlay());
  document.getElementById("daw-pause").addEventListener("click", () => dawPause());
  document.getElementById("daw-stop").addEventListener("click", () => dawStop());
  const loopBtn = document.getElementById("daw-loop");
  loopBtn.addEventListener("click", () => {
    const on = loopBtn.style.background === "";
    dawSetLoop(on);
    loopBtn.style.background = on ? "#7c65d9" : "";
    loopBtn.style.color = on ? "#fff" : "";
  });
  document.getElementById("daw-zoom-in").addEventListener("click", () => dawZoom(1.4));
  document.getElementById("daw-zoom-out").addEventListener("click", () => dawZoom(1 / 1.4));
  document.getElementById("daw-add-track").addEventListener("click", () => dawAddTrack());

  document.getElementById("daw-new").addEventListener("click", async () => {
    const name = prompt("New project name:", "Untitled Project");
    if (name === null) return;
    await dawNewProject(name || "Untitled Project");
    await dawRefreshProjectList();
    renderTimeline();
  });
  document.getElementById("daw-rename").addEventListener("click", async () => {
    const name = prompt("Rename project:", dawState.name);
    if (!name) return;
    dawState.name = name; dawMarkDirty(); await dawRefreshProjectList();
  });
  document.getElementById("daw-delete").addEventListener("click", async () => {
    if (dawState.id == null || !confirm("Delete this project?")) return;
    await dawDeleteProject(dawState.id);
    dawState = { id: null, name: "Untitled Project", tempo: 120, tracks: [] };
    await onDawTabOpen();
  });
  document.getElementById("daw-project-select").addEventListener("change", async e => {
    await dawLoadProject(parseInt(e.target.value, 10));
    await dawLoadLibrary();
    renderTimeline();
  });
}
```

- [ ] **Step 2: Wire the tab-open hook in `tabs.js`**

In `static/tabs.js`, inside the `.tab-btn` click handler, add a line next to the other tab hooks (after the `video` line):

```javascript
    if (btn.dataset.tab === "daw") { if (typeof onDawTabOpen === "function") onDawTabOpen(); }
```

- [ ] **Step 3: Bump cache-busts**

In `templates/index.html`, bump all five DAW script tags and `tabs.js`:
- `daw-project.js?v=1` → `?v=2`, and the same `?v=1` → `?v=2` for `daw-engine.js`, `daw-library.js`, `daw-timeline.js`, `daw.js`
- `tabs.js?v=3` → `?v=4`

- [ ] **Step 4: Syntax check + restart**

```bash
node --check static/daw.js && node --check static/tabs.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
```
Expected: no JS errors; health 3.10.0.

- [ ] **Step 5: Commit**

```bash
git add static/daw.js static/tabs.js templates/index.html
git commit -m "feat(daw): tab hook, transport + project controls glue

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end live verification (Playwright)

**Files:**
- Create: `/tmp/daw_verify.py` (throwaway; not committed)

This is the runtime proof the arranger works. Requires ComfyUI/Ollama not needed — only the service, with at least one owned audio file in the library (the verification creates one via the existing generate flow if the library is empty, or uses an existing clip).

- [ ] **Step 1: Write the verification driver**

Create `/tmp/daw_verify.py`:

```python
from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:8001"
HDR = {"Cf-Access-Authenticated-User-Email": "steve.j.petry@gmail.com"}

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 950}, extra_http_headers=HDR)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_selector("#btn-generate", timeout=15000)
    page.wait_for_timeout(1500)

    # Open DAW tab
    page.click('[data-tab="daw"]')
    page.wait_for_timeout(1500)
    print("DAW tab active:", page.is_visible("#daw-root"))
    print("default track rendered:", page.eval_on_selector_all("#daw-tracks-head > div", "els => els.length"))

    # Library has at least one draggable clip
    page.wait_for_timeout(1000)
    chips = page.eval_on_selector_all(".daw-lib-chip", "els => els.length")
    print("library chips:", chips)
    assert chips > 0, "no clips in library — generate or demucs something first"

    # Simulate drag: read the first chip's payload and drop it on lane 0 via JS
    payload = page.eval_on_selector(".daw-lib-chip", """el => {
        const dt = new DataTransfer();
        // reconstruct from title (file) — easier: trigger real dragstart capture
        return null;
    }""")
    # Add a clip programmatically through the public mutation (exercises state+render+autosave)
    page.evaluate("""() => {
        const t = dawState.tracks[0];
        const item = _dawLibItems[0];
        dawAddClip(t.id, {file:item.file, name:item.name, source_duration:item.duration||10}, 1.0);
    }""")
    page.wait_for_timeout(1500)
    clip_els = page.eval_on_selector_all(".daw-clip", "els => els.length")
    print("clips on timeline:", clip_els)
    assert clip_els >= 1

    # Play, confirm AudioContext running + playhead advances
    page.click("#daw-play")
    page.wait_for_timeout(2000)
    ph1 = page.evaluate("dawGetPlayhead()")
    playing = page.evaluate("dawIsPlaying()")
    print("playing:", playing, "playhead:", round(ph1, 2))
    page.click("#daw-stop")
    page.wait_for_timeout(500)
    print("playhead after stop:", page.evaluate("dawGetPlayhead()"))

    # Autosave → reload → reopen → clip persists
    page.wait_for_timeout(1200)  # let debounced autosave flush
    pid = page.evaluate("dawState.id")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#btn-generate", timeout=15000)
    page.wait_for_timeout(1000)
    page.click('[data-tab="daw"]')
    page.wait_for_timeout(2000)
    persisted = page.evaluate(f"""async () => {{
        await dawLoadProject({pid});
        return dawState.tracks.reduce((n,t)=>n+t.clips.length,0);
    }}""")
    print("clips after reload+reopen:", persisted)
    assert persisted >= 1, "arrangement did not persist"

    print("PAGE ERRORS:", errors)
    page.screenshot(path="/tmp/daw_verify.png", full_page=True)
    ctx.close(); b.close()
print("DAW VERIFY OK")
```

- [ ] **Step 2: Ensure a library clip exists**

```bash
sqlite3 /home/legion/legionprojects/nyx-step/nyx_step.db "SELECT count(*) FROM jobs WHERE status='done' AND user_email='steve.j.petry@gmail.com';"
```
Expected: ≥ 1. If 0, generate one first via the UI or the `/generate` API before running the driver.

- [ ] **Step 3: Run the driver**

Run: `cd /tmp && python3 daw_verify.py`
Expected output includes: `DAW tab active: True`, `default track rendered: 1`, `library chips: <N>0`, `clips on timeline: 1`, `playing: True playhead: >0`, `playhead after stop: 0.0`, `clips after reload+reopen: >=1`, `PAGE ERRORS: []`, `DAW VERIFY OK`.

- [ ] **Step 4: Inspect the screenshot + manual drag spot-check**

Open `/tmp/daw_verify.png` — confirm the DAW tab shows the transport bar, a track header with M/S/✕, a clip block with a waveform on the timeline, and the clip library row at the bottom.

The driver adds a clip via the public `dawAddClip` mutation (exercises state → render → engine → autosave), but **not** the native HTML5 drag-drop drop handler (DnD with a custom `dataTransfer` payload is unreliable to script). Manually confirm the drop gesture once in a real browser at music-ai.nyxstudios.net: drag a library chip onto a lane and verify a clip appears at the drop position.

- [ ] **Step 5: Full regression + commit the plan completion**

```bash
python3 -m pytest tests/ -q          # all green (baseline 75 + DAW backend tests)
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
```
No code commit here (driver is throwaway). If any frontend fix was needed during verification, commit it with a `fix(daw):` message and re-run the driver.

---

## Self-Review

**Spec coverage:**
- daw_projects table + per-user CRUD → Task 1 ✓
- `/daw` project CRUD API → Task 3 ✓
- `/daw/library` (clips + stems) → Task 4 ✓
- `/daw/audio` ownership-aware (clips + stems + traversal block) → Tasks 2, 5 ✓
- Web Audio engine (cache, schedule, transport, mute/solo, loop, seek) → Task 8 ✓
- UI layout (transport / track headers / timeline / library) → Task 6 ✓
- Clip ops: add/move/trim/delete/duplicate → Tasks 7 (state) + 10 (gestures) ✓
- Track ops: add/remove/rename/mute/solo/color → Tasks 7 + 10 ✓
- Autosave + project list + new/open/rename/delete → Tasks 7 + 11 ✓
- Waveform peaks (client, canvas) → Task 10 ✓
- Edge cases (missing file, decode fail, autoplay resume, clamp, rapid stop) → Tasks 8 + 10 ✓
- Testing (backend pytest + frontend Playwright) → Tasks 1/3/4/5 + 12 ✓

**Deferred (correctly not in this plan):** faders/pan, split/fade/normalize, export, AI hooks, FX, session grid, grid snapping, uploads, MIDI — all noted as later phases in the spec.

**Type/name consistency:** `dawState`, `dawAddClip`, `dawMoveClip`, `dawTrimClip`, `dawDeleteClip`, `dawDuplicateClip`, `dawAddTrack`, `dawToggleMute/Solo`, `dawArrangementLength`, `renderTimeline`, `dawOnPlayhead`, `dawGetBuffer`, `_dawBufferCache`, `dawReschedule`, `dawGetPlayhead`, `dawIsPlaying`, `dawMarkDirty`, `onDawTabOpen` — used consistently across tasks 7–12. Backend: `create/list/get/update/delete_daw_project`, `safe_output_path` — consistent across tasks 1–5.

**Placeholder scan:** no TBD/TODO; every code step has complete code; every test has assertions.
