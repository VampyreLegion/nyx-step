from __future__ import annotations
import copy
import json
import logging
import random
import shutil
import pathlib

import requests

import config
from core.circuit_breaker import comfyui_breaker, CircuitOpenError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_SCALE_MAP = {
    "major": "major", "minor": "minor",
    "harmonic minor": "minor", "melodic minor": "minor",
    "pentatonic major": "major", "pentatonic minor": "minor",
}
_FMT_MAP = {
    "mp3":  ("SaveAudioMP3",  "Save Audio"),
    "flac": ("SaveAudio",     "Save Audio"),
    "opus": ("SaveAudioOpus", "Save Audio"),
}
_DIT_MODELS = {
    "turbo": "acestep_v1.5_xl_turbo_bf16.safetensors",
    "sft":   "acestep_v1.5_xl_sft_bf16.safetensors",
    "base":  "acestep_v1.5_xl_base_bf16.safetensors",
}
_AUDIO_SAVE_CLASSES = frozenset(("SaveAudioMP3", "SaveAudio", "SaveAudioOpus"))
_TEMPLATE_CACHE: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _load_template(path: pathlib.Path) -> dict:
    key = str(path)
    if key not in _TEMPLATE_CACHE:
        with open(path) as f:
            _TEMPLATE_CACHE[key] = json.load(f)
    return copy.deepcopy(_TEMPLATE_CACHE[key])


def _find_nodes(workflow: dict, class_type: str) -> list[dict]:
    return [v for v in workflow.values() if isinstance(v, dict) and v.get("class_type") == class_type]


def _find_node_id(workflow: dict, class_type: str) -> str | None:
    return next(
        (k for k, v in workflow.items() if isinstance(v, dict) and v.get("class_type") == class_type),
        None,
    )


def _gen_seed(state: dict) -> int:
    seed = state.get("seed", 0)
    if not state.get("lock_seed", False) or seed == 0:
        seed = random.randint(0, 2**32 - 1)
    return seed


def _apply_text_encoder(
    inputs: dict,
    caption: str,
    lyrics: str,
    state: dict,
    override_duration: float | None = None,
) -> None:
    inputs["tags"] = caption
    inputs["lyrics"] = lyrics
    inputs["bpm"] = state.get("bpm", 120)
    inputs["duration"] = override_duration if override_duration is not None else float(state.get("duration", 30))
    inputs["cfg_scale"] = state.get("cfg_scale", 2.0)
    inputs["temperature"] = state.get("temperature", 0.85)
    inputs["top_p"] = state.get("top_p", 0.9)
    inputs["top_k"] = state.get("top_k", 0)
    inputs["min_p"] = state.get("min_p", 0.0)
    key = state.get("key", "")
    scale = state.get("scale", "")
    if key and scale:
        mapped = _SCALE_MAP.get(scale.lower())
        if mapped:
            inputs["keyscale"] = f"{key} {mapped}"
        if scale.lower() not in ("major", "minor"):
            inputs["tags"] = f"{inputs['tags']}, {scale.lower()} scale"
    time_sig = state.get("time_sig", "4/4")
    if time_sig:
        inputs["timesignature"] = time_sig.split("/")[0]


def _apply_ksampler(
    workflow: dict,
    state: dict,
    seed: int,
    denoise: float = 1.0,
    default_steps: int = 8,
) -> None:
    sampler_name = state.get("sampler_name", "er_sde") or "er_sde"
    scheduler = state.get("scheduler", "linear_quadratic") or "linear_quadratic"
    for node in _find_nodes(workflow, "KSampler"):
        inp = node.setdefault("inputs", {})
        inp["steps"] = state.get("steps", default_steps)
        inp["denoise"] = float(denoise)
        inp["seed"] = seed
        inp["sampler_name"] = sampler_name
        inp["scheduler"] = scheduler


def _apply_seed_to_encoder(workflow: dict, seed: int) -> None:
    for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
        node.setdefault("inputs", {})["seed"] = seed


