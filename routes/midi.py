from __future__ import annotations
import io
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response, JSONResponse

router = APIRouter()


@router.post("/midi/extract")
async def midi_extract(
    file: UploadFile = File(...),
    mode: str = Form("melody"),
    bpm: float = Form(120.0),
):
    if not file.filename:
        return JSONResponse({"error": "No file provided"}, status_code=400)

    suffix = Path(file.filename).suffix or ".audio"
    data = await file.read()

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        if mode == "piano":
            from core.midi import extract_piano_midi
            midi_bytes, info = extract_piano_midi(tmp_path)
        else:
            from core.midi import extract_melody_midi
            midi_bytes, info = extract_melody_midi(tmp_path, bpm=bpm)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    stem = Path(file.filename).stem
    return Response(
        content=midi_bytes,
        media_type="audio/midi",
        headers={
            "Content-Disposition": f'attachment; filename="{stem}_{mode}.mid"',
            "X-Midi-Info": str(info),
            "X-Note-Count": str(info.get("note_count", 0)),
            "X-Pitch-Range": info.get("pitch_range", ""),
            "X-Duration": str(info.get("duration_s", 0.0)),
            "X-Mode": mode,
        },
    )
