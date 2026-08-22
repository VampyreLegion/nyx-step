from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from nyx_step import get_user_email

router = APIRouter()


class CallResponseRequest(BaseModel):
    call_prompt: str = ""
    response_prompt: str = ""
    interleave: str = "1:1"
    duration: float = 30.0
    song_name: str = "Call and Response"


@router.post("/call-response/generate")
async def generate_call_response(req: CallResponseRequest, request: Request):
    user_email = get_user_email(request)
    import httpx
    queued = []
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=30) as client:
        for label, prompt in [("call", req.call_prompt), ("response", req.response_prompt)]:
            if not prompt.strip():
                continue
            payload = {
                "tags": prompt,
                "duration": req.duration / 2,
                "song_name": f"{req.song_name} - {label.title()}",
            }
            try:
                r = await client.post("/generate", json=payload)
                if r.status_code == 200:
                    queued.append({"part": label, "prompt_id": r.json().get("prompt_id")})
            except Exception:
                pass
    return JSONResponse({"queued": queued, "interleave": req.interleave})
