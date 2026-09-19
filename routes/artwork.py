from __future__ import annotations
import asyncio
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import config
from core.comfyui import ComfyUIClient
from core.executor import get_audio_pool
from nyx_step import get_user_email

router = APIRouter(prefix="/api/artwork", tags=["artwork"])

# ── In-memory artwork job registry ─────────────────────────────────────────────
# Artwork generation is async: /generate returns immediately with a prompt_id and
# a background task polls ComfyUI. Returning instantly keeps the HTTP request well
# under reverse-proxy timeouts (Cloudflare Edge ≈ 100 s) — the previous sync
# version held the connection for several minutes and the proxy replied with an
# HTML timeout page, which broke resp.json() on the frontend.
_ARTWORK_RESULTS: dict[str, dict] = {}
_ARTWORK_POLL_SECONDS = 0.5
_ARTWORK_TIMEOUT_STEPS = 600  # up to 300 s — SDXL Base can take 2–4 min


class ArtworkRequest(BaseModel):
    prompt: str = Field(..., description="Text prompt for artwork generation")
    song_name: str = "Artwork"
    width: int = Field(default=1024, ge=512, le=2048)
    height: int = Field(default=1024, ge=512, le=2048)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=7.0, ge=1.0, le=20.0)
    sampler: str = "euler"
    scheduler: str = "simple"
    seed: int = Field(default=0, ge=0, le=4294967295)
    model: str = "sdxl"
    negative_prompt: str = "text, watermark, signature, logo, blurry, low quality, ugly, deformed, noisy, grain, lowres, bad anatomy, extra limbs, missing limbs, cropped, worst quality, jpeg artifacts"


def _build_artwork_workflow(req: ArtworkRequest, seed: int) -> dict:
    """Build a ComfyUI SDXL txt2img workflow for album cover generation."""
    if req.model == "sdxl":
        ckpt = "sd_xl_base_1.0.safetensors"
    elif req.model == "sdxl_turbo":
        ckpt = "sd_xl_turbo_1.0_fp16.safetensors"
    else:
        ckpt = "sd_xl_base_1.0.safetensors"

    prefix = f"nyx_artwork_{uuid.uuid4().hex[:8]}"

    wf = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": req.negative_prompt, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": req.width, "height": req.height, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0],
            "seed": seed, "steps": req.steps, "cfg": req.cfg,
            "sampler_name": req.sampler, "scheduler": req.scheduler, "denoise": 1.0}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        # subfolder "audio/" = config.COMFYUI_OUTPUT_DIR — keeps covers next to
        # the songs and matches what routes/download.py is able to resolve.
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": f"audio/{prefix}"}},
    }

    wf["2"]["inputs"]["text"] = req.prompt
    return {"workflow": wf, "seed": seed, "prefix": prefix}


async def _poll_artwork_and_store(
    prompt_id: str,
    prefix: str,
    req: ArtworkRequest,
    gen_seed: int,
    user_email: str,
) -> None:
    """Background worker: poll ComfyUI history until the PNG lands, then record it."""
    client = ComfyUIClient()
    output_root = config.COMFYUI_OUTPUT_DIR.parent  # SaveImage subfolder is relative to the output root

    for _ in range(_ARTWORK_TIMEOUT_STEPS):
        await asyncio.sleep(_ARTWORK_POLL_SECONDS)
        entry = client.get_history(prompt_id).get(prompt_id, {})
        status_str = entry.get("status", {}).get("status_str", "")
        if status_str == "error":
            _ARTWORK_RESULTS[prompt_id] = {
                "status": "error", "prompt_id": prompt_id, "error": "ComfyUI generation failed",
            }
            return
        for node_out in entry.get("outputs", {}).values():
            for img in node_out.get("images", []) or []:
                fname = img.get("filename", "")
                if not fname or not fname.startswith(prefix):
                    continue
                rel = Path(img.get("subfolder", "")) / fname if img.get("subfolder") else Path(fname)
                path = output_root / rel
                if path.exists():
                    _ARTWORK_RESULTS[prompt_id] = {
                        "status": "done",
                        "prompt_id": prompt_id,
                        "filename": fname,
                        "path": str(path),
                        "prompt": req.prompt,
                        "model": req.model,
                        "steps": req.steps,
                        "seed": gen_seed,
                        "dimensions": f"{req.width}x{req.height}",
                    }
                    return

    _ARTWORK_RESULTS[prompt_id] = {
        "status": "timeout", "prompt_id": prompt_id,
        "error": "Generation timed out — ComfyUI is busy or the run stalled",
    }


