from __future__ import annotations

import asyncio
import json
import re

from fastapi import APIRouter, Request
from pydantic import BaseModel

import config
from core.circuit_breaker import ollama_breaker, CircuitOpenError
from core.executor import get_audio_pool

router = APIRouter(prefix="/api")

_DEFAULT_MODEL = "gemma4:latest"


def _known_genres() -> list[str]:
    try:
        data = json.loads(config.ACETALK_GENRES.read_text(encoding="utf-8"))
        return [g["name"] for g in data.get("genres", []) if isinstance(g, dict) and g.get("name")]
    except Exception:
        return []


def _genre_catalog() -> dict:
    """name → {tags, bpm range} for enriching suggestions without another LLM call."""
    try:
        data = json.loads(config.ACETALK_GENRES.read_text(encoding="utf-8"))
        return {g["name"]: g for g in data.get("genres", []) if isinstance(g, dict)}
    except Exception:
        return {}


def detect_genre(caption: str, model: str = _DEFAULT_MODEL) -> dict:
    """Ask Ollama to suggest matching genres (with confidence) plus extra tags."""
    system = (
        "You are a music genre classification expert. Given a song description (caption/tags), "
        "suggest the best-matching music genres and additional descriptive tags.\n"
        "Output ONLY raw JSON — no markdown, no backticks, no explanation — with these keys:\n"
        '  "genres": array of 2-5 objects {"name": <genre>, "confidence": <0.0-1.0>}, '
        "most likely first. Prefer genres from the provided list when they fit; "
        "you may add a genre not on the list only if nothing fits well.\n"
        '  "additional_tags": array of 3-8 lowercase style/mood/production tags that '
        "would improve this caption but are NOT already present.\n\n"
        "Example: "
        '{"genres": [{"name": "Lo-Fi Hip Hop", "confidence": 0.92}, '
        '{"name": "Chillhop", "confidence": 0.61}], '
        '"additional_tags": ["dusty vinyl crackle", "warm rhodes", "mellow swing drums", "tape saturation"]}'
    )
    names = _known_genres()
    prompt = (
        f"{system}\n\nKnown genres list:\n{', '.join(names)}\n\n"
        f"Caption/tags to classify: {caption}"
    )

    payload = {"model": model, "prompt": prompt, "stream": False,
               "format": "json"}
    resp = ollama_breaker.call(
        _post_with_retry, f"{config.OLLAMA_URL}/api/generate", payload)
    text = resp.json().get("response", "").strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return {"error": f"No JSON in model response: {text[:120]}"}
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError as exc:
        return {"error": f"Malformed JSON from model: {exc}"}

    catalog = _genre_catalog()
    known_lower = {n.lower(): n for n in catalog}
    genres_out = []
    for g in parsed.get("genres", []):
        if not isinstance(g, dict):
            continue
        name = str(g.get("name", "")).strip()
        if not name:
            continue
        canonical = known_lower.get(name.lower(), name)
        conf = g.get("confidence")
        try:
            conf = round(max(0.0, min(1.0, float(conf))), 2)
        except (TypeError, ValueError):
            conf = 0.5
        entry = {"name": canonical, "confidence": conf}
        info = catalog.get(canonical)
        if isinstance(info, dict):
            if info.get("bpm_min") and info.get("bpm_max"):
                entry["typical_bpm"] = [info["bpm_min"], info["bpm_max"]]
            if info.get("tags"):
                entry["genre_tags"] = info["tags"]
        genres_out.append(entry)

    tags_out = []
    existing = {t.strip().lower() for t in caption.split(",") if t.strip()}
    for t in parsed.get("additional_tags", []):
        t = str(t).strip().lower()
        if t and t not in existing and t not in tags_out:
            tags_out.append(t)

    return {
        "genres": genres_out[:6],
        "additional_tags": tags_out[:10],
        "model": model,
    }


def _post_with_retry(url: str, payload: dict, timeout: int = 120, retries: int = 2):
    import time
    import random
    import requests
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            resp = requests.post(url, json=payload, timeout=timeout)
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(1 + random.uniform(0, 1))
    raise last_exc


class _DetectRequest(BaseModel):
    caption: str = ""
    model: str = _DEFAULT_MODEL


@router.post("/detect-genre")
async def detect_genre_route(req: _DetectRequest, request: Request):
    caption = req.caption.strip()
    if not caption:
        return {"error": "Caption required"}

    loop = asyncio.get_event_loop()

    def _work():
        return detect_genre(caption, req.model)

    try:
        result = await loop.run_in_executor(get_audio_pool(), _work)
    except CircuitOpenError:
        return {"error": "Ollama unavailable (circuit open)"}
    except Exception as exc:
        return {"error": str(exc)}

    if result.get("error"):
        return result
    result["caption_analyzed"] = caption
    return result
