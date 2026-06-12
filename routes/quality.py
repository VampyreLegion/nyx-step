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
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import config
import core.db as db
from core.executor import get_audio_pool
from nyx_step import get_user_email

router = APIRouter()


def suggest_fixes(scores: dict, metrics: dict) -> list[dict]:
    """Map low dimension scores to concrete tag/parameter remedies.

    Each suggestion: {"dimension", "text", "add_tags": [...], "param_hint": str}
    add_tags may be empty when the fix is parameter-side only.
    """
    fixes: list[dict] = []

    if scores.get("loudness", 10) < 7:
        lufs = metrics.get("lufs", -14)
        if lufs < -16:
            fixes.append({
                "dimension": "loudness",
                "text": f"Track is quiet ({lufs} LUFS vs −14 target)",
                "add_tags": ["punchy", "powerful"],
                "param_hint": "",
            })
        elif lufs > -12:
            fixes.append({
                "dimension": "loudness",
                "text": f"Track is hot ({lufs} LUFS vs −14 target)",
                "add_tags": ["spacious", "dynamic"],
                "param_hint": "",
            })

    if scores.get("dynamics", 10) < 6:
        fixes.append({
            "dimension": "dynamics",
            "text": f"Over-compressed (LRA ≈ {metrics.get('lra', '?')} LU)",
            "add_tags": ["dynamic", "expressive"],
            "param_hint": "Try CFG 3–4 or sampler euler_ancestral for more variation",
        })

    if scores.get("spectral", 10) < 6:
        lo, hi = metrics.get("lo_r", 0.35), metrics.get("hi_r", 0.20)
        if lo > 0.45:
            fixes.append({
                "dimension": "spectral",
                "text": f"Bass-heavy mix ({lo:.0%} energy below 250 Hz)",
                "add_tags": ["bright", "crisp", "airy"],
                "param_hint": "Consider removing heavy bass instrument tags",
            })
        elif hi > 0.30:
            fixes.append({
                "dimension": "spectral",
                "text": f"Treble-heavy mix ({hi:.0%} energy above 4 kHz)",
                "add_tags": ["warm", "full", "deep bass"],
                "param_hint": "",
            })
        else:
            fixes.append({
                "dimension": "spectral",
                "text": "Unbalanced frequency spectrum",
                "add_tags": ["balanced mix", "full"],
                "param_hint": "",
            })

    if scores.get("saturation", 10) < 8:
        fixes.append({
            "dimension": "saturation",
            "text": f"Clipping detected ({metrics.get('clipped_pct', '?')}% samples)",
            "add_tags": [],
            "param_hint": "Regenerate — clipping is rare and usually seed-specific",
        })

    if scores.get("coherence", 10) < 6:
        if metrics.get("silence_pct", 0) > 20:
            fixes.append({
                "dimension": "coherence",
                "text": f"Excessive silence ({metrics.get('silence_pct')}%)",
                "add_tags": ["continuous", "flowing"],
                "param_hint": "Check structural brackets aren't creating empty sections",
            })
        else:
            fixes.append({
                "dimension": "coherence",
                "text": f"Inconsistent energy (CV {metrics.get('cv', '?')})",
                "add_tags": [],
                "param_hint": "Increase Steps; use er_sde + linear_quadratic",
            })

    return fixes


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
    metrics: dict[str, float] = {}

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
        metrics["lufs"] = round(float(lufs), 1)
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
        metrics["lra"] = round(lra, 1)
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
        metrics["lo_r"], metrics["mid_r"], metrics["hi_r"] = round(float(lo_r), 2), round(float(mid_r), 2), round(float(hi_r), 2)
        metrics["centroid"] = round(float(centroid), 0)
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
        metrics["clipped_pct"] = round(clipped_pct, 3)
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
        metrics["cv"] = round(cv, 2)
        metrics["silence_pct"] = round(silence_pct, 1)
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
        "suggestions": suggest_fixes(scores, metrics),
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
    result = await loop.run_in_executor(get_audio_pool(), lambda: _score_quality(audio_path))

    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=400)
    try:
        db.set_history_quality(filename, result["composite"])
    except Exception:
        pass  # insight storage is best-effort
    return result
