"""
Continuous AI Radio — chains Nyx-Step generations so each segment uses the
previous segment's audio as a timbre reference, creating an ever-evolving
stream with AI-generated complete songs (lyrics + vocals + music).

Modes:
  manual — user sets style description; Ollama generates a full song per segment
  auto   — AI DJ picks style from a curated list (or style_override); fully autonomous

Architecture:
  POST /radio/start        — start session
  POST /radio/stop         — stop after current segment
  GET  /radio/events       — SSE: {type: segment|stopped|error, file, segment, song_name, style}
  GET  /radio/status       — current state snapshot
  GET  /radio/random-style — returns a random style string from the DJ list
  POST /radio/generate-params — preview: Ollama generates song params for a style
"""
from __future__ import annotations
import asyncio
import json
import logging
import random
import re
import shutil
import threading
import time
from pathlib import Path

import requests
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

import config
from core.comfyui import ComfyUIClient
from core.executor import get_audio_pool
from nyx_step import tracker, get_user_email
from routes.generate import GenerateRequest

logger = logging.getLogger(__name__)
router = APIRouter()
_client = ComfyUIClient()

# ── DJ style library ───────────────────────────────────────────────────────────
_DJ_STYLES = [
    "lo-fi hip hop, jazzy piano chords, vinyl warmth, female vocals, mellow, 75 BPM",
    "synthwave, 80s retro electronic, pulsing synth bass, male vocals, neon atmosphere, 110 BPM",
    "jazz, acoustic piano, upright bass, brushed drums, female scat vocals, cool jazz, 95 BPM",
    "indie folk, acoustic guitar, fingerpicking, introspective female vocals, warm, 85 BPM",
    "deep house, four-on-the-floor, soulful female vocals, rich bass, atmospheric, 122 BPM",
    "R&B soul, smooth female vocals, groovy bass, electric piano, soulful, 88 BPM",
    "bossa nova, nylon guitar, gentle samba rhythm, Brazilian jazz, female vocals, cool, 92 BPM",
    "funk, slap bass, brass stabs, electric guitar, male vocals, groove, 98 BPM",
    "chillhop, downtempo, hip hop beats, soft piano, female vocal samples, relaxed, 80 BPM",
    "electronic pop, synth leads, punchy drums, female vocals, catchy, energetic, 128 BPM",
    "acoustic singer-songwriter, gentle guitar, personal lyrics, female vocals, intimate, 90 BPM",
    "dream pop, reverb guitar, ethereal female vocals, lush pads, melancholic, 100 BPM",
    "reggae, off-beat rhythms, roots, heavy bass, melodic male vocals, island vibes, 80 BPM",
    "smooth jazz, saxophone, electric piano, female vocalese, late night, cool, 88 BPM",
    "country pop, acoustic guitar, pedal steel, storytelling female vocals, warm, 100 BPM",
    "neo-soul, Rhodes piano, male vocals, organic drums, soulful, introspective, 90 BPM",
    "trip-hop, downtempo, female vocals, cinematic, dark, atmospheric, 85 BPM",
    "indie rock, electric guitar, male vocals, driving drums, energetic, 120 BPM",
    "classical crossover, string quartet, piano, wordless female vocals, elegant",
    "afrobeats, percussion, talking drum, Afro-pop male vocals, joyful, 105 BPM",
    "dark ambient, droning synths, field recordings, whispered spoken word, eerie, 70 BPM",
    "psychedelic rock, fuzz guitar, phaser effects, reverb-heavy male vocals, trippy, 95 BPM",
    "bluegrass, banjo, fiddle, mandolin, tight harmonies, lively, 130 BPM",
    "latin jazz, piano montuno, conga drums, female scat, salsa influence, mambo, 120 BPM",
    "minimal techno, repetitive kick, glitch effects, atmospheric pads, no vocals, driving, 130 BPM",
    "disco, four-on-the-floor, string section, funky bass, female vocals, dance, 118 BPM",
    "folk metal, accordion, distorted guitars, harsh male vocals, epic, 140 BPM",
    "downtempo electronica, warm bass, glitch percussion, ethereal wordless vocals, chill, 90 BPM",
    "gospel choir, organ, piano, powerful female lead, call-and-response, uplifting, 85 BPM",
    "jazz fusion, electric bass slap, syncopated drums, synthesizer leads, complex harmonies, 110 BPM",
    "shoegaze, wall of sound, distorted guitar, ethereal male vocals, atmospheric, 90 BPM",
    "soul blues, slide guitar, Hammond organ, gravelly male vocals, emotional, slow, 72 BPM",
    "drum and bass, breakbeats, sub-bass, atmospheric pads, female vocal samples, 170 BPM",
    "krautrock, motorik beat, analog synths, repetitive bassline, minimal male vocals, 125 BPM",
    "flamenco, acoustic guitar rasgueado, handclaps, passionate male vocals, dance, 105 BPM",
    "vaporwave, slowed samples, cassette warmth, nostalgic synths, pitch-shifted vocals, 90 BPM",
]

