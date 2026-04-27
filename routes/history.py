from __future__ import annotations
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import config
from musicweb import get_user_email

router = APIRouter()


@router.get("/api/history")
async def get_history(request: Request, limit: int = 100):
    user_email = get_user_email(request)
    records = []
    if config.HISTORY_LOG.exists():
        try:
            with open(config.HISTORY_LOG) as f:
                lines = f.readlines()
            for line in reversed(lines):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    if r.get("user_email") == user_email:
                        r.pop("user_email", None)
                        records.append(r)
                        if len(records) >= limit:
                            break
                except Exception:
                    continue
        except Exception:
            pass
    return JSONResponse({"records": records})


@router.delete("/api/history")
async def clear_history(request: Request):
    user_email = get_user_email(request)
    if not config.HISTORY_LOG.exists():
        return JSONResponse({"cleared": 0})
    try:
        with open(config.HISTORY_LOG) as f:
            lines = f.readlines()
        kept = [l for l in lines if l.strip() and json.loads(l).get("user_email") != user_email]
        with open(config.HISTORY_LOG, "w") as f:
            f.writelines(kept)
        return JSONResponse({"cleared": len(lines) - len(kept)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
