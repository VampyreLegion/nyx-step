from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from core.comfyui import ComfyUIClient
from core.rate_limit import check as rate_check
from musicweb import tracker, get_user_email

router = APIRouter()
_client = ComfyUIClient()


class RemixRequest(BaseModel):
    source_file: str
    mode: str = "variation"       # variation | extend | repaint
    denoise: float = Field(default=0.5, ge=0.05, le=0.95)
    seed_seconds: float = Field(default=10.0, ge=3.0, le=60.0)
    tags: str = ""
    lyrics: str = ""
    genre: str = ""
    bpm: int = Field(default=120, ge=40, le=300)
    key: str = "C"
    scale: str = "Major"
    mode_scale: str = ""
    time_sig: str = "4/4"
    instruments: list[str] = []
    vocal_tags: list[str] = []
    steps: int = Field(default=8, ge=1, le=150)
    cfg_scale: float = Field(default=2.0, ge=0.1, le=20.0)
    duration: float = Field(default=30.0, ge=5.0, le=300.0)
    seed: int = Field(default=0, ge=0, le=4294967295)
    lock_seed: bool = False
    temperature: float = Field(default=0.85, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    top_k: int = Field(default=0, ge=0, le=1000)
    min_p: float = Field(default=0.0, ge=0.0, le=1.0)
    repaint_start: float = Field(default=0.0, ge=0.0)
    repaint_end: float = Field(default=10.0, ge=0.0)
    song_name: str = "Remix"


@router.post("/remix")
async def remix(req: RemixRequest, request: Request):
    user_email = get_user_email(request)

    if not rate_check(f"generate:{user_email}"):
        return JSONResponse({"error": "Rate limit exceeded — slow down"}, status_code=429)

    state = req.model_dump()
    caption = req.tags.strip()
    lyrics = req.lyrics

    if req.mode == "repaint":
        result = _client.build_repaint_workflow(
            source_filename=req.source_file,
            caption=caption,
            lyrics=lyrics,
            state=state,
            start_time=req.repaint_start,
            end_time=req.repaint_end,
        )
    else:
        result = _client.build_remix_workflow(
            source_filename=req.source_file,
            caption=caption,
            lyrics=lyrics,
            state=state,
            mode=req.mode,
            denoise=req.denoise,
            seed_seconds=req.seed_seconds,
        )
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    send_result = _client.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse({"error": "ComfyUI unreachable: " + send_result["error"]}, status_code=400)

    prompt_id = send_result.get("prompt_id", "")
    tracker.register(prompt_id, user_email, req.song_name, seed=result.get("seed", 0),
                     caption=caption, lyrics=lyrics)

    q = tracker.get_queue_counts()
    return {"prompt_id": prompt_id, "queue_position": q["pending"]}
