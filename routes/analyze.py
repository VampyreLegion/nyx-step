from __future__ import annotations
import asyncio
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse

import config
from core.analyze import analyze, transcribe
from core.executor import get_audio_pool, stream_upload
from nyx_step import get_user_email

router = APIRouter()


@router.post("/analyze")
async def analyze_audio(request: Request, audio: UploadFile = File(...)):
    get_user_email(request)  # auth check

    suffix = Path(audio.filename).suffix or ".mp3"
    tmp = await stream_upload(audio, suffix)
    if isinstance(tmp, JSONResponse):
        return tmp

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(get_audio_pool(), lambda: analyze(tmp))
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

    suffix = Path(audio.filename).suffix or ".webm"
    tmp = await stream_upload(audio, suffix, max_bytes=50 * 1024 * 1024)
    if isinstance(tmp, JSONResponse):
        return tmp

    def _run():
        from faster_whisper import WhisperModel
        m = WhisperModel(model_size, device="auto", compute_type="auto")
        segs, info = m.transcribe(str(tmp), vad_filter=True, word_timestamps=False)
        text = " ".join(seg.text.strip() for seg in segs)
        return {"text": text, "language": info.language}

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(get_audio_pool(), _run)
    finally:
        with suppress(FileNotFoundError):
            tmp.unlink()

    return result
