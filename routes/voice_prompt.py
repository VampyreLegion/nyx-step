from __future__ import annotations
import tempfile, os
from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse
from nyx_step import get_user_email

router = APIRouter()

@router.post("/voice-to-prompt")
async def voice_to_prompt(request: Request, file: UploadFile = File(...)):
    user_email = get_user_email(request)
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        from core.analyze import transcribe as whisper_transcribe
        result = whisper_transcribe(tmp_path)
        transcript = result.get("text", "")
        import httpx
        async with httpx.AsyncClient(base_url="http://localhost:11434", timeout=30) as client:
            r = await client.post("/api/generate", json={
                "model": "llama3.1:8b",
                "prompt": f"Convert this spoken music description into ACE-Step style tags (comma-separated, no explanations): \"{transcript}\"",
                "stream": False,
            })
            tags = r.json().get("response", transcript).strip()
        return JSONResponse({"transcript": transcript, "suggested_tags": tags})
    except Exception as e:
        return JSONResponse({"transcript": "", "suggested_tags": "", "error": str(e)})
    finally:
        os.unlink(tmp_path)
