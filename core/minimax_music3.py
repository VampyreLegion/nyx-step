"""MiniMax Music3 workflow builder for ComfyUI integration."""
from __future__ import annotations
import random


def build_minimax_workflow(
    caption: str,
    lyrics: str,
    duration: float = 120.0,
    seed: int | None = None,
    cfg_scale: float = 7.0,
    top_k: int = 250,
    save_format: str = "mp3",
) -> dict:
    """Build a ComfyUI API-format workflow for MiniMax Music3.

    Args:
        caption: Structured music description (genre, instruments, mood, etc.)
        lyrics: Song lyrics with section tags like [Verse], [Chorus], etc.
        duration: Max duration in seconds (model can end earlier).
        seed: Random seed (auto-generated if None).
        cfg_scale: CFG scale for sampling.
        top_k: Top-k for text encoding.
        save_format: Output format (mp3, wav, flac, opus).

    Returns:
        ComfyUI API workflow dict.
    """
    if seed is None:
        seed = random.randint(0, 2**32 - 1)

    # Map save format to the appropriate save node class
    save_classes = {
        "mp3": "SaveAudioMP3",
        "wav": "SaveAudio",
        "flac": "SaveAudio",
        "opus": "SaveAudioOpus",
    }
    save_class = save_classes.get(save_format, "SaveAudioMP3")

    workflow = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": "minimax_music3_dit_fp16.safetensors",
                "weight_dtype": "default",
            },
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "minimax_music3_text_encoder_bf16.safetensors",
                "type": "minimax",
            },
        },
        "3": {
            "class_type": "MiniMaxMusic3TextEncode",
            "inputs": {
                "clip": ["2", 0],
                "caption": caption,
                "lyrics": lyrics,
                "seed": seed,
                "max_duration": duration,
                "cfg_scale": cfg_scale,
                "top_k": top_k,
            },
        },
        "4": {
            "class_type": "EmptyMiniMaxMusic3LatentAudio",
            "inputs": {
                "seconds": duration,
                "batch_size": 1,
            },
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["6", 0],
                "latent_image": ["4", 0],
                "seed": seed,
                "steps": 30,
                "cfg": cfg_scale,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
            },
        },
        "6": {
            "class_type": "ConditioningZeroOut",
            "inputs": {
                "conditioning": ["3", 0],
            },
        },
        "7": {
            "class_type": "VAEDecodeAudio",
            "inputs": {
                "vae": ["8", 0],
                "samples": ["5", 0],
            },
        },
        "8": {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": "minimax_music3_dav.safetensors",
            },
        },
        "9": {
            "class_type": save_class,
            "inputs": {
                "audio": ["7", 0],
                "filename_prefix": "audio/Nyx_music_m",
                "quality": "V0",
            },
        },
    }

    return {"workflow": workflow, "seed": seed}
