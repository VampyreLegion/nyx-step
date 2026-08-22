from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import core.db as db
from nyx_step import get_user_email

router = APIRouter()

class GrooveToSongRequest(BaseModel):
    groove_clip_id: int

@router.post("/groove-to-song")
async def groove_to_song(req: GrooveToSongRequest, request: Request):
    user_email = get_user_email(request)
    clips = db.get_groove_clips(user_email)
    clip = next((c for c in clips if c["id"] == req.groove_clip_id), None)
    if not clip:
        return JSONResponse({"error": "Clip not found"}, status_code=404)
    import httpx
    try:
        from core.analyze import analyze_audio
        info = analyze_audio(clip["file_path"])
        bpm = info.get("bpm", 128)
        key = info.get("key", "A")
    except Exception:
        bpm, key = 128, "A"
    async with httpx.AsyncClient(base_url="http://localhost:11434", timeout=30) as client:
        r = await client.post("/api/generate", json={
            "model": "llama3.1:8b",
            "prompt": f"Given a {bpm} BPM groove in {key}, suggest: genre, caption tags, and 4 lines of lyrics. Reply as JSON with keys genre, caption, lyrics.",
            "stream": False,
        })
        import json
        text = r.json().get("response", "{}")
        try:
            suggestion = json.loads(text)
        except Exception:
            suggestion = {"genre": "electronic", "caption": f"{bpm} BPM, {key}", "lyrics": ""}
    return JSONResponse({
        "bpm": bpm, "key": key,
        "suggested_genre": suggestion.get("genre", ""),
        "suggested_caption": suggestion.get("caption", ""),
        "suggested_lyrics": suggestion.get("lyrics", ""),
    })
