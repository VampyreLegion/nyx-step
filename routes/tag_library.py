from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/api")


class _TagPresetCreate(BaseModel):
    name: str
    tags: str = ""


@router.get("/tag-presets")
async def list_tag_presets(request: Request):
    user_email = get_user_email(request)
    return {"presets": db.list_tag_presets(user_email)}


@router.post("/tag-presets")
async def save_tag_preset(req: _TagPresetCreate, request: Request):
    user_email = get_user_email(request)
    name = req.name.strip()
    if not name:
        return JSONResponse({"error": "Name is required"}, status_code=400)
    preset_id = db.create_tag_preset(user_email, name[:120], req.tags.strip())
    return {"id": preset_id, "name": name[:120], "saved": True}


@router.delete("/tag-presets/{preset_id}")
async def delete_tag_preset(preset_id: int, request: Request):
    user_email = get_user_email(request)
    if not db.delete_tag_preset(user_email, preset_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": preset_id}
