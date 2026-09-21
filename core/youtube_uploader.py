from __future__ import annotations
import json
import logging
import os
import pathlib
import subprocess
import tempfile
import threading
import time
import uuid

logger = logging.getLogger(__name__)

_SCOPE = "https://www.googleapis.com/auth/youtube"
_TOKEN_PATH = pathlib.Path(__file__).resolve().parent.parent / ".youtube_token.json"
_CLIENT_SECRET_PATH = pathlib.Path(__file__).resolve().parent.parent / "client_secret.json"

# In-memory upload job store (mirrors core/video_orchestrator style)
_upload_jobs: dict[str, dict] = {}


def _client_config() -> dict | None:
    """Build the Google OAuth client config from .env or client_secret.json."""
    client_id = os.getenv("YOUTUBE_CLIENT_ID", "").strip()
    client_secret = os.getenv("YOUTUBE_CLIENT_SECRET", "").strip()
    if client_id and client_secret:
        return {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                "redirect_uris": [os.getenv("YOUTUBE_REDIRECT_URI", "http://localhost:8001/youtube/auth/callback")],
            }
        }
    if _CLIENT_SECRET_PATH.exists():
        try:
            data = json.loads(_CLIENT_SECRET_PATH.read_text())
            if any(k in data for k in ("web", "installed")):
                return data
        except Exception as exc:
            logger.warning("Failed to read client_secret.json: %s", exc)
    return None


def is_configured() -> bool:
    return _client_config() is not None


def token_path() -> pathlib.Path:
    override = os.getenv("YOUTUBE_TOKEN_PATH", "").strip()
    return pathlib.Path(override) if override else _TOKEN_PATH


def has_token() -> bool:
    return token_path().exists()


def _load_token() -> dict:
    try:
        return json.loads(token_path().read_text())
    except Exception:
        return {}


def save_token(token: dict) -> None:
    token_path().write_text(json.dumps(token))
    try:
        os.chmod(token_path(), 0o600)
    except OSError:
        pass


def clear_token() -> None:
    token_path().unlink(missing_ok=True)


def redirect_uri() -> str:
    return os.getenv("YOUTUBE_REDIRECT_URI", "http://localhost:8001/youtube/auth/callback").strip()


def build_auth_url() -> str:
    """Return the Google consent URL for the installed-app flow using a manual code."""
    from google_auth_oauthlib.flow import Flow
    config = _client_config()
    flow = Flow.from_client_config(config, scopes=[_SCOPE], redirect_uri=redirect_uri())
    auth_url, _state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return auth_url


def exchange_code(code: str) -> dict:
    """Exchange an authorization code for tokens and persist them."""
    from google_auth_oauthlib.flow import Flow
    config = _client_config()
    flow = Flow.from_client_config(config, scopes=[_SCOPE], redirect_uri=redirect_uri())
    flow.fetch_token(code=code)
    save_token(dict(flow.credentials.to_json()))
    return get_channel_info()


def _credentials():
    from google.oauth2.credentials import Credentials
    tok = _load_token()
    if not tok:
        raise RuntimeError("Not authenticated — run the YouTube auth flow first")
    config = _client_config() or {}
    client_type = "web" if "web" in config else ("installed" if "installed" in config else None)
    cfg = config.get(client_type, {}) if client_type else {}
    client_id = tok.get("client_id") or cfg.get("client_id", "")
    client_secret = tok.get("client_secret") or cfg.get("client_secret", "")
    return Credentials(
        token=tok.get("token"),
        refresh_token=tok.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=[_SCOPE],
    )


def _youtube():
    from googleapiclient.discovery import build
    return build("youtube", "v3", credentials=_credentials(), cache_discovery=False)


def get_channel_info() -> dict:
    """Return the authenticated channel's title + id (used for status + auth confirm)."""
    yt = _youtube()
    resp = yt.channels().list(part="snippet", mine=True).execute()
    items = resp.get("items", [])
    if not items:
        return {"title": "", "id": ""}
    snip = items[0].get("snippet", {})
    return {"title": snip.get("title", ""), "id": items[0].get("id", "")}


auth_status = lambda: {
    "configured": is_configured(),
    "authed": has_token(),
    "channel": get_channel_info() if has_token() else {},
}


