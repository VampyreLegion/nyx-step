from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
import config
import core.db as db
from nyx_step import get_user_email

router = APIRouter()

@router.get("/api/history")
async def get_history(request: Request, limit: int = 20, offset: int = 0):
    limit = max(1, min(limit, 50))
    user_email = get_user_email(request)
    records, has_more = db.get_history_page(user_email, limit=limit, offset=offset)
    return JSONResponse({"records": records, "offset": offset, "limit": limit, "has_more": has_more})

@router.delete("/api/history")
async def clear_history(request: Request):
    user_email = get_user_email(request)
    cleared = db.clear_user_history(user_email)
    return JSONResponse({"cleared": cleared})
