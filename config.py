import pathlib

COMFYUI_URL = "http://127.0.0.1:8188"
OLLAMA_URL = "http://localhost:11434"
BRAVE_API_KEY = "REDACTED-BRAVE-KEY"

_ACETALK = pathlib.Path("/home/legion/legionprojects/ComfyUI/AceUser")
_COMFYUI = pathlib.Path("/home/legion/legionprojects/ComfyUI")

WORKFLOW_TEMPLATE          = _ACETALK / "workflow_template.json"
WORKFLOW_EXTRACT_TEMPLATE  = _ACETALK / "workflow_extract_template.json"
ACEUSER_HTML               = _ACETALK / "Aceuser.html"
ACETALK_INSTRUMENTS        = _ACETALK / "acetalk" / "data" / "instruments.json"
ACETALK_TEMPLATES          = _ACETALK / "acetalk" / "data" / "templates.json"
ACETALK_GENRES             = _ACETALK / "acetalk" / "data" / "genres.json"

COMFYUI_OUTPUT_DIR  = _COMFYUI / "output" / "audio"
COMFYUI_INPUT_DIR   = _COMFYUI / "input"
DEMUCS_OUTPUT_DIR   = COMFYUI_OUTPUT_DIR / "separated"
