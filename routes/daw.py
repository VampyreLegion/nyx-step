from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import config
import core.db as db
from nyx_step import get_user_email, tracker
from routes.download import safe_output_path

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
    name = req.name.strip() if req.name is not None else None
    ok = db.update_daw_project(user, project_id, name=name, data=req.data)
    if not ok:
        return JSONResponse({"error": "Not found"}, status_code=404)
    p = db.get_daw_project(user, project_id)
    return {"saved": project_id, "updated_at": p["updated_at"] if p else None}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, request: Request):
    user = get_user_email(request)
    if not db.delete_daw_project(user, project_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": project_id}


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

    # Songs this user owns (filename without extension) → match stem folders.
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


@router.get("/job/{prompt_id}")
async def job_status(prompt_id: str, request: Request):
    user = get_user_email(request)
    if not tracker.user_owns(user, prompt_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    job = tracker.get(prompt_id)
    if not job:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"status": job.status, "files": job.output_files, "error": job.error_msg}


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
