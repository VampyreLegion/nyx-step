from __future__ import annotations
import concurrent.futures
import tempfile
from pathlib import Path

import aiofiles
from fastapi import UploadFile
from fastapi.responses import JSONResponse

import config

# Shared thread pool for CPU-bound audio work (analysis, demucs, MIDI, quality scoring)
_audio_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="audio")


def get_audio_pool() -> concurrent.futures.ThreadPoolExecutor:
    return _audio_pool


async def stream_upload(upload: UploadFile, suffix: str, max_bytes: int = config.MAX_UPLOAD_BYTES) -> Path | JSONResponse:
    """Stream an uploaded file to a temp path, returning 413 JSONResponse if oversized."""
    tmp = Path(tempfile.mktemp(suffix=suffix))
    total = 0
    try:
        async with aiofiles.open(tmp, "wb") as f:
            while chunk := await upload.read(65536):
                total += len(chunk)
                if total > max_bytes:
                    await f.close()
                    tmp.unlink(missing_ok=True)
                    return JSONResponse(
                        {"error": f"File too large (max {max_bytes // 1024 // 1024} MB)"},
                        status_code=413,
                    )
                await f.write(chunk)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return tmp
