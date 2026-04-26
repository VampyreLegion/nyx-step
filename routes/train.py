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


class TrainRequest(BaseModel):
    dataset_dir: str
    lora_name: str = "my_lora"
    output_dir: str = ""
    lora_rank: int = Field(default=8, ge=1, le=128)
    lora_alpha: int = Field(default=16, ge=1, le=256)
    lora_dropout: float = Field(default=0.1, ge=0.0, le=0.5)
    learning_rate: float = Field(default=1e-4, ge=1e-6, le=1e-2)
    max_epochs: int = Field(default=100, ge=1, le=1000)
    batch_size: int = Field(default=1, ge=1, le=8)
    gradient_accumulation: int = Field(default=4, ge=1, le=32)
    save_every_n_epochs: int = Field(default=10, ge=1, le=100)
    seed: int = Field(default=42, ge=0, le=4294967295)
    use_llm_labeling: bool = False


def _build_training_workflow(req: TrainRequest) -> dict:
    output_dir = req.output_dir.strip() or str(config.COMFYUI_OUTPUT_DIR / "loras")

    workflow: dict = {
        "train_unet": {
            "class_type": "UNETLoader",
            "_meta": {"title": "Load ACE-Step Model"},
            "inputs": {
                "unet_name": "acestep_v1.5_xl_turbo_bf16.safetensors",
                "weight_dtype": "bf16",
            },
        },
        "train_scan": {
            "class_type": "FL_AceStep_ScanDirectory",
            "_meta": {"title": "Scan Dataset"},
            "inputs": {"directory": req.dataset_dir},
        },
        "train_preprocess": {
            "class_type": "FL_AceStep_PreprocessDataset",
            "_meta": {"title": "Preprocess Dataset"},
            "inputs": {"audio_data": ["train_scan", 0]},
        },
        "train_config": {
            "class_type": "FL_AceStep_TrainingConfig",
            "_meta": {"title": "Training Config"},
            "inputs": {
                "lora_rank": req.lora_rank,
                "lora_alpha": req.lora_alpha,
                "lora_dropout": req.lora_dropout,
                "learning_rate": req.learning_rate,
                "max_epochs": req.max_epochs,
                "batch_size": req.batch_size,
                "gradient_accumulation": req.gradient_accumulation,
                "save_every_n_epochs": req.save_every_n_epochs,
                "output_dir": output_dir,
                "seed": req.seed,
            },
        },
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
        workflow["train_label"] = {
            "class_type": "FL_AceStep_LabelSamples",
            "_meta": {"title": "LLM Label Samples"},
            "inputs": {"audio_data": ["train_scan", 0]},
        }
        workflow["train_preprocess"]["inputs"]["audio_data"] = ["train_label", 0]

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
                        yield {"event": "train_error", "data": json.dumps(msg.get("data", {}))}
                    elif msg_type == "execution_success":
                        yield {"event": "train_complete", "data": "{}"}
                        break

        except Exception as exc:
            yield {"event": "train_error", "data": json.dumps({"message": str(exc)})}

    return EventSourceResponse(event_stream())
