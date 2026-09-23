import os
import pathlib

COMFYUI_URL = "http://127.0.0.1:8188"
OLLAMA_URL = "http://localhost:11434"
RADIO_HOST = os.getenv("RADIO_HOST", "127.0.0.1")
RADIO_PORT = int(os.getenv("RADIO_PORT", "8001"))
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
YOUTUBE_COVER_MODEL = os.getenv("YOUTUBE_COVER_MODEL", "sd_xl_turbo_1.0_fp16.safetensors")

# ID3/FLAC tag defaults. Per-song override is sent as `artist` / `album`
# in the generate request and stored in job params.
DEFAULT_ARTIST = os.getenv("DEFAULT_ARTIST", "Legion and Nyx")
DEFAULT_ALBUM  = os.getenv("DEFAULT_ALBUM", "Nyx-Step AI")

_ACETALK = pathlib.Path("/home/legion/legionprojects/ComfyUI/AceUser")
_COMFYUI = pathlib.Path("/home/legion/legionprojects/ComfyUI")

WORKFLOW_TEMPLATE          = _ACETALK / "workflow_template.json"
WORKFLOW_EXTRACT_TEMPLATE  = _ACETALK / "workflow_extract_template.json"
WORKFLOW_REMIX_TEMPLATE    = _ACETALK / "workflow_remix_template.json"
WORKFLOW_REPAINT_TEMPLATE  = _ACETALK / "workflow_repaint_template.json"
WORKFLOW_LEGO_TEMPLATE          = _ACETALK / "workflow_lego_template.json"
WORKFLOW_MULTIREPAINT_TEMPLATE        = _ACETALK / "workflow_multirepaint_template.json"
WORKFLOW_RADIO_CONTINUE_TEMPLATE      = _ACETALK / "workflow_radio_continue_template.json"
ACEUSER_HTML               = _ACETALK / "Aceuser.html"
ACETALK_INSTRUMENTS        = _ACETALK / "acetalk" / "data" / "instruments.json"
ACETALK_TEMPLATES          = _ACETALK / "acetalk" / "data" / "templates.json"
ACETALK_GENRES             = _ACETALK / "acetalk" / "data" / "genres.json"

COMFYUI_OUTPUT_DIR  = _COMFYUI / "output" / "audio"
COMFYUI_INPUT_DIR   = _COMFYUI / "input"
DEMUCS_OUTPUT_DIR   = COMFYUI_OUTPUT_DIR / "separated"

# Radio segments are copied here after completion so Liquidsoap on Astraea
# can serve them directly via the Nyx_storage CIFS mount.
RADIO_OUTPUT_DIR = pathlib.Path("/media/Nyx_storage/Radio")

# Repo-relative paths — resolve the same on Nyx, but stay portable (CI)
_NYX_STEP = pathlib.Path(__file__).resolve().parent

PRESETS_DIR = _NYX_STEP / "presets"
SINGERS_DATA = _NYX_STEP / "data" / "singers.json"

DB_PATH = _NYX_STEP / "nyx_step.db"

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB

# Rate limiting: max requests per window per user
RATE_LIMIT_MAX = 20
RATE_LIMIT_WINDOW = 60  # seconds

# ── Video generation ──────────────────────────────────────────────────────────
WORKFLOW_VIDEO_T2V = _NYX_STEP / "workflow_video_t2v.json"
WORKFLOW_VIDEO_I2V = _NYX_STEP / "workflow_video_i2v.json"

VIDEO_OUTPUT_DIR = _COMFYUI / "output" / "video"
VIDEO_CHUNK_DIR  = VIDEO_OUTPUT_DIR / "chunks"

# Nyx-local paths — creation fails off-Nyx (e.g. CI); features that need them
# will error at use time instead of blocking import.
for _d in (RADIO_OUTPUT_DIR, PRESETS_DIR, VIDEO_OUTPUT_DIR, VIDEO_CHUNK_DIR):
    try:
        _d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

WAN_MODEL        = "wan2.1_t2v_1.3B_bf16.safetensors"
WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN_VAE          = "wan_2.1_vae.safetensors"
