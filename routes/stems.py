from __future__ import annotations
import asyncio
import json
from contextlib import suppress
from pathlib import Path
from typing import AsyncGenerator

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse

import config
from core.comfyui import ComfyUIClient
from core.demucs import run_demucs
from core.executor import get_audio_pool, stream_upload
from nyx_step import tracker, get_user_email

router = APIRouter(prefix="/stems")
_client = ComfyUIClient()


@router.post("/extract")
async def stems_extract(
    request: Request,
    audio: UploadFile = File(...),
    steps: int = Form(8),
    seed: int = Form(0),
    duration: float = Form(30.0),
    song_name: str = Form("Stem Extract"),
):
    user_email = get_user_email(request)
    suffix = Path(audio.filename).suffix or ".mp3"
    tmp = await stream_upload(audio, suffix)
    if isinstance(tmp, JSONResponse):
        return tmp
    try:
        filename = _client.copy_to_input(tmp)
    finally:
        with suppress(FileNotFoundError):
            tmp.unlink()

    state = {"steps": steps, "seed": seed, "duration": duration, "lock_seed": False}
    result = _client.build_workflow("", "", state, config.WORKFLOW_EXTRACT_TEMPLATE)
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)

    workflow = result["workflow"]
    for node in workflow.values():
        if isinstance(node, dict) and node.get("class_type") == "LoadAudio":
            node.setdefault("inputs", {})["audio"] = filename

    send_result = _client.send_workflow(workflow)
    if "error" in send_result:
        return JSONResponse({"error": send_result["error"]}, status_code=502)

    prompt_id = send_result.get("prompt_id", "")
    tracker.register(prompt_id, user_email, song_name, seed=result.get("seed", 0))
    return {"prompt_id": prompt_id}


@router.get("/audio-files")
async def list_audio_files():
    exts = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}
    files = sorted(
        (f for f in config.COMFYUI_OUTPUT_DIR.iterdir() if f.suffix.lower() in exts and f.is_file()),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    return {"files": [f.name for f in files[:100]]}


@router.post("/demucs/upload")
async def demucs_upload(audio: UploadFile = File(...), request: Request = None):
    """Upload a local file into COMFYUI_OUTPUT_DIR for demucs processing."""
    if request:
        get_user_email(request)
    suffix = Path(audio.filename).suffix or ".mp3"
    tmp = await stream_upload(audio, suffix)
    if isinstance(tmp, JSONResponse):
        return tmp
    safe_name = Path(audio.filename).name
    dest = config.COMFYUI_OUTPUT_DIR / safe_name
    tmp.rename(dest)
    return {"filename": safe_name}


@router.get("/demucs/stream")
async def demucs_stream(
    request: Request,
    filename: str,
    model: str = "htdemucs",
):
    input_path = config.COMFYUI_OUTPUT_DIR / filename

    async def log_gen() -> AsyncGenerator[dict, None]:
        loop = asyncio.get_event_loop()

        def _run():
            return list(run_demucs(input_path, model))

        lines = await loop.run_in_executor(get_audio_pool(), _run)
        for line in lines:
            if await request.is_disconnected():
                break
            yield {"event": "log", "data": json.dumps({"line": line})}
        yield {"event": "done", "data": "{}"}

    return EventSourceResponse(log_gen())


@router.get("/demucs/files")
async def demucs_files(filename: str, model: str = "htdemucs"):
    """List separated stem files for a given source filename and model."""
    track_name = Path(filename).stem
    stem_dir = config.DEMUCS_OUTPUT_DIR / model / track_name
    if not stem_dir.exists():
        return {"stems": []}
    stems = sorted(stem_dir.glob("*.mp3")) + sorted(stem_dir.glob("*.wav"))
    return {"stems": [f.name for f in stems], "model": model, "track": track_name}


@router.get("/demucs/download/{model}/{track}/{stem_file}")
async def demucs_download(model: str, track: str, stem_file: str, request: Request):
    """Download an individual separated stem file."""
    get_user_email(request)
    safe_model = Path(model).name
    safe_track = Path(track).name
    safe_stem = Path(stem_file).name
    file_path = config.DEMUCS_OUTPUT_DIR / safe_model / safe_track / safe_stem
    if not file_path.exists():
        return JSONResponse({"error": "Stem file not found"}, status_code=404)
    return FileResponse(
        path=str(file_path),
        media_type="audio/mpeg",
        headers={"Content-Disposition": f'attachment; filename="{safe_stem}"'},
    )
