"""
Generation Quality Score
Analyzes a completed audio file and returns a 0–10 composite quality score
plus per-dimension breakdowns.

Dimensions scored:
  loudness    — integrated LUFS vs. streaming target (–14 LUFS)
  dynamics    — loudness range (LRA); good music has ≥ 6 LU
  spectral    — spectral balance and high-freq content (not all bass/mud)
  saturation  — absence of clipping / digital distortion
  coherence   — RMS stability over time (consistent energy, no dropouts)
"""
from __future__ import annotations
import asyncio
import concurrent.futures
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import config
from musicweb import get_user_email

router = APIRouter()
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)


def _score_quality(audio_path: Path) -> dict:
    import numpy as np

    try:
        import librosa
        import soundfile as sf
        y_stereo, sr = sf.read(str(audio_path), always_2d=True)
        y_mono = y_stereo.mean(axis=1)
    except Exception as exc:
        return {"error": str(exc)}

    scores: dict[str, float] = {}
    details: dict[str, str] = {}

    # ── 1. Loudness ─────────────────────────────────────────────────────────────
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
        # pyloudnorm needs shape (samples, channels)
        lufs = meter.integrated_loudness(y_stereo)
        target = -14.0
        diff = abs(lufs - target)
        if diff <= 2:
            s = 10.0
        elif diff <= 5:
            s = 10 - (diff - 2) * 1.5
        elif diff <= 10:
            s = 5.5 - (diff - 5) * 0.7
        else:
            s = max(0.0, 2.0 - (diff - 10) * 0.2)
        scores["loudness"] = round(max(0.0, min(10.0, s)), 1)
        details["loudness"] = f"{lufs:.1f} LUFS (target –14)"
    except Exception:
        scores["loudness"] = 5.0
        details["loudness"] = "unable to measure"

    # ── 2. Dynamics (LRA approximation) ─────────────────────────────────────────
    try:
        frame_len = int(sr * 0.4)
        hop = frame_len // 2
        rms_frames = librosa.feature.rms(y=y_mono, frame_length=frame_len, hop_length=hop)[0]
        rms_db = librosa.amplitude_to_db(rms_frames + 1e-9)
        active = rms_db[rms_db > rms_db.max() - 40]
        lra = float(np.percentile(active, 95) - np.percentile(active, 10)) if len(active) > 10 else 0
        if lra >= 8:
            s = 10.0
        elif lra >= 5:
            s = 7.0 + (lra - 5) * 1.0
        elif lra >= 2:
            s = 4.0 + (lra - 2) * 1.0
        else:
            s = max(0.0, lra * 2)
        scores["dynamics"] = round(max(0.0, min(10.0, s)), 1)
        details["dynamics"] = f"LRA ≈ {lra:.1f} LU"
    except Exception:
        scores["dynamics"] = 5.0
        details["dynamics"] = "unable to measure"

    # ── 3. Spectral balance ─────────────────────────────────────────────────────
    try:
        stft = np.abs(librosa.stft(y_mono, n_fft=2048, hop_length=512))
        freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
        # Energy in low / mid / high bands
        lo = stft[freqs < 250].mean()
        mid = stft[(freqs >= 250) & (freqs < 4000)].mean()
        hi = stft[freqs >= 4000].mean()
        total = lo + mid + hi + 1e-9
        lo_r, mid_r, hi_r = lo / total, mid / total, hi / total
        # Penalise extreme bass-heavy or treble-heavy signals
        balance_penalty = abs(lo_r - 0.35) + abs(mid_r - 0.45) + abs(hi_r - 0.20)
        s = max(0.0, 10.0 - balance_penalty * 20)
        # Centroid in a reasonable range → bonus
        centroid = librosa.feature.spectral_centroid(y=y_mono, sr=sr).mean()
        if 800 < centroid < 4000:
            s = min(10.0, s + 1.0)
        scores["spectral"] = round(max(0.0, min(10.0, s)), 1)
        details["spectral"] = f"centroid {centroid:.0f} Hz | lo {lo_r:.0%} mid {mid_r:.0%} hi {hi_r:.0%}"
    except Exception:
        scores["spectral"] = 5.0
        details["spectral"] = "unable to measure"

    # ── 4. Saturation / clipping ─────────────────────────────────────────────────
    try:
        peak = float(np.abs(y_stereo).max())
        clipped_pct = float((np.abs(y_stereo) > 0.999).sum() / y_stereo.size * 100)
        if clipped_pct < 0.01:
            s = 10.0
        elif clipped_pct < 0.1:
            s = 8.0
        elif clipped_pct < 0.5:
            s = 5.0
        else:
            s = max(0.0, 3.0 - clipped_pct * 0.5)
        scores["saturation"] = round(max(0.0, min(10.0, s)), 1)
        details["saturation"] = f"peak {peak:.3f} | clipped {clipped_pct:.3f}%"
    except Exception:
        scores["saturation"] = 5.0
        details["saturation"] = "unable to measure"

    # ── 5. Energy coherence ─────────────────────────────────────────────────────
    try:
        rms_short = librosa.feature.rms(y=y_mono, frame_length=int(sr * 0.1), hop_length=int(sr * 0.05))[0]
        cv = float(rms_short.std() / (rms_short.mean() + 1e-9))
        silence_pct = float((rms_short < rms_short.max() * 0.03).sum() / len(rms_short) * 100)
        if cv < 0.5 and silence_pct < 5:
            s = 10.0
        elif cv < 1.0:
            s = 8.0 - cv * 2
        else:
            s = max(0.0, 5.0 - (cv - 1.0) * 2)
        if silence_pct > 20:
            s = max(0.0, s - 3.0)
        scores["coherence"] = round(max(0.0, min(10.0, s)), 1)
        details["coherence"] = f"CV {cv:.2f} | silence {silence_pct:.1f}%"
    except Exception:
        scores["coherence"] = 5.0
        details["coherence"] = "unable to measure"

    # ── Composite ───────────────────────────────────────────────────────────────
    weights = {"loudness": 0.25, "dynamics": 0.20, "spectral": 0.25, "saturation": 0.15, "coherence": 0.15}
    composite = sum(scores[k] * w for k, w in weights.items())

    return {
        "composite": round(composite, 1),
        "scores": scores,
        "details": details,
        "grade": "A" if composite >= 8 else "B" if composite >= 6.5 else "C" if composite >= 5 else "D",
    }


@router.get("/quality/{filename:path}")
async def quality_score(filename: str, request: Request):
    get_user_email(request)

    audio_path: Path | None = None
    for p in config.COMFYUI_OUTPUT_DIR.rglob(filename):
        audio_path = p
        break
    if audio_path is None:
        direct = config.COMFYUI_OUTPUT_DIR / filename
        if direct.exists():
            audio_path = direct
    if audio_path is None:
        return JSONResponse({"error": f"File not found: {filename}"}, status_code=404)

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_executor, lambda: _score_quality(audio_path))

    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)
    return result
