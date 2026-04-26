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
                lang = state.get("vocal_language", "auto")
                if lang and lang != "auto":
                    inputs["language"] = lang
                inputs["generate_audio_codes"] = state.get("generate_audio_codes", True)
                inputs["bpm"] = state.get("bpm", 120)
                inputs["duration"] = float(state.get("duration", 30))
                inputs["cfg_scale"] = state.get("cfg_scale", 2.0)
                inputs["temperature"] = state.get("temperature", 0.85)
                inputs["top_p"] = state.get("top_p", 0.9)
                inputs["top_k"] = state.get("top_k", 0)
                inputs["min_p"] = state.get("min_p", 0.0)
                key = state.get("key", "")
                scale = state.get("scale", "")
                _scale_map = {
                    "major": "major", "minor": "minor",
                    "harmonic minor": "minor", "melodic minor": "minor",
                    "pentatonic major": "major", "pentatonic minor": "minor",
                }
                if key and scale:
                    mapped = _scale_map.get(scale.lower())
                    if mapped:
                        inputs["keyscale"] = f"{key} {mapped}"
                    if scale.lower() not in ("major", "minor"):
                        inputs["tags"] = f"{inputs['tags']}, {scale.lower()} scale"
                time_sig = state.get("time_sig", "4/4")
                if time_sig:
                    inputs["timesignature"] = time_sig.split("/")[0]
                filled = True

        if not filled:
            return {"error": "No TextEncodeAceStepAudio1.5 node found in template"}

        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "EmptyAceStep1.5LatentAudio":
                node.setdefault("inputs", {})["seconds"] = float(state.get("duration", 30))
                node["inputs"]["batch_size"] = max(1, min(8, int(state.get("batch_size", 1))))

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

        # Swap DiT model in UNETLoader
        _dit_models = {
            "turbo": "acestep_v1.5_xl_turbo_bf16.safetensors",
            "sft":   "acestep_v1.5_xl_sft_bf16.safetensors",
            "base":  "acestep_v1.5_xl_base_bf16.safetensors",
        }
        dit_key = state.get("dit_model", "turbo").lower()
        unet_name = _dit_models.get(dit_key, _dit_models["turbo"])
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "UNETLoader":
                node.setdefault("inputs", {})["unet_name"] = unet_name

        # Swap audio save node to match requested format
        _fmt_map = {
            "mp3":  ("SaveAudioMP3",  "Save Audio (MP3)"),
            "flac": ("SaveAudio",     "Save Audio (FLAC)"),
            "opus": ("SaveAudioOpus", "Save Audio (Opus)"),
        }
        audio_format = state.get("audio_format", "mp3").lower()
        audio_quality = state.get("audio_quality", "V0")
        cls, title = _fmt_map.get(audio_format, _fmt_map["mp3"])
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") in (
                "SaveAudioMP3", "SaveAudio", "SaveAudioOpus"
            ):
                node["class_type"] = cls
                node["_meta"] = {"title": title}
                inp = node.setdefault("inputs", {})
                inp.pop("quality", None)
                inp.pop("audioUI", None)
                if audio_format == "mp3":
                    inp["quality"] = audio_quality or "V0"
                    inp["audioUI"] = ""
                elif audio_format == "opus":
                    inp["quality"] = audio_quality or "128k"

        return {"workflow": workflow, "seed": seed}

    def build_remix_workflow(
        self,
        source_filename: str,
        caption: str,
        lyrics: str,
        state: dict,
        mode: str = "variation",
        denoise: float = 0.5,
        seed_seconds: float = 10.0,
    ) -> dict:
        if not config.WORKFLOW_REMIX_TEMPLATE.exists():
            return {"error": f"Remix template not found: {config.WORKFLOW_REMIX_TEMPLATE}"}

        source_path = config.COMFYUI_OUTPUT_DIR / source_filename
        if not source_path.exists():
            return {"error": f"Source file not found: {source_filename}"}

        if mode == "extend":
            input_name = self._trim_for_extend(source_path, seed_seconds)
            if input_name is None:
                input_name = self.copy_to_input(source_path)
        else:
            input_name = self.copy_to_input(source_path)

        with open(config.WORKFLOW_REMIX_TEMPLATE) as f:
            workflow = json.load(f)

        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") == "LoadAudio":
                node["inputs"]["audio"] = input_name

        _scale_map = {
            "major": "major", "minor": "minor",
            "harmonic minor": "minor", "melodic minor": "minor",
            "pentatonic major": "major", "pentatonic minor": "minor",
        }
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
                    mapped = _scale_map.get(scale.lower())
                    if mapped:
                        inputs["keyscale"] = f"{key} {mapped}"
                    if scale.lower() not in ("major", "minor"):
                        inputs["tags"] = f"{inputs['tags']}, {scale.lower()} scale"
                time_sig = state.get("time_sig", "4/4")
                if time_sig:
                    inputs["timesignature"] = time_sig.split("/")[0]

        seed = state.get("seed", 0)
        if not state.get("lock_seed", False) or seed == 0:
            seed = random.randint(0, 2**32 - 1)
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                inputs = node.setdefault("inputs", {})
                inputs["steps"] = state.get("steps", 8)
                inputs["denoise"] = float(denoise)
                inputs["seed"] = seed
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "TextEncodeAceStepAudio1.5":
                node.setdefault("inputs", {})["seed"] = seed

        return {"workflow": workflow, "seed": seed}

    def build_repaint_workflow(
        self,
        source_filename: str,
        caption: str,
        lyrics: str,
        state: dict,
        start_time: float,
        end_time: float,
    ) -> dict:
        if not config.WORKFLOW_REPAINT_TEMPLATE.exists():
            return {"error": f"Repaint template not found: {config.WORKFLOW_REPAINT_TEMPLATE}"}

        source_path = config.COMFYUI_OUTPUT_DIR / source_filename
        if not source_path.exists():
            return {"error": f"Source file not found: {source_filename}"}

        if start_time < 0 or end_time <= start_time:
            return {"error": "end_time must be greater than start_time"}

        input_name = self.copy_to_input(source_path)
        repaint_duration = round(end_time - start_time, 3)

        with open(config.WORKFLOW_REPAINT_TEMPLATE) as f:
            workflow = json.load(f)

        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type")
            inputs = node.setdefault("inputs", {})
            if ct == "LoadAudio":
                inputs["audio"] = input_name
            elif ct == "TrimAudioDuration":
                title = node.get("_meta", {}).get("title", "")
                if "Pre-segment" in title:
                    inputs["start_index"] = 0.0
                    inputs["duration"] = float(start_time)
                elif "Repaint segment" in title:
                    inputs["start_index"] = float(start_time)
                    inputs["duration"] = repaint_duration
                elif "Post-segment" in title:
                    inputs["start_index"] = float(end_time)
                    inputs["duration"] = 10000.0

        _scale_map = {
            "major": "major", "minor": "minor",
            "harmonic minor": "minor", "melodic minor": "minor",
            "pentatonic major": "major", "pentatonic minor": "minor",
        }
        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") == "TextEncodeAceStepAudio1.5":
                inputs = node.setdefault("inputs", {})
                inputs["tags"] = caption
                inputs["lyrics"] = lyrics
                inputs["bpm"] = state.get("bpm", 120)
                inputs["duration"] = repaint_duration
                inputs["cfg_scale"] = state.get("cfg_scale", 2.0)
                inputs["temperature"] = state.get("temperature", 0.85)
                inputs["top_p"] = state.get("top_p", 0.9)
                inputs["top_k"] = state.get("top_k", 0)
                inputs["min_p"] = state.get("min_p", 0.0)
                key = state.get("key", "")
                scale = state.get("scale", "")
                if key and scale:
                    mapped = _scale_map.get(scale.lower())
                    if mapped:
                        inputs["keyscale"] = f"{key} {mapped}"
                    if scale.lower() not in ("major", "minor"):
                        inputs["tags"] = f"{inputs['tags']}, {scale.lower()} scale"
                time_sig = state.get("time_sig", "4/4")
                if time_sig:
                    inputs["timesignature"] = time_sig.split("/")[0]

        seed = state.get("seed", 0)
        if not state.get("lock_seed", False) or seed == 0:
            seed = random.randint(0, 2**32 - 1)
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                inputs = node.setdefault("inputs", {})
                inputs["steps"] = state.get("steps", 8)
                inputs["denoise"] = 1.0
                inputs["seed"] = seed
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
            if not resp.ok:
                body = resp.text[:500]
                logger.error("ComfyUI /prompt %s: %s", resp.status_code, body)
                return {"error": f"{resp.status_code} {resp.reason}: {body}"}
            return resp.json()
        except Exception as exc:
            return {"error": str(exc)}

    def _trim_for_extend(self, source_path: pathlib.Path, seed_seconds: float) -> str | None:
        import subprocess
        try:
            from mutagen.mp3 import MP3
            duration = MP3(source_path).info.length
            start = max(0.0, duration - seed_seconds)
            out_name = f"extend_seed_{source_path.stem}.mp3"
            out_path = config.COMFYUI_INPUT_DIR / out_name
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(start), "-i", str(source_path), "-c", "copy", str(out_path)],
                check=True, capture_output=True,
            )
            return out_name
        except Exception as exc:
            logger.warning("Trim for extend failed: %s", exc)
            return None

    def copy_to_input(self, src_path: pathlib.Path) -> str:
        dest = config.COMFYUI_INPUT_DIR / src_path.name
        shutil.copy2(src_path, dest)
        return src_path.name

    def find_cached_output_files(self, history: dict, prompt_id: str) -> list[str]:
        """When a job was fully cached (empty outputs), find files from the original run."""
        entry = history.get(prompt_id, {})
        messages = entry.get("status", {}).get("messages", [])
        all_cached = messages and all(m[0] in ("execution_cached", "execution_start") for m in messages)
        if not all_cached:
            return []

        prompt_data = entry.get("prompt", [])
        wf = prompt_data[2] if len(prompt_data) > 2 else {}
        seed = None
        for node in wf.values():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                seed = node.get("inputs", {}).get("seed")
                break
        if seed is None:
            return []

        try:
            full_history = requests.get(f"{self.base_url}/history", timeout=5).json()
        except Exception:
            return []

        for other_pid, other_entry in full_history.items():
            if other_pid == prompt_id:
                continue
            files = self.extract_output_files(full_history, other_pid)
            if not files:
                continue
            other_prompt = other_entry.get("prompt", [])
            other_wf = other_prompt[2] if len(other_prompt) > 2 else {}
            for node in other_wf.values():
                if isinstance(node, dict) and node.get("class_type") == "KSampler":
                    if node.get("inputs", {}).get("seed") == seed:
                        logger.info("Cache hit for %s → reusing files from %s", prompt_id[:8], other_pid[:8])
                        return files
        return []

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
