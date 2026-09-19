from __future__ import annotations
import logging
import re
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse, FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from core import youtube_uploader as ytu
from nyx_step import get_user_email

logger = logging.getLogger(__name__)
router = APIRouter()

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

_MAX_IMAGE_BYTES = 15 * 1024 * 1024


def _resolve_audio(filename: str) -> Path | None:
    """Resolve a song filename inside the ComfyUI output dir (mirrors download.py)."""
    import config as cfg
    from routes.download import safe_output_path
    return safe_output_path(filename)


def _load_job_for(filename: str) -> dict:
    import core.db as db
    return db.get_job_by_filename(filename) or {}


@router.get("/youtube/auth/status")
async def youtube_auth_status(request: Request):
    get_user_email(request)
    if not ytu.is_configured():
        return {
            "configured": False,
            "authed": False,
            "message": "YouTube API not configured — set YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET "
                       "(and YOUTUBE_REDIRECT_URI) in .env",
        }
    authed = ytu.has_token()
    channel = {}
    if authed:
        try:
            channel = ytu.get_channel_info()
        except Exception as exc:
            authed = False
            ytu.clear_token()
            logger.warning("Token rejected, cleared: %s", exc)
    return {"configured": True, "authed": authed, "channel": channel}


@router.post("/youtube/auth/url")
async def youtube_auth_url(request: Request):
    get_user_email(request)
    if not ytu.is_configured():
        return JSONResponse({"error": "YouTube API not configured — set credentials in .env"}, status_code=400)
    try:
        return {"url": ytu.build_auth_url()}
    except Exception as exc:
        return JSONResponse({"error": f"Failed to build auth URL: {exc}"}, status_code=500)


@router.get("/youtube/auth/callback")
async def youtube_auth_callback(request: Request, code: str = "", state: str = ""):
    get_user_email(request)
    if not code:
        return JSONResponse({"error": "Missing authorization code"}, status_code=400)
    try:
        channel = ytu.exchange_code(code)
        return {
            "ok": True,
            "authed": True,
            "channel": channel,
            "message": "YouTube connected! You can close this tab and return to Nyx-Step.",
        }
    except Exception as exc:
        logger.warning("OAuth exchange failed: %s", exc)
        return JSONResponse({"error": f"OAuth failed: {exc}"}, status_code=400)


@router.post("/youtube/auth/logout")
async def youtube_auth_logout(request: Request):
    get_user_email(request)
    ytu.clear_token()
    return {"ok": True}


async def _save_cover(image: UploadFile | None) -> tuple[str | None, JSONResponse | None]:
    """Persist an uploaded cover image to a temp file. Returns (path, error)."""
    if image is None or not image.filename:
        return None, None
    ext = Path(image.filename).suffix.lower()
    if ext not in _IMAGE_EXTS:
        return None, JSONResponse({"error": "Image must be PNG/JPG/WebP"}, status_code=400)
    data = await image.read()
    if len(data) > _MAX_IMAGE_BYTES:
        return None, JSONResponse({"error": "Image too large (max 15 MB)"}, status_code=400)
    tmp = Path(tempfile.mkdtemp(prefix="yt_img_")) / f"cover{ext}"
    tmp.write_bytes(data)
    return str(tmp), None


def _build_job_payload(
    filename: str,
    audio_path: Path,
    image_path: str | None,
    title: str,
    description: str,
    privacy: str,
    karaoke: str,
    captions: str,
    ai_cover: str,
) -> dict:
    job = _load_job_for(filename)
    params = job.get("params", {}) or {}
    return {
        "filename": filename,
        "audio_path": str(audio_path),
        "image_path": image_path,
        "song_name": job.get("song_name") or params.get("song_name") or title or audio_path.stem,
        "caption": job.get("caption", ""),
        "lyrics": job.get("lyrics", "") or description or job.get("caption", ""),
        "bpm": params.get("bpm", 120),
        "key": params.get("key", ""),
        "scale": params.get("scale", ""),
        "seed": job.get("seed", 0),
        "tags": job.get("caption", "") or (params.get("genre") or ""),
        "title": title,
        "description": description,
        "privacy": privacy if privacy in {"public", "unlisted", "private"} else "private",
        "karaoke": karaoke.lower() in ("1", "true", "on", "yes"),
        "captions": captions.lower() in ("1", "true", "on", "yes"),
        "ai_cover": ai_cover.lower() in ("1", "true", "on", "yes"),
    }


