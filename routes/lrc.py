"""
LRC Synchronized Lyrics
Approximates time-aligned lyrics from a generated audio file + raw lyrics text.

Algorithm:
  1. Load audio, compute RMS energy envelope at ~10 Hz
  2. Detect phrase boundaries: sustained low-energy gaps > gap_threshold seconds
  3. Distribute lyric lines across detected phrase start times
  4. If more lyric lines than phrase starts: evenly interpolate remaining times
  5. Return LRC text and optionally save a .lrc file alongside the audio

This is a heuristic approximation — not the DiT attention-alignment method
used by the standalone ACE-Step API — but it produces playable LRC files for
standard music players.
"""
from __future__ import annotations
import asyncio
import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel

import config
from core.executor import get_audio_pool
from nyx_step import get_user_email

router = APIRouter()


def _fmt_lrc_time(seconds: float) -> str:
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"[{minutes:02d}:{secs:05.2f}]"


_INSTRUMENT_VOCAL_TAGS = {
    "guitar", "guitars", "acoustic guitar", "electric guitar", "clean guitar",
    "distorted guitar", "lead guitar", "rhythm guitar", "slide guitar",
    "drums", "drum", "drum kit", "drum set", "percussion", "kick", "snare",
    "hi-hat", "hihat", "cymbal", "cymbals", "tom", "toms", "ride", "crash",
    "bass", "bass guitar", "electric bass", "upright bass", "double bass",
    "piano", "keys", "keyboard", "synth", "synthesizer", "organ", "rhodes",
    "wurlitzer", "clavinet", "mellotron", "pad", "pads", "lead synth",
    "strings", "string", "violin", "viola", "cello", "orchestra", "orchestral",
    "brass", "trumpet", "trombone", "sax", "saxophone", "horn", "horns",
    "woodwind", "flute", "clarinet", "oboe", "bassoon",
    "vocal", "vocals", "voice", "lead vocal", "lead vocals", "backing vocal",
    "backing vocals", "bgv", "harmony", "harmonies", "choir", "a cappella",
    "acappella", "rap", "spoken word", "soprano", "alto", "tenor", "baritone",
    "bass vocal", "male vocal", "male vocals", "female vocal", "female vocals",
    "androgynous vocal", "duet", "group vocal", "call and response",
    "solo", "guitar solo", "piano solo", "sax solo", "saxophone solo",
    "drum solo", "bass solo", "violin solo", "trumpet solo", "organ solo",
    "instrumental", "interlude", "fill", "drum fill", "break", "breakdown",
    "drop", "build", "buildup", "riser", "downlifter",
    "ad-lib", "adlib", "improv", "improvisation",
}


def _is_instrument_vocal_tag(text: str) -> bool:
    """Check if a bracketed line is an instrument/vocal tag (not a structural section)."""
    stripped = text.strip()
    if not (stripped.startswith("[") and stripped.endswith("]")):
        return False
    content = stripped[1:-1].strip().lower()
    if not content:
        return True
    # Structural sections to KEEP (they guide song structure but aren't timed as lyrics)
    structural = {
        "intro", "verse", "pre-chorus", "pre chorus", "chorus", "bridge",
        "outro", "interlude", "drop", "breakdown", "pre-chorus", "post-chorus",
        "pre chorus", "post chorus", "pre-drop", "post-drop",
    }
    # Check if it's a structural section (with optional number/label)
    for s in structural:
        if content == s or content.startswith(s + " ") or content.startswith(s + ":"):
            return False
    # Check if it matches known instrument/vocal tags
    if content in _INSTRUMENT_VOCAL_TAGS:
        return True
    # Check for patterns like "guitar solo", "drum fill", "vocal harmony"
    for tag in _INSTRUMENT_VOCAL_TAGS:
        if content.startswith(tag + " ") or content.endswith(" " + tag):
            return True
    return False


def _split_lyrics(text: str) -> list[str]:
    """Split lyrics into non-empty lines, stripping section markers and instrument/vocal tags."""
    lines = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        # Skip structural section brackets like [Verse], [Verse 1], [Chorus 2],
        # [Intro: ...], [Bridge: ...] — metadata, not song text.
        if re.match(r"^\[[^\]]+\]$", stripped):
            continue
        # Skip lines that are entirely instrument/vocal tags like [Guitar], [Drums], [Vocals]
        if _is_instrument_vocal_tag(stripped):
            continue
        # Strip leading instrument/vocal tag from lines like "[Guitar] Some lyrics here"
        leading_tag_match = re.match(r"^\[[^\]]+\]\s*(.+)$", stripped)
        if leading_tag_match and _is_instrument_vocal_tag(leading_tag_match.group(0).split("]")[0] + "]"):
            stripped = leading_tag_match.group(1).strip()
            if not stripped:
                continue
        lines.append(stripped)
    return lines


