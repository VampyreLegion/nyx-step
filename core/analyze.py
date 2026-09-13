from __future__ import annotations
import logging
import pathlib

import numpy as np
import soundfile as sf
from scipy.signal import find_peaks

logger = logging.getLogger(__name__)

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _load_mono(path: pathlib.Path, max_seconds: float = 120.0) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), always_2d=True, dtype="float32")
    mono = data.mean(axis=1)
    return mono[:int(sr * max_seconds)], sr


def _get_duration(path: pathlib.Path) -> float:
    """Full-file duration via file header (no full decode)."""
    try:
        info = sf.info(str(path))
        return round(info.frames / info.samplerate, 2)
    except Exception:
        return 0.0


def estimate_bpm(mono: np.ndarray, sr: int) -> int:
    try:
        import librosa
        tempo = float(librosa.feature.tempo(y=mono, sr=sr)[0])
        if 55 <= tempo <= 210:
            return int(round(tempo))
    except Exception:
        pass
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


def estimate_key(mono: np.ndarray, sr: int) -> tuple[str, str, float]:
    """Estimate key+scale via a consensus of chroma windows and methods (Krumhansl).

    Returns (key, scale, confidence). Scale is title-cased ("Major"/"Minor") to
    match the frontend select options. Tuning is disabled so a slightly sharp
    track doesn't shift the detected key by a semitone.
    """
    import librosa

    total = len(mono) / sr
    windows: list[tuple[int, int]] = []
    for s in range(0, min(int(total), 120), 30):
        windows.append((s, min(s + 30, int(total))))
    if total > 60 and (0, 120) not in windows:
        windows.append((0, 120))

    votes: dict[tuple[str, str], float] = {}
    for start, end in windows:
        seg = mono[int(start * sr):int(end * sr)]
        if len(seg) < int(2 * sr):
            continue
        chromas = [
            librosa.feature.chroma_cqt(y=seg, sr=sr, tuning=0.0),
            librosa.feature.chroma_stft(y=seg, sr=sr),
        ]
        for chroma in chromas:
            mean_c = chroma.mean(axis=1)
            for template, scale in ((_KS_MAJOR, "Major"), (_KS_MINOR, "Minor")):
                best, best_root, best_scale = -2.0, "C", scale
                for root in range(12):
                    corr = float(np.corrcoef(mean_c, np.roll(template, root))[0, 1])
                    if corr > best:
                        best, best_root = corr, NOTE_NAMES[root]
                if best > 0.15:
                    votes[(best_root, best_scale)] = votes.get((best_root, best_scale), 0.0) + best

    if not votes:
        return "C", "Major", 0.0

    ranked = sorted(votes.items(), key=lambda kv: kv[1], reverse=True)
    (key, scale), top = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = top / (top + runner) if (top + runner) > 0 else 1.0
    return key, scale, round(confidence, 3)


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
_KEY_PCS = {
    "Major": {0, 2, 4, 5, 7, 9, 11},
    "Minor": {0, 2, 3, 5, 7, 8, 10},
}
_CHORD_QUALITIES: dict[str, tuple[int, ...]] = {
    "": (0, 4, 7),      # major
    "m": (0, 3, 7),     # minor
    "7": (0, 4, 7, 10), # dominant 7
}

def _build_chord_templates() -> None:
    """Build major/minor chord templates over 12 pitch classes."""
    if _CHORD_TEMPLATES:
        return
    major = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]  # root, M3, P5
    minor = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]  # root, m3, P5
    for root in range(12):
        _CHORD_TEMPLATES[NOTE_NAMES[root]] = [major[(i - root) % 12] for i in range(12)]
        _CHORD_TEMPLATES[NOTE_NAMES[root] + "m"] = [minor[(i - root) % 12] for i in range(12)]


def _diatonic_templates(key: str, scale: str) -> dict[str, list[float]]:
    """Chord templates whose notes all belong to the detected key's scale.

    Suppresses out-of-key chords (e.g. Bm or Fm in A minor) that simple
    template matching picks up from beat transients and harmonics.
    """
    key_pc = NOTE_NAMES.index(key)
    pcs = _KEY_PCS.get(scale, _KEY_PCS["Major"])
    abs_pcs = {(key_pc + iv) % 12 for iv in pcs}
    templates: dict[str, list[float]] = {}
    for chord_root in range(12):
        for suffix, intervals in _CHORD_QUALITIES.items():
            if {(chord_root + iv) % 12 for iv in intervals} <= abs_pcs:
                name = NOTE_NAMES[chord_root] + suffix
                vector = [0.0] * 12
                for iv in intervals:
                    vector[(chord_root + iv) % 12] = 1.0
                templates[name] = vector
    return templates


def estimate_chords(
    mono: np.ndarray, sr: int, key: str = "C", scale: str = "Major", n_chords: int = 8
) -> str:
    """Detect the most prominent chord progression from the audio.

    Constrained to chords diatonic to the detected key so the result is a
    coherent harmonic map for the model (out-of-key artifacts are dropped).
    """
    try:
        import librosa
        templates = _diatonic_templates(key, scale)
        safe = {k: v for k, v in templates.items() if not k.endswith("7")}
        if not safe:
            _build_chord_templates()
            templates = _CHORD_TEMPLATES
        else:
            templates = safe
        hop = 4096
        chroma = librosa.feature.chroma_stft(y=mono, sr=sr, hop_length=hop, n_fft=8192)
        # Median-pool into segments of ~1 beat
        seg_frames = max(1, sr // hop // 2)
        n_segs = chroma.shape[1] // seg_frames
        chords_seq: list[str] = []
        for s in range(n_segs):
            seg = chroma[:, s * seg_frames:(s + 1) * seg_frames].mean(axis=1)
            best, best_chord = -1.0, ""
            for name, tmpl in templates.items():
                score = float(np.dot(seg, tmpl) / (np.linalg.norm(seg) * np.linalg.norm(tmpl) + 1e-8))
                if score > best:
                    best, best_chord = score, name
            chords_seq.append(best_chord)
        # Collapse consecutive duplicates
        compressed: list[str] = []
        for c in chords_seq:
            if c and (not compressed or compressed[-1] != c):
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
    key, scale, key_conf = estimate_key(mono, sr)

    duration = _get_duration(path) or round(len(mono) / sr, 2)
    lufs = estimate_lufs(path)
    chords = estimate_chords(mono, sr, key, scale)

    # Transcription via Whisper
    transcription = transcribe(path)

    result: dict = {
        "bpm": bpm,
        "key": key,
        "scale": scale,
        "key_confidence": round(key_conf, 3),
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
