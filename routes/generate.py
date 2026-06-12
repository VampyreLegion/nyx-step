from __future__ import annotations
import asyncio
import json
import re
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from core.comfyui import ComfyUIClient
from core.rate_limit import check as rate_check
from nyx_step import tracker, get_user_email

router = APIRouter()
_client = ComfyUIClient()


@router.get("/loras")
async def list_loras():
    try:
        import requests as _req
        import config as _cfg
        r = _req.get(f"{_cfg.COMFYUI_URL}/models/loras", timeout=5)
        r.raise_for_status()
        return {"loras": r.json()}
    except Exception as exc:
        return {"loras": [], "error": str(exc)}


class GenerateRequest(BaseModel):
    tags: str = ""
    lyrics: str = ""
    genre: str = ""
    bpm: int = Field(default=120, ge=40, le=300)
    key: str = "C"
    scale: str = "Major"
    mode: str = ""
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
    song_name: str = "Untitled"
    audio_format: str = "mp3"
    audio_quality: str = "V0"
    vocal_language: str = "auto"
    generate_audio_codes: bool = True
    dit_model: str = "turbo"
    batch_size: int = Field(default=1, ge=1, le=8)
    lora_name: str = ""
    lora_scale: float = Field(default=1.0, ge=0.0, le=2.0)
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"
    lora2_name: str = ""
    lora2_scale: float = Field(default=1.0, ge=0.0, le=2.0)
    negative_tags: str = ""


@router.post("/generate")
async def generate(req: GenerateRequest, request: Request):
    user_email = get_user_email(request)

    if not rate_check(f"generate:{user_email}"):
        return JSONResponse({"error": "Rate limit exceeded — slow down"}, status_code=429)

    state = req.model_dump()
    caption = req.tags.strip()
    # Strip parenthetical content — ACE-Step sings everything verbatim,
    # so (backing vocal cues) / (oh yeah) end up being performed as lyrics.
    lyrics = re.sub(r'\([^)]*\)', '', req.lyrics)
    lyrics = re.sub(r'\n{3,}', '\n\n', lyrics).strip()

    result = _client.build_workflow(caption, lyrics, state)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    send_result = _client.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse({"error": "ComfyUI unreachable: " + send_result["error"]}, status_code=400)

    prompt_id = send_result.get("prompt_id", "")
    safe_params = {k: v for k, v in state.items() if k not in ("lyrics", "tags")}
    tracker.register(prompt_id, user_email, req.song_name, seed=result.get("seed", 0),
                     caption=caption, lyrics=lyrics, params=safe_params)

    q = tracker.get_queue_counts()
    return {"prompt_id": prompt_id, "queue_position": q["pending"]}


@router.get("/events")
async def events(request: Request):
    user_email = get_user_email(request)

    # Pre-seed with already-terminal statuses so stale completed jobs don't
    # replay as job_done events on every new browser connection.
    # In-progress (queued/running) jobs are left unseeded so their current
    # status fires immediately on the first poll.
    my_jobs = tracker.get_user_jobs(user_email)
    last_statuses: dict[str, str] = {
        j.prompt_id: j.status
        for j in my_jobs
        if j.status in ("done", "error")
    }

    async def generate_events() -> AsyncGenerator[dict, None]:
        while True:
            if await request.is_disconnected():
                break

            my_jobs = tracker.get_user_jobs(user_email)
            for job in my_jobs:
                prev = last_statuses.get(job.prompt_id)
                if prev != job.status:
                    last_statuses[job.prompt_id] = job.status
                    if job.status == "done":
                        yield {
                            "event": "job_done",
                            "data": json.dumps({
                                "prompt_id": job.prompt_id,
                                "files": job.output_files,
                                "song_name": job.song_name,
                            }),
                        }
                    elif job.status == "running":
                        yield {"event": "job_running", "data": json.dumps({"prompt_id": job.prompt_id, "song_name": job.song_name})}
                    elif job.status == "error":
                        yield {"event": "job_error", "data": json.dumps({"prompt_id": job.prompt_id, "message": job.error_msg})}

            counts = tracker.get_queue_counts()
            yield {"event": "queue_update", "data": json.dumps(counts)}

            await asyncio.sleep(2)

    return EventSourceResponse(generate_events())
