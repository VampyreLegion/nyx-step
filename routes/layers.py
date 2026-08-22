from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from nyx_step import get_user_email

router = APIRouter()


class LayerConfig(BaseModel):
    name: str = "Layer"
    prompt: str = ""
    volume: float = 1.0
    pan: float = 0.0


class LayerGenerateRequest(BaseModel):
    layers: list[LayerConfig] = []
    song_name: str = "Layered Track"
    duration: float = 30.0
    bpm: int = 120


@router.post("/layers/generate")
async def generate_layers(req: LayerGenerateRequest, request: Request):
    user_email = get_user_email(request)
    import httpx
    queued = []
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=30) as client:
        for i, layer in enumerate(req.layers):
            if not layer.prompt.strip():
                continue
            payload = {
                "tags": layer.prompt,
                "duration": req.duration,
                "song_name": f"{req.song_name} - {layer.name}",
                "bpm": req.bpm,
            }
            try:
                r = await client.post("/generate", json=payload)
                if r.status_code == 200:
                    queued.append({
                        "layer": i,
                        "name": layer.name,
                        "prompt_id": r.json().get("prompt_id"),
                        "volume": layer.volume,
                        "pan": layer.pan,
                    })
            except Exception:
                pass
    return JSONResponse({"queued": queued, "total": len(req.layers)})
