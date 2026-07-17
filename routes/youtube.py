from __future__ import annotations
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from core.rate_limit import check as rate_check
from core.youtube import download_audio
from core.comfyui import ComfyUIClient
from nyx_step import tracker, get_user_email

router = APIRouter()
_client = ComfyUIClient()


class YouTubeCoverRequest(BaseModel):
    url: str
    tags: str = ""
    lyrics: str = ""
    song_name: str = "YouTube Cover"
    denoise: float = Field(default=0.75, ge=0.1, le=0.95)
    steps: int = Field(default=20, ge=1, le=150)
    cfg_scale: float = Field(default=7.0, ge=0.1, le=20.0)
    duration: float = Field(default=30.0, ge=5.0, le=300.0)
    seed: int = Field(default=0, ge=0, le=4294967295)
    lock_seed: bool = False
    temperature: float = Field(default=0.85, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    top_k: int = Field(default=0, ge=0, le=1000)
    min_p: float = Field(default=0.0, ge=0.0, le=1.0)


@router.post("/youtube/cover")
async def youtube_cover(req: YouTubeCoverRequest, request: Request):
    user_email = get_user_email(request)
    if not rate_check(f"generate:{user_email}"):
        return JSONResponse({"error": "Rate limit exceeded — slow down"}, status_code=429)

    # 1. Download audio from YouTube
    _tmpdir = tempfile.mkdtemp(prefix="ytcover_")
    try:
        audio_path = download_audio(req.url, output_dir=_tmpdir)
    except RuntimeError as e:
        shutil.rmtree(_tmpdir, ignore_errors=True)
        return JSONResponse({"error": f"Download failed: {e}"}, status_code=400)

    # 2. Copy into ComfyUI input dir
    try:
        input_name = _client.copy_to_input(Path(audio_path))
    finally:
        shutil.rmtree(_tmpdir, ignore_errors=True)

    # 3. Build cover workflow
    state = {
        "steps": req.steps,
        "cfg_scale": req.cfg_scale,
        "duration": req.duration,
        "temperature": req.temperature,
        "top_p": req.top_p,
        "top_k": req.top_k,
        "min_p": req.min_p,
        "seed": req.seed,
        "lock_seed": req.lock_seed,
    }
    result = _client.build_cover_workflow(
        input_name=input_name,
        caption=req.tags.strip(),
        lyrics=req.lyrics,
        state=state,
        denoise=req.denoise,
    )
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    # 4. Send to ComfyUI
    send_result = _client.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse({"error": "ComfyUI unreachable: " + send_result["error"]}, status_code=400)

    prompt_id = send_result.get("prompt_id", "")
    tracker.register(prompt_id, user_email, req.song_name, seed=result.get("seed", 0),
                     caption=req.tags.strip(), lyrics=req.lyrics)
    q = tracker.get_queue_counts()
    return {"prompt_id": prompt_id, "queue_position": q["pending"]}