_dj_style_iter: list[str] | None = None


# ── Shared radio state ─────────────────────────────────────────────────────────
_state: dict = {
    "active": False,
    "prompt_id": None,
    "segment": 0,
    "last_file": None,
    "history": [],          # list of {file, song_name, style}
    "stream_queue": [],     # filenames waiting to be served to Liquidsoap
    "stream_pointer": 0,    # next index in history to push to stream_queue
    "settings": {},
    "user_email": None,
    "error": None,
    "current_song": "",
    "current_style": "",
    "generating_params": False,
}
_lock = threading.Lock()
_watcher_started = False


# ── Ollama song generation ─────────────────────────────────────────────────────
def _ollama_generate_params(
    style: str,
    bpm: int,
    key: str,
    scale: str,
    duration: float = 30.0,
    model: str = "gemma4:latest",
) -> dict:
    """Ask Ollama to generate a complete song (name, caption, tags, lyrics) for a style."""
    section_hint = (
        "[Verse 1]\nline1\nline2\nline3\nline4\n\n[Chorus]\nline1\nline2\nline3"
        if duration <= 35
        else "[Verse 1]\nline1\nline2\nline3\nline4\n\n[Chorus]\nline1\nline2\nline3\nline4\n\n[Verse 2]\nline1\nline2\nline3\nline4\n\n[Chorus]\nline1\nline2\nline3\nline4\n\n[Outro]\nline1\nline2"
    )

    prompt = (
        f"You are a senior music producer writing prompts for Nyx-Step, an AI music generation system. "
        f"Your descriptions must be specific enough that an AI can generate rich, varied, non-repetitive music.\n\n"
        f"Style: {style}\n"
        f"BPM: {bpm}, Key: {key} {scale}, Duration: ~{duration:.0f}s\n\n"
        f"Output ONLY a JSON object. No markdown, no code fences. Start with {{ end with }}.\n\n"
        f"Fields:\n"
        f"- song_name: evocative 3-6 word title\n"
        f"- tags: comma-separated Nyx-Step style tags. Rules:\n"
        f"  * MUST include a vocal type: 'female vocals', 'male vocals', 'rap vocals', 'choir', or similar\n"
        f"  * Include: primary genre, 2-3 specific instruments (e.g. 'Rhodes piano' not just 'piano'), "
        f"mood, production style (e.g. 'lo-fi', 'live recording', 'studio polished'), tempo feel\n"
        f"  * NO generic placeholders. Be specific.\n"
        f"- caption: 2-3 sentences for the AI to understand the music deeply. Include:\n"
        f"  * Specific chord progression or harmonic movement (e.g. 'Cmaj7-Am7-Fmaj7-G7')\n"
        f"  * Rhythmic feel in detail (e.g. 'swung eighth notes on brushed snare with a syncopated kick', "
        f"NOT 'steady beat' or '16th note pattern')\n"
        f"  * Texture and dynamics (e.g. 'sparse intro builds to full band by bar 8')\n"
        f"  * Vocal delivery style (e.g. 'breathy alto with vibrato', 'punchy tenor rap with ad-libs')\n"
        f"- lyrics: original song lyrics. Structure:\n{section_hint}\n"
        f"  Write vivid, singable lines matching the style. Use real words, not placeholders."
    )

    try:
        resp = requests.post(
            f"{config.OLLAMA_URL}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
            timeout=60,
        )
        resp.raise_for_status()
        text = resp.json().get("response", "").strip()

        # Strip markdown code fences if Ollama added them
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text.strip())

        # Extract first JSON object
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            text = m.group(0)

        data = json.loads(text)
        return {
            "song_name": str(data.get("song_name", "Untitled")).strip(),
            "caption": str(data.get("caption", style)).strip(),
            "tags": str(data.get("tags", style)).strip(),
            "lyrics": str(data.get("lyrics", "")).strip(),
        }
    except Exception as exc:
        logger.warning("Ollama song generation failed (%s): %s", style[:40], exc)
        return {
            "song_name": "Untitled",
            "caption": style,
            "tags": style,
            "lyrics": "",
        }


