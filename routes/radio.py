"""
Continuous AI Radio — chains Nyx-Step generations so each segment uses the
previous segment's audio as a timbre reference, creating an ever-evolving
stream that stays sonically coherent.

Architecture:
  • POST /radio/start  — starts the session (submits segment 0 as a standard gen)
  • POST /radio/stop   — halts after the current segment finishes
  • GET  /radio/events — SSE stream: {type: segment|stopped|error, file, segment}
  • GET  /radio/status — current state snapshot (JSON)

The _watcher background thread polls the job tracker every 3 s.  When a
segment completes it copies the output to ComfyUI input, submits the next
workflow (build_radio_continue_workflow), and updates _state so the SSE
endpoint picks it up on its next poll.
"""
from __future__ import annotations
import asyncio
import logging
import threading
import time
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import config
from core.comfyui import ComfyUIClient
from musicweb import tracker, get_user_email

logger = logging.getLogger(__name__)
router = APIRouter()
_client = ComfyUIClient()

# ── Shared radio state ─────────────────────────────────────────────────────────
_state: dict = {
    "active": False,
    "prompt_id": None,
    "segment": 0,           # segments *completed* (0 = nothing done yet)
    "last_file": None,      # filename of the latest completed segment
    "history": [],
    "settings": {},
    "user_email": None,
    "error": None,
}
_lock = threading.Lock()
_watcher_started = False


# ── Background watcher ─────────────────────────────────────────────────────────
def _copy_output_to_input(filename: str) -> str | None:
    """Copy a ComfyUI output file into ComfyUI's input dir. Returns input filename."""
    # Primary: COMFYUI_OUTPUT_DIR is output/audio/ so plain filenames live here
    src = config.COMFYUI_OUTPUT_DIR / filename
    if not src.exists():
        # Search entire ComfyUI output tree (handles any subfolder)
        base = config.COMFYUI_OUTPUT_DIR.parent
        for p in base.rglob(filename):
            src = p
            break
    if not src.exists():
        logger.warning("Radio: output file not found: %s", filename)
        return None
    dest = config.COMFYUI_INPUT_DIR / f"radio_ref_{src.name}"
    shutil.copy2(src, dest)
    return dest.name


def _submit_radio_segment(user_email: str, prev_file: str | None, settings: dict, seg_num: int) -> str:
    """Build and submit one radio segment. Returns prompt_id."""
    caption = settings.get("tags", "")
    song_name = f"Radio S{seg_num:03d}"

    if prev_file is None:
        # First segment — standard generation (no timbre reference)
        state_dict = {
            "bpm": settings.get("bpm", 120),
            "key": settings.get("key", "C"),
            "scale": settings.get("scale", "Major"),
            "steps": settings.get("steps", 20),
            "cfg_scale": settings.get("cfg", 2.0),
            "duration": settings.get("duration", 30),
            "seed": 0, "lock_seed": False,
            "audio_format": settings.get("audio_format", "mp3"),
            "audio_quality": settings.get("audio_quality", "V0"),
            "dit_model": settings.get("dit_model", "turbo"),
            "sampler_name": settings.get("sampler_name", "er_sde"),
            "scheduler": settings.get("scheduler", "linear_quadratic"),
            "generate_audio_codes": True,
        }
        result = _client.build_workflow(caption, "", state_dict)
        # Rename save node prefix so segment 0 also uses Nyx_radio naming
        if "workflow" in result:
            for node in result["workflow"].values():
                if isinstance(node, dict) and node.get("class_type") in (
                    "SaveAudioMP3", "SaveAudio", "SaveAudioOpus"
                ):
                    node.setdefault("inputs", {})["filename_prefix"] = "audio/Nyx_radio"
    else:
        input_name = _copy_output_to_input(prev_file)
        if input_name is None:
            raise RuntimeError(f"Cannot find previous segment: {prev_file}")
        state_dict = {
            "bpm": settings.get("bpm", 120),
            "key": settings.get("key", "C"),
            "scale": settings.get("scale", "Major"),
            "steps": settings.get("steps", 20),
            "cfg_scale": settings.get("cfg", 2.0),
            "duration": settings.get("duration", 30),
            "audio_format": settings.get("audio_format", "mp3"),
            "audio_quality": settings.get("audio_quality", "V0"),
            "dit_model": settings.get("dit_model", "turbo"),
            "sampler_name": settings.get("sampler_name", "er_sde"),
            "scheduler": settings.get("scheduler", "linear_quadratic"),
        }
        result = _client.build_radio_continue_workflow(input_name, caption, state_dict)

    if "error" in result:
        raise RuntimeError(result["error"])

    send = _client.send_workflow(result["workflow"])
    if "error" in send:
        raise RuntimeError(send["error"])

    pid = send["prompt_id"]
    tracker.register(pid, user_email, song_name, caption=caption, seed=result.get("seed", 0),
                     params={"radio": True, "segment": seg_num})
    return pid