@router.post("/youtube/upload")
async def youtube_upload(
    request: Request,
    filename: str = Form(...),
    title: str = Form(""),
    description: str = Form(""),
    privacy: str = Form("private"),
    karaoke: str = Form("false"),
    captions: str = Form("true"),
    ai_cover: str = Form("true"),
    image: UploadFile | None = File(None),
):
    user_email = get_user_email(request)
    import core.db as db
    if not db.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    audio_path = _resolve_audio(filename)
    if audio_path is None or not audio_path.exists():
        return JSONResponse({"error": "Audio file missing on disk"}, status_code=404)

    image_path, err = await _save_cover(image)
    if err is not None:
        return err

    payload = _build_job_payload(
        filename, audio_path, image_path, title, description, privacy, karaoke, captions, ai_cover
    )
    job_id = ytu.create_upload_job(payload)
    return {"job_id": job_id, "filename": filename}


@router.post("/youtube/prepare")
async def youtube_prepare(
    request: Request,
    filename: str = Form(...),
    title: str = Form(""),
    description: str = Form(""),
    karaoke: str = Form("true"),
    ai_cover: str = Form("true"),
    image: UploadFile | None = File(None),
):
    """Build the YouTube-ready mp4 and stream it for manual upload (no Google API)."""
    user_email = get_user_email(request)
    import core.db as db
    if not db.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    audio_path = _resolve_audio(filename)
    if audio_path is None or not audio_path.exists():
        return JSONResponse({"error": "Audio file missing on disk"}, status_code=404)

    image_path, err = await _save_cover(image)
    if err is not None:
        return err

    payload = _build_job_payload(
        filename, audio_path, image_path, title, description, "private", karaoke, "true", ai_cover
    )
    outdir = Path(tempfile.mkdtemp(prefix="youtube_manual_"))
    out_path = outdir / f"{_safe_stem(payload['song_name'])}.mp4"

    try:
        await run_in_threadpool(ytu.prepare_video_for_manual_upload, payload, out_path)
    except Exception as exc:
        shutil.rmtree(outdir, ignore_errors=True)
        logger.warning("Manual prep failed: %s", exc)
        return JSONResponse({"error": f"Could not build video: {exc}"}, status_code=500)

    return FileResponse(
        out_path,
        media_type="video/mp4",
        filename=out_path.name,
        background=BackgroundTask(shutil.rmtree, outdir, ignore_errors=True),
    )


def _safe_stem(name: str) -> str:
    stem = re.sub(r"[^\w\-. ]+", "", (name or "").strip()).strip() or "nyx-step"
    return stem[:80]



@router.get("/youtube/upload/{job_id}")
async def youtube_job_status(job_id: str, request: Request):
    get_user_email(request)
    job = ytu.get_upload_job(job_id)
    if job is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "progress": job["progress"],
        "note": job["note"],
        "error": job["error"],
        "video_id": job["video_id"],
        "url": job["url"],
        "privacy": job.get("privacy", "private"),
        "filename": job.get("filename"),
    }


@router.get("/youtube/lrc/{filename}")
async def youtube_lrc_preview(filename: str, request: Request):
    """Preview of the SRT/ASS that would be burned for a song."""
    user_email = get_user_email(request)
    import core.db as db
    from nyx_step import tracker
    if not tracker.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)
    audio_path = _resolve_audio(filename)
    if audio_path is None or not audio_path.exists():
        return JSONResponse({"error": "Audio file missing"}, status_code=404)
    job = _load_job_for(filename)
    params = job.get("params", {}) or {}
    lrc = ytu._load_or_build_lrc(audio_path, job.get("lyrics", ""), params.get("bpm", 120))
    return {"lrc": lrc, "has_sync": bool(ytu._parse_lrc(lrc))}