@router.post("/generate")
async def generate_artwork(req: ArtworkRequest, request: Request):
    """Queue album cover artwork from a text prompt (lyrics, description, etc.).

    Submits the workflow to ComfyUI and returns immediately with a ``prompt_id``;
    the PNG is produced in the background. Poll ``/api/artwork/status/{id}`` and
    fetch the finished image from ``/api/artwork/image/{id}``.
    """
    get_user_email(request)

    client = ComfyUIClient()
    if not client.ping():
        return JSONResponse({"error": "ComfyUI unreachable"}, status_code=503)

    gen_seed = req.seed if req.seed != 0 else int(time.time()) % 2**31
    result = _build_artwork_workflow(req, gen_seed)

    send_result = client.send_workflow(result["workflow"])
    if "error" in send_result:
        return JSONResponse({"error": "ComfyUI submit failed: " + send_result["error"]}, status_code=400)

    prompt_id = send_result.get("prompt_id", "")
    if not prompt_id:
        return JSONResponse({"error": "ComfyUI submit returned no prompt_id"}, status_code=500)

    _ARTWORK_RESULTS[prompt_id] = {"status": "running", "prompt_id": prompt_id, "song_name": req.song_name}
    asyncio.create_task(
        _poll_artwork_and_store(prompt_id, result["prefix"], req, gen_seed, get_user_email(request))
    )
    return {"prompt_id": prompt_id, "status": "running", "song_name": req.song_name}


@router.get("/status/{prompt_id}")
async def artwork_status(prompt_id: str, request: Request):
    """Live state of an artwork job: ``running`` / ``done`` / ``error`` / ``timeout``."""
    get_user_email(request)
    res = _ARTWORK_RESULTS.get(prompt_id)
    if res is None:
        return {"status": "unknown", "prompt_id": prompt_id}
    return res


@router.get("/image/{prompt_id}")
async def artwork_image(prompt_id: str, request: Request):
    """Stream the finished cover PNG for a completed artwork job."""
    get_user_email(request)
    res = _ARTWORK_RESULTS.get(prompt_id) or {}
    if res.get("status") != "done" or not res.get("path"):
        return JSONResponse({"error": "Artwork not ready"}, status_code=404)
    path = Path(res["path"])
    if not path.is_file():
        return JSONResponse({"error": "Image missing on disk"}, status_code=404)
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{res["filename"]}"', "Cache-Control": "no-store"},
    )


class LyricsArtworkRequest(BaseModel):
    lyrics: str = Field(..., description="Song lyrics to base artwork on")
    song_name: str = "Song"
    style: str = Field(default="album cover art, vibrant, professional, evocative, no text", description="Style modifiers")
    genre: str = Field(default="", description="Music genre for visual style guidance")
    mood: str = Field(default="", description="Mood/emotion (dark, uplifting, melancholic, energetic, dreamy, aggressive)")
    width: int = Field(default=1024, ge=512, le=2048)
    height: int = Field(default=1024, ge=512, le=2048)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=7.0, ge=1.0, le=20.0)
    seed: int = Field(default=0, ge=0, le=4294967295)


# ── Visual concept extraction from lyrics ─────────────────────────────────────

