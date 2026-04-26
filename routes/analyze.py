from __future__ import annotations
import asyncio
import concurrent.futures
import tempfile
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse

import config
from core.analyze import analyze, transcribe
from musicweb import get_user_email

router = APIRouter()
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)


@router.post("/analyze")
async def analyze_audio(request: Request, audio: UploadFile = File(...)):
    get_user_email(request)  # auth check

    content = await audio.read()
    if len(content) > config.MAX_UPLOAD_BYTES:
        return JSONResponse(
            {"error": f"File too large (max {config.MAX_UPLOAD_BYTES // 1024 // 1024} MB)"},
            status_code=413,
        )

    suffix = Path(audio.filename).suffix or ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(content)
        tmp = Path(f.name)

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, lambda: analyze(tmp))
    finally:
        with suppress(FileNotFoundError):
            tmp.unlink()

    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)
    return result


@router.post("/transcribe")
async def transcribe_voice(
    request: Request,
    audio: UploadFile = File(...),
    model_size: str = Form("base"),
):
    get_user_email(request)

    content = await audio.read()
    if len(content) > 50 * 1024 * 1024:
        return JSONResponse({"error": "File too large (max 50 MB)"}, status_code=413)

    suffix = Path(audio.filename).suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(content)
        tmp = Path(f.name)

    def _run():
        from faster_whisper import WhisperModel
        m = WhisperModel(model_size, device="auto", compute_type="auto")
        segs, info = m.transcribe(str(tmp), vad_filter=True, word_timestamps=False)
        text = " ".join(seg.text.strip() for seg in segs)
        return {"text": text, "language": info.language}

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_executor, _run)
    finally:
        with suppress(FileNotFoundError):
            tmp.unlink()

    return result
