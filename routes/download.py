from __future__ import annotations
import io
import json
import re
import zipfile
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

import config
from nyx_step import tracker, get_user_email

router = APIRouter()

_CHAPTER_IDS = ["starthere", "whatsnew", "summary", "flowcharts", "scale", "midi", "analyze", "sampler", "lm", "presets", "radio", "extract", "quality", "lrc", "video", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"]

_STYLE = (
    "<style>"
    "body{font-family:Arial,sans-serif;font-size:13px;color:#e2e4ed;background:#0b0c10;padding:12px;}"
    "h2{color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;}"
    "h3{color:#00d4b6;} p,li{color:#e2e4ed;margin-bottom:6px;}"
    "table{border-collapse:collapse;width:100%;margin:8px 0;}"
    "th{background:#1a1c26;color:#00d4b6;padding:6px;border:1px solid #2d3041;}"
    "td{padding:6px;border:1px solid #2d3041;color:#e2e4ed;}"
    "code{background:#151720;color:#a6e3a1;padding:2px 4px;border-radius:3px;font-family:monospace;}"
    "pre{background:#151720;color:#cdd6f4;padding:10px;border-radius:6px;border:1px solid #2d3041;}"
    "</style>"
)

# Static guide chapters live as plain HTML files; ch1–ch8 and summary are
# extracted from Aceuser.html at request time.
_GUIDE_DIR = Path(__file__).resolve().parent.parent / "templates" / "guide"
_guide_cache: dict[str, str] = {}


def _parse_chapter(section_id: str) -> str:
    """Serve a guide page from templates/guide/, or extract an <h2 id> section from Aceuser.html."""
    if section_id in _guide_cache:
        return _guide_cache[section_id]
    page = _GUIDE_DIR / f"{section_id}.html"
    if page.exists():
        html = page.read_text(encoding="utf-8")
        _guide_cache[section_id] = html
        return html
    if not config.ACEUSER_HTML.exists():
        return "<p>Guide file not found.</p>"
    raw = config.ACEUSER_HTML.read_text(encoding="utf-8")
    chunks = re.split(r'(?=<h2\s)', raw)
    for chunk in chunks:
        m = re.search(r'<h2[^>]*id="([^"]+)"', chunk)
        if m and m.group(1) == section_id:
            return f"<html><head>{_STYLE}</head><body>{chunk}</body></html>"
    if section_id == "summary":
        return f"<html><head>{_STYLE}</head><body><p style='color:#8a8f9e'>No summary content found.</p></body></html>"
    return f"<p>Section '{section_id}' not found.</p>"


@router.get("/guide/{section_id}", response_class=HTMLResponse)
async def guide_section(section_id: str):
    if section_id not in _CHAPTER_IDS:
        return HTMLResponse("<p>Invalid section.</p>", status_code=404)
    return HTMLResponse(_parse_chapter(section_id))


@router.get("/meta/{filename}")
async def meta(filename: str, request: Request):
    user_email = get_user_email(request)
    if not tracker.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    import core.db as db
    job = db.get_job_by_filename(filename)
    if job:
        job.pop("user_email", None)
        return JSONResponse(job)

    return JSONResponse({"error": "Metadata not found"}, status_code=404)


def _safe_output_path(filename: str) -> Path | None:
    """Resolve filename inside COMFYUI_OUTPUT_DIR, rejecting traversal outside it."""
    base = config.COMFYUI_OUTPUT_DIR.resolve()
    resolved = (base / filename).resolve()
    return resolved if resolved.is_relative_to(base) else None


def _tag_audio(file_path: Path, meta: dict | None) -> bytes | None:
    """Return file bytes with ID3/FLAC tags applied from meta. Returns None on failure.

    Works on a temp copy — mutagen's file-path save replaces existing tags
    in place, whereas its BytesIO path can leave a duplicate tag block.
    """
    if not meta:
        return None
    ext = file_path.suffix.lower()
    if ext not in (".mp3", ".flac"):
        return None

    import shutil
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as ntf:
        tmp = Path(ntf.name)
    try:
        shutil.copyfile(file_path, tmp)
        title   = meta.get("song_name", "")
        caption = meta.get("caption", "")
        seed    = str(meta.get("seed", ""))
        comment = f"Tags: {caption}\nSeed: {seed}" if caption else f"Seed: {seed}"

        if ext == ".mp3":
            from mutagen.mp3 import MP3
            from mutagen.id3 import TIT2, TPE1, COMM
            audio = MP3(tmp)
            if audio.tags is None:
                audio.add_tags()
            audio.tags.add(TIT2(encoding=3, text=title))
            audio.tags.add(TPE1(encoding=3, text="Nyx-Step AI"))
            audio.tags.add(COMM(encoding=3, lang="eng", desc="", text=comment))
        else:
            from mutagen.flac import FLAC
            audio = FLAC(tmp)
            audio["title"]   = title
            audio["artist"]  = "Nyx-Step AI"
            audio["comment"] = comment
        audio.save()
        return tmp.read_bytes()
    except Exception:
        return None
    finally:
        tmp.unlink(missing_ok=True)


def _get_meta_for_file(filename: str) -> dict | None:
    """Look up job metadata for a filename from DB."""
    import core.db as db
    return db.get_job_by_filename(filename)


@router.get("/download/{filename:path}")
async def download(filename: str, request: Request):
    user_email = get_user_email(request)

    if not tracker.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    file_path = _safe_output_path(filename)
    if file_path is None or not file_path.exists():
        return JSONResponse({"error": "File not on disk"}, status_code=404)

    ext = file_path.suffix.lower()
    media_type = {"mp3": "audio/mpeg", "flac": "audio/flac", "opus": "audio/ogg"}.get(ext.lstrip("."), "audio/mpeg")

    # Try to serve with embedded metadata tags
    meta = _get_meta_for_file(filename)
    tagged = _tag_audio(file_path, meta)
    if tagged:
        return StreamingResponse(
            io.BytesIO(tagged),
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store, no-cache, must-revalidate",
                "Pragma": "no-cache",
            },
        )

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


class _ZipRequest(BaseModel):
    filenames: list[str]
    zip_name: str = "nyx-step_batch.zip"


@router.post("/download/zip")
async def download_zip(req: _ZipRequest, request: Request):
    user_email = get_user_email(request)
    if not req.filenames:
        return JSONResponse({"error": "No filenames provided"}, status_code=400)
    if len(req.filenames) > 50:
        return JSONResponse({"error": "Max 50 files per ZIP"}, status_code=400)

    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in req.filenames:
            if not tracker.user_owns_file(user_email, fname):
                continue
            fpath = _safe_output_path(fname)
            if fpath is not None and fpath.exists():
                zf.write(fpath, fname)
                added += 1

    if added == 0:
        return JSONResponse({"error": "No accessible files found"}, status_code=404)

    buf.seek(0)
    safe_name = re.sub(r"[^\w.\-]", "_", req.zip_name)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )
