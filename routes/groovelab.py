from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse

import config
from nyx_step import get_user_email

router = APIRouter(prefix="/groovelab")

_GROOVE_DIR = config.COMFYUI_OUTPUT_DIR / "groovelab"


def _ensure_dir():
    _GROOVE_DIR.mkdir(parents=True, exist_ok=True)


@router.post("/upload")
async def upload_groove(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form("Groove"),
):
    user = get_user_email(request)
    _ensure_dir()

    ext = Path(file.filename or "audio.webm").suffix or ".webm"
    safe_name = f"groove_{uuid.uuid4().hex[:12]}{ext}"
    dest = _GROOVE_DIR / safe_name

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Register in DB so DAW library can find it
    import core.db as db
    db.insert_groove_clip(user, name, f"groovelab/{safe_name}")

    return {
        "ok": True,
        "file": f"groovelab/{safe_name}",
        "name": name,
    }


@router.get("/clips")
async def list_grooves(request: Request):
    user = get_user_email(request)
    import core.db as db
    clips = db.get_groove_clips(user)
    return {"clips": clips}
