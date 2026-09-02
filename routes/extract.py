from __future__ import annotations
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import config
from core.comfyui import ComfyUIClient
from nyx_step import tracker, get_user_email

router = APIRouter()
_client = ComfyUIClient()


@router.post("/extract")
async def extract_generate(
    request: Request,
    audio: UploadFile = File(...),
    tags: str = Form(""),
    lyrics: str = Form(""),
    song_name: str = Form("Extract"),
    denoise: float = Form(0.98),
    steps: int = Form(20),
    cfg: float = Form(2.0),
    duration: float = Form(30.0),
    seed: int = Form(0),
    bpm: int = Form(120),
    key: str = Form("C"),
    scale: str = Form("Major"),
    audio_format: str = Form("mp3"),
    audio_quality: str = Form("V0"),
    dit_model: str = Form("sft"),
    sampler_name: str = Form("er_sde"),
    scheduler: str = Form("linear_quadratic"),
):
    user_email = get_user_email(request)
    content = await audio.read()
    if len(content) > config.MAX_UPLOAD_BYTES:
        return JSONResponse({"error": f"File too large (max {config.MAX_UPLOAD_BYTES // 1024 // 1024} MB)"}, status_code=413)

    suffix = Path(audio.filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(content)
        tmp = Path(f.name)
    try:
        input_name = _client.copy_to_input(tmp)
    finally:
        with suppress(FileNotFoundError):
            tmp.unlink()

    state = {
        "bpm": bpm, "key": key, "scale": scale,
        "steps": steps, "cfg_scale": cfg, "duration": duration,
        "seed": seed, "lock_seed": seed != 0,
        "audio_format": audio_format, "audio_quality": audio_quality,
        "dit_model": dit_model, "sampler_name": sampler_name, "scheduler": scheduler,
    }
    result = _client.build_extract_workflow(input_name, tags, lyrics, state, denoise)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    send_result = _client.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse({"error": send_result["error"]}, status_code=502)

    prompt_id = send_result.get("prompt_id", "")
    tracker.register(prompt_id, user_email, song_name, caption=tags, seed=result.get("seed", 0),
                     params={"bpm": bpm, "key": key, "scale": scale, "steps": steps,
                             "cfg_scale": cfg, "duration": duration})
    return {"prompt_id": prompt_id}


class _Region(BaseModel):
    start: float
    end: float


class _MultiRepaintRequest(BaseModel):
    filename: str
    tags: str = ""
    lyrics: str = ""
    song_name: str = "MultiRepaint"
    denoise: float = 0.7
    steps: int = 20
    cfg: float = 2.0
    seed: int = 0
    bpm: int = 120
    key: str = "C"
    scale: str = "Major"
    audio_format: str = "mp3"
    audio_quality: str = "V0"
    dit_model: str = "sft"
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"
    regions: List[_Region] = []


@router.post("/multirepaint")
async def multirepaint_generate(request: Request, body: _MultiRepaintRequest):
    user_email = get_user_email(request)

    source_path = config.COMFYUI_OUTPUT_DIR / body.filename
    if not source_path.exists():
        return JSONResponse({"error": f"Source file not found: {body.filename}"}, status_code=404)

    input_name = _client.copy_to_input(source_path)

    regions = [{"start": r.start, "end": r.end} for r in body.regions]
    state = {
        "bpm": body.bpm, "key": body.key, "scale": body.scale,
        "steps": body.steps, "cfg_scale": body.cfg,
        "seed": body.seed, "lock_seed": body.seed != 0,
        "audio_format": body.audio_format, "audio_quality": body.audio_quality,
        "dit_model": body.dit_model, "sampler_name": body.sampler_name,
        "scheduler": body.scheduler,
    }
    result = _client.build_multirepaint_workflow(input_name, body.tags, body.lyrics, state, regions, body.denoise)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    send_result = _client.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse({"error": send_result["error"]}, status_code=502)

    prompt_id = send_result.get("prompt_id", "")
    tracker.register(prompt_id, user_email, body.song_name, caption=body.tags, seed=result.get("seed", 0),
                     params={"bpm": body.bpm, "key": body.key, "scale": body.scale,
                             "steps": body.steps, "cfg_scale": body.cfg, "regions": len(regions)})
    return {"prompt_id": prompt_id}