_VISUAL_KEYWORDS = {
    # Settings / Locations
    "city": ["city", "urban", "metropolis", "downtown", "streets", "skyscraper", "alley", "boulevard"],
    "nature": ["forest", "woods", "mountain", "river", "ocean", "sea", "beach", "desert", "field", "meadow", "lake", "waterfall", "canyon", "valley", "hill", "tree", "flower", "garden"],
    "space": ["space", "star", "planet", "galaxy", "cosmos", "universe", "nebula", "orbit", "satellite", "astronaut", "moon", "sun", "solar"],
    "night": ["night", "midnight", "darkness", "shadow", "moonlight", "starlight", "nocturnal", "twilight", "dusk", "evening"],
    "day": ["day", "sunrise", "dawn", "morning", "sunlight", "daylight", "noon", "afternoon", "golden hour"],
    "indoors": ["room", "bedroom", "kitchen", "house", "home", "apartment", "club", "bar", "venue", "stage", "studio", "basement", "attic"],
    "water": ["rain", "storm", "flood", "wave", "drown", "swim", "ocean", "river", "lake", "tear", "cry", "wet", "soak"],
    "fire": ["fire", "flame", "burn", "ash", "ember", "spark", "blaze", "ignite", "scorch", "heat"],
    "road": ["road", "highway", "path", "journey", "drive", "ride", "travel", "wander", "roam", "miles", "distance"],
    "sky": ["sky", "cloud", "heaven", "horizon", "atmosphere", "air", "wind", "breeze", "fly", "soar", "wing"],
    
    # Colors / Lighting
    "neon": ["neon", "electric", "glow", "fluorescent", "led", "laser", "cyberpunk", "synthwave", "retrowave"],
    "dark": ["dark", "black", "shadow", "gloom", "dim", "murky", "obscure", "pitch", "void", "abyss"],
    "bright": ["bright", "light", "shine", "radiant", "brilliant", "luminous", "glow", "beam", "ray"],
    "gold": ["gold", "golden", "amber", "honey", "bronze", "copper", "sunset", "warm"],
    "blue": ["blue", "azure", "cyan", "teal", "indigo", "navy", "cobalt", "sapphire", "ocean blue"],
    "red": ["red", "crimson", "scarlet", "ruby", "blood", "rose", "cherry", "fire", "passion"],
    "purple": ["purple", "violet", "lavender", "amethyst", "magenta", "orchid", "plum"],
    "green": ["green", "emerald", "jade", "forest", "mint", "olive", "sage", "lime", "nature"],
    "white": ["white", "pure", "ivory", "pearl", "snow", "frost", "ice", "crystal", "angelic"],
    "gray": ["gray", "grey", "silver", "steel", "iron", "metallic", "concrete", "stone", "ash"],
    
    # Emotions / Moods
    "melancholic": ["sad", "lonely", "alone", "empty", "hollow", "grief", "sorrow", "pain", "hurt", "broken", "lost", "missing", "goodbye", "farewell", "tear", "cry", "weep"],
    "uplifting": ["hope", "rise", "fly", "soar", "dream", "believe", "triumph", "victory", "win", "overcome", "strong", "power", "free", "liberation", "joy", "happy", "smile", "laugh"],
    "romantic": ["love", "heart", "kiss", "embrace", "hold", "touch", "darling", "beloved", "romance", "passion", "desire", "intimate", "tender", "sweet", "forever", "together"],
    "aggressive": ["rage", "anger", "hate", "fight", "battle", "war", "destroy", "break", "smash", "crush", "violent", "furious", "wrath", "scream", "shout", "roar"],
    "dreamy": ["dream", "fantasy", "imagine", "surreal", "ethereal", "magical", "mystical", "enchant", "spell", "illusion", "vision", "cloud", "float", "drift", "wander"],
    "nostalgic": ["memory", "remember", "past", "yesterday", "childhood", "innocence", "time", "clock", "hour", "moment", "flashback", "reminisce", "old", "vintage", "retro"],
    "mysterious": ["mystery", "secret", "hidden", "unknown", "shadow", "whisper", "silence", "enigma", "puzzle", "riddle", "veil", "mask", "disguise", "cloak"],
    "energetic": ["energy", "power", "force", "electric", "voltage", "current", "surge", "pulse", "beat", "rhythm", "move", "dance", "jump", "run", "fast", "speed", "wild"],
    
    # Time / Era
    "futuristic": ["future", "tomorrow", "next", "new", "modern", "advanced", "technology", "digital", "cyber", "ai", "robot", "machine", "synthetic", "virtual", "hologram"],
    "vintage": ["old", "past", "history", "ancient", "classic", "retro", "vintage", "antique", "timeless", "era", "age", "generation", "legacy", "tradition"],
    "post_apocalyptic": ["ruin", "wasteland", "ash", "dust", "decay", "abandoned", "forgotten", "collapsed", "broken", "survivor", "end", "apocalypse", "doom", "fallout"],
    
    # Abstract concepts
    "music": ["music", "song", "melody", "harmony", "rhythm", "beat", "note", "chord", "sound", "audio", "frequency", "wave", "vibration", "resonance", "silence", "noise"],
    "dance": ["dance", "move", "groove", "sway", "spin", "twirl", "step", "rhythm", "flow", "motion", "body", "hips", "feet"],
    "journey": ["journey", "path", "road", "way", "direction", "destination", "arrive", "depart", "leave", "go", "come", "travel", "wander", "explore", "discover"],
    "transformation": ["change", "transform", "become", "evolve", "grow", "bloom", "rise", "emerge", "reborn", "phoenix", "metamorphosis", "shift", "turn"],
}


