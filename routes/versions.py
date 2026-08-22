from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/api/versions")


class _SaveVersion(BaseModel):
    history_id: int | None = None
    song_name: str | None = None
    prompt_id: str | None = None
    params: dict | None = None
    notes: str = ""


@router.post("")
async def save_version(req: _SaveVersion, request: Request):
    user = get_user_email(request)

    if req.history_id is not None:
        rec = db.get_history_record(user, req.history_id)
        if rec is None:
            return JSONResponse({"error": "History record not found"}, status_code=404)
        song_name = (req.song_name or rec["song_name"] or "Untitled").strip() or "Untitled"
        prompt_id = req.prompt_id or rec["prompt_id"]
        params = req.params if req.params is not None else {
            **rec["params"],
            "tags": rec["caption"],
            "lyrics": rec["lyrics"],
            "seed": rec["seed"],
            "song_name": rec["song_name"],
        }
    elif req.song_name and req.params is not None:
        song_name = req.song_name.strip() or "Untitled"
        prompt_id = req.prompt_id
        params = req.params
    else:
        return JSONResponse(
            {"error": "Provide history_id or both song_name and params"}, status_code=400)

    vid = db.save_song_version(user, song_name, prompt_id, params, notes=req.notes)
    v = db.get_song_version(user, vid)
    return {"saved": vid, "version": v}


@router.get("")
async def list_versions(request: Request, song_name: str = ""):
    user = get_user_email(request)
    if not song_name.strip():
        return {"songs": db.list_versioned_songs(user)}
    versions = db.list_song_versions(user, song_name.strip())
    for v in versions:
        v.pop("params", None)  # keep list light; details via /{id}
    return {"song_name": song_name.strip(), "versions": versions}


@router.get("/songs")
async def versioned_songs(request: Request):
    user = get_user_email(request)
    return {"songs": db.list_versioned_songs(user)}


@router.get("/{version_id}")
async def version_details(version_id: int, request: Request):
    user = get_user_email(request)
    v = db.get_song_version(user, version_id)
    if v is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return v


class _Restore(BaseModel):
    notes: str | None = None


@router.post("/{version_id}/restore")
async def restore_version(version_id: int, request: Request):
    """Return the stored generation payload so the client can load it into the form."""
    user = get_user_email(request)
    v = db.get_song_version(user, version_id)
    if v is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    p = v["params"]
    return {
        "restored": v["id"],
        "song_name": p.get("song_name") or v["song_name"],
        "tags": p.get("tags", ""),
        "lyrics": p.get("lyrics", ""),
        "seed": p.get("seed", 0),
        "notes": v["notes"],
        "params": {k: val for k, val in p.items()
                   if k not in ("tags", "lyrics", "seed", "song_name")},
        "created_at": v["created_at"],
        "version": v["version"],
    }
