from __future__ import annotations
import json
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


def _probe_rate(path: Path) -> int:
    """Return the audio stream's sample rate via ffprobe (default 48000)."""
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-select_streams", "a:0", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=15,
        )
        streams = json.loads(probe.stdout).get("streams", [])
        if streams:
            return int(streams[0].get("sample_rate", 48000))
    except Exception:
        pass
    return 48000


def _vocal_key_offset(vocal_stem: Path, key: str, scale: str) -> int:
    """Semitones to shift the vocal stem so its detected tonic matches the
    jam's key. Returns 0 when detection is too uncertain to act on."""
    try:
        import numpy as np
        import soundfile as sf
        from core.analyze import NOTE_NAMES, estimate_key
        data, sr = sf.read(str(vocal_stem), always_2d=True, dtype="float32")
        mono = data.mean(axis=1)[: int(sr * 120)]
        if len(mono) < int(sr * 20):
            return 0
        voc_key, voc_scale, voc_conf = estimate_key(mono, sr)
        if voc_conf < 0.5:
            logger.info("skip in-key lock: vocal key uncertain (%.2f)", voc_conf)
            return 0
        try:
            jam_pc = NOTE_NAMES.index(key.upper())
            voc_pc = NOTE_NAMES.index(voc_key.upper())
        except ValueError:
            return 0
        offset = (jam_pc - voc_pc) % 12
        if offset > 6:
            offset -= 12
        if offset == 0:
            return 0
        logger.info("in-key lock: vocal in %s %s -> shifting %+d st to %s", voc_key, voc_scale, offset, key)
        return offset
    except Exception as exc:
        logger.warning("in-key lock failed: %s", exc)
        return 0


def _pitch_shift(path: Path, semitones: int, take_dir: Path) -> Path:
    """Preserve-duration pitch shift via asetrate/aresample/atempo (ffmpeg).

    Handles -6..+6 st cleanly; semitones outside that range are clipped.
    """
    semitones = max(-6, min(6, int(semitones)))
    sr = _probe_rate(path)
    factor = 2 ** (semitones / 12)
    out = take_dir / f"{path.stem}_shift{semitones:+d}.mp3"
    cmd = [
        "ffmpeg", "-y",
        "-i", str(path),
        "-af", (
            f"asetrate={sr * factor:.1f},aresample={sr},atempo={1.0 / factor:.6f}"
        ),
        "-c:a", "libmp3lame", "-q:a", "2",
        str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"pitch shift failed: {proc.stderr[-400:]}")
    return out


def mix_vocals_over_instrumental(
    jam_path: Path,
    vocal_stem: Path,
    song_name: str = "Song",
    vocal_gain_db: float = 0.0,
    duck_jam: bool = False,
    take_index: int = 1,
    takes: int = 1,
    pitch_lock: bool = False,
    lock_key: str = "C",
    lock_scale: str = "Major",
) -> str:
    """Overlay the vocal stem onto the original instrumental, preserving the
    instrumental bit-for-bit as the timing base. Returns the bare output
    filename (lives in COMFYUI_OUTPUT_DIR so downloads resolve).

    - ``vocal_gain_db``: post-fader on the vocal stem (dB).
    - ``duck_jam``: sidechain-compress the jam under the vocal so the song
      pulls back when the singer is present.
    - ``pitch_lock``: when the vocal's detected key differs from the jam's,
      shift it so the tonic matches before mixing.
    """
    jam_sr = _probe_rate(jam_path)
    vocal_sr = _probe_rate(vocal_stem)
    sr = max(jam_sr, vocal_sr)

    stem = vocal_stem
    workdir = config.COMFYUI_OUTPUT_DIR / "vocalize_work"
    workdir.mkdir(parents=True, exist_ok=True)
    if pitch_lock:
        offset = _vocal_key_offset(vocal_stem, lock_key, lock_scale)
        if offset:
            stem = _pitch_shift(vocal_stem, offset, workdir)

    safe = "".join(c if c.isalnum() or c in " _-" else "_" for c in song_name).strip().replace(" ", "_")[:40] or "Song"
    take_tag = f"_take{take_index + 1}" if takes > 1 else ""
    out_name = f"jam_vocals_{safe}{take_tag}_{int(time.time())}.mp3"
    out_path = config.COMFYUI_OUTPUT_DIR / out_name
    out_path.parent.mkdir(parents=True, exist_ok=True)

    gain = min(12.0, max(-12.0, float(vocal_gain_db)))
    gain_frag = f"volume={gain:+.1f}dB," if gain else ""

    if duck_jam:
        # sidechain compress the jam against the vocal as the key input.
        filter_complex = (
            f"[1:a]{gain_frag}aresample={sr},asplit=2[vocL][keysrc];"
            f"[0:a]aresample={sr}[music];"
            f"[music][keysrc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[ducked];"
            f"[ducked][vocL]amix=inputs=2:duration=first:normalize=0[vout]"
        )
    else:
        filter_complex = (
            f"[1:a]{gain_frag}apad[v];"
            f"[0:a][v]amix=inputs=2:duration=first:normalize=0[vout]"
        )

    cmd = [
        "ffmpeg", "-y",
        "-i", str(jam_path),
        "-i", str(stem),
        "-filter_complex", filter_complex,
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
    return mix_vocals_over_instrumental(
        jam_path,
        vocal_stem,
        song_name,
        vocal_gain_db=float(params.get("vocal_gain_db", 0.0)),
        duck_jam=bool(params.get("duck_jam", False)),
        take_index=int(params.get("take_index", 0)),
        takes=int(params.get("takes", 1)),
        pitch_lock=bool(params.get("pitch_lock", False)),
        lock_key=str(params.get("key", "C") or "C"),
        lock_scale=str(params.get("scale", "Major") or "Major"),
    )