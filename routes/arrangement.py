from __future__ import annotations
import json
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import core.db as db
from nyx_step import get_user_email

router = APIRouter()


class Section(BaseModel):
    type: str = "custom"
    name: str = ""
    caption: str = ""
    lyrics: str = ""
    duration: float = 30.0


class ArrangementCreate(BaseModel):
    name: str = "New Arrangement"
    sections: list[Section] = []
    tempo: int = 120


class ArrangementUpdate(BaseModel):
    name: str | None = None
    sections: list[Section] | None = None
    tempo: int | None = None


@router.get("/api/arrangements")
async def list_arrangements(request: Request):
    user_email = get_user_email(request)
    projects = db.list_daw_projects(user_email)
    arrangements = []
    for p in projects:
        data = p.get("data", {})
        if isinstance(data, dict) and data.get("type") == "arrangement":
            arrangements.append({"id": p["id"], "name": p["name"], "updated_at": p["updated_at"]})
    return JSONResponse({"arrangements": arrangements})


@router.post("/api/arrangements")
async def create_arrangement(req: ArrangementCreate, request: Request):
    user_email = get_user_email(request)
    project_id = db.create_daw_project(user_email, req.name)
    data = {
        "type": "arrangement",
        "tempo": req.tempo,
        "sections": [s.model_dump() for s in req.sections],
    }
    db.update_daw_project(user_email, project_id, data=data)
    return JSONResponse({"id": project_id, "ok": True})


@router.put("/api/arrangements/{arr_id}")
async def update_arrangement(arr_id: int, req: ArrangementUpdate, request: Request):
    user_email = get_user_email(request)
    project = db.get_daw_project(user_email, arr_id)
    if not project:
        return JSONResponse({"error": "Not found"}, status_code=404)
    data = project["data"]
    if req.name is not None:
        db.update_daw_project(user_email, arr_id, name=req.name)
    if req.sections is not None:
        data["sections"] = [s.model_dump() for s in req.sections]
    if req.tempo is not None:
        data["tempo"] = req.tempo
    db.update_daw_project(user_email, arr_id, data=data)
    return JSONResponse({"ok": True})


@router.delete("/api/arrangements/{arr_id}")
async def delete_arrangement(arr_id: int, request: Request):
    user_email = get_user_email(request)
    ok = db.delete_daw_project(user_email, arr_id)
    return JSONResponse({"ok": ok})


@router.post("/api/arrangements/{arr_id}/generate")
async def generate_arrangement(arr_id: int, request: Request):
    user_email = get_user_email(request)
    project = db.get_daw_project(user_email, arr_id)
    if not project:
        return JSONResponse({"error": "Not found"}, status_code=404)
    sections = project["data"].get("sections", [])
    if not sections:
        return JSONResponse({"error": "No sections"}, status_code=400)

    import httpx
    queued = []
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=30) as client:
        for i, sec in enumerate(sections):
            payload = {
                "tags": sec.get("caption", ""),
                "lyrics": sec.get("lyrics", ""),
                "duration": sec.get("duration", 30.0),
                "song_name": f"{project['name']} - Section {i+1}",
                "bpm": project["data"].get("tempo", 120),
            }
            try:
                r = await client.post("/generate", json=payload)
                if r.status_code == 200:
                    queued.append({"section": i, "prompt_id": r.json().get("prompt_id")})
            except Exception:
                pass
    return JSONResponse({"queued": queued, "total": len(sections)})