# ── LRC → ASS / SRT (karaoke + captions) ───────────────────────────────────────

def _parse_lrc(lrc_text: str) -> list[tuple[float, str]]:
    import re
    out: list[tuple[float, str]] = []
    for raw in lrc_text.splitlines():
        if not raw.strip():
            continue
        m = re.search(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)", raw)
        if not m:
            continue
        mm, ss, text = int(m.group(1)), float(m.group(2)), m.group(3).strip()
        if not text:
            continue
        out.append((mm * 60 + ss, text))
    return out


def _ass_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    cs = round((s - int(s)) * 100)
    return f"{h}:{m:02d}:{int(s):02d}.{cs:02d}"


def _srt_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = round((sec - int(sec)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def lrc_to_ass(lrc_text: str, fps: int = 30) -> str:
    """Convert LRC to a single-line karaoke ASS (word-level \\k highlight).

    Each lyric line gets one Dialogue event; words pop white-on-color as the
    line plays.  STYLE blocks bottom-center with a soft box so it reads as a
    scrolling lyric video.
    """
    lines = _parse_lrc(lrc_text)
    if not lines:
        return ""
    ends = [t for t, _ in lines[1:]] + [lines[-1][0] + 4.0]

    header = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n"
        "WrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding\n"
        "Style: Karaoke,DejaVu Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
        "-1,0,0,0,100,100,0,0,1,2,0,2,80,80,40,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = []
    for i, ((start, text), end) in enumerate(zip(lines, ends)):
        end = max(end, start + 1.0)
        words = text.split()
        total_chars = max(1, sum(len(w) for w in words))
        dur = end - start
        pieces = []
        elapsed = 0.0
        for w in words:
            w_sec = dur * (len(w) / total_chars)
            k = max(3, int(w_sec * fps))
            pieces.append(f"{{\\k{k}}}{w}")
        karaoke = " ".join(pieces)
        events.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Karaoke,,0,0,0,,{karaoke}")
    return header + "\n".join(events)


def lrc_to_srt(lrc_text: str) -> str:
    lines = _parse_lrc(lrc_text)
    if not lines:
        return ""
    ends = [t for t, _ in lines[1:]] + [lines[-1][0] + 4.0]
    blocks = []
    for i, ((start, text), end) in enumerate(zip(lines, ends), start=1):
        end = max(end, start + 1.0)
        blocks.append(f"{i}\n{_srt_time(start)} --> {_srt_time(end)}\n{text}\n")
    return "\n".join(blocks)


# ── Video assembly (static image + audio + optional burned karaoke) ──────────

def _audio_duration(path: pathlib.Path) -> float:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
            capture_output=True, text=True, timeout=15,
        )
        return float(json.loads(probe.stdout)["format"]["duration"])
    except Exception:
        return 0.0


def generate_cover_ffmpeg(caption: str, song_name: str, out_path: pathlib.Path) -> pathlib.Path:
    """Fallback cover: dark gradient + centered song title, no external deps."""
    song_seg = (song_name or "Nyx-Step")[:80].replace(":", "\\:")
    cap_seg = (caption or "Generated with Nyx-Step AI")[:160].replace(":", "\\:")
    fc = (
        "gradients=s=1920x1080:c0=0x1a1140:c1=0x0d0d14:x0=0:y0=0:x1=1920:y1=1080:nb_colors=2,"
        f"drawtext=text='\\:{song_seg}':fontcolor=white:fontsize=88:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:"
        f"x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.6:shadowx=3:shadowy=3,"
        f"drawtext=text='\\:{cap_seg}':fontcolor=0x7c65d9:fontsize=48:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:"
        f"x=(w-text_w)/2:y=(h-text_h)/2+110[v]"
    )
    cmd = ["ffmpeg", "-y", "-filter_complex", fc, "-map", "[v]", "-frames:v", "1", str(out_path)]
    subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)
    return out_path