def _next_dj_style(style_override: str) -> str:
    """Return a DJ style — either from static list or Ollama-generated for variety."""
    global _dj_style_iter
    if style_override.strip():
        return style_override.strip()
    if not _dj_style_iter:
        _dj_style_iter = random.sample(_DJ_STYLES, len(_DJ_STYLES))
    try:
        return _dj_style_iter.pop()
    except IndexError:
        _dj_style_iter = random.sample(_DJ_STYLES, len(_DJ_STYLES))
        return _dj_style_iter.pop()


def _ollama_dj_choice(model: str = "gemma4:latest") -> str:
    """Ask Ollama to freely invent a creative music style for the next set."""
    prompt = (
        "You are the AI DJ for Nyx Radio, curating a diverse electronic music stream. "
        "Invent a COMPLETELY NEW music style for the next song — do NOT repeat anything you've suggested before. "
        "Return ONLY a short style description (10-30 words) — no explanation, no quotes, no JSON, no preamble. "
        "Be inventive and specific: include genre, mood, tempo feel, and instrumentation. "
        "AVOID generic or overused combinations. Think of unusual genre fusions and rare instruments.\n"
        "Examples of the exact format:\n"
        "cinematic synthwave with lush pads, punchy drums, and a wistful melodic lead, 100 BPM\n"
        "upbeat bossa nova with nylon guitar, brushed drums, and warm female vocals, 92 BPM\n"
        "dark industrial techno with distorted bass, mechanical rhythms, and cold atmosphere, 135 BPM\n"
        "experimental glitch-hop with granular synth textures, breakbeat edits, and spoken word, 100 BPM\n"
        "Now invent a fresh style unlike any of those:"
    )
    try:
        resp = requests.post(
            f"{config.OLLAMA_URL}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("response", "").strip().splitlines()[0].strip(" -•")
    except Exception as exc:
        logger.warning("DJ choice Ollama error: %s", exc)
        return random.choice(_DJ_STYLES)


# ── Segment submission ─────────────────────────────────────────────────────────
def _find_output_file(filename: str) -> Path | None:
    """Locate a generated audio file across all known output locations."""
    for candidate in [
        config.COMFYUI_OUTPUT_DIR / filename,
        config.RADIO_OUTPUT_DIR / filename,
    ]:
        if candidate.exists():
            return candidate
    for p in config.COMFYUI_OUTPUT_DIR.parent.rglob(filename):
        return p
    return None


def _copy_to_radio_dir(filename: str) -> None:
    """Copy a completed segment into RADIO_OUTPUT_DIR for Liquidsoap."""
    src = _find_output_file(filename)
    if src is None:
        logger.warning("Radio: cannot copy %s to radio dir — file not found", filename)
        return
    dest = config.RADIO_OUTPUT_DIR / src.name
    if not dest.exists():
        shutil.copy2(src, dest)
        logger.info("Radio: copied %s → %s", src.name, config.RADIO_OUTPUT_DIR)


def _build_caption(song_params: dict) -> str:
    """Combine tags + caption into a single ACE-Step caption string."""
    tags = song_params.get("tags", "")
    cap = song_params.get("caption", "")
    if tags and cap and tags.lower() != cap.lower():
        return f"{tags}. {cap}"
    return tags or cap


def _submit_radio_segment(
    user_email: str,
    settings: dict,
    seg_num: int,
    song_params: dict,
) -> str:
    """Build and submit one radio segment. Returns prompt_id.
    Every segment uses the same build_workflow as the Generate tab — no timbre
    reference chaining, identical parameters."""
    caption = _build_caption(song_params)
    lyrics = song_params.get("lyrics", "")
    song_name = song_params.get("song_name") or f"Radio S{seg_num:03d}"

    radio_req = GenerateRequest(
        tags=caption,
        lyrics=lyrics,
        bpm=settings.get("bpm", 120),
        key=settings.get("key", "C"),
        scale=settings.get("scale", "Major"),
        time_sig=settings.get("time_sig", "4/4"),
        steps=settings.get("steps", 8),
        cfg_scale=settings.get("cfg", 2.0),
        temperature=settings.get("temperature", 0.85),
        top_p=settings.get("top_p", 0.9),
        top_k=settings.get("top_k", 0),
        duration=settings.get("duration", 30),
        seed=0, lock_seed=False,
        audio_format=settings.get("audio_format", "mp3"),
        audio_quality=settings.get("audio_quality", "V0"),
        dit_model=settings.get("dit_model", "turbo"),
        sampler_name=settings.get("sampler_name", "er_sde"),
        scheduler=settings.get("scheduler", "linear_quadratic"),
    )
    state_dict = radio_req.model_dump()

    result = _client.build_workflow(caption, lyrics, state_dict)
    if "workflow" in result:
        for node in result["workflow"].values():
            if isinstance(node, dict) and node.get("class_type") in (
                "SaveAudioMP3", "SaveAudio", "SaveAudioOpus"
            ):
                node.setdefault("inputs", {})["filename_prefix"] = "audio/Nyx_radio"

    if "error" in result:
        raise RuntimeError(result["error"])

    send = _client.send_workflow(result["workflow"])
    if "error" in send:
        raise RuntimeError(send["error"])

    pid = send["prompt_id"]
    safe_params = {k: v for k, v in state_dict.items() if k not in ("tags", "lyrics")}
    safe_params.update({"radio": True, "segment": seg_num})
    tracker.register(pid, user_email, song_name, caption=caption, lyrics=lyrics,
                     seed=result.get("seed", 0), params=safe_params)
    return pid


# ── Background watcher ─────────────────────────────────────────────────────────
def _watcher():
    while True:
        time.sleep(3)
        try:
            with _lock:
                if not _state["active"]:
                    continue
                pid = _state["prompt_id"]
                if not pid:
                    continue

            job = tracker.get(pid)
            if not job or job.status not in ("done", "error"):
                continue

            if job.status == "error":
                with _lock:
                    _state["active"] = False
                    _state["error"] = f"Generation error: {job.error_msg or 'unknown'}"
                continue

            files = job.output_files
            if not files:
                with _lock:
                    _state["active"] = False
                    _state["error"] = "Segment produced no output"
                continue

            output_file = files[0]

            # Copy to Radio directory for Liquidsoap
            _copy_to_radio_dir(output_file)

            with _lock:
                still_active = _state["active"]
                settings = _state["settings"].copy()
                user_email = _state["user_email"]
                next_seg = _state["segment"] + 1

            # Always record completed segment
            with _lock:
                _state["last_file"] = output_file
                _state["history"].append({
                    "file": output_file,
                    "song_name": _state.get("current_song", ""),
                    "style": _state.get("current_style", ""),
                })
                _state["stream_queue"].append(output_file)
                _state["segment"] = next_seg
                _state["error"] = None

            if not still_active:
                continue

            # Generate song params for next segment
            mode = settings.get("mode", "manual")
            if mode == "auto":
                ollama_model = settings.get("ollama_model", "gemma4:latest")
                dj = _ollama_dj_choice(ollama_model)
                style = dj if dj else _next_dj_style(settings.get("style_override", ""))
            else:
                style = settings.get("tags", "")

            with _lock:
                _state["generating_params"] = True

            song_params = _ollama_generate_params(
                style,
                settings.get("bpm", 120),
                settings.get("key", "C"),
                settings.get("scale", "Major"),
                settings.get("duration", 30.0),
                settings.get("ollama_model", "gemma4:latest"),
            )

            with _lock:
                _state["generating_params"] = False
                _state["current_song"] = song_params.get("song_name", "")
                _state["current_style"] = style

            try:
                next_pid = _submit_radio_segment(user_email, settings, next_seg, song_params)
                with _lock:
                    if _state["active"]:
                        _state["prompt_id"] = next_pid
            except Exception as exc:
                logger.error("Radio: failed to submit segment %d: %s", next_seg, exc)
                with _lock:
                    _state["active"] = False
                    _state["error"] = str(exc)

        except Exception as exc:
            logger.warning("Radio watcher unexpected error: %s", exc)


def _ensure_watcher():
    global _watcher_started
    if not _watcher_started:
        t = threading.Thread(target=_watcher, daemon=True, name="radio-watcher")
        t.start()
        _watcher_started = True


# ── Pydantic models ────────────────────────────────────────────────────────────
class RadioStartRequest(BaseModel):
    mode: str = "manual"          # "manual" | "auto"
    tags: str = ""                # style description (manual)
    style_override: str = ""      # auto mode: stick to this style; blank = random
    ollama_model: str = "gemma4:latest"
    bpm: int = 90
    key: str = "C"
    scale: str = "Major"
    time_sig: str = "4/4"
    steps: int = 8
    cfg: float = 2.0
    temperature: float = 0.85
    top_p: float = 0.9
    top_k: int = 0
    duration: float = 30.0
    audio_format: str = "mp3"
    audio_quality: str = "V0"
    dit_model: str = "turbo"
    sampler_name: str = "er_sde"
    scheduler: str = "linear_quadratic"


class GenerateParamsRequest(BaseModel):
    style: str
    bpm: int = 90
    key: str = "C"
    scale: str = "Major"
    duration: float = 30.0
    ollama_model: str = "gemma4:latest"


# ── Routes ─────────────────────────────────────────────────────────────────────
@router.get("/radio/random-style")
async def radio_random_style(request: Request):
    get_user_email(request)
    return {"style": random.choice(_DJ_STYLES)}


@router.get("/radio/dj-choice")
async def radio_dj_choice(request: Request):
    get_user_email(request)
    model = request.query_params.get("model", "gemma4:latest")
    loop = asyncio.get_running_loop()
    style = await loop.run_in_executor(get_audio_pool(), lambda: _ollama_dj_choice(model))
    return {"style": style}


@router.post("/radio/generate-params")
async def radio_generate_params(request: Request, body: GenerateParamsRequest):
    get_user_email(request)
    loop = asyncio.get_running_loop()
    params = await loop.run_in_executor(
        get_audio_pool(),
        lambda: _ollama_generate_params(
            body.style, body.bpm, body.key, body.scale, body.duration, body.ollama_model
        ),
    )
    return params


@router.post("/radio/start")
async def radio_start(request: Request, body: RadioStartRequest):
    user_email = get_user_email(request)
    _ensure_watcher()

    with _lock:
        if _state["active"]:
            return JSONResponse({"error": "Radio already running"}, status_code=409)

    # Pick style for first segment
    if body.mode == "auto":
        style = _next_dj_style(body.style_override)
    else:
        style = body.tags or "pop music, vocals, upbeat"

    # Generate song params via Ollama
    loop = asyncio.get_running_loop()
    song_params = await loop.run_in_executor(
        get_audio_pool(),
        lambda: _ollama_generate_params(
            style, body.bpm, body.key, body.scale, body.duration, body.ollama_model
        ),
    )

    settings = body.model_dump()
    try:
        pid = _submit_radio_segment(user_email, settings, 0, song_params)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)

    with _lock:
        _state.update({
            "active": True,
            "prompt_id": pid,
            "segment": 0,
            "last_file": None,
            "history": [],
            "stream_queue": [],
            "settings": settings,
            "user_email": user_email,
            "error": None,
            "current_song": song_params.get("song_name", ""),
            "current_style": style,
            "generating_params": False,
        })

    return {
        "status": "started",
        "prompt_id": pid,
        "song_name": song_params.get("song_name", ""),
        "style": style,
    }


