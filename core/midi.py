from __future__ import annotations
import io
import tempfile
from pathlib import Path

import librosa
import numpy as np


def _hz_to_midi(hz: np.ndarray) -> np.ndarray:
    """Convert Hz to MIDI note numbers (NaN where unvoiced)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        midi = 12 * np.log2(hz / 440.0) + 69
    return midi


def _notes_from_pyin(f0: np.ndarray, voiced: np.ndarray, times: np.ndarray,
                     min_duration_s: float = 0.05) -> list[tuple[float, float, int, int]]:
    """Convert pyin f0 track → list of (start_s, end_s, midi_note, velocity)."""
    notes = []
    in_note = False
    note_start = 0.0
    note_midi = 0

    for i, (t, hz, v) in enumerate(zip(times, f0, voiced)):
        if v and not in_note:
            in_note = True
            note_start = float(t)
            note_midi = int(round(float(_hz_to_midi(np.array([hz]))[0])))
        elif not v and in_note:
            dur = float(t) - note_start
            if dur >= min_duration_s:
                notes.append((note_start, float(t), note_midi, 80))
            in_note = False

    if in_note and len(times) > 0:
        dur = float(times[-1]) - note_start
        if dur >= min_duration_s:
            notes.append((note_start, float(times[-1]), note_midi, 80))

    return notes


def _write_midi(notes: list[tuple[float, float, int, int]],
                tempo_bpm: float = 120.0,
                program: int = 0) -> bytes:
    """Write notes to a MIDI file and return bytes."""
    import mido
    mid = mido.MidiFile(type=0)
    track = mido.MidiTrack()
    mid.tracks.append(track)

    tempo_us = int(60_000_000 / tempo_bpm)
    track.append(mido.MetaMessage("set_tempo", tempo=tempo_us, time=0))
    track.append(mido.Message("program_change", program=program, time=0))

    ticks_per_beat = mid.ticks_per_beat
    events: list[tuple[float, str, int, int]] = []
    for start, end, note, vel in notes:
        note = max(0, min(127, note))
        events.append((start, "on", note, vel))
        events.append((end, "off", note, 0))

    events.sort(key=lambda x: x[0])

    prev_s = 0.0
    for t_s, kind, note, vel in events:
        delta_s = max(0.0, t_s - prev_s)
        delta_ticks = int(delta_s * ticks_per_beat * tempo_bpm / 60.0)
        if kind == "on":
            track.append(mido.Message("note_on", note=note, velocity=vel, time=delta_ticks))
        else:
            track.append(mido.Message("note_off", note=note, velocity=0, time=delta_ticks))
        prev_s = t_s

    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


def melody_notes(audio_path: str) -> list[tuple[float, float, int, int]]:
    """Monophonic melody note list via librosa pyin."""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"), sr=sr)
    times = librosa.times_like(f0, sr=sr)
    voiced = voiced_flag & ~np.isnan(f0)
    f0_clean = np.where(voiced, f0, 0.0)
    return _notes_from_pyin(f0_clean, voiced, times)


def rhythm_notes(audio_path: str, pitch: int = 38) -> list[tuple[float, float, int, int]]:
    """Percussive onsets → short hits on a single pitch, velocity from onset strength."""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time")
    env_times = librosa.times_like(env, sr=sr)
    emax = float(env.max()) if len(env) else 1.0
    if emax <= 0:
        emax = 1.0
    notes = []
    for t in onsets:
        idx = int(np.argmin(np.abs(env_times - t))) if len(env_times) else 0
        s = float(env[idx]) if idx < len(env) else emax
        vel = int(max(40, min(120, 40 + (s / emax) * 80)))
        notes.append((float(t), float(t) + 0.12, int(pitch), vel))
    return notes


def _notes_from_midi_bytes(b: bytes) -> list[tuple[float, float, int, int]]:
    """Parse MIDI bytes → absolute-time note tuples."""
    import mido
    mid = mido.MidiFile(file=io.BytesIO(b))
    tempo = 500000
    abs_t = 0.0
    pending: dict[int, tuple[float, int]] = {}
    notes = []
    for msg in mido.merge_tracks(mid.tracks):
        abs_t += mido.tick2second(msg.time, mid.ticks_per_beat, tempo)
        if msg.type == "set_tempo":
            tempo = msg.tempo
        elif msg.type == "note_on" and msg.velocity > 0:
            pending[msg.note] = (abs_t, msg.velocity)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            if msg.note in pending:
                st, v = pending.pop(msg.note)
                notes.append((st, abs_t, int(msg.note), int(v)))
    return notes


def piano_notes(audio_path: str) -> list[tuple[float, float, int, int]]:
    """Polyphonic piano note list (runs the transcription model, parses its MIDI)."""
    midi_bytes, _ = extract_piano_midi(audio_path)
    return _notes_from_midi_bytes(midi_bytes)


def notes_to_json(notes: list[tuple[float, float, int, int]]) -> list[dict]:
    return [{"start": round(s, 4), "dur": round(max(0.0, e - s), 4),
             "pitch": int(p), "vel": int(v)} for (s, e, p, v) in notes]


def extract_melody_midi(audio_path: str, bpm: float = 120.0) -> tuple[bytes, dict]:
    """Monophonic melody extraction using librosa pyin. Returns (midi_bytes, info_dict)."""
    notes = melody_notes(audio_path)
    midi_bytes = _write_midi(notes, tempo_bpm=bpm, program=0)
    midi_notes = [n[2] for n in notes]
    end = max((n[1] for n in notes), default=0.0)
    return midi_bytes, {
        "mode": "melody",
        "note_count": len(notes),
        "pitch_range": f"{librosa.midi_to_note(min(midi_notes))}–{librosa.midi_to_note(max(midi_notes))}" if midi_notes else "—",
        "duration_s": float(end),
    }


def extract_piano_midi(audio_path: str) -> tuple[bytes, dict]:
    """
    Polyphonic piano transcription using piano-transcription-inference.
    Returns (midi_bytes, info_dict).
    """
    from piano_transcription_inference import PianoTranscription, load_audio, sample_rate

    audio, _ = load_audio(audio_path, sr=sample_rate, mono=True)

    with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as tmp:
        tmp_path = tmp.name

    transcriptor = PianoTranscription(device="cuda", checkpoint_path=None)
    transcriptor.transcribe(audio, tmp_path)

    midi_bytes = Path(tmp_path).read_bytes()
    Path(tmp_path).unlink(missing_ok=True)

    # Parse note stats from the MIDI we just wrote
    try:
        import mido
        mid = mido.MidiFile(file=io.BytesIO(midi_bytes))
        note_count = sum(
            1 for track in mid.tracks
            for msg in track
            if msg.type == "note_on" and msg.velocity > 0
        )
    except Exception:
        note_count = 0

    return midi_bytes, {
        "mode": "piano",
        "note_count": note_count,
        "pitch_range": "A0–C8",
        "duration_s": 0.0,
    }