MODEL_PRESETS: dict[str, dict] = {
    # majicmixRealistic = photoreal humans (SD1.5). Native sweet spot ~768 wide.
    "majicmixRealistic_v7.safetensors": {
        "width": 768, "height": 1024, "steps": 26, "cfg": 6.5,
        "sampler": "euler", "scheduler": "simple",
        "style": "photorealistic, sharp focus, detailed face, cinematic lighting",
    },
    # SDXL Base = balanced, generic-natural skin tones (least "Asian-lean").
    "sd_xl_base_1.0.safetensors": {
        "width": 1024, "height": 1536, "steps": 24, "cfg": 7.0,
        "sampler": "euler", "scheduler": "karras",
        "style": "photorealistic, cinematic lighting, detailed subject",
    },
    # RealVisXL V5.0 — dedicated photoreal SDXL, least-Asian-lean skin tones (recommended default).
    "RealVisXL_V5.0_fp16.safetensors": {
        "width": 1024, "height": 1536, "steps": 26, "cfg": 5.5,
        "sampler": "euler", "scheduler": "karras",
        "style": "photorealistic, natural skin texture, sharp focus, cinematic lighting",
    },
    # Juggernaut XL v9 (RunDiffusion Photo v2) — top all-round SDXL photorealism, warm-natural skin.
    "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors": {
        "width": 1024, "height": 1536, "steps": 28, "cfg": 6.0,
        "sampler": "euler", "scheduler": "karras",
        "style": "photorealistic, cinematic lighting, detailed subject, neutral skin tones",
    },
    # DreamShaper XL (alpha2 Xl10) — anime/stylized SDXL sibling.
    "dreamshaperXL_alpha2Xl10.safetensors": {
        "width": 1024, "height": 1536, "steps": 26, "cfg": 7.0,
        "sampler": "euler", "scheduler": "karras",
        "style": "masterpiece, best quality, highly detailed, anime style",
    },
    # Porcelain/"anime" is an SDXL model — needs its own prompt idiom & res.
    "ponyDiffusionV6XL_v6.safetensors": {
        "width": 1024, "height": 1536, "steps": 24, "cfg": 7.0,
        "sampler": "euler", "scheduler": "karras",
        "prompt_prefix": "score_9, score_8_up, score_7_up, ",
        "style": "masterpiece, best quality, highly detailed, anime style",
    },
    # RealVisXL V5 = the least-Asian-lean SDXL photoreal series (neutral skin), 1024 native.
    "RealVisXL_V5.0_fp16.safetensors": {
        "width": 1024, "height": 1536, "steps": 22, "cfg": 4.5,
        "sampler": "euler", "scheduler": "karras",
        "style": "photorealistic, natural skin texture, sharp focus, cinematic lighting",
    },
    # Juggernaut XL v9 — best all-round SDXL photoreal, warm-natural skin (RunDiffusion licensed).
    "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors": {
        "width": 1024, "height": 1536, "steps": 26, "cfg": 5.0,
        "sampler": "euler", "scheduler": "karras",
        "style": "photorealistic, detailed face, cinematic lighting, natural skin texture",
    },
    # DreamShaper XL alpha2 — SDXL stylized-anime-friendly, fast (alpha1 lineage).
    "dreamshaperXL_alpha2Xl10.safetensors": {
        "width": 1024, "height": 1536, "steps": 24, "cfg": 5.5,
        "sampler": "euler", "scheduler": "karras",
        "prompt_prefix": "score_9, score_8_up, score_7_up, ",
        "style": "masterpiece, best quality, highly detailed, anime style",
    },
}


