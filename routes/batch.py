from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from nyx_step import get_user_email

router = APIRouter()

class BatchRequest(BaseModel):
    tags: str = ""
    lyrics: str = ""
    duration: float = 30.0
    song_name: str = "Batch"
    count: int = Field(default=4, ge=2, le=8)
    bpm: int = 120
    key: str = "C"
    scale: str = "Major"

@router.post("/batch-generate")
async def batch_generate(req: BatchRequest, request: Request):
    user_email = get_user_email(request)
    import httpx, random
    queued = []
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=30) as client:
        for i in range(req.count):
            payload = {
                "tags": req.tags,
                "lyrics": req.lyrics,
                "duration": req.duration,
                "song_name": f"{req.song_name} #{i+1}",
                "bpm": req.bpm,
                "key": req.key,
                "scale": req.scale,
                "seed": random.randint(0, 4294967295),
            }
            try:
                r = await client.post("/generate", json=payload)
                if r.status_code == 200:
                    queued.append({"index": i, "prompt_id": r.json().get("prompt_id")})
            except Exception:
                pass
    return JSONResponse({"queued": queued, "total": req.count})
