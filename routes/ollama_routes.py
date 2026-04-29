from __future__ import annotations
import asyncio
import json
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from core.executor import get_audio_pool
from core.ollama import list_models, lookup_artist, stream_lyrics, expand_prompt

router = APIRouter(prefix="/ollama")


@router.get("/models")
async def get_models():
    return {"models": list_models()}


class ArtistInfoRequest(BaseModel):
    artist: str
    model: str = "gemma4:latest"
    use_web: bool = False


@router.post("/artist-info")
async def artist_info(req: ArtistInfoRequest):
    if not req.artist.strip():
        return {"error": "artist required"}
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        get_audio_pool(),
        lambda: lookup_artist(req.artist, req.model, req.use_web),
    )
    return result


class ExpandRequest(BaseModel):
    description: str
    model: str = "gemma4:latest"


@router.post("/expand")
async def expand(req: ExpandRequest):
    if not req.description.strip():
        return {"error": "description required"}
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        get_audio_pool(),
        lambda: expand_prompt(req.description.strip(), req.model),
    )
    return result


@router.get("/stream")
async def ollama_stream(
    request: Request,
    topic: str = "",
    genre: str = "electronic",
    key: str = "C",
    mood: str = "",
    structure: str = "Verse-Chorus",
    subject: str = "",
    name_override: str = "",
    model: str = "gemma4:latest",
    artist: str = "",
    lyric_style: str = "",
    lyric_themes: str = "",
    vocal_style: str = "",
    instruments_hint: str = "",
    instrumental: bool = False,
):
    async def token_gen() -> AsyncGenerator[dict, None]:
        loop = asyncio.get_event_loop()
        executor = get_audio_pool()

        def _stream():
            return list(stream_lyrics(
                prompt=topic or f"Write a {genre} song",
                genre=genre, key=key, mood=mood, structure=structure,
                model=model, subject=subject, name_override=name_override,
                artist=artist, lyric_style=lyric_style, lyric_themes=lyric_themes, vocal_style=vocal_style,
                instruments_hint=instruments_hint, instrumental=instrumental,
            ))

        tokens = await loop.run_in_executor(executor, _stream)
        for token in tokens:
            if await request.is_disconnected():
                break
            yield {"event": "token", "data": json.dumps({"token": token})}
        yield {"event": "done", "data": "{}"}

    return EventSourceResponse(token_gen())
