from __future__ import annotations
import asyncio
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import config
from core.analyze import analyze
from core.comfyui import ComfyUIClient
from core.executor import get_audio_pool, stream_upload
from core.minimax_music3 import build_minimax_workflow
from nyx_step import get_user_email, tracker
from routes._helpers import submit_and_register

router = APIRouter(prefix="/api/jam")

JAM_DIR = config.COMFYUI_OUTPUT_DIR / "jams"
JAM_DIR.mkdir(parents=True, exist_ok=True)

MUSICGEN_URL = "http://127.0.0.1:8180"
_comfy = ComfyUIClient()


# ── Upload & Analyze ────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_jam(request: Request, audio: UploadFile = File(...)):
    """Save a jam recording and return BPM/key/duration analysis."""
    get_user_email(request)
    suffix = Path(audio.filename).suffix or ".mp3"
    tmp = await stream_upload(audio, suffix)
    if isinstance(tmp, JSONResponse):
        return tmp
    try:
        dest = JAM_DIR / tmp.name
        dest.write_bytes(tmp.read_bytes())
    finally:
        tmp.unlink(missing_ok=True)

    loop = asyncio.get_event_loop()
    analysis = await loop.run_in_executor(get_audio_pool(), lambda: analyze(dest))
    return {"filename": dest.name, "analysis": analysis}


# ── ACE-Step backing generation ─────────────────────────────────────────────

class JamGenerateRequest(BaseModel):
    jam_filename: str
    tags: str = "instrumental backing"
    bpm: int = Field(default=120, ge=40, le=300)
    key: str = "C"
    scale: str = "Major"
    duration: float = Field(default=30.0, ge=5.0, le=120.0)
    song_name: str = "Jam Backing"
    steps: int = Field(default=8, ge=1, le=150)
    cfg_scale: float = Field(default=2.0, ge=0.1, le=20.0)
    seed: int = Field(default=0, ge=0, le=4294967295)
    dit_model: str = "turbo"
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"


@router.post("/generate-backing")
async def generate_backing(req: JamGenerateRequest, request: Request):
    user_email = get_user_email(request)

    caption = req.tags.strip() or "instrumental backing"
    lyrics = ""
    state = {
        "bpm": req.bpm,
        "key": req.key,
        "scale": req.scale,
        "duration": float(req.duration),
        "steps": req.steps,
        "cfg_scale": req.cfg_scale,
        "seed": req.seed,
        "lock_seed": req.seed != 0,
        "dit_model": req.dit_model,
        "sampler_name": req.sampler_name,
        "scheduler": req.scheduler,
        "temperature": 0.85,
        "top_p": 0.9,
        "top_k": 0,
        "min_p": 0.0,
        "batch_size": 1,
        "lora_name": "",
        "lora_scale": 1.0,
        "lora2_name": "",
        "lora2_scale": 1.0,
        "negative_tags": "",
        "keep_parentheticals": False,
        "variance_mode": False,
        "variance_count": 1,
    }

    result = _comfy.build_workflow(caption, lyrics, state)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    safe_params = {
        k: v for k, v in state.items()
        if k not in ("lyrics", "negative_tags")
    }
    return submit_and_register(
        _comfy, user_email, result["workflow"], req.song_name,
        seed=result.get("seed", 0),
        caption=caption,
        lyrics=lyrics,
        params=safe_params,
        upstream_error_status=502,
    )


# ── MusicGen-melody local generation ────────────────────────────────────────

class MusicGenRequest(BaseModel):
    prompt: str = "upbeat guitar jam"
    jam_filename: str = ""
    duration: float = Field(default=8.0, ge=1.0, le=30.0)


