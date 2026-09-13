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


# ── ACE-Step Complete — keep the instrumental, add vocals ────────────────────

_VOCAL_DESCRIPTOR = "clear lead vocals singing the lyrics"


def _measure_jam_duration(jam_path: Path) -> float:
    """Return the jam's length in seconds (0.0 when it cannot be read)."""
    import json as _json
    import subprocess

    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(jam_path)],
            capture_output=True, text=True, timeout=10,
        )
        return float(_json.loads(probe.stdout)["format"]["duration"])
    except Exception:
        return 0.0


def _build_lyric_song_workflow(req, caption: str, lyrics: str, jam_path: Path, seed: int | None = None) -> dict:
    """Build a reference-free ACE-Step workflow that actually sings the lyrics.

    The previous lego path attached the jam via ReferenceTimbreAudio, which puts
    the model into cover mode — it re-tokenizes the reference and drops the LLM
    audio codes, so an instrumental reference comes back instrumental (a washed
    pad, no singer). Generating without a reference keeps the audio-codes path
    so the LM sings the supplied lyrics; vocals are harvested downstream.
    """
    user_duration = float(req.duration or 0) if req.duration else 0.0
    duration = _measure_jam_duration(jam_path) or user_duration or 30.0
    if not any(word in caption.lower() for word in ("vocal", "voice", "sing")):
        caption = f"{caption}, {_VOCAL_DESCRIPTOR}"
    style = getattr(req, "vocal_style", "") or ""
    if style.strip() and not any(word in style.lower() for word in caption.lower().split()):
        caption = f"{caption}, {style.strip()}"

    gen_seed = int(seed if seed is not None else getattr(req, "seed", 0) or 0)
    state = {
        "bpm": req.bpm, "key": req.key, "scale": req.scale,
        "steps": req.steps, "cfg_scale": req.cfg, "duration": duration,
        "seed": gen_seed, "lock_seed": gen_seed != 0,
        "audio_format": req.audio_format, "audio_quality": req.audio_quality,
        "dit_model": req.dit_model, "sampler_name": req.sampler_name,
        "scheduler": req.scheduler, "temperature": req.temperature,
        "top_p": req.top_p, "top_k": req.top_k, "min_p": req.min_p,
        "generate_audio_codes": True, "denoise": 1.0, "batch_size": 1,
    }
    return _comfy.build_workflow(caption, lyrics, state)


