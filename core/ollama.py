from __future__ import annotations
import json
import logging
from typing import Generator

import requests

import config

logger = logging.getLogger(__name__)


def list_models() -> list[str]:
    try:
        resp = requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=3)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        return models if models else ["(no models found)"]
    except Exception as exc:
        logger.debug("Ollama unreachable: %s", exc)
        return ["(Ollama offline)"]


def stream_lyrics(
    prompt: str,
    genre: str,
    key: str,
    mood: str,
    structure: str,
    model: str,
    subject: str = "",
    name_override: str = "",
) -> Generator[str, None, None]:
    mood_str = f"with a {mood} mood" if mood else "with an appropriate mood"
    subject_str = f" The song is about: {subject}." if subject else ""
    name_str = (
        f" IMPORTANT: In the lyrics, refer to '{subject or 'the subject'}' as '{name_override}' — "
        f"never use any other name."
    ) if name_override else ""

    system = (
        f"You are an expert lyricist specializing in {genre} music. "
        f"Write lyrics in the key of {key}, {mood_str}. "
        f"Use this song structure: {structure}.{subject_str}{name_str} "
        f"Format every section with ACE-Step structural tags. "
        f"Available tags — use whichever fit: [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Outro] "
        f"[Build] [Drop] [Breakdown] [Fade Out] [Guitar Solo] [Piano Interlude] [Drum Break]. "
        f"Append ': descriptor' for mood e.g. [Chorus: Anthemic]. "
        f"Every section MUST start with a tag on its own line. "
        f"Output ONLY the lyrics — no explanations."
    )
    payload = {"model": model, "prompt": f"{system}\n\nTask: {prompt}", "stream": True}
    try:
        with requests.post(
            f"{config.OLLAMA_URL}/api/generate", json=payload, stream=True, timeout=120
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    token = data.get("response", "")
                    if token:
                        yield token
                    if data.get("done"):
                        break
                except json.JSONDecodeError:
                    continue
    except Exception as exc:
        logger.error("Ollama failed: %s", exc)
        yield f"\n[Error: {exc}]"