@router.post("/musicgen")
async def musicgen_generate(req: MusicGenRequest, request: Request):
    """Generate music via local MusicGen-melody service, conditioned on jam audio."""
    get_user_email(request)

    import httpx as _httpx
    payload: dict = {
        "prompt": req.prompt,
        "duration": req.duration,
    }
    if req.jam_filename:
        jam_path = str(JAM_DIR / req.jam_filename)
        if not Path(jam_path).exists():
            return JSONResponse({"error": "Jam file not found"}, status_code=404)
        payload["audio_path"] = jam_path

    try:
        async with _httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(f"{MUSICGEN_URL}/generate", json=payload)
    except _httpx.ConnectError:
        return JSONResponse(
            {"error": "MusicGen service offline — start musicgen.service"},
            status_code=503,
        )
    except Exception as exc:
        return JSONResponse(
            {"error": f"MusicGen request failed: {exc}"},
            status_code=502,
        )

    if resp.status_code != 200:
        return JSONResponse(
            {"error": f"MusicGen error ({resp.status_code}): {resp.text[:300]}"},
            status_code=502,
        )

    # Save WAV bytes directly to jams dir
    import soundfile as sf
    import numpy as np
    import io
    wav_data, sr = sf.read(io.BytesIO(resp.content), dtype="float32")
    if wav_data.ndim > 1:
        wav_data = wav_data.mean(axis=1)
    stem = req.jam_filename.rsplit(".", 1)[0] if req.jam_filename else "generated"
    safe_prompt = "".join(c if c.isalnum() or c in " _-" else "_" for c in req.prompt[:20]).strip()
    out_name = f"musicgen_{stem}_{safe_prompt}.wav"
    out_path = JAM_DIR / out_name
    sf.write(str(out_path), wav_data, sr)
    return {
        "filename": out_name,
        "sampling_rate": sr,
        "duration": round(len(wav_data) / sr, 2),
    }


# ── MusicGen health check ──────────────────────────────────────────────────

@router.get("/musicgen/status")
async def musicgen_status(request: Request):
    import httpx as _httpx
    get_user_email(request)
    try:
        async with _httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{MUSICGEN_URL}/health")
            return resp.json()
    except Exception:
        return {"status": "offline"}


# ── MiniMax Music3 generation ─────────────────────────────────────────────

class MiniMaxRequest(BaseModel):
    caption: str = "acoustic guitar, piano, cello, brushed snare, female vocal"
    lyrics: str = "[Verse]\nWhispered words in the morning light"
    duration: float = Field(default=120.0, ge=5.0, le=300.0)
    seed: int = Field(default=0, ge=0, le=4294967295)
    cfg_scale: float = Field(default=7.0, ge=1.0, le=20.0)
    top_k: int = Field(default=250, ge=1, le=1000)
    save_format: str = "mp3"
    song_name: str = "MiniMax Song"


@router.post("/minimax")
async def minimax_generate(req: MiniMaxRequest, request: Request):
    """Generate a song via MiniMax Music3 through ComfyUI."""
    user_email = get_user_email(request)

    seed = req.seed if req.seed != 0 else None
    result = build_minimax_workflow(
        caption=req.caption,
        lyrics=req.lyrics,
        duration=req.duration,
        seed=seed,
        cfg_scale=req.cfg_scale,
        top_k=req.top_k,
        save_format=req.save_format,
    )

    send_result = _comfy.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse(
            {"error": "ComfyUI unreachable: " + send_result["error"]},
            status_code=502,
        )

    prompt_id = send_result.get("prompt_id", "")
    safe_params = {
        "caption": req.caption,
        "duration": req.duration,
        "cfg_scale": req.cfg_scale,
        "top_k": req.top_k,
        "save_format": req.save_format,
        "engine": "minimax_music3",
    }
    tracker.register(
        prompt_id, user_email, req.song_name,
        seed=result.get("seed", 0),
        caption=req.caption,
        lyrics=req.lyrics,
        params=safe_params,
    )
    q = tracker.get_queue_counts()
    return {"prompt_id": prompt_id, "queue_position": q["pending"]}