def generate_cover_comfyui(
    caption: str,
    song_name: str,
    lyrics: str = "",
    model: str = "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors",
) -> pathlib.Path | None:
    """Generate an album-cover via ComfyUI txt2img (selectable photoreal models).

    Uses lyrics (if provided) to extract visual concepts for more relevant artwork.
    Falls back to caption/tags if no lyrics.
    Accepts `model` = a key into MODEL_PRESETS (default majicmix for photoreal humans).
    """
    import config as cfg
    from core.comfyui import ComfyUIClient
    import re
    import time as _t

    presets = MODEL_PRESETS.get(model) or MODEL_PRESETS["sd_xl_base_1.0.safetensors"]
    ckpt = presets.get("ckpt") or model  # honor the actually-selected checkpoint
    prefix = "nyx_youtube_cover"
    wf = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "text, watermark, signature, logo, blurry, low quality, ugly, deformed, noisy, grain, lowres, bad anatomy, extra limbs, cropped, worst quality, jpeg artifacts", "clip": ["1", 1]}},
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": presets["width"], "height": presets["height"], "batch_size": 1},
        },
        "5": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0],
            "seed": int(time.time()) % 2**31,
            "steps": presets["steps"], "cfg": presets["cfg"],
            "sampler_name": presets["sampler"], "scheduler": presets["scheduler"], "denoise": 1.0}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": prefix}},
    }

    if lyrics:
        lines = []
        for raw in lyrics.splitlines():
            stripped = raw.strip()
            if not stripped:
                continue
            if stripped.startswith("[") and stripped.endswith("]"):
                inner = stripped[1:-1]
                if ":" in inner:
                    _, _, detail = inner.partition(":")
                    detail = detail.strip()
                    if detail:
                        lines.append(detail)
                else:
                    lines.append(inner)
            else:
                lines.append(stripped)
        text = " ".join(lines[:10])
        text = re.sub(r'\([^)]*\)', '', text)
        text = text[:300]
        if text:
            prompt = f"{text}, album cover art, vibrant, professional, evocative, no text"
        else:
            prompt = (caption[:400] or song_name or "abstract music album cover")
            prompt += ", album cover art, vibrant, professional, evocative, no text"
    else:
        prompt = (caption[:400] or song_name or "abstract music album cover")
        prompt += ", album cover art, vibrant, professional, evocative, no text"

    wf["2"]["inputs"]["text"] = prompt

    client = ComfyUIClient()
    resp = client.send_workflow(wf)
    if "error" in resp:
        logger.warning("ComfyUI cover failed: %s", resp["error"])
        return None
    pid = resp.get("prompt_id", "")
    output_dir = cfg._COMFYUI / "output"
    for _ in range(300):  # up to 150s (SDXL Base is slower than Turbo)
        time.sleep(0.5)
        hist = client.get_history(pid)
        entry = hist.get(pid, {})
        status_str = entry.get("status", {}).get("status_str", "")
        if status_str == "error":
            return None
        outputs = entry.get("outputs", {})
        for node_out in outputs.values():
            for img in node_out.get("images", []) or []:
                fname = img.get("filename", "")
                if fname and fname.startswith(prefix):
                    path = output_dir / fname
                    if path.exists():
                        return path
    return None


def build_video(
    audio_path: pathlib.Path,
    image_path: pathlib.Path,
    out_path: pathlib.Path,
    ass_path: pathlib.Path | None = None,
    zoom_rate: float = 0.0004,
) -> pathlib.Path:
    """Compose a lyric-video mp4: static cover + audio (+ burned karaoke if ASS).

    zoom_rate is the Ken Burns per-frame scale increment (default 0.0004, a
    slow gentle drift). Lower = slower/smoother zoom, higher = more dramatic.
    """
    dur = _audio_duration(audio_path)
    if dur <= 0:
        raise RuntimeError("Could not read audio duration")

    # Gentle Ken Burns on the still, then optional subtitle burn.
    # NOTE: no 4x canvas upscale here — measured (laplacian var: 22 → 25 vs
    # ideal 1965, +2.7x render). zoompan resamples at fixed precision, so a
    # bigger canvas doesn't help. Sharpness comes from native cover resolution,
    # raised in generate_cover_comfyui (EmptyLatentImage).
    # Gentle Ken Burns on the still, then optional subtitle burn.
    # zoompan z is a per-frame scale multiplier: zoom_rate controls how fast
    # the camera pushes in (higher = faster zoom).
    zoom_expr = f"1+{zoom_rate}*on"
    scale = (
        "[0:v]scale=2200:1240:force_original_aspect_ratio=increase:flags=lanczos,"
        "crop=2200:1240,"
        f"zoompan=z='{zoom_expr}':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':"
        f"d={int(dur * 30)}:fps=30:s=1920x1080,format=yuv420p"
    )
    if ass_path is not None and ass_path.exists():
        scale += f",ass=filename={shlex_quote(str(ass_path))}"
    scale += "[v]"

    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-i", str(image_path),
        "-i", str(audio_path),
        "-filter_complex", scale,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-t", f"{dur:.3f}",
        "-movflags", "+faststart",
        str(out_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=dur * 4 + 120)
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffmpeg timed out building video")
    if result.returncode != 0:
        # Retry without zoompan (some libass/older builds dislike the chain)
        simple = [
            "ffmpeg", "-y", "-loop", "1", "-i", str(image_path),
            "-i", str(audio_path),
            "-vf", (f"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p"
                    + (f",ass={shlex_quote(str(ass_path))}" if ass_path is not None and ass_path.exists() else "")),
            "-map", "1:a", "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k", "-t", f"{dur:.3f}", "-movflags", "+faststart",
            str(out_path),
        ]
        result = subprocess.run(simple, capture_output=True, text=True, timeout=dur * 4 + 120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr[-800:]}")
    if not out_path.exists():
        raise RuntimeError("ffmpeg produced no output file")
    return out_path


