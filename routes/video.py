from __future__ import annotations
import asyncio
import logging
import requests
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import config
from core.beat_analyser import analyse
from core.executor import get_audio_pool
from core.video_orchestrator import create_job, get_job, run_video_job
from nyx_step import get_user_email

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/video")


class AnalyseRequest(BaseModel):
    audio_file: str
    chunk_seconds: float = Field(default=6.0, ge=1.0, le=30.0)
    fps: float = Field(default=16.0, ge=8.0, le=30.0)
    sync_mode: str = "both"
    lyrics: str = ""
    bpm_hint: float | None = None


class GenerateRequest(BaseModel):
    schedule: dict
    section_prompts: dict
    settings: dict


class SuggestPromptsRequest(BaseModel):
    sections: list[str]
    genre: str = ""
    caption: str = ""
    style: str = "cinematic"
    ollama_model: str = "gemma4:latest"


@router.post("/analyse")
async def analyse_audio(request: Request, body: AnalyseRequest):
    get_user_email(request)
    loop = asyncio.get_event_loop()
    try:
        schedule = await loop.run_in_executor(
            get_audio_pool(),
            lambda: analyse(
                body.audio_file,
                chunk_seconds=body.chunk_seconds,
                fps=body.fps,
                sync_mode=body.sync_mode,
                lyrics=body.lyrics,
                bpm_hint=body.bpm_hint,
            )
        )
    except FileNotFoundError:
        return JSONResponse({"error": f"Audio file not found: {body.audio_file}"}, status_code=400)
    except Exception as exc:
        logger.exception("Beat analysis failed")
        return JSONResponse({"error": str(exc)}, status_code=500)
    return schedule


@router.post("/suggest-prompts")
async def suggest_prompts(request: Request, body: SuggestPromptsRequest):
    get_user_email(request)
    style_desc = {
        "abstract": "abstract art with flowing shapes and colors",
        "cinematic": "cinematic film scene with dramatic lighting",
        "artistic": "detailed oil painting illustration",
    }.get(body.style, "cinematic film scene")

    def _ask_ollama(section: str) -> str:
        prompt_text = (
            f"Write a 20-word visual scene description for a music video. "
            f"Style: {style_desc}. Genre: {body.genre}. Section: {section}. "
            f"Caption: {body.caption[:200]}. Be specific and visual. No lyrics."
        )
        try:
            resp = requests.post(
                f"{config.OLLAMA_URL}/api/generate",
                json={"model": body.ollama_model, "prompt": prompt_text, "stream": False},
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json().get("response", "").strip()[:200]
        except Exception:
            return f"{section} visual scene"

    loop = asyncio.get_event_loop()
    results: dict[str, str] = {}
    for section in body.sections:
        s = section
        text = await loop.run_in_executor(get_audio_pool(), lambda sec=s: _ask_ollama(sec))
        results[section] = text or f"{section} visual scene"

    return {"prompts": results}


@router.post("/generate")
async def generate_video(
    request: Request,
    body: GenerateRequest,
    background_tasks: BackgroundTasks,
):
    user_email = get_user_email(request)
    chunks = body.schedule.get("chunks", [])
    job_id = create_job(total_chunks=len(chunks), user_email=user_email)

    async def _run():
        await run_video_job(job_id, body.schedule, body.section_prompts, body.settings)

    background_tasks.add_task(_run)
    return {"job_id": job_id, "chunks_total": len(chunks)}


@router.get("/status/{job_id}")
async def video_status(request: Request, job_id: str):
    get_user_email(request)
    state = get_job(job_id)
    if state is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    return state


@router.get("/download/{job_id}")
async def download_video(request: Request, job_id: str):
    get_user_email(request)
    state = get_job(job_id)
    if state is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    if state["status"] != "done" or not state.get("output_file"):
        return JSONResponse({"error": "Video not ready"}, status_code=404)
    out = Path(state["output_file"])
    if not out.exists():
        return JSONResponse({"error": "Output file missing"}, status_code=404)
    return FileResponse(
        str(out),
        media_type="video/mp4",
        filename=f"nyx_video_{job_id[:8]}.mp4",
    )
