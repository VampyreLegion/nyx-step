from __future__ import annotations
import json
import os
import pathlib
import random
from dataclasses import dataclass
from typing import Sequence

_CONFIG_PATH = pathlib.Path(__file__).resolve().parent.parent / "NyxStudio-Config.json"

_DEFAULT_LIBRARY = [
    "psytrance, 145bpm, deep resonant bassline, driving percussion, hypnotic synth leads",
    "progressive house, 126bpm, smooth bass pulse, airy pads, clean pluck melody",
    "minimal tech-house, 128bpm, dry percussive groove, glitchy vocal chops",
]


@dataclass
class VarianceConfig:
    global_randomization: bool = True
    batch_strategy: str = "increment"
    seed_mode: str = "random_per_index"
    cfg_range: list[float] = None
    denoise_range: list[float] = None
    prompt_library: list[str] = None

    def __post_init__(self):
        if self.cfg_range is None:
            self.cfg_range = [1.5, 3.5]
        if self.denoise_range is None:
            self.denoise_range = [0.85, 1.0]
        if self.prompt_library is None:
            self.prompt_library = list(_DEFAULT_LIBRARY)


def load_config(path: str | pathlib.Path | None = None) -> VarianceConfig:
    p = pathlib.Path(path) if path else _CONFIG_PATH
    if not p.exists():
        return VarianceConfig()
    try:
        with open(p) as f:
            data = json.load(f)
        vp = data.get("variance_parameters", {})
        return VarianceConfig(
            global_randomization=data.get("settings", {}).get("global_randomization", True),
            batch_strategy=data.get("settings", {}).get("batch_strategy", "increment"),
            seed_mode=data.get("settings", {}).get("seed_mode", "random_per_index"),
            cfg_range=vp.get("cfg_range", [1.5, 3.5]),
            denoise_range=vp.get("denoise_range", [0.85, 1.0]),
            prompt_library=data.get("prompt_library", _DEFAULT_LIBRARY),
        )
    except Exception:
        return VarianceConfig()


def generate_seed(base_seed: int, index: int, lock_seed: bool = False) -> int:
    if lock_seed and base_seed != 0:
        return base_seed
    return random.randint(0, 2**32 - 1)


def randomize_cfg(base_cfg: float, cfg_range: Sequence[float]) -> float:
    lo, hi = cfg_range
    if lo >= hi:
        return base_cfg
    return round(random.uniform(lo, hi), 2)


def randomize_denoise(base_denoise: float, denoise_range: Sequence[float]) -> float:
    lo, hi = denoise_range
    if lo >= hi:
        return base_denoise
    return round(random.uniform(lo, hi), 3)


def pick_prompt(prompt_library: list[str], index: int, base_tags: str) -> str:
    if not prompt_library:
        return base_tags
    variant = prompt_library[index % len(prompt_library)]
    return variant


def build_variance_states(
    state: dict,
    count: int,
    config: VarianceConfig | None = None,
) -> list[dict]:
    """Return a list of ``count`` state dicts, each with per-item variance applied."""
    if config is None:
        config = load_config()

    cfg_range = config.cfg_range or [1.5, 3.5]
    denoise_range = config.denoise_range or [0.85, 1.0]
    library = config.prompt_library or []
    base_seed = state.get("seed", 0)
    lock_seed = state.get("lock_seed", False)
    base_tags = state.get("tags", "")
    base_cfg = state.get("cfg_scale", 2.0)
    base_steps = state.get("steps", 8)

    states = []
    for i in range(count):
        s = dict(state)
        s["seed"] = generate_seed(base_seed, i, lock_seed)
        s["batch_size"] = 1

        if library and config.batch_strategy != "none":
            s["tags"] = pick_prompt(library, i, base_tags)

        if cfg_range[0] < cfg_range[1]:
            s["cfg_scale"] = randomize_cfg(base_cfg, cfg_range)

        if denoise_range[0] < denoise_range[1]:
            s["denoise"] = randomize_denoise(1.0, denoise_range)

        if base_steps > 4:
            step_jitter = random.choice([-1, 0, 0, 1])
            s["steps"] = max(4, base_steps + step_jitter)

        states.append(s)
    return states
