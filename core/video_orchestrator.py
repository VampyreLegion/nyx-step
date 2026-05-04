from __future__ import annotations
import asyncio
import json
import logging
import pathlib
import random
import shutil
import subprocess
import tempfile
import uuid
from typing import Any

import cv2
import requests

import config

logger = logging.getLogger(__name__)

# ── In-memory job state ────────────────────────────────────────────────────────
_video_jobs: dict[str, dict] = {}


def create_job(total_chunks: int, user_email: str) -> str:
    job_id = str(uuid.uuid4())
    _video_jobs[job_id] = {
        "job_id": job_id,
        "user_email": user_email,
        "status": "queued",
        "chunks_total": total_chunks,
        "chunks_done": 0,
        "output_file": None,
        "error": None,
    }
    return job_id


def get_job(job_id: str) -> dict | None:
    return _video_jobs.get(job_id)


def _update_job(job_id: str, **kwargs: Any) -> None:
    if job_id in _video_jobs:
        _video_jobs[job_id].update(kwargs)


def scale_cfg(base: float, mean_beat_weight: float, sync_mode: str) -> float:
    """Return CFG scale for this chunk. Beat-reactive modes scale base to base+2."""
    if sync_mode == "section_only":
        return base
    return base + 2.0 * mean_beat_weight


def fill_template(template_path: pathlib.Path, values: dict) -> dict:
    """Load template JSON and replace all {{key}} placeholders with values.

    When a placeholder is the sole content of a JSON string value (i.e. the raw
    template contains ``"{{key}}"``), the surrounding quotes are removed so that
    non-string types (int, float, bool) round-trip correctly through json.loads.
    """
    raw = template_path.read_text()
    for key, val in values.items():
        placeholder = f"{{{{{key}}}}}"
        if isinstance(val, str):
            # String values: just drop in the string; keep surrounding quotes.
            raw = raw.replace(placeholder, val)
        else:
            # Non-string values: replace the whole quoted placeholder with the
            # JSON-encoded literal so that integers stay integers, etc.
            quoted_placeholder = f'"{placeholder}"'
            json_val = json.dumps(val)
            if quoted_placeholder in raw:
                raw = raw.replace(quoted_placeholder, json_val)
            else:
                raw = raw.replace(placeholder, json_val)
    return json.loads(raw)


def _post_prompt(workflow: dict) -> str:
    """POST workflow to ComfyUI /prompt. Returns prompt_id."""
    resp = requests.post(
        f"{config.COMFYUI_URL}/prompt",
        json={"prompt": workflow},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"ComfyUI error: {data['error']}")
    return data["prompt_id"]


async def _wait_for_prompt(prompt_id: str, timeout: int = 600) -> list[str]:
    """Wait for a ComfyUI prompt to finish via WebSocket. Returns output filenames."""
    import websockets

    ws_url = config.COMFYUI_URL.replace("http://", "ws://").replace("https://", "wss://")
    ws_url = f"{ws_url}/ws?clientId=nyx_video_{prompt_id[:8]}"

    async with websockets.connect(ws_url) as ws:
        async def _recv():
            async for raw in ws:
                msg = json.loads(raw) if isinstance(raw, str) else {}
                mtype = msg.get("type", "")
                data = msg.get("data", {})
                if mtype == "executed" and data.get("prompt_id") == prompt_id:
                    outputs = data.get("output", {})
                    files = []
                    for node_out in outputs.values():
                        for item in node_out.get("gifs", []):
                            files.append(item.get("filename", ""))
                        for item in node_out.get("videos", []):
                            files.append(item.get("filename", ""))
                    return [f for f in files if f]
                if mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                    raise RuntimeError(data.get("exception_message", "ComfyUI execution error"))
        return await asyncio.wait_for(_recv(), timeout=timeout)