@router.post("/radio/stop")
async def radio_stop(request: Request):
    get_user_email(request)
    with _lock:
        _state["active"] = False
        _state["generating_params"] = False
    return {"status": "stopped", "segments": _state["segment"]}


@router.get("/radio/status")
async def radio_status():
    with _lock:
        return {
            "active": _state["active"],
            "segment": _state["segment"],
            "last_file": _state["last_file"],
            "history": list(_state["history"]),
            "error": _state["error"],
            "current_song": _state.get("current_song", ""),
            "current_style": _state.get("current_style", ""),
            "generating_params": _state.get("generating_params", False),
        }


@router.get("/radio/next-for-stream", response_class=PlainTextResponse)
async def radio_next_for_stream():
    """Blocking endpoint for Liquidsoap: returns next audio URL as plain text.
    Polls for up to 90s then returns empty string (Liquidsoap retries)."""
    deadline = asyncio.get_event_loop().time() + 90
    while asyncio.get_event_loop().time() < deadline:
        with _lock:
            if _state["stream_queue"]:
                filename = _state["stream_queue"].pop(0)
                return f"http://{config.RADIO_HOST}:{config.RADIO_PORT}/download/{filename}"
        await asyncio.sleep(2)
    return ""


@router.get("/radio/events")
async def radio_events(request: Request):
    """SSE stream. Emits segment events with song_name and style."""
    last_seen = -1

    async def generate():
        nonlocal last_seen
        yield "data: {\"type\": \"connected\"}\n\n"
        while True:
            if await request.is_disconnected():
                break
            with _lock:
                active = _state["active"]
                seg = _state["segment"]
                history = _state["history"]
                error = _state["error"]
                gen_params = _state.get("generating_params", False)

            if error:
                yield f"data: {json.dumps({'type': 'error', 'message': error})}\n\n"
                break

            if seg > last_seen and history:
                entry = history[-1]
                last_seen = seg
                yield f"data: {json.dumps({'type': 'segment', 'file': entry['file'], 'segment': seg, 'song_name': entry.get('song_name',''), 'style': entry.get('style','')})}\n\n"
            elif gen_params:
                yield f"data: {json.dumps({'type': 'generating', 'segment': seg + 1})}\n\n"

            if not active and seg > 0:
                yield f"data: {json.dumps({'type': 'stopped', 'segment': seg})}\n\n"
                break

            yield ": heartbeat\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
