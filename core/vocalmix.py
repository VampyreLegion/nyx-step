from __future__ import annotations
import logging
import subprocess
import threading
import time
from pathlib import Path

import config
from core.demucs import run_demucs

logger = logging.getLogger(__name__)

JAM_DIR = config.COMFYUI_OUTPUT_DIR / "jams"
JAM_DIR.mkdir(parents=True, exist_ok=True)


def resolve_output_file(filename: str) -> Path | None:
    """Locate a generated file inside the ComfyUI output tree.

    Most audio lands in COMFYUI_OUTPUT_DIR (output/audio); the ACE-Step lego
    template writes to output/lego/. Search the output root's immediate
    subfolders so both resolve.
    """
    base = config.COMFYUI_OUTPUT_DIR.resolve()
    direct = base / filename
    if direct.is_file():
        return direct
    root = base.parent.resolve()
    name = Path(filename).name
    for sub in root.iterdir():
        if not sub.is_dir():
            continue
        cand = sub / name
        if cand.is_file():
            return cand
    return None


def extract_vocal_stem(src_path: Path, model: str = "htdemucs") -> Path:
    """Separate the generated track and return the isolated vocals stem."""
    for line in run_demucs(src_path, model):
        logger.info("demucs: %s", line)
    stem_dir = config.DEMUCS_OUTPUT_DIR / model / src_path.stem
    vocal = stem_dir / "vocals.mp3"
    if not vocal.exists():
        raise FileNotFoundError(f"Vocals stem not produced: {vocal}")
    return vocal


def mix_vocals_over_instrumental(
    jam_path: Path,
    vocal_stem: Path,
    song_name: str = "Song",
) -> str:
    """Overlay the vocal stem onto the original instrumental, preserving the
    instrumental bit-for-bit as the timing base. Returns the bare output
    filename (lives in COMFYUI_OUTPUT_DIR so downloads resolve)."""
    safe = "".join(c if c.isalnum() or c in " _-" else "_" for c in song_name).strip()[:40] or "Song"
    out_name = f"jam_vocals_{safe}_{int(time.time())}.mp3"
    out_path = config.COMFYUI_OUTPUT_DIR / out_name
    out_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg", "-y",
        "-i", str(jam_path),
        "-i", str(vocal_stem),
        "-filter_complex",
        "[1:a]apad[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[vout]",
        "-map", "[vout]",
        "-c:a", "libmp3lame",
        "-q:a", "2",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg mix failed: {proc.stderr[-400:]}")
    return out_name


def postprocess_vocalize_job(
    params: dict,
    output_files: list[str],
    song_name: str = "Song",
) -> str:
    """Run the full vocal-mixdown pipeline after an ACE-Step lego job finishes.

    The lego output is only used to harvest the AI-sung vocal stem; the final
    track is the ORIGINAL jam instrumental with those vocals layered on top.
    Returns the final output filename.
    """
    jam_filename = params.get("jam_filename", "")
    if not jam_filename:
        raise ValueError("No jam_filename recorded for vocalize job")

    jam_path = JAM_DIR / jam_filename
    if not jam_path.is_file():
        raise FileNotFoundError(f"Original jam missing on server: {jam_filename}")

    if not output_files:
        raise ValueError("No lego output files to harvest vocals from")

    lego_path = resolve_output_file(output_files[0])
    if lego_path is None:
        raise FileNotFoundError(f"Could not resolve lego output: {output_files[0]}")

    vocal_stem = extract_vocal_stem(lego_path)
    return mix_vocals_over_instrumental(jam_path, vocal_stem, song_name)