def _apply_dit_model(workflow: dict, state: dict, default: str = "turbo") -> None:
    dit_key = state.get("dit_model", default).lower()
    unet_name = _DIT_MODELS.get(dit_key, _DIT_MODELS[default])
    for node in _find_nodes(workflow, "UNETLoader"):
        node.setdefault("inputs", {})["unet_name"] = unet_name


def _apply_negative_tags(workflow: dict, state: dict) -> None:
    """Wire an 'avoid' prompt into KSampler's negative conditioning.

    Clones the positive TextEncodeAceStepAudio1.5 node with the negative tags
    (and no lyrics) and points KSampler.negative at it instead of the
    ConditioningZeroOut passthrough.
    """
    neg = (state.get("negative_tags") or "").strip()
    if not neg:
        return
    enc_id = _find_node_id(workflow, "TextEncodeAceStepAudio1.5")
    ks_id = _find_node_id(workflow, "KSampler")
    if not enc_id or not ks_id:
        return
    neg_node = copy.deepcopy(workflow[enc_id])
    neg_node["inputs"]["tags"] = neg
    neg_node["inputs"]["lyrics"] = ""
    workflow["neg_encode"] = neg_node
    workflow[ks_id]["inputs"]["negative"] = ["neg_encode", 0]


def _apply_audio_format(workflow: dict, state: dict, label: str = "Save Audio") -> None:
    audio_format = state.get("audio_format", "mp3").lower()
    audio_quality = state.get("audio_quality", "V0")
    cls, _ = _FMT_MAP.get(audio_format, _FMT_MAP["mp3"])
    for node in workflow.values():
        if isinstance(node, dict) and node.get("class_type") in _AUDIO_SAVE_CLASSES:
            node["class_type"] = cls
            node["_meta"] = {"title": f"{label} ({audio_format.upper()})"}
            inp = node.setdefault("inputs", {})
            inp.pop("quality", None)
            inp.pop("audioUI", None)
            if audio_format == "mp3":
                inp["quality"] = audio_quality or "V0"
                inp["audioUI"] = ""
            elif audio_format == "opus":
                inp["quality"] = audio_quality or "128k"


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


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
            def _get():
                r = requests.get(f"{self.base_url}/queue", timeout=5)
                r.raise_for_status()
                return r.json()
            return comfyui_breaker.call(_get)
        except CircuitOpenError:
            return {"queue_running": [], "queue_pending": []}
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

        workflow = _load_template(template_path)

        # TextEncoder — find nodes and fill
        filled = False
        for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
            inputs = node.setdefault("inputs", {})
            _apply_text_encoder(inputs, caption, lyrics, state)
            lang = state.get("vocal_language", "auto")
            if lang and lang != "auto":
                inputs["language"] = lang
            inputs["generate_audio_codes"] = state.get("generate_audio_codes", True)
            filled = True

        if not filled:
            return {"error": "No TextEncodeAceStepAudio1.5 node found in template"}

        for node in _find_nodes(workflow, "EmptyAceStep1.5LatentAudio"):
            node.setdefault("inputs", {})["seconds"] = float(state.get("duration", 30))
            node["inputs"]["batch_size"] = max(1, min(8, int(state.get("batch_size", 1))))

        seed = _gen_seed(state)
        _apply_ksampler(workflow, state, seed, denoise=1.0, default_steps=8)
        _apply_seed_to_encoder(workflow, seed)
        _apply_dit_model(workflow, state, default="turbo")

        # Insert LoraLoader chain if one or two LoRAs are selected
        lora_name  = state.get("lora_name",  "").strip()
        lora_scale = float(state.get("lora_scale", 1.0))
        lora2_name  = state.get("lora2_name", "").strip()
        lora2_scale = float(state.get("lora2_scale", 1.0))

        if lora_name:
            unet_id = _find_node_id(workflow, "UNETLoader")
            clip_id = _find_node_id(workflow, "DualCLIPLoader")
            if unet_id and clip_id:
                lora_id = "_lora_"
                workflow[lora_id] = {
                    "class_type": "LoraLoader",
                    "_meta": {"title": f"LoRA: {lora_name}"},
                    "inputs": {
                        "model": [unet_id, 0],
                        "clip": [clip_id, 0],
                        "lora_name": lora_name,
                        "strength_model": lora_scale,
                        "strength_clip": lora_scale,
                    },
                }
                # Redirect downstream nodes from UNETLoader/DualCLIPLoader to LoraLoader outputs
                for node in workflow.values():
                    if not isinstance(node, dict):
                        continue
                    for ik, iv in node.get("inputs", {}).items():
                        if isinstance(iv, list) and len(iv) == 2 and iv[0] == unet_id and iv[1] == 0:
                            node["inputs"][ik] = [lora_id, 0]
                        elif isinstance(iv, list) and len(iv) == 2 and iv[0] == clip_id and iv[1] == 0:
                            node["inputs"][ik] = [lora_id, 1]
                # Restore LoraLoader's own inputs
                workflow[lora_id]["inputs"]["model"] = [unet_id, 0]
                workflow[lora_id]["inputs"]["clip"] = [clip_id, 0]

                # Chain second LoRA on top of first
                if lora2_name:
                    lora2_id = "_lora2_"
                    workflow[lora2_id] = {
                        "class_type": "LoraLoader",
                        "_meta": {"title": f"LoRA2: {lora2_name}"},
                        "inputs": {
                            "model": [lora_id, 0],
                            "clip": [lora_id, 1],
                            "lora_name": lora2_name,
                            "strength_model": lora2_scale,
                            "strength_clip": lora2_scale,
                        },
                    }
                    # Redirect from lora_id outputs to lora2_id outputs
                    for node in workflow.values():
                        if not isinstance(node, dict) or node is workflow[lora2_id]:
                            continue
                        for ik, iv in node.get("inputs", {}).items():
                            if isinstance(iv, list) and len(iv) == 2 and iv[0] == lora_id and iv[1] == 0:
                                node["inputs"][ik] = [lora2_id, 0]
                            elif isinstance(iv, list) and len(iv) == 2 and iv[0] == lora_id and iv[1] == 1:
                                node["inputs"][ik] = [lora2_id, 1]
                    workflow[lora2_id]["inputs"]["model"] = [lora_id, 0]
                    workflow[lora2_id]["inputs"]["clip"] = [lora_id, 1]

        _apply_audio_format(workflow, state)
        _apply_negative_tags(workflow, state)
        return {"workflow": workflow, "seed": seed}

    def build_cover_workflow(
        self,
        input_name: str,
        caption: str,
        lyrics: str,
        state: dict,
        denoise: float = 0.75,
    ) -> dict:
        """Like build_remix_workflow but the file is already in ComfyUI input dir."""
        return self._build_remix_from_input(input_name, caption, lyrics, state, denoise)

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
        source_path = config.COMFYUI_OUTPUT_DIR / source_filename
        if not source_path.exists():
            return {"error": f"Source file not found: {source_filename}"}

        if mode == "extend":
            input_name = self._trim_for_extend(source_path, seed_seconds)
            if input_name is None:
                input_name = self.copy_to_input(source_path)
        else:
            input_name = self.copy_to_input(source_path)

        return self._build_remix_from_input(input_name, caption, lyrics, state, denoise)

    def _build_remix_from_input(
        self,
        input_name: str,
        caption: str,
        lyrics: str,
        state: dict,
        denoise: float,
    ) -> dict:
        if not config.WORKFLOW_REMIX_TEMPLATE.exists():
            return {"error": f"Remix template not found: {config.WORKFLOW_REMIX_TEMPLATE}"}

        workflow = _load_template(config.WORKFLOW_REMIX_TEMPLATE)

        for node in _find_nodes(workflow, "LoadAudio"):
            node["inputs"]["audio"] = input_name

        for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
            _apply_text_encoder(node.setdefault("inputs", {}), caption, lyrics, state)

        seed = _gen_seed(state)
        _apply_ksampler(workflow, state, seed, denoise=denoise, default_steps=8)
        _apply_seed_to_encoder(workflow, seed)

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

        workflow = _load_template(config.WORKFLOW_REPAINT_TEMPLATE)

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

        for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
            _apply_text_encoder(node.setdefault("inputs", {}), caption, lyrics, state, override_duration=repaint_duration)

        seed = _gen_seed(state)
        _apply_ksampler(workflow, state, seed, denoise=1.0, default_steps=8)
        _apply_seed_to_encoder(workflow, seed)

        return {"workflow": workflow, "seed": seed}

    def build_lego_workflow(
        self,
        input_name: str,
        caption: str,
        lyrics: str,
        state: dict,
        denoise: float,
    ) -> dict:
        if not config.WORKFLOW_LEGO_TEMPLATE.exists():
            return {"error": f"Lego template not found: {config.WORKFLOW_LEGO_TEMPLATE}"}

        workflow = _load_template(config.WORKFLOW_LEGO_TEMPLATE)

        for node in _find_nodes(workflow, "LoadAudio"):
            node["inputs"]["audio"] = input_name

        for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
            inp = node.setdefault("inputs", {})
            _apply_text_encoder(inp, caption, lyrics, state)
            lang = state.get("vocal_language", "auto")
            if lang and lang != "auto":
                inp["language"] = lang
            inp["generate_audio_codes"] = state.get("generate_audio_codes", True)

        seed = _gen_seed(state)
        _apply_ksampler(workflow, state, seed, denoise=denoise, default_steps=20)
        _apply_seed_to_encoder(workflow, seed)
        _apply_dit_model(workflow, state, default="sft")
        _apply_audio_format(workflow, state)

        return {"workflow": workflow, "seed": seed}

    def build_radio_continue_workflow(
        self,
        prev_input_name: str,
        caption: str,
        state: dict,
        lyrics: str = "",
    ) -> dict:
        """Generate the next radio segment using the previous segment as timbre reference."""
        if not config.WORKFLOW_RADIO_CONTINUE_TEMPLATE.exists():
            return {"error": f"Radio continue template not found: {config.WORKFLOW_RADIO_CONTINUE_TEMPLATE}"}

        workflow = _load_template(config.WORKFLOW_RADIO_CONTINUE_TEMPLATE)

        duration = float(state.get("duration", 30))

        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") == "LoadAudio":
                node["inputs"]["audio"] = prev_input_name
            elif node.get("class_type") == "TextEncodeAceStepAudio1.5":
                inp = node.setdefault("inputs", {})
                _apply_text_encoder(inp, caption, lyrics, state, override_duration=duration)
                inp["generate_audio_codes"] = True
            elif node.get("class_type") == "EmptyAceStep1.5LatentAudio":
                node.setdefault("inputs", {})["seconds"] = duration

        seed = random.randint(0, 2**32 - 1)
        _apply_ksampler(workflow, state, seed, denoise=1.0, default_steps=20)
        _apply_seed_to_encoder(workflow, seed)
        _apply_dit_model(workflow, state, default="turbo")
        _apply_audio_format(workflow, state, label="Save Radio Segment")

        return {"workflow": workflow, "seed": seed}

    def build_extract_workflow(
        self,
        input_name: str,
        caption: str,
        lyrics: str,
        state: dict,
        denoise: float = 0.98,
    ) -> dict:
        """Stem extraction via ReferenceTimbreAudio + high-denoise repaint."""
        if not config.WORKFLOW_EXTRACT_TEMPLATE.exists():
            return {"error": f"Extract template not found: {config.WORKFLOW_EXTRACT_TEMPLATE}"}

        workflow = _load_template(config.WORKFLOW_EXTRACT_TEMPLATE)

        for node in _find_nodes(workflow, "LoadAudio"):
            node["inputs"]["audio"] = input_name

        for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
            inp = node.setdefault("inputs", {})
            _apply_text_encoder(inp, caption, lyrics, state)
            inp["generate_audio_codes"] = False  # always skip LM for extraction

        seed = _gen_seed(state)
        _apply_ksampler(workflow, state, seed, denoise=denoise, default_steps=20)
        _apply_seed_to_encoder(workflow, seed)
        _apply_dit_model(workflow, state, default="sft")
        _apply_audio_format(workflow, state)

        return {"workflow": workflow, "seed": seed}

    def build_multirepaint_workflow(
        self,
        input_name: str,
        caption: str,
        lyrics: str,
        state: dict,
        regions: list[dict],
        denoise: float = 0.7,
    ) -> dict:
        """Multi-region repaint using NyxAudioOverlay to stitch regions back.

        regions: list of dicts with keys start (float, seconds) and end (float, seconds).
        Supports up to 3 regions — extras are ignored.
        """
        if not config.WORKFLOW_MULTIREPAINT_TEMPLATE.exists():
            return {"error": f"Multi-repaint template not found: {config.WORKFLOW_MULTIREPAINT_TEMPLATE}"}

        if not regions:
            return {"error": "At least one region required"}

        regions = [r for r in regions if r.get("end", 0) > r.get("start", 0)][:3]
        if not regions:
            return {"error": "All regions have end <= start"}

        workflow = _load_template(config.WORKFLOW_MULTIREPAINT_TEMPLATE)

        for node in _find_nodes(workflow, "LoadAudio"):
            node["inputs"]["audio"] = input_name

        for node in _find_nodes(workflow, "TextEncodeAceStepAudio1.5"):
            inp = node.setdefault("inputs", {})
            _apply_text_encoder(inp, caption, lyrics, state)
            inp["generate_audio_codes"] = False

        seed = _gen_seed(state)
        sampler_name = state.get("sampler_name", "er_sde") or "er_sde"
        scheduler = state.get("scheduler", "linear_quadratic") or "linear_quadratic"

        # Region node ID groups: (trim_id, encode_id, ksampler_id, decode_id, overlay_id)
        region_nodes = [
            ("10", "11", "12", "13", "14"),
            ("20", "21", "22", "23", "24"),
            ("30", "31", "32", "33", "34"),
        ]

        # Wire the overlay chain: first region overlays onto LoadAudio output ("1")
        # Second region overlays onto first overlay output ("14"), etc.
        overlay_chain_input = "1"
        for i, (trim_id, enc_id, ks_id, dec_id, ov_id) in enumerate(region_nodes):
            if i < len(regions):
                r = regions[i]
                start = float(r["start"])
                duration = round(float(r["end"]) - start, 3)
                if trim_id in workflow:
                    workflow[trim_id]["inputs"]["start_index"] = start
                    workflow[trim_id]["inputs"]["duration"] = duration
                if ks_id in workflow:
                    inp = workflow[ks_id].setdefault("inputs", {})
                    inp["steps"] = state.get("steps", 20)
                    inp["denoise"] = float(denoise)
                    inp["seed"] = seed
                    inp["sampler_name"] = sampler_name
                    inp["scheduler"] = scheduler
                if ov_id in workflow:
                    workflow[ov_id]["inputs"]["base"] = [overlay_chain_input, 0]
                    workflow[ov_id]["inputs"]["start_time"] = start
                overlay_chain_input = ov_id
            else:
                # Remove unused region nodes and re-wire the save node
                for nid in (trim_id, enc_id, ks_id, dec_id, ov_id):
                    workflow.pop(nid, None)

        _apply_seed_to_encoder(workflow, seed)

        # Point save node at the last overlay in the chain
        for node in workflow.values():
            if isinstance(node, dict) and node.get("class_type") in _AUDIO_SAVE_CLASSES:
                node["inputs"]["audio"] = [overlay_chain_input, 0]

        _apply_dit_model(workflow, state, default="sft")
        _apply_audio_format(workflow, state)

        return {"workflow": workflow, "seed": seed}

    def send_workflow(self, workflow: dict) -> dict:
        try:
            def _post():
                resp = requests.post(
                    f"{self.base_url}/prompt",
                    json={"prompt": workflow},
                    timeout=10,
                )
                if not resp.ok:
                    body = resp.text[:500]
                    logger.error("ComfyUI /prompt %s: %s", resp.status_code, body)
                    raise RuntimeError(f"{resp.status_code} {resp.reason}: {body}")
                return resp.json()
            return comfyui_breaker.call(_post)
        except CircuitOpenError:
            return {"error": "ComfyUI unavailable (circuit open)"}
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