_GENRE_VISUAL_STYLES = {
    "edm": "neon lights, laser beams, festival crowd, electric energy, vibrant colors, motion blur, futuristic stage",
    "synthwave": "retro-futuristic, neon grid, sunset highway, palm silhouettes, chrome, VHS aesthetic, 80s nostalgia",
    "cyberpunk": "rain-slicked streets, neon signage, holographic ads, high-tech low-life, megacity, cybernetic implants",
    "ambient": "ethereal landscape, soft focus, misty atmosphere, minimal composition, pastel tones, serene, spacious",
    "lo-fi": "cozy bedroom, vinyl record, warm lighting, anime aesthetic, rainy window, nostalgic, chill atmosphere",
    "hip hop": "urban streets, graffiti, concrete, gold chains, lowrider, city skyline at night, street culture",
    "trap": "dark atmosphere, heavy shadows, luxury aesthetic, diamond, champagne, trap house, menacing energy",
    "rock": "gritty texture, stage lights, guitar amps, concert energy, leather, denim, raw power, dynamic motion",
    "metal": "dark fantasy, fire, skull, chains, leather, aggressive, intense lighting, dramatic composition",
    "jazz": "smoky club, dim lights, saxophone, piano, intimate venue, blue tones, sophisticated, vintage",
    "blues": "dimly lit bar, guitar, emotional expression, deep shadows, warm amber, raw authenticity",
    "country": "open road, desert highway, sunset, acoustic guitar, dusty boots, wide landscape, americana",
    "folk": "forest clearing, campfire, acoustic instruments, natural light, intimate, organic textures, storytelling",
    "classical": "grand concert hall, chandelier, orchestra, elegant, refined, golden age, architectural detail",
    "electronic": "abstract geometry, digital waves, circuit patterns, fluorescent, technological, precision, synthetic",
    "house": "club interior, disco ball, dancing silhouettes, strobe lights, euphoric, communal energy",
    "techno": "industrial warehouse, minimal lighting, repetitive patterns, hypnotic, monochrome, raw concrete",
    "trance": "euphoric hands-up, laser pyramid, cosmic journey, uplifting, spiritual, transcendent light",
    "drum and bass": "high velocity, motion streaks, urban night, breakbeat energy, kinetic, fast-paced",
    "dubstep": "heavy bass visualization, sound waves, distortion, dark industrial, aggressive drops, sub-bass",
    "pop": "bright colorful, polished, glossy, fashion-forward, iconic imagery, mainstream appeal, vibrant",
    "r&b": "smooth gradients, intimate lighting, velvet texture, sensual, moody atmosphere, slow motion",
    "soul": "warm vintage tones, gospel choir, emotional depth, rich colors, authentic, heartfelt",
    "funk": "groovy patterns, bass guitar, retro 70s aesthetic, colorful, rhythmic, playful energy",
    "disco": "mirror ball, sparkling lights, dance floor, glamour, 70s fashion, celebratory, glitter",
    "reggae": "tropical beach, palm trees, sunset, relaxed, Rastafarian colors, organic, island vibes",
    "latin": "passionate dance, vibrant colors, rhythmic patterns, carnival, fiesta, warm tones, movement",
    "k-pop": "high fashion, polished choreography, vibrant concepts, futuristic sets, glossy production",
    "j-pop": "anime aesthetic, cherry blossoms, school uniform, bright pastels, kawaii culture, emotional",
    "indie": "authentic, DIY aesthetic, natural lighting, intimate, quirky, personal, raw honesty",
    "alternative": "unconventional, artistic, moody, textured, experimental, non-mainstream, expressive",
    "punk": "raw, rebellious, gritty, high contrast, safety pins, leather jacket, anti-establishment",
    "grunge": "distressed, flannel, Seattle rain, muted tones, angst, authenticity, raw emotion",
    "psychedelic": "kaleidoscopic, swirling patterns, vibrant colors, surreal, mind-expanding, trippy",
    "progressive": "complex, layered, conceptual, architectural, intricate detail, intellectual, epic scale",
    "experimental": "abstract, avant-garde, unconventional composition, challenging, innovative, boundary-pushing",
    "industrial": "factory, machinery, metal, rust, mechanical, harsh, rhythmic noise, dystopian",
    "gothic": "dark romantic, cathedral, candlelight, Victorian, melancholic beauty, dramatic shadows",
    "darkwave": "shadowy, atmospheric, synthesizer, cold wave, monochrome, introspective, nocturnal",
    "witch house": "occult symbols, dark ritual, glitch aesthetic, inverted crosses, mysterious, esoteric",
    "vaporwave": "glitch art, Greek statues, Japanese text, sunset gradient, nostalgia, consumerism critique",
    "chillwave": "hazy, washed out, summer memory, lo-fi nostalgia, dreamy, slow motion, pastel",
    "future bass": "wobbly supersaws, bright chords, vocal chops, euphoric drops, anime aesthetic, colorful",
    "hardstyle": "hard kicks, reverse bass, euphoric melody, festival mainstage, raw energy, distorted",
    "psytrance": "psychedelic patterns, fractal geometry, spiritual, tribal, trance-inducing, intricate",
    "afrobeat": "African patterns, vibrant colors, percussion, dance, community, celebration, rhythmic",
    "reggaeton": "urban Latin, dembow rhythm, nightlife, sensual, street culture, tropical urban",
    "k-pop": "high concept, fashion editorial, synchronized choreography, vibrant sets, polished",
}


