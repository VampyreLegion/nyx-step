from __future__ import annotations
import logging
import pathlib

import numpy as np
import soundfile as sf
from scipy.signal import find_peaks
from scipy.fft import rfft

logger = logging.getLogger(__name__)

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _load_mono(path: pathlib.Path, max_seconds: float = 120.0) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), always_2d=True, dtype="float32")
    mono = data.mean(axis=1)
    return mono[:int(sr * max_seconds)], sr


def estimate_bpm(mono: np.ndarray, sr: int) -> int:
    hop = 512
    frame = 1024
    energies = np.array([
        float(np.sqrt(np.mean(mono[i:i + frame] ** 2)))
        for i in range(0, len(mono) - frame, hop)
    ])
    if len(energies) < 4:
        return 120
    # Smooth energy
    kernel = np.ones(5) / 5
    energies = np.convolve(energies, kernel, mode="same")
    peaks, _ = find_peaks(energies, distance=max(1, int(sr * 0.2 / hop)))
    if len(peaks) < 2:
        return 120
    intervals_s = np.diff(peaks) * hop / sr
    median_interval = float(np.median(intervals_s))
    bpm = 60.0 / median_interval if median_interval > 0 else 120.0
    # Bring into 60–200 range
    while bpm < 60:
        bpm *= 2
    while bpm > 200:
        bpm /= 2
    return int(round(bpm))


def estimate_key(mono: np.ndarray, sr: int) -> tuple[str, str]:
    segment = mono[:sr * 30]
    win = 2048
    chroma = np.zeros(12, dtype=float)
    for i in range(0, len(segment) - win, win // 2):
        frame = segment[i:i + win] * np.hanning(win)
        spectrum = np.abs(rfft(frame))
        freqs = np.fft.rfftfreq(win, 1.0 / sr)
        for j in range(1, len(freqs)):
            f = freqs[j]
            if f < 27.5 or f > 4200:
                continue
            midi = 12 * np.log2(f / 440.0) + 69
            pc = int(round(midi)) % 12
            chroma[pc] += spectrum[j]

    best_score, best_key, best_scale = -2.0, "C", "major"
    for root in range(12):
        maj = np.corrcoef(chroma, np.roll(_KS_MAJOR, root))[0, 1]
        mni = np.corrcoef(chroma, np.roll(_KS_MINOR, root))[0, 1]
        if maj > best_score:
            best_score, best_key, best_scale = maj, NOTE_NAMES[root], "major"
        if mni > best_score:
            best_score, best_key, best_scale = mni, NOTE_NAMES[root], "minor"
    return best_key, best_scale


def _transcribe_impl(path: pathlib.Path, language: str | None = None) -> dict:
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="auto", compute_type="auto")
    segments, info = model.transcribe(
        str(path),
        language=language,
        word_timestamps=False,
        vad_filter=True,
    )
    lyrics_lines = []
    for seg in segments:
        start = f"{int(seg.start // 60):02d}:{seg.start % 60:05.2f}"
        lyrics_lines.append(f"[{start}] {seg.text.strip()}")
    return {
        "lyrics": "\n".join(lyrics_lines),
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
    }


def transcribe(path: pathlib.Path, language: str | None = None) -> dict:
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(_transcribe_impl, path, language)
        try:
            return future.result(timeout=120)
        except concurrent.futures.TimeoutError:
            logger.warning("Transcription timed out for %s", path.name)
            return {"lyrics": "", "language": "en", "language_probability": 0.0}
        except Exception as exc:
            logger.warning("Transcription failed: %s", exc)
            return {"lyrics": "", "language": "en", "language_probability": 0.0}


_CHORD_TEMPLATES: dict[str, list[float]] = {}

def _build_chord_templates() -> None:
    """Build major/minor chord templates over 12 pitch classes."""
    if _CHORD_TEMPLATES:
        return
    major = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]  # root, M3, P5
    minor = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]  # root, m3, P5
    for root in range(12):
        _CHORD_TEMPLATES[NOTE_NAMES[root]] = [major[(i - root) % 12] for i in range(12)]
        _CHORD_TEMPLATES[NOTE_NAMES[root] + "m"] = [minor[(i - root) % 12] for i in range(12)]


def estimate_chords(mono: np.ndarray, sr: int, n_chords: int = 8) -> str:
    """Detect the most prominent chord progression from the audio."""
    try:
        import librosa
        _build_chord_templates()
        hop = 4096
        chroma = librosa.feature.chroma_stft(y=mono, sr=sr, hop_length=hop, n_fft=8192)
        # Median-pool into segments of ~1 beat
        seg_frames = max(1, sr // hop // 2)
        n_segs = chroma.shape[1] // seg_frames
        chords_seq: list[str] = []
        for s in range(n_segs):
            seg = chroma[:, s * seg_frames:(s + 1) * seg_frames].mean(axis=1)
            best, best_chord = -1.0, "C"
            for name, tmpl in _CHORD_TEMPLATES.items():
                score = float(np.dot(seg, tmpl) / (np.linalg.norm(seg) * np.linalg.norm(tmpl) + 1e-8))
                if score > best:
                    best, best_chord = score, name
            chords_seq.append(best_chord)
        # Collapse consecutive duplicates
        compressed: list[str] = []
        for c in chords_seq:
            if not compressed or compressed[-1] != c:
                compressed.append(c)
        # Return the n_chords most representative unique chords in order
        seen: list[str] = []
        for c in compressed:
            if c not in seen:
                seen.append(c)
            if len(seen) >= n_chords:
                break
        return " - ".join(seen) if seen else ""
    except Exception:
        return ""


def estimate_lufs(path: pathlib.Path) -> float | None:
    """Measure integrated LUFS via pyloudnorm (ITU-R BS.1770-4)."""
    try:
        import pyloudnorm as pyln
        data, sr = sf.read(str(path), always_2d=True, dtype="float32")
        meter = pyln.Meter(sr)
        loudness = meter.integrated_loudness(data)
        if np.isfinite(loudness):
            return round(float(loudness), 1)
        return None
    except Exception:
        return None


def analyze(path: pathlib.Path) -> dict:
    try:
        mono, sr = _load_mono(path)
    except Exception as exc:
        return {"error": f"Could not load audio: {exc}"}

    bpm = estimate_bpm(mono, sr)
    key, scale = estimate_key(mono, sr)

    duration = round(len(mono) / sr, 2)
    lufs = estimate_lufs(path)
    chords = estimate_chords(mono, sr)

    # Transcription via Whisper
    transcription = transcribe(path)

    result: dict = {
        "bpm": bpm,
        "key": key,
        "scale": scale,
        "duration": duration,
        "lyrics": transcription["lyrics"],
        "vocal_language": transcription["language"],
        "language_probability": transcription["language_probability"],
    }
    if lufs is not None:
        result["lufs"] = lufs
    if chords:
        result["chords"] = chords
    return result
