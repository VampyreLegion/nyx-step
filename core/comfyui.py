from __future__ import annotations
import json
import logging
import random
import shutil
import pathlib

import requests

import config

logger = logging.getLogger(__name__)


class ComfyUIClient:

    def __init__(self, base_url: str = config.COMFYUI_URL):
        self.base_url = base_url.rstrip("/")

    def ping(self) -> bool:
        try:
            requests.get(f"{self.base_url}/system_stats", timeout=3).raise_for_status()
            return True
        except Exception:
            return False

    def get_queue(self) -> dict:
        try:
            r = requests.get(f"{self.base_url}/queue", timeout=5)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            logger.warning("get_queue failed: %s", exc)
            return {"queue_running": [], "queue_pending": []}

    def get_history(self, prompt_id: str) -> dict:
        try:
            r = requests.get(f"{self.base_url}/history/{prompt_id}", timeout=5)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            logger.warning("get_history failed: %s", exc)
            return {}

    def build_workflow(
        self,
        caption: str,
        lyrics: str,
        state: dict,
        template_path: pathlib.Path = None,
    ) -> dict:
        if template_path is None:
            template_path = config.WORKFLOW_TEMPLATE

        if not template_path.exists():
            return {"error": f"Workflow template not found: {template_path}"}

        with open(template_path) as f:
            workflow = json.load(f)

        filled = False
        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") == "TextEncodeAceStepAudio1.5":
                inputs = node.setdefault("inputs", {})
                inputs["tags"] = caption
                inputs["lyrics"] = lyrics
                inputs["bpm"] = state.get("bpm", 120)
                inputs["duration"] = float(state.get("duration", 30))
                inputs["cfg_scale"] = state.get("cfg_scale", 2.0)
                inputs["temperature"] = state.get("temperature", 0.85)
                inputs["top_p"] = state.get("top_p", 0.9)
                inputs["top_k"] = state.get("top_k", 0)
                inputs["min_p"] = state.get("min_p", 0.0)
                key = state.get("key", "")
                scale = state.get("scale", "")
                if key and scale:
                    inputs["keyscale"] = f"{key} {scale.lower()}"
                time_sig = state.get("time_sig", "4/4")
                if time_sig:
                    inputs["timesignature"] = time_sig.split("/")[0]
                filled = True

        if not filled:
            return {"error": "No TextEncodeAceStepAudio1.5 node found in template"}

        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "EmptyAceStep1.5LatentAudio":
                node.setdefault("inputs", {})["seconds"] = float(state.get("duration", 30))

        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                node.setdefault("inputs", {})["steps"] = state.get("steps", 8)

        seed = state.get("seed", 0)
        if not state.get("lock_seed", False) or seed == 0:
            seed = random.randint(0, 2**32 - 1)
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                node.setdefault("inputs", {})["seed"] = seed
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "TextEncodeAceStepAudio1.5":
                node.setdefault("inputs", {})["seed"] = seed

        return {"workflow": workflow, "seed": seed}

    def send_workflow(self, workflow: dict) -> dict:
        try:
            resp = requests.post(
                f"{self.base_url}/prompt",
                json={"prompt": workflow},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            return {"error": str(exc)}

    def copy_to_input(self, src_path: pathlib.Path) -> str:
        dest = config.COMFYUI_INPUT_DIR / src_path.name
        shutil.copy2(src_path, dest)
        return src_path.name

    def extract_output_files(self, history: dict, prompt_id: str) -> list[str]:
        entry = history.get(prompt_id, {})
        outputs = entry.get("outputs", {})
        files = []
        for node_output in outputs.values():
            for item in node_output.get("audio", []):
                fname = item.get("filename", "")
                if fname:
                    files.append(fname)
        return files
