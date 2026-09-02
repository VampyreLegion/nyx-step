from __future__ import annotations
import tempfile
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse

import config
from core.comfyui import ComfyUIClient
from nyx_step import get_user_email
from routes._helpers import submit_and_register

router = APIRouter()
_client = ComfyUIClient()


@router.post("/lego")
async def lego_generate(
    request: Request,
    audio: UploadFile = File(...),
    tags: str = Form(""),
    lyrics: str = Form(""),
    song_name: str = Form("Lego"),
    denoise: float = Form(0.5),
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
        "generate_audio_codes": True,
    }
    result = _client.build_lego_workflow(input_name, tags, lyrics, state, denoise)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    return submit_and_register(
        _client, user_email, result["workflow"], song_name,
        seed=result.get("seed", 0), caption=tags,
        upstream_error_status=502,
        params={"bpm": bpm, "key": key, "scale": scale, "steps": steps,
                "cfg_scale": cfg, "duration": duration},
    )


@router.post("/complete")
async def complete_generate(
    request: Request,
    audio: UploadFile = File(...),
    tags: str = Form(""),
    lyrics: str = Form(""),
    song_name: str = Form("Complete"),
    denoise: float = Form(0.8),
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
        "generate_audio_codes": True,
    }
    result = _client.build_lego_workflow(input_name, tags, lyrics, state, denoise)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    return submit_and_register(
        _client, user_email, result["workflow"], song_name,
        seed=result.get("seed", 0), caption=tags,
        upstream_error_status=502,
        params={"bpm": bpm, "key": key, "scale": scale, "steps": steps,
                "cfg_scale": cfg, "duration": duration},
    )