def _generate_lrc(audio_path: Path, lyrics_text: str, bpm: float) -> str:
    """CPU-bound work — runs in executor."""
    import numpy as np

    try:
        import librosa
        y, sr = librosa.load(str(audio_path), mono=True, sr=22050)
    except Exception as exc:
        return f"[00:00.00]LRC generation failed: {exc}"

    lines = _split_lyrics(lyrics_text)
    if not lines:
        return "[00:00.00]No lyrics"

    duration = len(y) / sr

    # ── Phrase boundary detection via RMS energy ───────────────────────────────
    frame_length = 2048
    hop = 512
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)

    # Threshold = 20th percentile of non-silent frames
    threshold = np.percentile(rms[rms > 0], 20) if (rms > 0).any() else 0.01
    is_silent = rms < threshold

    # Find transitions from silent → active (phrase starts)
    phrase_starts: list[float] = []
    min_gap = 0.8  # seconds of silence before counting as a new phrase
    min_phrase = 1.5  # minimum seconds between phrase starts
    in_silence = False
    silence_start = 0.0

    for t, sil in zip(times, is_silent):
        if sil and not in_silence:
            in_silence = True
            silence_start = t
        elif not sil and in_silence:
            in_silence = False
            gap = t - silence_start
            if gap >= min_gap and (not phrase_starts or t - phrase_starts[-1] >= min_phrase):
                phrase_starts.append(t)
    if not phrase_starts:
        phrase_starts = [0.0]

    # Keep a trailing margin so the outro/slow-down isn't crammed with lines.
    tail_margin = 3.0
    usable_end = max(2.0, duration - tail_margin)
    anchors = [t for t in phrase_starts if t < usable_end]

    # Assign every line a strictly increasing slot spread evenly across the
    # whole singing window, snapping to a nearby detected phrase start when one
    # is close — so lines never collapse onto one timestamp before the end.
    n = len(lines)
    first = anchors[0] if anchors else 0.0
    span = max(1.0, usable_end - first)

    line_times: list[float] = []
    used = 0
    prev = -1.0
    for i in range(n):
        ideal = first + span * ((i + 0.5) / n)
        while used < len(anchors) and anchors[used] < ideal - 0.8:
            used += 1
        t = ideal
        if used < len(anchors) and anchors[used] <= ideal + 1.0:
            t = anchors[used]
            used += 1
        if t <= prev:
            t = prev + 0.2
        t = min(t, usable_end)
        if t > usable_end - 0.05:
            t = max(prev, usable_end - 0.05)
        line_times.append(t)
        prev = t

    # ── Assign lyrics → times ──────────────────────────────────────────────────
    lrc_lines = [(t, line) for t, line in zip(line_times, lines)]

    header = (
        f"[ti:Generated by Nyx-Step]\n"
        f"[ar:Nyx Studios]\n"
        f"[length:{int(duration//60):02d}:{duration%60:.2f}]\n"
    )
    body = "\n".join(f"{_fmt_lrc_time(t)}{line}" for t, line in lrc_lines)
    return header + body


class LRCRequest(BaseModel):
    filename: str
    lyrics: str
    bpm: float = 120.0
    save: bool = True


@router.post("/lrc/generate")
async def generate_lrc(request: Request, body: LRCRequest):
    get_user_email(request)

    # Find audio file
    audio_path: Path | None = None
    for search_dir in [config.COMFYUI_OUTPUT_DIR, config.COMFYUI_OUTPUT_DIR / "audio"]:
        candidate = search_dir / body.filename
        if candidate.exists():
            audio_path = candidate
            break
    if audio_path is None:
        for p in config.COMFYUI_OUTPUT_DIR.rglob(body.filename):
            audio_path = p
            break
    if audio_path is None:
        return JSONResponse({"error": f"Audio file not found: {body.filename}"}, status_code=404)

    loop = asyncio.get_event_loop()
    lrc_content = await loop.run_in_executor(
        get_audio_pool(), lambda: _generate_lrc(audio_path, body.lyrics, body.bpm)
    )

    if body.save:
        lrc_path = audio_path.with_suffix(".lrc")
        lrc_path.write_text(lrc_content, encoding="utf-8")

    return {"lrc": lrc_content, "filename": audio_path.stem + ".lrc"}


@router.get("/lrc/download/{filename}")
async def download_lrc(filename: str, request: Request):
    get_user_email(request)
    lrc_path: Path | None = None
    for p in config.COMFYUI_OUTPUT_DIR.rglob(filename):
        lrc_path = p
        break
    if lrc_path is None:
        return JSONResponse({"error": "LRC file not found"}, status_code=404)
    return PlainTextResponse(
        lrc_path.read_text(encoding="utf-8"),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