class JamCompleteRequest(BaseModel):
    jam_filename: str
    caption: str = "instrumental backing"
    lyrics: str = ""
    song_name: str = "Jam Song"
    denoise: float = Field(default=0.8, ge=0.1, le=0.95)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=2.0, ge=0.1, le=20.0)
    duration: float = Field(default=30.0, ge=5.0, le=120.0)
    seed: int = Field(default=0, ge=0, le=4294967295)
    bpm: int = Field(default=120, ge=40, le=300)
    key: str = "C"
    scale: str = "Major"
    audio_format: str = "mp3"
    audio_quality: str = "V0"
    dit_model: str = "sft"
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"
    temperature: float = Field(default=0.85, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    top_k: int = Field(default=0, ge=0, le=1000)
    min_p: float = Field(default=0.0, ge=0.0, le=1.0)


@router.post("/complete")
async def jam_complete(req: JamCompleteRequest, request: Request):
    """ACE-Step song generation from the jam's feel + the provided lyrics.

    Generation is reference-free (the lego cover path drops the audio codes and
    cannot sing over an instrumental), so the result is a full song with vocals
    in the jam's detected key/BPM/chords.
    """
    user_email = get_user_email(request)

    jam_path = JAM_DIR / req.jam_filename
    if not jam_path.exists():
        return JSONResponse(
            {"error": "Jam file not found on server — please upload it again (step 1)"},
            status_code=404,
        )

    caption = req.caption.strip() or "instrumental backing"
    lyrics = req.lyrics.strip()
    if not lyrics:
        return JSONResponse(
            {"error": "No lyrics to sing — generate them with the AI step, then Copy to MiniMax, then Complete."},
            status_code=400,
        )

    result = _build_lyric_song_workflow(req, caption, lyrics, jam_path)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    return submit_and_register(
        _comfy, user_email, result["workflow"], req.song_name,
        seed=result.get("seed", 0), caption=caption, lyrics=lyrics,
        upstream_error_status=502,
        params={"bpm": req.bpm, "key": req.key, "scale": req.scale,
                "steps": req.steps, "cfg_scale": req.cfg, "duration": req.duration,
                "engine": "ace_step_complete"},
    )


# ── Vocals-only mixdown — keep the original jam, add lyrics on top ──────────

class JamVocalizeRequest(BaseModel):
    jam_filename: str
    caption: str = "instrumental backing"
    lyrics: str = ""
    song_name: str = "Jam Song"
    denoise: float = Field(default=0.8, ge=0.1, le=0.95)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=2.0, ge=0.1, le=20.0)
    duration: float = Field(default=30.0, ge=5.0, le=120.0)
    seed: int = Field(default=0, ge=0, le=4294967295)
    bpm: int = Field(default=120, ge=40, le=300)
    key: str = "C"
    scale: str = "Major"
    vocal_style: str = ""
    vocal_gain_db: float = Field(default=0.0, ge=-12.0, le=12.0)
    duck_jam: bool = False
    takes: int = Field(default=1, ge=1, le=3)
    pitch_lock: bool = False
    audio_format: str = "mp3"
    audio_quality: str = "V0"
    dit_model: str = "sft"
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"
    temperature: float = Field(default=0.85, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    top_k: int = Field(default=0, ge=0, le=1000)
    min_p: float = Field(default=0.0, ge=0.0, le=1.0)


@router.post("/vocalize")
async def jam_vocalize(req: JamVocalizeRequest, request: Request):
    """Add AI lyrics on top of the SAME instrumental.

    Queues a reference-free ACE-Step job conditioned on the jam's feel (so the
    LM actually sings the lyrics — the reference/lego path drops the audio codes
    and cannot produce a vocal over an instrumental), then post-processes:
    Demucs-isolates the vocal stem and ffmpeg mixes it over the ORIGINAL
    uploaded instrumental — the song itself is not regenerated or replaced.
    """
    user_email = get_user_email(request)

    jam_path = JAM_DIR / req.jam_filename
    if not jam_path.exists():
        return JSONResponse(
            {"error": "Jam file not found on server — please upload it again (step 1)"},
            status_code=404,
        )

    caption = req.caption.strip() or "instrumental backing"
    lyrics = req.lyrics.strip()
    if not lyrics:
        return JSONResponse(
            {"error": "No lyrics to sing — generate them with the AI step first."},
            status_code=400,
        )

    submitted = []
    for i in range(req.takes):
        take_seed = (int(req.seed) + i) % 4294967296
        result = _build_lyric_song_workflow(req, caption, lyrics, jam_path, seed=take_seed)
        if "error" in result:
            return JSONResponse({"error": result["error"]}, status_code=400)
        params = {
            "bpm": req.bpm, "key": req.key, "scale": req.scale,
            "steps": req.steps, "cfg_scale": req.cfg, "duration": req.duration,
            "denoise": req.denoise, "jam_filename": req.jam_filename,
            "engine": "jam_vocals", "seed": take_seed,
            "take_index": i, "takes": req.takes,
            "vocal_gain_db": req.vocal_gain_db, "duck_jam": req.duck_jam,
            "pitch_lock": req.pitch_lock,
        }
        out = submit_and_register(
            _comfy, user_email, result["workflow"], req.song_name,
            seed=take_seed, caption=caption, lyrics=lyrics,
            upstream_error_status=502,
            params=params,
        )
        if isinstance(out, JSONResponse):
            return out
        submitted.append(out)

    queue_position = tracker.get_queue_counts()["pending"]
    resp: dict = {"prompt_ids": [s.get("prompt_id", "") for s in submitted], "count": req.takes}
    if submitted:
        resp["prompt_id"] = submitted[0].get("prompt_id", "")
    resp["queue_position"] = queue_position
    return resp


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
