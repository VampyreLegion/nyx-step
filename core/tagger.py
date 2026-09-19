from __future__ import annotations
from datetime import datetime
from pathlib import Path

import config


def _clean(value) -> str:
    return str(value).strip() if value not in (None, "") else ""


def _resolve(meta: dict, key: str, default: str) -> str:
    """Top-level meta wins, then params, then the configured default."""
    params = meta.get("params") or {}
    return _clean(meta.get(key)) or _clean(params.get(key)) or default


def _year(meta: dict) -> str:
    for key in ("date", "submitted_at", "created_at"):
        raw = meta.get(key)
        if raw:
            try:
                return str(datetime.fromisoformat(str(raw)).year)
            except (ValueError, TypeError):
                pass
    return str(datetime.now().year)


def _tag_meta(meta: dict) -> dict:
    """Normalise a job/meta dict into the values we write as tags."""
    params = meta.get("params") or {}
    key_raw = _clean(params.get("key"))
    scale = _clean(params.get("scale"))
    instruments = params.get("instruments") or []
    vocal_tags = params.get("vocal_tags") or []
    return {
        "title": _clean(meta.get("song_name")),
        "artist": _resolve(meta, "artist", config.DEFAULT_ARTIST),
        "album": _resolve(meta, "album", config.DEFAULT_ALBUM),
        "year": _year(meta),
        "lyrics": _clean(meta.get("lyrics")),
        "bpm": _clean(params.get("bpm")),
        "key": f"{key_raw} {scale}".strip() if key_raw else "",
        "genre": _clean(params.get("genre")),
        "instruments": ", ".join(str(i) for i in instruments if i),
        "vocal_tags": ", ".join(str(v) for v in vocal_tags if v),
    }


def tag_file(file_path: Path, meta: dict | None) -> bool:
    """Tag an audio file in-place with metadata. Returns True on success."""
    if not meta:
        return False
    ext = file_path.suffix.lower()
    if ext not in (".mp3", ".flac"):
        return False

    m = _tag_meta(meta)
    seed = str(meta.get("seed", ""))
    caption = _clean(meta.get("caption"))
    comment = f"Tags: {caption}\nSeed: {seed}" if caption else f"Seed: {seed}"

    try:
        if ext == ".mp3":
            from mutagen.mp3 import MP3
            from mutagen.id3 import (
                TIT2, TPE1, TPE2, TALB, TDRC, TCON, TBPM, TKEY,
                COMM, USLT, TXXX,
            )
            audio = MP3(file_path)
            if audio.tags is None:
                audio.add_tags()
            frames = {
                "TIT2": TIT2(encoding=3, text=m["title"]),
                "TPE1": TPE1(encoding=3, text=m["artist"]),
                "TPE2": TPE2(encoding=3, text=m["artist"]),
                "TALB": TALB(encoding=3, text=m["album"]),
                "TDRC": TDRC(encoding=3, text=m["year"]),
                "COMM": COMM(encoding=3, lang="eng", desc="", text=comment),
            }
            if m["lyrics"]:
                frames["USLT"] = USLT(encoding=3, lang="eng", desc="", text=m["lyrics"])
            if m["bpm"]:
                frames["TBPM"] = TBPM(encoding=3, text=m["bpm"])
            if m["key"]:
                frames["TKEY"] = TKEY(encoding=3, text=m["key"])
            if m["genre"]:
                frames["TCON"] = TCON(encoding=3, text=m["genre"])
            if m["instruments"]:
                frames["TXXX:Instruments"] = TXXX(encoding=3, desc="Instruments", text=m["instruments"])
            if m["vocal_tags"]:
                frames["TXXX:Vocal Tags"] = TXXX(encoding=3, desc="Vocal Tags", text=m["vocal_tags"])
            for key, frame in frames.items():
                audio.tags.setall(key, [frame])
        else:
            from mutagen.flac import FLAC
            audio = FLAC(file_path)
            audio["title"] = m["title"]
            audio["artist"] = m["artist"]
            audio["albumartist"] = m["artist"]
            audio["album"] = m["album"]
            audio["date"] = m["year"]
            audio["comment"] = comment
            if m["lyrics"]:
                audio["lyrics"] = m["lyrics"]
            if m["bpm"]:
                audio["bpm"] = m["bpm"]
            if m["key"]:
                audio["initialkey"] = m["key"]
            if m["genre"]:
                audio["genre"] = m["genre"]
            if m["instruments"]:
                audio["instruments"] = m["instruments"]
            if m["vocal_tags"]:
                audio["vocal_tags"] = m["vocal_tags"]
        audio.save()
        return True
    except Exception:
        return False


def tag_bytes(file_path: Path, meta: dict | None) -> bytes | None:
    """Return file bytes with tags applied (temp copy). Returns None on failure."""
    if not meta:
        return None
    ext = file_path.suffix.lower()
    if ext not in (".mp3", ".flac"):
        return None

    import shutil
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as ntf:
        tmp = Path(ntf.name)
    try:
        shutil.copyfile(file_path, tmp)
        if tag_file(tmp, meta):
            return tmp.read_bytes()
        return None
    except Exception:
        return None
    finally:
        tmp.unlink(missing_ok=True)
