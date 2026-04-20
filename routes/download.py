from __future__ import annotations
import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

import config
from musicweb import tracker, get_user_email

router = APIRouter()

_CHAPTER_IDS = ["starthere", "summary", "flowcharts", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"]

_STYLE = (
    "<style>"
    "body{font-family:Arial,sans-serif;font-size:13px;color:#e2e4ed;background:#0b0c10;padding:12px;}"
    "h2{color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;}"
    "h3{color:#00d4b6;} p,li{color:#e2e4ed;margin-bottom:6px;}"
    "table{border-collapse:collapse;width:100%;margin:8px 0;}"
    "th{background:#1a1c26;color:#00d4b6;padding:6px;border:1px solid #2d3041;}"
    "td{padding:6px;border:1px solid #2d3041;color:#e2e4ed;}"
    "code{background:#151720;color:#a6e3a1;padding:2px 4px;border-radius:3px;font-family:monospace;}"
    "pre{background:#151720;color:#cdd6f4;padding:10px;border-radius:6px;border:1px solid #2d3041;}"
    "</style>"
)

_FLOWCHARTS_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Flowcharts</h2>'
    '<div style="margin-bottom:20px;text-align:center">'
    '<p style="color:#8a8f9e;font-size:12px;margin-bottom:8px">How Nyx-Step Works</p>'
    '<img src="/static/images/nyx-step-how-it-works.png" '
    'alt="How Nyx-Step Works" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    '<div style="margin-bottom:20px;text-align:center">'
    '<p style="color:#8a8f9e;font-size:12px;margin-bottom:8px">How AI Creates Music From Static (Audio Diffusion Process)</p>'
    '<img src="/static/images/nyx-audio-diffusion.png" '
    'alt="How AI Creates Music From Static" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    '<div style="margin-bottom:20px;text-align:center">'
    '<p style="color:#8a8f9e;font-size:12px;margin-bottom:8px">Nyx AI Music Keyword &amp; Tag Library</p>'
    '<img src="/static/images/nyx-keyword-library.png" '
    'alt="Nyx AI Music Keyword &amp; Tag Library" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    "</body></html>"
)


_START_HERE_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Start Here</h2>'
    '<div style="text-align:center">'
    '<img src="/static/images/nyx-start-here.png" '
    'alt="From Blank Slate to Beatmaker: A Musical Journey with Nyx AI" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    "</body></html>"
)


def _parse_chapter(section_id: str) -> str:
    """Extract one <h2 id="section_id">...</h2> section from Aceuser.html."""
    if section_id == "starthere":
        return _START_HERE_HTML
    if section_id == "flowcharts":
        return _FLOWCHARTS_HTML
    if not config.ACEUSER_HTML.exists():
        return "<p>Guide file not found.</p>"
    raw = config.ACEUSER_HTML.read_text(encoding="utf-8")
    chunks = re.split(r'(?=<h2\s)', raw)
    for chunk in chunks:
        m = re.search(r'<h2[^>]*id="([^"]+)"', chunk)
        if m and m.group(1) == section_id:
            return f"<html><head>{_STYLE}</head><body>{chunk}</body></html>"
    if section_id == "summary":
        return f"<html><head>{_STYLE}</head><body><p style='color:#8a8f9e'>No summary content found.</p></body></html>"
    return f"<p>Section '{section_id}' not found.</p>"


@router.get("/guide/{section_id}", response_class=HTMLResponse)
async def guide_section(section_id: str):
    if section_id not in _CHAPTER_IDS:
        return HTMLResponse("<p>Invalid section.</p>", status_code=404)
    return HTMLResponse(_parse_chapter(section_id))


@router.get("/download/{filename}")
async def download(filename: str, request: Request):
    user_email = get_user_email(request)

    if not tracker.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    file_path = config.COMFYUI_OUTPUT_DIR / filename
    if not file_path.exists():
        return JSONResponse({"error": "File not on disk"}, status_code=404)

    return FileResponse(
        path=str(file_path),
        media_type="audio/mpeg",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