def _watcher():
    global _state
    while True:
        time.sleep(3)
        try:
            with _lock:
                if not _state["active"]:
                    continue
                pid = _state["prompt_id"]
                if not pid:
                    continue

            job = tracker.get(pid)
            if not job:
                continue

            if job.status == "error":
                with _lock:
                    _state["active"] = False
                    _state["error"] = f"Generation error: {job.error_msg or 'unknown'}"
                continue

            if job.status != "done":
                continue

            # Segment done
            files = job.output_files
            if not files:
                with _lock:
                    _state["active"] = False
                    _state["error"] = "Segment produced no output"
                continue

            output_file = files[0]

            with _lock:
                still_active = _state["active"]
                settings = _state["settings"].copy()
                user_email = _state["user_email"]
                next_seg = _state["segment"] + 1

            if not still_active:
                # Stopped by user before this segment registered
                with _lock:
                    _state["last_file"] = output_file
                    _state["history"].append(output_file)
                    _state["segment"] = next_seg
                continue

            # Update state so SSE clients see new segment
            with _lock:
                _state["last_file"] = output_file
                _state["history"].append(output_file)
                _state["segment"] = next_seg
                _state["error"] = None

            # Queue next segment
            try:
                next_pid = _submit_radio_segment(user_email, output_file, settings, next_seg)
                with _lock:
                    if _state["active"]:
                        _state["prompt_id"] = next_pid
            except Exception as exc:
                logger.error("Radio: failed to submit segment %d: %s", next_seg, exc)
                with _lock:
                    _state["active"] = False
                    _state["error"] = str(exc)

        except Exception as exc:
            logger.warning("Radio watcher unexpected error: %s", exc)


def _ensure_watcher():
    global _watcher_started
    if not _watcher_started:
        t = threading.Thread(target=_watcher, daemon=True, name="radio-watcher")
        t.start()
        _watcher_started = True


# ── Pydantic model ─────────────────────────────────────────────────────────────
class RadioStartRequest(BaseModel):
    tags: str = ""
    bpm: int = 120
    key: str = "C"
    scale: str = "Major"
    steps: int = 20
    cfg: float = 2.0
    duration: float = 30.0
    audio_format: str = "mp3"
    audio_quality: str = "V0"
    dit_model: str = "turbo"
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"


# ── Routes ─────────────────────────────────────────────────────────────────────
@router.post("/radio/start")
async def radio_start(request: Request, body: RadioStartRequest):
    user_email = get_user_email(request)
    _ensure_watcher()

    with _lock:
        if _state["active"]:
            return JSONResponse({"error": "Radio already running"}, status_code=409)

    settings = body.model_dump()
    try:
        pid = _submit_radio_segment(user_email, None, settings, 0)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)

    with _lock:
        _state.update({
            "active": True,
            "prompt_id": pid,
            "segment": 0,
            "last_file": None,
            "history": [],
            "settings": settings,
            "user_email": user_email,
            "error": None,
        })

    return {"status": "started", "prompt_id": pid}


@router.post("/radio/stop")
async def radio_stop():
    with _lock:
        _state["active"] = False
    return {"status": "stopped", "segments": _state["segment"]}


@router.get("/radio/status")
async def radio_status():
    with _lock:
        return {
            "active": _state["active"],
            "segment": _state["segment"],
            "last_file": _state["last_file"],
            "history": list(_state["history"]),
            "error": _state["error"],
        }


@router.get("/radio/events")
async def radio_events(request: Request):
    """SSE stream.  Poll every 2 s; emit when segment number advances."""
    last_seen = -1

    async def generate():
        nonlocal last_seen
        yield "data: {\"type\": \"connected\"}\n\n"
        while True:
            if await request.is_disconnected():
                break
            with _lock:
                active = _state["active"]
                seg = _state["segment"]
                last_file = _state["last_file"]
                error = _state["error"]

            if error:
                yield f"data: {json.dumps({'type': 'error', 'message': error})}\n\n"
                break

            if seg > last_seen and last_file:
                last_seen = seg
                yield f"data: {json.dumps({'type': 'segment', 'file': last_file, 'segment': seg})}\n\n"

            if not active and seg > 0:
                yield f"data: {json.dumps({'type': 'stopped', 'segment': seg})}\n\n"
                break

            # keepalive comment
            yield ": heartbeat\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
