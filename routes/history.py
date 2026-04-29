from __future__ import annotations
import json

import aiofiles
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import config
from nyx_step import get_user_email

router = APIRouter()

_MAX_LIMIT = 50


@router.get("/api/history")
async def get_history(request: Request, limit: int = 20, offset: int = 0):
    limit = max(1, min(limit, _MAX_LIMIT))
    user_email = get_user_email(request)
    records: list[dict] = []
    skipped = 0

    if config.HISTORY_LOG.exists():
        try:
            async with aiofiles.open(config.HISTORY_LOG) as f:
                content = await f.read()
            lines = content.splitlines()
            for line in reversed(lines):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("user_email") != user_email:
                    continue
                if skipped < offset:
                    skipped += 1
                    continue
                r.pop("user_email", None)
                records.append(r)
                if len(records) >= limit:
                    break
        except Exception:
            pass

    # Check if more records exist beyond this page
    has_more = len(records) == limit

    return JSONResponse({"records": records, "offset": offset, "limit": limit, "has_more": has_more})


@router.delete("/api/history")
async def clear_history(request: Request):
    user_email = get_user_email(request)
    if not config.HISTORY_LOG.exists():
        return JSONResponse({"cleared": 0})
    try:
        async with aiofiles.open(config.HISTORY_LOG) as f:
            content = await f.read()
        lines = content.splitlines(keepends=True)
        kept = []
        cleared = 0
        for line in lines:
            stripped = line.strip()
            if not stripped:
                kept.append(line)
                continue
            try:
                r = json.loads(stripped)
                if r.get("user_email") == user_email:
                    cleared += 1
                else:
                    kept.append(line)
            except Exception:
                kept.append(line)
        async with aiofiles.open(config.HISTORY_LOG, "w") as f:
            await f.writelines(kept)
        return JSONResponse({"cleared": cleared})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
