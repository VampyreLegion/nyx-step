from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/api")


class _NotesUpdate(BaseModel):
    notes: str = ""


@router.get("/favorites")
async def list_favorites(request: Request):
    user_email = get_user_email(request)
    return {"records": db.get_bookmarked_history(user_email)}


@router.post("/favorites/{record_id}/bookmark")
async def toggle_bookmark(record_id: int, request: Request):
    user_email = get_user_email(request)
    new_state = db.toggle_history_bookmark(user_email, record_id)
    if new_state is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"id": record_id, "bookmarked": new_state}


@router.put("/favorites/{record_id}/notes")
async def update_notes(record_id: int, req: _NotesUpdate, request: Request):
    user_email = get_user_email(request)
    if not db.update_history_notes(user_email, record_id, req.notes):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"id": record_id, "notes": req.notes}