def shlex_quote(s: str) -> str:
    """FFmpeg ass filter arg — escape colons and quotes so libass parses the path."""
    return s.replace(":", "\\:").replace("\\", "\\\\")


# ── YouTube upload ─────────────────────────────────────────────────────────────

def upload_video_with_progress(
    path: pathlib.Path,
    *,
    title: str,
    description: str,
    privacy: str = "private",
    category_id: str = "10",
    tags: list[str] | None = None,
    progress_cb=None,
) -> dict:
    """Upload an mp4 to YouTube. Returns dict with id, url, count."""
    from googleapiclient.http import MediaFileUpload
    yt = _youtube()
    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:4200],
            "categoryId": category_id,
            "tags": (tags or [])[:500],
            "defaultAudioLanguage": "en",
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }
    media = MediaFileUpload(str(path), mimetype="video/mp4", resumable=True)
    req = yt.videos().insert(part="snippet,status", body=body, media_body=media)
    last = 0
    while True:
        status, resp = req.next_chunk()
        if status and progress_cb:
            pct = int(status.progress() * 100)
            if pct != last:
                last = pct
                progress_cb(pct)
        if resp:
            vid_id = resp.get("id")
            return {"id": vid_id, "url": f"https://youtu.be/{vid_id}", "privacy": privacy}
        if status is None:
            raise RuntimeError("Upload ended without a response")


def upload_captions(video_id: str, srt_text: str, name: str = "English") -> bool:
    """Attach an SRT caption track to a video. Returns True on success."""
    from googleapiclient.http import MediaFileUpload
    import tempfile
    yt = _youtube()
    with tempfile.NamedTemporaryFile("w", suffix=".srt", delete=False, encoding="utf-8") as f:
        f.write(srt_text)
        tmp = pathlib.Path(f.name)
    try:
        body = {"snippet": {"videoId": video_id, "language": "en", "name": name, "isDraft": False}}
        media = MediaFileUpload(str(tmp), mimetype="application/octet-stream")
        res = yt.captions().insert(part="snippet", body=body, media_body=media).execute()
        return bool(res.get("id"))
    except Exception as exc:
        logger.warning("Caption upload failed: %s", exc)
        return False
    finally:
        tmp.unlink(missing_ok=True)


def add_to_playlist(video_id: str) -> None:
    yt = _youtube()
    playlist_id = os.getenv("YOUTUBE_PLAYLIST_ID", "").strip()
    if not playlist_id:
        return
    yt.playlistItems().insert(
        part="snippet",
        body={"snippet": {"playlistId": playlist_id, "resourceId": {"kind": "youtube#video", "videoId": video_id}}},
    ).execute()


def create_upload_job(data: dict) -> str:
    job_id = str(uuid.uuid4())
    state = {
        "job_id": job_id,
        "status": "queued",
        "progress": 0,
        "note": "preparing…",
        "error": None,
        "video_id": None,
        "url": None,
    }
    state.update(data)
    _upload_jobs[job_id] = state

    def worker():
        thread_local = state
        thread_local["status"] = "running"
        try:
            thread_local.update(_run_upload(thread_local))
            thread_local["status"] = "done"
            thread_local["progress"] = 100
        except Exception as exc:
            logger.warning("YouTube upload failed: %s", exc)
            thread_local["status"] = "error"
            thread_local["error"] = str(exc)

    threading.Thread(target=worker, daemon=True).start()
    return job_id


def get_upload_job(job_id: str) -> dict | None:
    return _upload_jobs.get(job_id)


