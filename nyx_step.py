from __future__ import annotations
import logging
from pathlib import Path

# Load .env before config is imported
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            import os as _os
            _k, _v = _line.split("=", 1)
            _os.environ.setdefault(_k.strip(), _v.strip())

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse as _JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from core.job_tracker import JobTracker

logging.basicConfig(level=logging.INFO)

import config as _config
import core.db as _db
_db.init_db(_config.DB_PATH)

app = FastAPI(title="Nyx-Step", docs_url="/api/docs", redoc_url="/api/redoc")

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    msgs = "; ".join(
        f"{' → '.join(str(l) for l in e['loc'][1:])}: {e['msg']}"
        for e in exc.errors()
    )
    return _JSONResponse({"error": f"Invalid parameters: {msgs}"}, status_code=400)

# Shared job tracker — one instance for the process lifetime
tracker = JobTracker()

# Static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# Cf-Access-* headers are only trustworthy when the request comes through the
# Cloudflare tunnel on Astraea — direct LAN clients could spoof them.
_TRUSTED_PROXIES = {"192.168.1.109", "127.0.0.1", "::1"}


def get_user_email(request: Request) -> str:
    client_ip = request.client.host if request.client else ""
    if client_ip in _TRUSTED_PROXIES:
        return request.headers.get("Cf-Access-Authenticated-User-Email", "dev@local")
    return "dev@local"


@app.get("/health")
async def health():
    return {"status": "ok", "version": "4.0.0"}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    resp = templates.TemplateResponse(request, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# Register routers
from routes.generate import router as gen_router
from routes.queue import router as queue_router
from routes.download import router as dl_router
from routes.stems import router as stems_router
from routes.ollama_routes import router as ollama_router
from routes.presets import router as presets_router
from routes.remix import router as remix_router
from routes.history import router as history_router
from routes.library import router as library_router
from routes.jam import router as jam_router
from routes.analyze import router as analyze_router
from routes.train import router as train_router
from routes.midi import router as midi_router
from routes.lego import router as lego_router
from routes.extract import router as extract_router
from routes.radio import router as radio_router
from routes.lrc import router as lrc_router
from routes.quality import router as quality_router
from routes.video import router as video_router
from routes.daw import router as daw_router
from routes.youtube import router as youtube_router
from routes.groovelab import router as groovelab_router
from routes.tag_library import router as tag_library_router
from routes.templates_route import router as templates_router
from routes.favorites import router as favorites_router
from routes.versions import router as versions_router
from routes.mood_arc import router as mood_arc_router
from routes.auto_genre import router as auto_genre_router
from routes.collections import router as collections_router
from routes.arrangement import router as arrangement_router
from routes.layers import router as layers_router
from routes.call_response import router as call_response_router
from routes.quick_remix import router as quick_remix_router
from routes.batch import router as batch_router
from routes.voice_prompt import router as voice_prompt_router
from routes.groove_to_song import router as groove_to_song_router
from routes.smart_fill import router as smart_fill_router

app.include_router(gen_router)
app.include_router(queue_router)
app.include_router(stems_router)
app.include_router(ollama_router)
app.include_router(dl_router)
app.include_router(presets_router)
app.include_router(remix_router)
app.include_router(history_router)
app.include_router(library_router)
app.include_router(jam_router)
app.include_router(analyze_router)
app.include_router(train_router)
app.include_router(midi_router)
app.include_router(lego_router)
app.include_router(extract_router)
app.include_router(radio_router)
app.include_router(lrc_router)
app.include_router(quality_router)
app.include_router(video_router)
app.include_router(daw_router)
app.include_router(youtube_router)
app.include_router(groovelab_router)
app.include_router(tag_library_router)
app.include_router(templates_router)
app.include_router(favorites_router)
app.include_router(versions_router)
app.include_router(mood_arc_router)
app.include_router(auto_genre_router)
app.include_router(collections_router)
app.include_router(arrangement_router)
app.include_router(layers_router)
app.include_router(call_response_router)
app.include_router(quick_remix_router)
app.include_router(batch_router)
app.include_router(voice_prompt_router)
app.include_router(groove_to_song_router)
app.include_router(smart_fill_router)

import json as _json
from fastapi.responses import JSONResponse
from core.prompt_linter import PromptLinter
from pydantic import BaseModel as _BaseModel

_linter = PromptLinter()

class _LintRequest(_BaseModel):
    tags: str = ""
    lyrics: str = ""
    duration: float = 0.0

@app.post("/lint")
async def lint(req: _LintRequest):
    results = _linter.lint(req.tags, req.lyrics, duration=req.duration)
    return {"results": [{"severity": r.severity, "field": r.field,
                         "message": r.message, "suggestion": r.suggestion}
                        for r in results]}

@app.get("/api/instruments")
async def api_instruments():
    import config
    data = _json.loads(config.ACETALK_INSTRUMENTS.read_text())
    cats = []
    for cat_name, subcats in data["categories"].items():
        subs = []
        for sub_name, items in subcats.items():
            subs.append({"name": sub_name, "items": items})
        cats.append({"name": cat_name, "subcategories": subs})
    return {"categories": cats}

@app.get("/api/genres")
async def api_genres():
    import config
    return _json.loads(config.ACETALK_GENRES.read_text())

@app.get("/api/vocals")
async def api_vocals():
    return {
        "Tone": [
            "breathy", "raspy", "smooth", "nasal", "powerful", "clear",
            "husky", "gravelly", "velvety", "rich", "resonant", "mellow",
            "dark", "bright tone", "thin", "piercing", "sharp", "airy tone",
        ],
        "Style": [
            "whispered", "belted", "falsetto", "spoken word", "operatic",
            "head voice", "chest voice", "mixed voice", "crooning", "soulful",
            "gospel", "rap", "chanting", "yodeling", "scat", "staccato",
            "legato", "melismatic", "conversational", "monotone", "ad-lib",
        ],
        "Texture & Technique": [
            "vibrato", "tremolo", "vocal fry", "growl", "scream", "flutter",
            "distorted vocal", "overdriven", "creaky", "gritty texture",
            "warm texture", "wet reverb", "dry", "intimate", "layered",
            "doubled vocal", "pitch-shifted",
        ],
        "Range": [
            "soprano", "mezzo-soprano", "alto", "contralto",
            "tenor", "baritone", "bass", "countertenor", "boy soprano",
        ],
        "Emotion": [
            "passionate", "melancholic", "joyful", "angry", "tender",
            "haunting", "longing", "playful", "intense", "nostalgic",
            "ethereal", "dramatic", "serene", "raw", "vulnerable", "confident",
        ],
        "Arrangement": [
            "lead vocal", "solo", "choir", "background vocals",
            "vocal harmonies", "call and response", "unison", "a cappella",
            "duet", "group vocal",
        ],
        "Voice Type": [
            "male vocal", "female vocal", "androgynous vocal",
            "male tenor", "male baritone", "male bass",
            "female soprano", "female alto",
        ],
        "Production": [
            "auto-tuned", "heavy reverb", "intimate mic", "processed vocal",
            "lo-fi vocal", "telephone effect", "vocoder", "harmonizer",
        ],
    }
