from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/api")


class _TemplateSave(BaseModel):
    name: str
    data: dict


@router.get("/song-templates")
async def list_song_templates(request: Request):
    user_email = get_user_email(request)
    return {"templates": db.list_song_templates(user_email)}


@router.post("/song-templates")
async def save_song_template(req: _TemplateSave, request: Request):
    user_email = get_user_email(request)
    name = req.name.strip()
    if not name:
        return JSONResponse({"error": "Name is required"}, status_code=400)
    template_id = db.create_song_template(user_email, name[:120], req.data)
    return {"id": template_id, "name": name[:120], "saved": True}


@router.post("/song-templates/{template_id}/apply")
async def apply_song_template(template_id: int, request: Request):
    user_email = get_user_email(request)
    template = db.get_song_template_for_apply(user_email, template_id)
    if template is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    template.pop("created_at", None)
    return template


@router.delete("/song-templates/{template_id}")
async def delete_song_template(template_id: int, request: Request):
    user_email = get_user_email(request)
    # Scoped to the requesting user, so shared built-ins are never deletable.
    if not db.delete_song_template(user_email, template_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": template_id}
