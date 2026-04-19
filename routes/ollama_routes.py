from __future__ import annotations
import json
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from core.ollama import list_models, stream_lyrics

router = APIRouter(prefix="/ollama")


@router.get("/models")
async def get_models():
    return {"models": list_models()}


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
):
    async def token_gen() -> AsyncGenerator[dict, None]:
        import asyncio
        import concurrent.futures
        loop = asyncio.get_event_loop()
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

        def _stream():
            return list(stream_lyrics(
                prompt=topic or f"Write a {genre} song",
                genre=genre, key=key, mood=mood, structure=structure,
                model=model, subject=subject, name_override=name_override,
            ))

        tokens = await loop.run_in_executor(executor, _stream)
        for token in tokens:
            if await request.is_disconnected():
                break
            yield {"event": "token", "data": json.dumps({"token": token})}
        yield {"event": "done", "data": "{}"}

    return EventSourceResponse(token_gen())
