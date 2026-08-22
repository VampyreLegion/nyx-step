from __future__ import annotations
import random
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import core.db as db
from nyx_step import get_user_email

router = APIRouter()

class RemixRequest(BaseModel):
    history_id: int
    variation_type: str = "drums"

VARIATION_SHIFTS = {
    "drums": "new drum pattern, varied percussion",
    "key": None,
    "tempo": None,
    "mood": None,
    "arrangement": "different arrangement, restructured",
}

MOOD_CHOICES = [
    "darker atmosphere", "brighter mood", "more aggressive",
    "dreamier texture", "heavier", "lighter feel", "more energetic",
]

@router.post("/quick-remix")
async def quick_remix(req: RemixRequest, request: Request):
    user_email = get_user_email(request)
    record = db.get_history_record(user_email, req.history_id)
    if not record:
        return JSONResponse({"error": "Not found"}, status_code=404)

    params = dict(record.get("params", {}))
    caption = record.get("caption", "")
    vt = req.variation_type

    if vt == "drums":
        caption = f"{caption}, {VARIATION_SHIFTS['drums']}"
    elif vt == "mood":
        caption = f"{caption}, {random.choice(MOOD_CHOICES)}"
    elif vt == "arrangement":
        caption = f"{caption}, {VARIATION_SHIFTS['arrangement']}"
    elif vt == "key":
        keys = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
        shift = random.choice([-3, -2, -1, 1, 2, 3])
        idx = keys.index(params.get("key", "C")) if params.get("key", "C") in keys else 0
        params["key"] = keys[(idx + shift) % 12]
    elif vt == "tempo":
        params["bpm"] = max(40, min(300, params.get("bpm", 120) + random.randint(-15, 15)))

    import httpx
    payload = {
        "tags": caption,
        "lyrics": record.get("lyrics", ""),
        "duration": params.get("duration", 30.0),
        "song_name": f"{record.get('song_name', 'Remix')} (remix)",
        "bpm": params.get("bpm", 120),
        "key": params.get("key", "C"),
        "scale": params.get("scale", "Major"),
        "seed": 0,
    }
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=30) as client:
        r = await client.post("/generate", json=payload)
        if r.status_code == 200:
            return JSONResponse({"ok": True, "prompt_id": r.json().get("prompt_id")})
    return JSONResponse({"error": "Generation failed"}, status_code=500)
