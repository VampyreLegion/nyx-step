from __future__ import annotations
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from core.rate_limit import check as rate_check
from core.youtube import download_audio
from nyx_step import tracker, get_user_email

router = APIRouter()


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

    # 2. Copy into ComfyUI output dir so /download/ can serve it
    import config
    import uuid
    try:
        src = Path(audio_path)
        dest_name = f"ytcover_{uuid.uuid4().hex[:8]}{src.suffix}"
        dest = config.COMFYUI_OUTPUT_DIR / dest_name
        config.COMFYUI_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src), str(dest))
    finally:
        shutil.rmtree(_tmpdir, ignore_errors=True)

    # 3. Register in tracker so /download/ ownership check passes
    prompt_id = f"ytcover_{uuid.uuid4().hex}"
    tracker.register(prompt_id, user_email, req.song_name, caption=req.tags.strip(), lyrics=req.lyrics)
    tracker.update(prompt_id, status="done", output_files=[dest_name])

    return {"prompt_id": prompt_id, "files": [dest_name]}