def _build_video_artifacts(job: dict, tmpdir: pathlib.Path) -> tuple[pathlib.Path, str]:
    """Build cover + karaoke + mp4 inside tmpdir. Returns (video_path, srt_text)."""
    audio_path = pathlib.Path(job["audio_path"])
    if not audio_path.exists():
        raise RuntimeError("Audio file missing")

    # 1. Resolve lyrics (song's saved .lrc, else sync-time the original lyrics)
    lrc_text = _load_or_build_lrc(audio_path, job.get("lyrics", ""), job.get("bpm", 120))
    srt_text = lrc_to_srt(lrc_text) if lrc_text else ""

    # 2. Cover image: user upload > AI > ffmpeg gradient
    image_path = job.get("image_path")
    if image_path and pathlib.Path(image_path).exists():
        cover = pathlib.Path(image_path)
    elif job.get("ai_cover", True):
        cover = generate_cover_comfyui(job.get("caption", ""), job.get("song_name", ""), job.get("lyrics", ""), model=job.get("model", ""))
        if cover is None:
            cover = generate_cover_ffmpeg(job.get("caption", ""), job.get("song_name", ""), tmpdir / "cover.png")
    else:
        cover = generate_cover_ffmpeg(job.get("caption", ""), job.get("song_name", ""), tmpdir / "cover.png")
    if cover is None or not cover.exists():
        raise RuntimeError("No cover image available")

    # 3. Burn karaoke ASS if requested
    ass_path = None
    if job.get("karaoke", True) and lrc_text:
        ass_path = tmpdir / "karaoke.ass"
        ass_path.write_text(lrc_to_ass(lrc_text))
        if not ass_path.read_text().strip():
            ass_path = None

    # 4. Compose the mp4
    video_path = tmpdir / "video.mp4"
    build_video(audio_path, cover, video_path, ass_path)
    return video_path, srt_text


def prepare_video_for_manual_upload(job: dict, out_path: pathlib.Path) -> pathlib.Path:
    """Build the YouTube-ready mp4 without touching Google's API.

    Used for the "download and upload manually" path.  The caption SRT is
    written next to the mp4 so the user can also add CC in YouTube Studio.
    """
    import shutil
    import tempfile
    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="youtube_prep_"))
    try:
        video_path, srt_text = _build_video_artifacts(job, tmpdir)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(video_path, out_path)
        if srt_text:
            try:
                out_path.with_suffix(".srt").write_text(srt_text, encoding="utf-8")
            except OSError:
                pass
        return out_path
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _run_upload(job: dict) -> dict:
    """Core worker: prep synced lyrics, build cover + video, upload, captions."""
    import shutil
    import tempfile

    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="youtube_up_"))
    try:
        video_path, srt_text = _build_video_artifacts(job, tmpdir)

        # 5. Upload
        result = upload_video_with_progress(
            video_path,
            title=job.get("title") or job.get("song_name") or "Nyx-Step",
            description=_build_description(job),
            privacy=job.get("privacy", "private"),
            tags=_build_tags(job),
            progress_cb=lambda pct: _upload_jobs.get(job["job_id"], {}).update(progress=pct),
        )

        # 6. Caption track (CC) — separate from burned karaoke
        if job.get("captions", True) and srt_text:
            try:
                upload_captions(result["id"], srt_text)
            except Exception as exc:
                logger.info("Caption upload skipped: %s", exc)
        try:
            add_to_playlist(result["id"])
        except Exception:
            pass
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _load_or_build_lrc(audio_path: pathlib.Path, lyrics: str, bpm: float) -> str:
    lrc_path = audio_path.with_suffix(".lrc")
    if lrc_path.exists():
        try:
            return lrc_path.read_text(encoding="utf-8")
        except Exception:
            pass
    if not lyrics.strip():
        return ""
    from routes.lrc import _generate_lrc
    return _generate_lrc(audio_path, lyrics, bpm)


