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


def lookup_artist(artist: str, model: str = "gemma4:latest", use_web: bool = False) -> dict:
    """Ask Ollama about an artist's musical profile, optionally grounded with Brave Search."""
    import re
    web_context = ""
    if use_web:
        from core.brave_search import search_artist
        web_context = search_artist(artist)

    system = (
        "You are a music production expert. Analyze the given artist or band and return ONLY valid JSON "
        "(no markdown fences, no explanation, nothing else). "
        "All tags must be lowercase and suitable for ACE-Step music generation (a tag-based AI music model). "
        "Use exactly these keys:\n"
        "  genre_tag: primary genre as a single lowercase ACE-Step tag (e.g. 'psytrance', 'dark ambient')\n"
        "  instrument_tags: array of instrument tags (e.g. ['electric guitar', 'synthesizer', 'drum kit'])\n"
        "  vocal_tags: array of vocal descriptor tags (e.g. ['male vocal', 'baritone', 'raspy', 'falsetto'])\n"
        "  style_tags: array of style/mood/texture tags (e.g. ['atmospheric', 'distorted', 'melodic', 'heavy'])\n"
        "  lyric_style: one sentence describing their songwriting/lyric style\n"
        "  lyric_themes: array of 3-5 common lyric theme words (e.g. ['darkness', 'rebellion', 'love'])"
    )
    prompt_parts = [system]
    if web_context:
        prompt_parts.append(f"\nWeb search context:\n{web_context}")
    prompt_parts.append(f"\nArtist: {artist}")

    payload = {"model": model, "prompt": "\n".join(prompt_parts), "stream": False}
    try:
        resp = requests.post(f"{config.OLLAMA_URL}/api/generate", json=payload, timeout=30)
        resp.raise_for_status()
        text = resp.json().get("response", "{}")
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            return json.loads(match.group())
        return {}
    except Exception as exc:
        logger.error("Artist lookup failed: %s", exc)
        return {}


def stream_lyrics(
    prompt: str,
    genre: str,
    key: str,
    mood: str,
    structure: str,
    model: str,
    subject: str = "",
    name_override: str = "",
    artist: str = "",
    lyric_style: str = "",
    lyric_themes: str = "",
    vocal_style: str = "",
    instruments_hint: str = "",
    instrumental: bool = False,
) -> Generator[str, None, None]:
    mood_str = f"with a {mood} mood" if mood else "with an appropriate mood"
    subject_str = f" The song is about: {subject}." if subject else ""
    name_str = (
        f" IMPORTANT: In the lyrics, refer to '{subject or 'the subject'}' as '{name_override}' — "
        f"never use any other name."
    ) if name_override else ""
    artist_str = f" Write in the lyrical style of {artist}." if artist else ""
    lyric_style_str = f" Lyric style: {lyric_style}." if lyric_style else ""
    themes_str = f" Common themes to draw from: {lyric_themes}." if lyric_themes else ""
    vocal_str = f" Vocal style: {vocal_style}." if vocal_style else ""
    instr_str = f" Suggested instruments: {instruments_hint}." if instruments_hint else ""

    if instrumental:
        system = (
            f"You are an expert music arranger specializing in {genre} music. "
            f"Create an instrumental arrangement outline {mood_str}. "
            f"Use this structure: {structure}.{instr_str} "
            f"Use only structural/instrumental tags — no sung lyrics: "
            f"[Intro] [Build] [Drop] [Breakdown] [Outro] [Guitar Solo] [Piano Interlude] [Drum Break]. "
            f"Under each tag write a brief arrangement note (e.g. 'filtered synth pads, rising arp'). "
            f"Output ONLY the arrangement — no explanations."
        )
    else:
        system = (
            f"You are an expert lyricist specializing in {genre} music. "
            f"Write lyrics in the key of {key}, {mood_str}. "
            f"Use this song structure: {structure}.{subject_str}{name_str}{artist_str}{lyric_style_str}{themes_str}{vocal_str}{instr_str} "
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
