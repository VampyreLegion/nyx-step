from __future__ import annotations
import json
import logging
import subprocess
import time

import requests
from fastapi import APIRouter

import config
from core.circuit_breaker import comfyui_breaker, CircuitOpenError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/comfy")


def _system_stats() -> dict:
    """Raw ComfyUI /system_stats (RAM + per-device VRAM, torch usage)."""
    try:
        def _get():
            r = requests.get(f"{config.COMFYUI_URL}/system_stats", timeout=5)
            r.raise_for_status()
            return r.json()
        return comfyui_breaker.call(_get)
    except (CircuitOpenError, Exception) as exc:
        logger.debug("system_stats unavailable: %s", exc)
        return {}


def _comfy_queue() -> dict:
    """ComfyUI /queue (running + pending prompt_ids)."""
    try:
        def _get():
            r = requests.get(f"{config.COMFYUI_URL}/queue", timeout=5)
            r.raise_for_status()
            return r.json()
        return comfyui_breaker.call(_get)
    except (CircuitOpenError, Exception) as exc:
        logger.debug("comfy queue unavailable: %s", exc)
        return {"queue_running": [], "queue_pending": []}


def _nvidia_stats() -> dict:
    """Live GPU utilization / temperature / power via nvidia-smi (best effort)."""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return {}
        parts = [p.strip() for p in out.stdout.splitlines()[0].split(",")]
        result = {}
        if len(parts) >= 3 and parts[0] != "[N/A]":
            result["gpu_util_pct"] = float(parts[0])
        if len(parts) >= 3 and parts[1] != "[N/A]":
            result["gpu_temp_c"] = float(parts[1])
        if len(parts) >= 3 and parts[2] != "[N/A]":
            result["gpu_power_w"] = float(parts[2])
        return result
    except Exception as exc:
        logger.debug("nvidia-smi unavailable: %s", exc)
        return {}


def _cpu_stats() -> dict:
    """Lightweight host CPU load (loadavg) and total/free RAM from /proc/meminfo."""
    try:
        with open("/proc/loadavg") as f:
            toks = f.read().split()
        load1 = float(toks[0]) if toks else 0.0
        total = free = 0
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    free = int(line.split()[1])
        return {
            "load_1min": load1,
            "ram_total_bytes": total * 1024,
            "ram_free_bytes": free * 1024,
        }
    except Exception as exc:
        logger.debug("cpu_stats unavailable: %s", exc)
        return {}


@router.get("/status")
async def comfy_status():
    """Live hardware telemetry for the ComfyUI host: GPU, CPU, VRAM, RAM, queue."""
    stats = _system_stats()
    nvidia = _nvidia_stats()
    cpu = _cpu_stats()
    cq = _comfy_queue()

    devices = []
    for dev in stats.get("devices", []):
        devices.append({
            "name": dev.get("name"),
            "type": dev.get("type"),
            "index": dev.get("index"),
            "vram_total_bytes": dev.get("vram_total"),
            "vram_free_bytes": dev.get("vram_free"),
            "torch_vram_total_bytes": dev.get("torch_vram_total"),
            "torch_vram_free_bytes": dev.get("torch_vram_free"),
        })

    system = stats.get("system", {})
    online = bool(stats or devices or nvidia) or bool(cq.get("queue_running") or cq.get("queue_pending"))

    return {
        "comfyui_online": online,
        "comfyui_version": system.get("comfyui_version"),
        "gpu": nvidia,
        "cpu": cpu,
        "ram_total_bytes": system.get("ram_total"),
        "ram_free_bytes": system.get("ram_free"),
        "devices": devices,
        "queue": {
            "running": cq.get("queue_running", []),
            "pending": cq.get("queue_pending", []),
            "running_count": len(cq.get("queue_running", [])),
            "pending_count": len(cq.get("queue_pending", [])),
        },
    }


@router.get("/queue")
async def comfy_queue():
    """ComfyUI generation queue (running + pending prompt_ids, with job titles)."""
    cq = _comfy_queue()
    running = cq.get("queue_running", [])
    pending = cq.get("queue_pending", [])
    return {
        "running": running,
        "pending": pending,
        "running_count": len(running),
        "pending_count": len(pending),
    }