def _build_description(job: dict) -> str:
    """Build YouTube description from job metadata and lyrics."""
    # If user provided a description via the UI, use it
    if job.get("description"):
        return job["description"]

    # Otherwise build from metadata + lyrics
    parts = []
    if job.get("caption"):
        parts.append(f"Style: {job['caption']}")

    comments = []
    if job.get("bpm"):
        comments.append(f"BPM {job['bpm']}")
    key = job.get("key", "")
    scale = job.get("scale", "")
    if key:
        comments.append(f"Key {key} {scale}".strip())
    if job.get("genre"):
        comments.append(f"Genre: {job['genre']}")
    if comments:
        parts.append(" | ".join(comments))

    # Add lyrical themes if available
    lyrics = job.get("lyrics", "")
    if lyrics:
        clean_lines = [
            l.strip().replace("(", "").replace(")", "")
            for l in lyrics.split("\n")
            if l.strip() and not l.strip().startswith("[")
        ]
        if clean_lines:
            text = " ".join(clean_lines[:5])
            if text:
                parts.append(text[:300] + ("…" if len(text) > 300 else ""))

    parts.append("\n🎵 Generated with Nyx-Step AI")
    parts.append("🌐 https://nyxstudios.net")
    parts.append("🎨 Cover: AI-generated from lyrics")

    seed = job.get("seed")
    if seed:
        parts.append(f"🔢 Seed: {seed}")
    dit = job.get("dit_model")
    if dit:
        parts.append(f"🤖 Model: ACE-Step {dit}")

    # Hashtags from genre + key lyrics concepts
    hashtags = _extract_hashtags(job.get("caption", ""), lyrics)
    if hashtags:
        parts.append(f"\n{hashtags}")

    return "\n\n".join(p for p in parts if p)


def _extract_hashtags(caption: str, lyrics: str) -> str:
    tags = set()
    genre_tags = {
        "synthwave": ["synthwave", "retrowave", "outrun", "80s", "neon"],
        "cyberpunk": ["cyberpunk", "neon", "futuristic", "dystopian", "scifi"],
        "ambient": ["ambient", "atmospheric", "chill", "meditation", "soundscapes"],
        "lo-fi": ["lofi", "lofihiphop", "chillhop", "studybeats", "relax"],
        "hip hop": ["hiphop", "rap", "beats", "boombap"],
        "trap": ["trap", "808", "hardhitting"],
        "edm": ["edm", "electronic", "dance", "festival"],
        "house": ["house", "deephouse", "dancemusic"],
        "techno": ["techno", "underground", "warehouse", "minimal"],
        "trance": ["trance", "uplifting", "progressive", "euphoric"],
        "drum and bass": ["dnb", "drumandbass", "liquid", "jungle"],
        "dubstep": ["dubstep", "bassmusic", "heavybass"],
        "pop": ["pop", "popmusic", "catchy"],
        "rock": ["rock", "guitar", "band", "livemusic"],
        "metal": ["metal", "heavymetal", "headbanging"],
        "jazz": ["jazz", "smoothjazz", "improvisation"],
        "classical": ["classical", "orchestral", "cinematic"],
        "folk": ["folk", "acoustic", "singer-songwriter"],
        "country": ["country", "americana", "storytelling"],
        "r&b": ["rnb", "soul", "smooth"],
        "funk": ["funk", "groove", "bass"],
        "reggae": ["reggae", "dub", "islandvibes"],
        "latin": ["latin", "reggaeton", "afrobeat", "spanish"],
        "indie": ["indie", "alternative", "underground"],
        "experimental": ["experimental", "avantgarde", "noise"],
    }
    caption_lower = caption.lower()
    for genre, gtags in genre_tags.items():
        if genre in caption_lower:
            for t in gtags:
                tags.add(t)

    visual_keywords = [
        "neon", "city", "night", "midnight", "rain", "fire", "water", "ocean",
        "space", "stars", "moon", "sun", "dawn", "dusk", "sunset", "sunrise",
        "dream", "memory", "love", "heart", "soul", "mind", "time", "journey",
        "road", "highway", "path", "mountain", "forest", "river", "sky", "cloud",
        "light", "dark", "shadow", "glow", "electric", "digital", "synthetic",
        "hope", "pain", "joy", "sorrow", "rage", "peace", "freedom",
    ]
    if lyrics:
        lower = lyrics.lower()
        for kw in visual_keywords:
            if kw in lower:
                tags.add(kw)

    return " ".join(f"#{t}" for t in sorted(tags)[:12])


def _build_tags(job: dict) -> list[str]:
    tags = [t.strip() for t in str(job.get("tags", "")).split(",") if t.strip()]
    tags = tags[:80]
    return tags or ["music"]