def _analyze_lyrics_for_visuals(lyrics: str) -> dict:
    """Analyze lyrics and extract visual concepts with weights."""
    import re
    from collections import Counter
    
    # Clean lyrics - remove structural markers and parentheticals
    lines = []
    for raw in lyrics.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("["):
            continue
        # Remove parentheticals (ad-libs, backing vocals)
        stripped = re.sub(r'\([^)]*\)', '', stripped)
        if stripped:
            lines.append(stripped)
    
    full_text = " ".join(lines).lower()
    if not full_text:
        return {"themes": [], "colors": [], "settings": [], "mood": [], "objects": [], "key_phrases": []}
    
    # Score each visual category
    category_scores = {}
    for category, keywords in _VISUAL_KEYWORDS.items():
        score = 0
        matched = []
        for kw in keywords:
            # Count occurrences (word boundary aware)
            pattern = r'\b' + re.escape(kw) + r'\b'
            count = len(re.findall(pattern, full_text))
            if count > 0:
                score += count
                matched.append(kw)
        if score > 0:
            category_scores[category] = {"score": score, "keywords": matched}
    
    # Sort by score
    sorted_categories = sorted(category_scores.items(), key=lambda x: x[1]["score"], reverse=True)
    
    # Extract key phrases (3-6 word sequences that are evocative)
    words = full_text.split()
    phrases = []
    for i in range(len(words) - 2):
        for length in [3, 4, 5, 6]:
            if i + length <= len(words):
                phrase = " ".join(words[i:i+length])
                # Filter for evocative phrases (not just filler)
                if any(c in phrase for c in [" ", "-"]) and not phrase.startswith(("the ", "and ", "but ", "for ", "with ", "from ")):
                    phrases.append(phrase)
    
    # Score phrases by visual evocativeness
    visual_words = set()
    for kw_list in _VISUAL_KEYWORDS.values():
        visual_words.update(kw_list)
    
    scored_phrases = []
    for phrase in phrases:
        score = sum(1 for w in phrase.split() if w in visual_words)
        if score > 0:
            scored_phrases.append((score, phrase))
    
    top_phrases = [p for _, p in sorted(scored_phrases, reverse=True)[:5]]
    
    # Categorize results
    themes = []
    colors = []
    settings = []
    mood = []
    objects = []
    
    theme_cats = {"music", "dance", "journey", "transformation"}
    color_cats = {"neon", "dark", "bright", "gold", "blue", "red", "purple", "green", "white", "gray"}
    setting_cats = {"city", "nature", "space", "night", "day", "indoors", "water", "fire", "road", "sky"}
    mood_cats = {"melancholic", "uplifting", "romantic", "aggressive", "dreamy", "nostalgic", "mysterious", "energetic"}
    object_cats = {"futuristic", "vintage", "post_apocalyptic"}
    
    for cat, data in sorted_categories:
        if cat in theme_cats:
            themes.extend(data["keywords"][:2])
        elif cat in color_cats:
            colors.extend(data["keywords"][:2])
        elif cat in setting_cats:
            settings.extend(data["keywords"][:2])
        elif cat in mood_cats:
            mood.extend(data["keywords"][:2])
        elif cat in object_cats:
            objects.extend(data["keywords"][:2])
    
    return {
        "themes": themes[:3],
        "colors": colors[:3],
        "settings": settings[:3],
        "mood": mood[:3],
        "objects": objects[:2],
        "key_phrases": top_phrases[:3],
        "raw_text": full_text[:200],
    }


