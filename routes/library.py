from __future__ import annotations
import os
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

import config

router = APIRouter()

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


def _safe_output_file(rel: str):
    """Resolve a relative path inside COMFYUI_OUTPUT_DIR, rejecting traversal."""
    base = config.COMFYUI_OUTPUT_DIR.resolve()
    resolved = (base / rel).resolve()
    if not resolved.is_relative_to(base) or not resolved.is_file():
        return None
    return resolved


@router.get("/api/library")
async def library_list(q: str = ""):
    base = config.COMFYUI_OUTPUT_DIR
    items = []
    if base.is_dir():
        for dirpath, _dirs, files in os.walk(base):
            for fname in files:
                if not fname.lower().endswith((".mp3", ".wav")):
                    continue
                full = os.path.join(dirpath, fname)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                items.append({
                    "name": os.path.relpath(full, base).replace(os.sep, "/"),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                })
    items.sort(key=lambda item: item["mtime"], reverse=True)
    if q:
        ql = q.lower()
        items = [item for item in items if ql in item["name"].lower()]
    return JSONResponse({"files": items, "dir": str(base)})


@router.get("/library/audio/{rel:path}")
async def library_audio(rel: str, request: Request):
    path = _safe_output_file(rel)
    if path is None:
        return JSONResponse({"error": "File not found"}, status_code=404)

    file_size = path.stat().st_size
    start, end = 0, file_size - 1
    status = 200
    m = _RANGE_RE.match(request.headers.get("range", "").strip())
    if m:
        s, e = m.groups()
        if s or e:
            status = 206
            if s:
                start = int(s)
                end = int(e) if e else file_size - 1
            else:
                start = max(0, file_size - int(e))

    start = max(0, min(start, file_size - 1)) if file_size else 0
    end = min(end, file_size - 1)
    length = max(0, end - start + 1)

    def iter_file():
        remaining = length
        with open(path, "rb") as fh:
            fh.seek(start)
            while remaining > 0:
                chunk = fh.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-store",
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    media_type = "audio/wav" if path.suffix.lower() == ".wav" else "audio/mpeg"
    return StreamingResponse(
        iter_file(), status_code=status, media_type=media_type, headers=headers
    )
