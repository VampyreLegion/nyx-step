from __future__ import annotations
from pathlib import Path


def tag_file(file_path: Path, meta: dict | None) -> bool:
    """Tag an audio file in-place with metadata. Returns True on success."""
    if not meta:
        return False
    ext = file_path.suffix.lower()
    if ext not in (".mp3", ".flac"):
        return False

    title   = meta.get("song_name", "")
    caption = meta.get("caption", "")
    seed    = str(meta.get("seed", ""))
    comment = f"Tags: {caption}\nSeed: {seed}" if caption else f"Seed: {seed}"

    params  = meta.get("params", {}) or {}
    bpm     = str(params.get("bpm", ""))
    key_raw = params.get("key", "")
    scale   = params.get("scale", "")
    key     = f"{key_raw} {scale}".strip() if key_raw else ""
    genre   = params.get("genre", "")

    try:
        if ext == ".mp3":
            from mutagen.mp3 import MP3
            from mutagen.id3 import TIT2, TPE1, COMM, TBPM, TKEY, TCON
            audio = MP3(file_path)
            if audio.tags is None:
                audio.add_tags()
            audio.tags.add(TIT2(encoding=3, text=title))
            audio.tags.add(TPE1(encoding=3, text="Nyx-Step AI"))
            audio.tags.add(COMM(encoding=3, lang="eng", desc="", text=comment))
            if bpm:
                audio.tags.add(TBPM(encoding=3, text=bpm))
            if key:
                audio.tags.add(TKEY(encoding=3, text=key))
            if genre:
                audio.tags.add(TCON(encoding=3, text=genre))
        else:
            from mutagen.flac import FLAC
            audio = FLAC(file_path)
            audio["title"]   = title
            audio["artist"]  = "Nyx-Step AI"
            audio["comment"] = comment
            if bpm:
                audio["bpm"] = bpm
            if key:
                audio["initialkey"] = key
            if genre:
                audio["genre"] = genre
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
