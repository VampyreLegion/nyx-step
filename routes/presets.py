from __future__ import annotations
import json
import re
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import config

router = APIRouter(prefix="/presets")

_SAFE = re.compile(r"[^a-zA-Z0-9 _\-]")

BUILTIN_DIR = config._NYX_STEP / "presets_builtin"


def _safe_name(name: str) -> str:
    return _SAFE.sub("_", name.strip())[:80] or "preset"


def _path(name: str) -> Path:
    return config.PRESETS_DIR / (_safe_name(name) + ".nyx")


@router.get("")
async def list_presets():
    files = sorted(config.PRESETS_DIR.glob("*.nyx"), key=lambda p: p.stat().st_mtime, reverse=True)
    user_names = [p.stem for p in files]
    builtin = sorted(p.stem for p in BUILTIN_DIR.glob("*.nyx")) if BUILTIN_DIR.exists() else []
    # User presets first; built-ins that aren't shadowed by a user preset after
    return {"presets": user_names + [b for b in builtin if b not in user_names]}


@router.post("/{name}")
async def save_preset(name: str, request_body: dict):
    path = _path(name)
    path.write_text(json.dumps(request_body, indent=2), encoding="utf-8")
    return {"saved": path.stem}


@router.get("/{name}")
async def load_preset(name: str):
    path = _path(name)
    if not path.exists():
        builtin = BUILTIN_DIR / (_safe_name(name) + ".nyx")
        if builtin.exists():
            return json.loads(builtin.read_text(encoding="utf-8"))
        return JSONResponse({"error": "Not found"}, status_code=404)
    return json.loads(path.read_text(encoding="utf-8"))


@router.delete("/{name}")
async def delete_preset(name: str):
    path = _path(name)
    if path.exists():
        path.unlink()
        return {"deleted": path.stem}
    if (BUILTIN_DIR / (_safe_name(name) + ".nyx")).exists():
        return JSONResponse({"error": "Built-in presets cannot be deleted"}, status_code=403)
    return {"deleted": path.stem}
