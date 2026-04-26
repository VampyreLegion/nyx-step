from __future__ import annotations
import asyncio
import json
import uuid
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

import config

router = APIRouter()
_current_prompt_id: str | None = None

# Model names from the main generation workflow template
_UNET_NAME = "acestep_v1.5_xl_turbo_bf16.safetensors"
_CLIP1_NAME = "qwen_0.6b_ace15.safetensors"
_CLIP2_NAME = "qwen_4b_ace15.safetensors"
_VAE_NAME   = "ace_1.5_vae.safetensors"


class TrainRequest(BaseModel):
    dataset_dir: str
    lora_name: str = "my_lora"
    tensor_output_dir: str = ""   # where PreprocessDataset writes tensors
    lora_output_dir: str = ""     # where Train saves the final LoRA
    all_instrumental: bool = True
    custom_tag: str = ""
    tag_position: str = "prepend"
    # TrainingConfig
    lora_rank: int = Field(default=8, ge=4, le=256)
    lora_alpha: int = Field(default=16, ge=4, le=512)
    lora_dropout: float = Field(default=0.1, ge=0.0, le=0.5)
    learning_rate: float = Field(default=1e-4, ge=1e-6, le=1e-2)
    max_epochs: int = Field(default=100, ge=10, le=10000)
    batch_size: int = Field(default=1, ge=1, le=8)
    gradient_accumulation: int = Field(default=4, ge=1, le=16)
    save_every_n_epochs: int = Field(default=10, ge=5, le=1000)
    warmup_steps: int = Field(default=100, ge=0, le=1000)
    weight_decay: float = Field(default=0.01, ge=0.0, le=0.1)
    max_grad_norm: float = Field(default=1.0, ge=0.1, le=10.0)
    target_modules: str = "q_proj,k_proj,v_proj,o_proj"
    seed: int = Field(default=42, ge=0, le=2147483647)
    # LLM labeling
    use_llm_labeling: bool = False
    llm_model: str = "acestep-5Hz-lm-1.7B"


def _build_training_workflow(req: TrainRequest) -> dict:
    tensor_dir = req.tensor_output_dir.strip() or "./output/acestep/datasets"
    lora_dir   = req.lora_output_dir.strip()   or "./output/acestep/loras"

    workflow: dict = {
        # Model loaders
        "train_unet": {
            "class_type": "UNETLoader",
            "_meta": {"title": "Load DiT Model"},
            "inputs": {"unet_name": _UNET_NAME, "weight_dtype": "bf16"},
        },
        "train_clip": {
            "class_type": "DualCLIPLoader",
            "_meta": {"title": "Load CLIP"},
            "inputs": {
                "clip_name1": _CLIP1_NAME,
                "clip_name2": _CLIP2_NAME,
                "type": "ace",
            },
        },
        "train_vae": {
            "class_type": "VAELoader",
            "_meta": {"title": "Load VAE"},
            "inputs": {"vae_name": _VAE_NAME},
        },
        # Dataset scan
        "train_scan": {
            "class_type": "FL_AceStep_ScanDirectory",
            "_meta": {"title": "Scan Dataset Directory"},
            "inputs": {
                "directory": req.dataset_dir,
                "all_instrumental": req.all_instrumental,
                "custom_tag": req.custom_tag,
                "tag_position": req.tag_position,
            },
        },
        # Preprocess (encodes audio to latents — needs model/vae/clip)
        "train_preprocess": {
            "class_type": "FL_AceStep_PreprocessDataset",
            "_meta": {"title": "Preprocess Dataset"},
            "inputs": {
                "dataset": ["train_scan", 0],
                "model": ["train_unet", 0],
                "vae": ["train_vae", 0],
                "clip": ["train_clip", 0],
                "output_dir": tensor_dir,
            },
        },
        # Training config
        "train_config": {
            "class_type": "FL_AceStep_TrainingConfig",
            "_meta": {"title": "LoRA Training Config"},
            "inputs": {
                "lora_rank": req.lora_rank,
                "lora_alpha": req.lora_alpha,
                "lora_dropout": req.lora_dropout,
                "learning_rate": req.learning_rate,
                "max_epochs": req.max_epochs,
                "batch_size": req.batch_size,
                "gradient_accumulation": req.gradient_accumulation,
                "save_every_n_epochs": req.save_every_n_epochs,
                "warmup_steps": req.warmup_steps,
                "weight_decay": req.weight_decay,
                "max_grad_norm": req.max_grad_norm,
                "target_modules": req.target_modules,
                "output_dir": lora_dir,
                "seed": req.seed,
            },
        },
        # Train
        "train_run": {
            "class_type": "FL_AceStep_Train",
            "_meta": {"title": "Train LoRA"},
            "inputs": {
                "model": ["train_unet", 0],
                "config": ["train_config", 0],
                "tensor_dir": ["train_preprocess", 0],
                "lora_name": req.lora_name,
            },
        },
    }

    if req.use_llm_labeling:
        workflow["train_llm"] = {
            "class_type": "FL_AceStep_LLMLoader",
            "_meta": {"title": "Load LLM for Labeling"},
            "inputs": {
                "model_name": req.llm_model,
                "device": "auto",
                "backend": "pt",
            },
        }
        workflow["train_label"] = {
            "class_type": "FL_AceStep_LabelSamples",
            "_meta": {"title": "LLM Label Samples"},
            "inputs": {
                "dataset": ["train_scan", 0],
                "model": ["train_unet", 0],
                "vae": ["train_vae", 0],
                "llm": ["train_llm", 0],
            },
        }
        # Wire labeled dataset into preprocess instead of raw scan output
        workflow["train_preprocess"]["inputs"]["dataset"] = ["train_label", 0]

    return workflow


