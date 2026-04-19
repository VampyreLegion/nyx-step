from __future__ import annotations

_DEFAULTS = {"bpm": 120, "key": "C", "scale": "Major", "time_sig": "4/4"}


def build_caption(state: dict) -> str:
    parts = []
    genre = state.get("genre", "")
    bpm = state.get("bpm", _DEFAULTS["bpm"])
    key = state.get("key", "")
    scale = state.get("scale", "")
    mode = state.get("mode", "")
    time_sig = state.get("time_sig", "")

    if genre:
        parts.append(genre.lower())

    if bpm and (genre or bpm != _DEFAULTS["bpm"]):
        parts.append(f"{bpm} BPM")

    if key and (genre or key != _DEFAULTS["key"] or scale != _DEFAULTS["scale"]):
        parts.append(f"{key} {scale}".strip() if scale else key)

    if mode:
        parts.append(f"{mode} mode")

    if time_sig and (genre or time_sig != _DEFAULTS["time_sig"]):
        parts.append(f"{time_sig} time")

    parts.extend(state.get("instruments", []))
    parts.extend(state.get("vocal_tags", []))

    return ", ".join(parts)


def build_lyrics(state: dict) -> str:
    return state.get("lyrics", "")


def build_prompt(state: dict) -> tuple[str, str]:
    return build_caption(state), build_lyrics(state)
