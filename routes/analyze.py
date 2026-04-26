from __future__ import annotations
import asyncio
import concurrent.futures
import tempfile
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse

import config
from core.analyze import analyze
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
