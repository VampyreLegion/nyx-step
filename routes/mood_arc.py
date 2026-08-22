from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/api/mood-arcs")

MOODS = [
    "Melancholy", "Euphoric", "Angry", "Chill",
    "Dark", "Uplifting", "Nostalgic", "Anxious",
]


class _MoodPoint(BaseModel):
    position: float
    mood: str

    class Config:
        schema_extra = {"example": {"position": 25.0, "mood": "Melancholy"}}


class _SaveArc(BaseModel):
    name: str
    data: list[_MoodPoint]


def _validate_points(points: list[dict]) -> str | None:
    if not 1 <= len(points) <= 32:
        return "A mood arc needs between 1 and 32 points"
    seen = set()
    for p in points:
        pos = p.get("position")
        mood = p.get("mood")
        if not isinstance(pos, (int, float)) or not 0 <= pos <= 100:
            return "Positions must be numbers between 0 and 100"
        if mood not in MOODS:
            return f"Mood must be one of: {', '.join(MOODS)}"
        key = round(float(pos), 1)
        if key in seen:
            return f"Duplicate point at position {key}"
        seen.add(key)
    return None


@router.get("")
async def list_arcs(request: Request):
    user = get_user_email(request)
    return {"moods": MOODS, "arcs": db.list_mood_arcs(user)}


@router.post("")
async def save_arc(req: _SaveArc, request: Request):
    user = get_user_email(request)
    name = req.name.strip()
    if not name:
        return JSONResponse({"error": "Name required"}, status_code=400)
    points = [{"position": p.position, "mood": p.mood} for p in req.data]
    err = _validate_points(points)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    points.sort(key=lambda p: p["position"])
    arc_id = db.create_mood_arc(user, name, points)
    return {"saved": arc_id, "name": name, "points": len(points)}


@router.delete("/{arc_id}")
async def delete_arc(arc_id: int, request: Request):
    user = get_user_email(request)
    if not db.delete_mood_arc(user, arc_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": arc_id}
