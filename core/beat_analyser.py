from __future__ import annotations
import logging
import re
from pathlib import Path

import librosa
import numpy as np

logger = logging.getLogger(__name__)

_SECTION_RE = re.compile(r"^\[([^\]]+)\]", re.MULTILINE)


def parse_sections(lyrics: str) -> list[str]:
    """Return ordered list of unique section names from lyrics [Tag] markers."""
    names = []
    for m in _SECTION_RE.finditer(lyrics):
        name = m.group(1).split(":")[0].strip()
        if name not in names:
            names.append(name)
    return names if names else ["Main"]


def _wan_align(frame_count: int) -> int:
    """Round frame_count down to nearest (4k+1) for Wan latent alignment."""
    if frame_count <= 1:
        return 1
    k = (frame_count - 1) // 4
    return max(1, k * 4 + 1)


def _per_frame_weights(beat_times: np.ndarray, total_frames: int, fps: float,
                       sync_mode: str) -> np.ndarray:
    """Return normalised per-frame weight array (0–1). Peaks at beat frames."""
    weights = np.full(total_frames, 0.5)
    if sync_mode == "section_only":
        return weights
    for bt in beat_times:
        frame = int(bt * fps)
        if 0 <= frame < total_frames:
            weights[frame] = 1.0
    from scipy.ndimage import gaussian_filter1d
    weights = gaussian_filter1d(weights, sigma=2.0)
    mn, mx = weights.min(), weights.max()
    if mx > mn:
        weights = (weights - mn) / (mx - mn)
    return weights


def analyse(
    audio_file: str,
    chunk_seconds: float,
    fps: float,
    sync_mode: str,
    lyrics: str,
    bpm_hint: float | None,
) -> dict:
    """
    Analyse audio file and return a schedule dict for the video orchestrator.
    sync_mode: "section_only" | "beat_only" | "both"
    """
    path = Path(audio_file)
    y, sr = librosa.load(str(path), sr=None, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    if bpm_hint and bpm_hint > 0:
        bpm = float(bpm_hint)
        beat_times = np.arange(0, duration, 60.0 / bpm)
    else:
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    total_frames = max(1, int(duration * fps))
    weights = _per_frame_weights(beat_times, total_frames, fps, sync_mode)

    sections = parse_sections(lyrics)
    n_chunks = max(1, int(np.ceil(duration / chunk_seconds)))
    section_duration = duration / len(sections) if sections else duration

    chunks = []
    for i in range(n_chunks):
        start = i * chunk_seconds
        end = min(start + chunk_seconds, duration)
        raw_frames = max(1, int((end - start) * fps))
        frame_count = _wan_align(raw_frames)

        section_idx = min(int(start / section_duration), len(sections) - 1)
        section = sections[section_idx]

        start_frame = int(start * fps)
        end_frame = min(int(end * fps), total_frames)
        chunk_weights = weights[start_frame:end_frame]
        mean_weight = float(chunk_weights.mean()) if len(chunk_weights) else 0.5

        chunks.append({
            "index": i,
            "start": round(start, 3),
            "end": round(end, 3),
            "section": section,
            "frame_count": frame_count,
            "mean_beat_weight": round(mean_weight, 4),
        })

    return {
        "audio_file": str(path),
        "bpm": round(bpm, 2),
        "duration": round(duration, 3),
        "beat_times": [round(float(t), 4) for t in beat_times.tolist()],
        "chunks": chunks,
    }