def extract_last_frame(video_path: pathlib.Path, dest: pathlib.Path) -> pathlib.Path:
    """Extract the last frame of video_path as a PNG to dest."""
    cap = cv2.VideoCapture(str(video_path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError(f"Could not read last frame from {video_path}")
    cv2.imwrite(str(dest), frame)
    return dest


def _copy_to_comfyui_input(src: pathlib.Path) -> str:
    """Copy a file to ComfyUI input dir and return just the filename."""
    dest = config.COMFYUI_INPUT_DIR / src.name
    shutil.copy2(src, dest)
    return src.name


def ffmpeg_stitch(chunk_paths: list[pathlib.Path], audio_file: str, job_id: str) -> pathlib.Path:
    """Concatenate chunk videos and mux with original audio → final MP4."""
    concat_list = pathlib.Path(tempfile.mktemp(suffix=".txt"))
    concat_list.write_text("\n".join(f"file '{p}'" for p in chunk_paths))
    out_path = config.VIDEO_OUTPUT_DIR / f"{job_id}.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-i", audio_file,
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "aac", "-shortest",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    concat_list.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-500:]}")
    return out_path


_STYLE_PREFIXES = {
    "abstract": "abstract art, flowing geometric shapes, colorful particles, ",
    "cinematic": "cinematic scene, film still, dramatic lighting, ",
    "artistic": "oil painting, artistic illustration, detailed brushwork, ",
}


async def run_video_job(
    job_id: str,
    schedule: dict,
    section_prompts: dict,
    settings: dict,
) -> None:
    """
    Async orchestration: queues ComfyUI chunks sequentially, extracts last frames
    for I2V continuity, then stitches the final MP4.
    """
    _update_job(job_id, status="running")
    chunk_paths: list[pathlib.Path] = []
    style_prefix = _STYLE_PREFIXES.get(settings.get("style", "cinematic"), "")
    neg = settings.get("negative_prompt", "blurry, low quality, watermark, text, static")
    seed_base = settings.get("seed") or random.randint(0, 2**32 - 1)
    loop = asyncio.get_event_loop()

    try:
        for chunk in schedule["chunks"]:
            i = chunk["index"]
            section = chunk["section"]
            raw_prompt = section_prompts.get(section, section_prompts.get("Main", f"{section} visual scene"))
            positive = style_prefix + raw_prompt
            cfg = scale_cfg(settings["cfg_base"], chunk["mean_beat_weight"], settings["sync_mode"])

            values = {
                "model_name": settings.get("model_name", config.WAN_MODEL),
                "text_encoder_name": settings.get("text_encoder_name", config.WAN_TEXT_ENCODER),
                "vae_name": settings.get("vae_name", config.WAN_VAE),
                "positive_prompt": positive,
                "negative_prompt": neg,
                "width": settings["width"],
                "height": settings["height"],
                "frame_count": chunk["frame_count"],
                "fps": settings["fps"],
                "steps": settings["steps"],
                "cfg_scale": round(cfg, 2),
                "seed": seed_base + i,
                "output_prefix": f"video/chunks/{job_id}_{i:03d}",
            }

            if i == 0:
                workflow = fill_template(config.WORKFLOW_VIDEO_T2V, values)
            else:
                last_frame_src = config.VIDEO_CHUNK_DIR / f"{job_id}_{i-1:03d}_last.png"
                last_frame_filename = _copy_to_comfyui_input(last_frame_src)
                values["start_image_filename"] = last_frame_filename
                workflow = fill_template(config.WORKFLOW_VIDEO_I2V, values)

            prompt_id = await loop.run_in_executor(None, _post_prompt, workflow)
            output_files = await _wait_for_prompt(prompt_id)

            if not output_files:
                raise RuntimeError(f"Chunk {i}: ComfyUI returned no output files")

            chunk_video = config.VIDEO_CHUNK_DIR / output_files[0]
            if not chunk_video.exists():
                chunk_video = config.VIDEO_OUTPUT_DIR / output_files[0]
            chunk_paths.append(chunk_video)

            if i < len(schedule["chunks"]) - 1:
                dest = config.VIDEO_CHUNK_DIR / f"{job_id}_{i:03d}_last.png"
                await loop.run_in_executor(None, extract_last_frame, chunk_video, dest)

            _update_job(job_id, chunks_done=i + 1)

        final = await loop.run_in_executor(
            None, ffmpeg_stitch, chunk_paths, schedule["audio_file"], job_id
        )
        _update_job(job_id, status="done", output_file=str(final))

    except Exception as exc:
        logger.exception("Video job %s failed: %s", job_id, exc)
        _update_job(job_id, status="error", error=str(exc))