def _build_visual_prompt(analysis: dict, genre: str, mood: str, style: str) -> str:
    """Construct a rich visual prompt from analyzed lyrics."""
    parts = []
    
    # Key phrases from lyrics (most important - direct visual references)
    if analysis["key_phrases"]:
        parts.extend(analysis["key_phrases"][:2])
    
    # Settings / locations
    if analysis["settings"]:
        parts.extend(analysis["settings"][:2])
    
    # Time of day / atmosphere
    time_atmos = []
    if "night" in analysis["settings"] or "dark" in analysis["colors"]:
        time_atmos.append("night atmosphere")
    elif "day" in analysis["settings"] or "bright" in analysis["colors"] or "gold" in analysis["colors"]:
        time_atmos.append("daylight")
    if "space" in analysis["settings"]:
        time_atmos.append("cosmic")
    if "water" in analysis["settings"]:
        time_atmos.append("water reflections")
    if "fire" in analysis["settings"]:
        time_atmos.append("fire light")
    parts.extend(time_atmos[:2])
    
    # Colors / lighting
    if analysis["colors"]:
        color_desc = ", ".join(analysis["colors"][:2]) + " color palette"
        parts.append(color_desc)
    
    # Mood / emotion
    mood_keywords = analysis["mood"]
    if mood:
        mood_keywords.insert(0, mood)
    if mood_keywords:
        parts.append(", ".join(mood_keywords[:2]) + " mood")
    
    # Themes
    if analysis["themes"]:
        parts.extend(analysis["themes"][:2])
    
    # Era / style
    if analysis["objects"]:
        parts.extend(analysis["objects"][:1])
    
    # Genre-specific visual style
    genre_lower = genre.lower().strip()
    if genre_lower in _GENRE_VISUAL_STYLES:
        parts.append(_GENRE_VISUAL_STYLES[genre_lower])
    elif genre_lower:
        # Try partial match
        for g, v in _GENRE_VISUAL_STYLES.items():
            if g in genre_lower or genre_lower in g:
                parts.append(v)
                break
    
    # Base style
    if style:
        parts.append(style)
    
    # Quality modifiers for album covers
    parts.append("album cover art, professional, high quality, detailed, evocative composition, no text, no watermark, no title")
    
    # Join and limit length
    prompt = ", ".join(parts)
    return prompt[:500]  # SDXL handles ~77 tokens well, ~500 chars is safe


def _extract_visual_prompt(lyrics: str, style: str, genre: str = "", mood: str = "") -> str:
    """Extract visual concepts from lyrics and build a rich art prompt."""
    analysis = _analyze_lyrics_for_visuals(lyrics)
    return _build_visual_prompt(analysis, genre, mood, style)


@router.post("/from-lyrics")
async def generate_from_lyrics(req: LyricsArtworkRequest, request: Request):
    """Queue album cover artwork automatically from song lyrics.

    Extracts visual concepts → builds the art prompt → submits to ComfyUI and
    returns immediately with a ``prompt_id`` (see ``/generate``).
    """
    get_user_email(request)

    visual_prompt = _extract_visual_prompt(req.lyrics, req.style, req.genre, req.mood)

    artwork_req = ArtworkRequest(
        prompt=visual_prompt,
        song_name=req.song_name,
        width=req.width,
        height=req.height,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed,
        model="sdxl",
    )

    return await generate_artwork(artwork_req, request)


@router.get("/models")
async def list_artwork_models(request: Request):
    """List available SDXL models for artwork generation."""
    get_user_email(request)
    return {
        "models": [
            {"id": "sdxl", "name": "SDXL Base", "recommended_steps": 20, "recommended_cfg": 7.0},
            {"id": "sdxl_turbo", "name": "SDXL Turbo", "recommended_steps": 4, "recommended_cfg": 1.0},
        ]
    }