from __future__ import annotations
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse as _JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from core.job_tracker import JobTracker

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="MusicWeb")

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


def get_user_email(request: Request) -> str:
    return request.headers.get("Cf-Access-Authenticated-User-Email", "dev@local")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


# Register routers
from routes.generate import router as gen_router
from routes.queue import router as queue_router
from routes.download import router as dl_router
from routes.stems import router as stems_router
from routes.ollama_routes import router as ollama_router
from routes.presets import router as presets_router

app.include_router(gen_router)
app.include_router(queue_router)
app.include_router(stems_router)
app.include_router(ollama_router)
app.include_router(dl_router)
app.include_router(presets_router)

import json as _json
from fastapi.responses import JSONResponse
from core.prompt_linter import PromptLinter
from pydantic import BaseModel as _BaseModel

_linter = PromptLinter()

class _LintRequest(_BaseModel):
    tags: str = ""
    lyrics: str = ""

@app.post("/lint")
async def lint(req: _LintRequest):
    results = _linter.lint(req.tags, req.lyrics)
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
        "Tone": ["breathy", "raspy", "smooth", "nasal", "powerful", "clear"],
        "Style": ["whispered", "belted", "falsetto", "spoken word", "operatic"],
        "Texture": ["airy", "gritty", "warm", "bright", "vibrato", "melismatic"],
        "Gender": ["male vocal", "female vocal", "androgynous vocal"],
    }
