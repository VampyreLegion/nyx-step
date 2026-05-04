import os
import pathlib

COMFYUI_URL = "http://127.0.0.1:8188"
OLLAMA_URL = "http://localhost:11434"
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")

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

PRESETS_DIR = pathlib.Path("/home/legion/legionprojects/nyx-step/presets")
PRESETS_DIR.mkdir(exist_ok=True)

DB_PATH = pathlib.Path("/home/legion/legionprojects/nyx-step/nyx_step.db")

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB

# Rate limiting: max requests per window per user
RATE_LIMIT_MAX = 20
RATE_LIMIT_WINDOW = 60  # seconds

# ── Video generation ──────────────────────────────────────────────────────────
_NYX_STEP = pathlib.Path("/home/legion/legionprojects/nyx-step")

WORKFLOW_VIDEO_T2V = _NYX_STEP / "workflow_video_t2v.json"
WORKFLOW_VIDEO_I2V = _NYX_STEP / "workflow_video_i2v.json"

VIDEO_OUTPUT_DIR = _COMFYUI / "output" / "video"
VIDEO_CHUNK_DIR  = VIDEO_OUTPUT_DIR / "chunks"
VIDEO_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
VIDEO_CHUNK_DIR.mkdir(parents=True, exist_ok=True)

WAN_MODEL        = "wan2.1_t2v_1.3B_bf16.safetensors"
WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN_VAE          = "wan_2.1_vae.safetensors"
