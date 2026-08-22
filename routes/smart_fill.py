from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import core.db as db
from nyx_step import get_user_email

router = APIRouter()

class SmartFillRequest(BaseModel):
    arrangement_id: int
    section_index: int

@router.post("/smart-fill")
async def smart_fill(req: SmartFillRequest, request: Request):
    user_email = get_user_email(request)
    project = db.get_daw_project(user_email, req.arrangement_id)
    if not project:
        return JSONResponse({"error": "Not found"}, status_code=404)
    sections = project["data"].get("sections", [])
    idx = req.section_index
    if idx < 0 or idx >= len(sections):
        return JSONResponse({"error": "Invalid section index"}, status_code=400)
    prev_cap = sections[idx - 1].get("caption", "") if idx > 0 else ""
    next_cap = sections[idx + 1].get("caption", "") if idx < len(sections) - 1 else ""
    import httpx
    async with httpx.AsyncClient(base_url="http://localhost:11434", timeout=30) as client:
        r = await client.post("/api/generate", json={
            "model": "llama3.1:8b",
            "prompt": f"Generate a short music caption (ACE style tags) that bridges these two sections:\nBefore: {prev_cap}\nAfter: {next_cap}\nReturn only the comma-separated tags.",
            "stream": False,
        })
        caption = r.json().get("response", "").strip()
    return JSONResponse({"suggested_caption": caption, "section_index": idx})