@router.post("/train/start")
async def train_start(req: TrainRequest):
    global _current_prompt_id

    if not req.dataset_dir.strip():
        return JSONResponse({"error": "dataset_dir is required"}, status_code=400)

    workflow = _build_training_workflow(req)

    import requests as _req
    try:
        r = _req.post(
            f"{config.COMFYUI_URL}/prompt",
            json={"prompt": workflow},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        return JSONResponse({"error": f"ComfyUI unreachable: {exc}"}, status_code=400)

    if "error" in data or "node_errors" in data:
        return JSONResponse({"error": str(data.get("error") or data.get("node_errors"))}, status_code=400)

    prompt_id = data.get("prompt_id", "")
    _current_prompt_id = prompt_id
    return {"prompt_id": prompt_id}


@router.post("/train/stop")
async def train_stop():
    import requests as _req
    try:
        _req.post(f"{config.COMFYUI_URL}/interrupt", timeout=5)
    except Exception:
        pass
    return {"ok": True}


@router.get("/train/events")
async def train_events(request: Request):
    async def event_stream() -> AsyncGenerator[dict, None]:
        try:
            import websockets
        except ImportError:
            yield {"event": "train_error", "data": json.dumps({"message": "websockets library not available"})}
            return

        client_id = str(uuid.uuid4())
        ws_url = f"ws://127.0.0.1:8188/ws?clientId={client_id}"

        try:
            async with websockets.connect(ws_url) as ws:
                yield {"event": "connected", "data": json.dumps({"status": "Connected to ComfyUI"})}

                while True:
                    if await request.is_disconnected():
                        break

                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        yield {"event": "ping", "data": "{}"}
                        continue
                    except Exception:
                        break

                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue

                    msg_type = msg.get("type", "")

                    if msg_type == "acestep.training.progress":
                        yield {"event": "train_progress", "data": json.dumps(msg.get("data", {}))}
                    elif msg_type == "execution_error":
                        err_data = msg.get("data", {})
                        yield {"event": "train_error", "data": json.dumps({
                            "message": err_data.get("exception_message", str(err_data))
                        })}
                    elif msg_type == "execution_success":
                        yield {"event": "train_complete", "data": "{}"}
                        break

        except Exception as exc:
            yield {"event": "train_error", "data": json.dumps({"message": str(exc)})}

    return EventSourceResponse(event_stream())
