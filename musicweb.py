from __future__ import annotations
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from core.job_tracker import JobTracker

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="MusicWeb")

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

app.include_router(gen_router)
app.include_router(queue_router)
app.include_router(stems_router)
app.include_router(ollama_router)
app.include_router(dl_router)
