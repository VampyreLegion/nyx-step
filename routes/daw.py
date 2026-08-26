from __future__ import annotations
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File, Form
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

    # Groove Lab clips
    for gc in db.get_groove_clips(user):
        clips.append({
            "file": gc["file_path"],
            "name": gc["name"],
            "duration": 0,
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
    # Groove Lab clip?
    for gc in db.get_groove_clips(user):
        if gc["file_path"] == filename:
            return True
    # Imported DAW clip?
    if filename.startswith("daw_imports/"):
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


class _Transcribe(BaseModel):
    file: str
    mode: str = "melody"


@router.post("/transcribe")
async def transcribe(req: _Transcribe, request: Request):
    import asyncio
    from core.executor import get_audio_pool
    user = get_user_email(request)
    if not _user_owns_daw_file(user, req.file):
        return JSONResponse({"error": "Not found or access denied"}, status_code=404)
    path = safe_output_path(req.file)
    if path is None or not path.exists():
        return JSONResponse({"error": "File not on disk"}, status_code=404)
    if req.mode not in ("melody", "rhythm", "piano"):
        return JSONResponse({"error": "Bad mode"}, status_code=400)

    def _work():
        from core.midi import melody_notes, rhythm_notes, piano_notes, notes_to_json
        fn = {"melody": melody_notes, "rhythm": rhythm_notes, "piano": piano_notes}[req.mode]
        notes = fn(str(path))
        return notes_to_json(notes)

    try:
        loop = asyncio.get_event_loop()
        notes = await loop.run_in_executor(get_audio_pool(), _work)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    duration = max((n["start"] + n["dur"] for n in notes), default=0.0)
    return {"notes": notes, "duration": round(duration, 4), "mode": req.mode, "count": len(notes)}


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


_DAW_IMPORTS_DIR = config.COMFYUI_OUTPUT_DIR / "daw_imports"


@router.post("/import")
async def import_audio(
    request: Request,
    file: UploadFile = File(...),
):
    """Upload an audio file (WAV/MP3/FLAC/OGG) and add it to the DAW clip library."""
    user = get_user_email(request)
    _DAW_IMPORTS_DIR.mkdir(parents=True, exist_ok=True)

    ext = Path(file.filename or "audio.wav").suffix.lower() or ".wav"
    if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus", ".wma"):
        return JSONResponse({"error": f"Unsupported format: {ext}"}, status_code=400)

    safe_name = f"import_{uuid.uuid4().hex[:12]}{ext}"
    dest = _DAW_IMPORTS_DIR / safe_name

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Detect duration via soundfile
    duration = 0.0
    try:
        import soundfile as sf
        info = sf.info(str(dest))
        duration = info.duration
    except Exception:
        pass

    rel = f"daw_imports/{safe_name}"
    return {
        "ok": True,
        "file": rel,
        "name": Path(file.filename or safe_name).stem,
        "duration": round(duration, 3),
    }
