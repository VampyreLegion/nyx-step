from __future__ import annotations
import json
import logging
import time
from typing import Generator

import requests

import config
from core.circuit_breaker import ollama_breaker, CircuitOpenError

logger = logging.getLogger(__name__)


def _post_with_retry(url: str, payload: dict, timeout: int = 120, retries: int = 3) -> requests.Response:
    import random
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            resp = requests.post(url, json=payload, timeout=timeout)
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(1 + random.uniform(0, 1))
    raise last_exc


def list_models() -> list[str]:
    try:
        resp = requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=3)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        return models if models else ["(no models found)"]
    except Exception as exc:
        logger.debug("Ollama unreachable: %s", exc)
        return ["(Ollama offline)"]


def lookup_artist(artist: str, model: str = "gemma4:latest", use_web: bool = False) -> dict:
    """Ask Ollama about an artist's musical profile, optionally grounded with Brave Search."""
    import re
    web_context = ""
    if use_web:
        from core.brave_search import search_artist
        web_context = search_artist(artist)[:1500]

    example = (
        '{"genre_tag":"hip hop","instrument_tags":["drum machine","synthesizer","bass"],'
        '"vocal_tags":["female vocal","powerful","rhythmic"],'
        '"vocal_key":"a3-e5, typically sings in f major / d minor",'
        '"style_tags":["energetic","urban","bold","playful"],'
        '"lyric_style":"Witty and confident with rapid-fire wordplay and self-empowerment themes.",'
        '"lyric_themes":["confidence","dance","empowerment","fun"]}'
    )
    system = (
        "You are a music production expert. Your task: analyze an artist and output their musical profile "
        "as a single JSON object — no markdown, no backticks, no explanation, just the raw JSON.\n"
        "All string values must be lowercase. Use these exact keys:\n"
        "  genre_tag (string): primary genre\n"
        "  instrument_tags (array of strings): instruments used\n"
        "  vocal_tags (array of strings): vocal style descriptors e.g. 'female vocal', 'raspy', 'falsetto'\n"
        "  vocal_key (string): typical vocal range and keys the artist sings in, e.g. 'a3-d5, often in g major / e minor'\n"
        "  style_tags (array of strings): mood/texture/production style\n"
        "  lyric_style (string): one sentence on their songwriting approach\n"
        "  lyric_themes (array of strings): 3-5 common lyric themes\n\n"
        f"Example output for a hip-hop artist:\n{example}"
    )
    prompt_parts = [system]
    if web_context:
        prompt_parts.append(f"\nWeb search context:\n{web_context}")
    prompt_parts.append(f"\nNow analyze this artist and return ONLY the JSON: {artist}")

    payload = {"model": model, "prompt": "\n".join(prompt_parts), "stream": False}
    try:
        resp = ollama_breaker.call(_post_with_retry, f"{config.OLLAMA_URL}/api/generate", payload)
        text = resp.json().get("response", "").strip()
        logger.info("Artist lookup raw response for %r: %s", artist, text[:300])

        # Strip markdown fences if present
        text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
        text = re.sub(r'```\s*$', '', text, flags=re.MULTILINE)
        text = text.strip()

        # Try to find JSON object
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError as exc:
                logger.error("JSON parse failed for %r: %s — raw: %s", artist, exc, text[:200])
                return {"error": f"Model returned malformed JSON: {text[:120]}"}
        logger.error("No JSON found in response for %r: %s", artist, text[:200])
        return {"error": f"No results found. Model said: {text[:120]}"}
    except CircuitOpenError:
        return {"error": "Ollama unavailable (circuit open)"}
    except Exception as exc:
        logger.error("Artist lookup failed: %s", exc)
        return {"error": str(exc)}


def expand_prompt(description: str, model: str = "gemma4:latest") -> dict:
    """Turn a free-text description into structured generation parameters."""
    import re
    example = (
        '{"tags":"dark orchestral, epic, cinematic, drums, strings, brass, powerful",'
        '"bpm":120,"key":"D","scale":"minor","time_sig":"4/4",'
        '"instruments":["orchestral drums","strings","brass","choir"],'
        '"mood":"epic, dark, intense"}'
    )
    system = (
        "You are a music production AI. Convert a free-text music description into structured generation "
        "parameters as a single JSON object. No markdown, no backticks, no explanation — just raw JSON.\n"
        "Required keys:\n"
        "  tags (string): comma-separated Nyx-Step style tags (genre, mood, instruments, tempo feel, etc.)\n"
        "  bpm (integer): estimated tempo 40-300\n"
        "  key (string): musical key, one of: C, C#, D, D#, E, F, F#, G, G#, A, A#, B\n"
        "  scale (string): one of: major, minor, harmonic minor, pentatonic major, pentatonic minor\n"
        "  time_sig (string): one of: 2/4, 3/4, 4/4, 6/8\n"
        "  instruments (array of strings): 3-6 instrument names to add to the instrument list\n"
        "  mood (string): 2-3 mood descriptors\n\n"
        f"Example for 'dark medieval battle music':\n{example}"
    )
    payload = {
        "model": model,
        "prompt": f"{system}\n\nNow convert this description and return ONLY the JSON: {description}",
        "stream": False,
    }
    try:
        resp = ollama_breaker.call(_post_with_retry, f"{config.OLLAMA_URL}/api/generate", payload)
        text = resp.json().get("response", "").strip()
        text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
        text = re.sub(r'```\s*$', '', text, flags=re.MULTILINE)
        text = text.strip()
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                return {"error": f"Model returned malformed JSON: {text[:120]}"}
        return {"error": f"No JSON found. Model said: {text[:120]}"}
    except CircuitOpenError:
        return {"error": "Ollama unavailable (circuit open)"}
    except Exception as exc:
        logger.error("expand_prompt failed: %s", exc)
        return {"error": str(exc)}


def infer_tags(analysis: dict, model: str = "gemma4:latest") -> dict:
    """Infer Nyx-Step style tags from Analyze-tab measurements."""
    import re
    parts = []
    if analysis.get("bpm"):
        parts.append(f"BPM: {analysis['bpm']}")
    if analysis.get("key"):
        parts.append(f"Key: {analysis['key']} {analysis.get('scale', '')}".strip())
    if analysis.get("chords"):
        parts.append(f"Chord progression: {analysis['chords']}")
    if analysis.get("lufs") is not None:
        parts.append(f"Loudness: {analysis['lufs']} LUFS")
    if analysis.get("duration"):
        parts.append(f"Duration: {analysis['duration']}s")
    lyrics = (analysis.get("lyrics") or "")[:300]
    if lyrics:
        parts.append(f"Transcribed lyrics excerpt: {lyrics}")

    example = '{"tags":"jazz, swing, piano trio, brushed drums, relaxed, late night","genre":"jazz","mood":"relaxed, smoky"}'
    system = (
        "You are a music analyst. Given measurements extracted from an audio file, infer the "
        "likely genre and produce Nyx-Step style tags as a single JSON object. "
        "No markdown, no backticks — just raw JSON.\n"
        "Required keys:\n"
        "  tags (string): 6-10 comma-separated style tags (genre, instruments, mood, production)\n"
        "  genre (string): single primary genre, lowercase\n"
        "  mood (string): 2-3 mood descriptors\n\n"
        f"Example output:\n{example}"
    )
    payload = {
        "model": model,
        "prompt": f"{system}\n\nMeasurements:\n" + "\n".join(parts) + "\n\nReturn ONLY the JSON:",
        "stream": False,
    }
    try:
        resp = ollama_breaker.call(_post_with_retry, f"{config.OLLAMA_URL}/api/generate", payload)
        text = resp.json().get("response", "").strip()
        text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
        text = re.sub(r'```\s*$', '', text, flags=re.MULTILINE)
        text = text.strip()
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                return {"error": f"Model returned malformed JSON: {text[:120]}"}
        return {"error": f"No JSON found. Model said: {text[:120]}"}
    except CircuitOpenError:
        return {"error": "Ollama unavailable (circuit open)"}
    except Exception as exc:
        logger.error("infer_tags failed: %s", exc)
        return {"error": str(exc)}


def deep_expand_prompt(description: str, model: str = "gemma4:latest") -> dict:
    """Full AI elaboration: research artist, generate complete tags + full lyrics.

    Returns dict with keys: tags, bpm, key, scale, time_sig, genre, mood,
    instruments (list), vocal_tags (list), lyrics (str), song_name (str).
    """
    import re

    # Detect if an artist is referenced — try Brave Search for context
    web_context = ""
    artist_name = ""
    try:
        from core.brave_search import search_artist
        result = search_artist(description)
        if result and len(result) > 100:
            web_context = result[:2000]
    except Exception:
        pass

    example = (
        '{"tags":"trance, electronic, driving bass, synth leads, '
        'atmospheric pads, energetic, euphoric, festival, big room",'
        '"bpm":132,"key":"F","scale":"minor","time_sig":"4/4",'
        '"genre":"trance","mood":"euphoric, energetic, uplifting",'
        '"instruments":["synth","drum machine","bass synth","sampler"],'
        '"vocal_tags":["male vocal","processed","reverent","ethereal"],'
        '"lyrics":"[Intro: Building]\\n\\n[Verse]\\nUnder the lights\\nThe bassline '
        'drives us\\n\\n[Chorus]\\nWe are the night\\nLifting spirits\\n\\n[Outro: Fading]",'
        '"song_name":"Neon Lights"}'
    )

    system = (
        "You are a world-class music producer and lyricist AI. "
        "Given a music idea or description, you will produce a COMPLETE song package "
        "as a single JSON object. No markdown, no backticks, no explanation — raw JSON only.\n\n"
        "Required keys:\n"
        "  tags (string): 8-15 comma-separated Nyx-Step style tags: genre, mood, instruments, "
        "tempo feel, production style, performance technique, energy level, sonic texture\n"
        "  bpm (integer): estimated tempo 40-300\n"
        "  key (string): musical key, one of: C, C#, D, D#, E, F, F#, G, G#, A, A#, B\n"
        "  scale (string): one of: major, minor, harmonic minor, pentatonic major, pentatonic minor, "
        "dorian, phrygian, lydian, mixolydian\n"
        "  time_sig (string): one of: 2/4, 3/4, 4/4, 6/8\n"
        "  genre (string): single primary genre\n"
        "  mood (string): 2-4 mood/energy descriptors\n"
        "  instruments (array of strings): 4-8 instrument names for the instrument list\n"
        "  vocal_tags (array of strings): 3-6 vocal style descriptors e.g. "
        "['female vocal','powerful','raspy','falsetto','breathy','choir']\n"
        "  lyrics (string): COMPLETE song with Nyx-Step section tags. "
        "Must include all of: [Intro], [Verse], [Chorus], [Bridge], [Outro]. "
        "At least 2 verses and 2 choruses. "
        "Every section starts with its bracketed tag on its own line. "
        "Write lyrics that are poetic, musical, and evoke the described mood.\n"
        "  song_name (string): a creative title derived from the description\n\n"
        f"Example output for 'Tiesto style live set':\n{example}"
    )

    # Build prompt with web context if available
    extra_context = ""
    if web_context:
        extra_context = (
            f"\n\nWeb research about this idea/artist:\n{web_context}\n\n"
            "Use this context to inform genre, style, instruments, and lyrics."
        )
    full_prompt = (
        f"{system}{extra_context}\n\n"
        f"Now convert this description into a complete song package. "
        f"Return ONLY the JSON: {description}"
    )

    payload = {"model": model, "prompt": full_prompt, "stream": False, "options": {"num_predict": 16384}}
    try:
        resp = ollama_breaker.call(_post_with_retry, f"{config.OLLAMA_URL}/api/generate", payload)
        text = resp.json().get("response", "").strip()
        text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
        text = re.sub(r'```\s*$', '', text, flags=re.MULTILINE)
        text = text.strip()

        # Robust JSON extraction: try full parse first, then partial
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass  # fall through to partial extraction

        # Partial extraction: grab whatever keys are present
        partial: dict = {}
        for key in ("tags","bpm","key","scale","time_sig","genre","mood","song_name","lyrics","instruments","vocal_tags"):
            if key in ("instruments","vocal_tags"):
                m = re.search(r'"' + key + r'"\s*:\s*\[(.*?)\]', text, re.DOTALL)
                if m:
                    raw = "[" + m.group(1) + "]"
                    try:
                        partial[key] = json.loads(raw)
                    except json.JSONDecodeError:
                        items = re.findall(r'"([^"]*?)"', raw)
                        partial[key] = items[:10] if items else []
            else:
                m = re.search(r'"' + key + r'"\s*:\s*"((?:[^"\\]|\\.)*)', text, re.DOTALL)
                if m:
                    val = m.group(1).replace('\\"', '"')
                    if key == "bpm":
                        try: partial[key] = int(val)
                        except: pass
                    else:
                        partial[key] = val

        if partial:
            return partial
        return {"error": f"Model returned malformed JSON: {text[:200]}"}
    except CircuitOpenError:
        return {"error": "Ollama unavailable (circuit open)"}
    except Exception as exc:
        logger.error("deep_expand_prompt failed: %s", exc)
        return {"error": str(exc)}


def stream_lyrics(
    prompt: str,
    genre: str,
    key: str,
    mood: str,
    structure: str,
    model: str,
    subject: str = "",
    name_override: str = "",
    artist: str = "",
    lyric_style: str = "",
    lyric_themes: str = "",
    vocal_style: str = "",
    instruments_hint: str = "",
    enhancement_tags: str = "",
    instrumental: bool = False,
) -> Generator[str, None, None]:
    mood_str = f"with a {mood} mood" if mood else "with an appropriate mood"
    subject_str = f" The song is about: {subject}." if subject else ""
    name_str = (
        f" IMPORTANT: In the lyrics, refer to '{subject or 'the subject'}' as '{name_override}' — "
        f"never use any other name."
    ) if name_override else ""
    artist_str = f" Write in the lyrical style of {artist}." if artist else ""
    lyric_style_str = f" Lyric style: {lyric_style}." if lyric_style else ""
    themes_str = f" Common themes to draw from: {lyric_themes}." if lyric_themes else ""
    vocal_str = f" Vocal style: {vocal_style}." if vocal_style else ""
    instr_str = f" Suggested instruments: {instruments_hint}." if instruments_hint else ""
    enhance_str = f" Key performance and production elements to incorporate: {enhancement_tags}." if enhancement_tags else ""

    if instrumental:
        system = (
            f"You are an expert music arranger specializing in {genre} music. "
            f"Create an instrumental arrangement outline {mood_str}. "
            f"Use this structure: {structure}.{instr_str}{enhance_str} "
            f"Use only structural/instrumental tags — no sung lyrics: "
            f"[Intro] [Build] [Drop] [Breakdown] [Outro] [Guitar Solo] [Piano Interlude] [Drum Break]. "
            f"Under each tag write a brief arrangement note (e.g. 'filtered synth pads, rising arp'). "
            f"Output ONLY the arrangement — no explanations."
        )
    else:
        system = (
            f"You are an expert lyricist and music producer specializing in {genre} music. "
            f"Write lyrics in the key of {key}, {mood_str}. "
            f"Use this song structure: {structure}.{subject_str}{name_str}{artist_str}{lyric_style_str}{themes_str}{vocal_str}{instr_str}{enhance_str} "
            f"Format every section with Nyx-Step structural tags. "
            f"Available tags — use whichever fit: [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Outro] "
            f"[Build] [Drop] [Breakdown] [Fade Out] [Guitar Solo] [Piano Interlude] [Drum Break]. "
            f"Append ': descriptor' for mood e.g. [Chorus: Anthemic]. "
            f"Every section MUST start with a tag on its own line. "
            f"Output ONLY the lyrics — no explanations."
        )
    payload = {"model": model, "prompt": f"{system}\n\nTask: {prompt}", "stream": True}
    try:
        def _open_stream():
            return requests.post(
                f"{config.OLLAMA_URL}/api/generate", json=payload, stream=True, timeout=120
            )
        resp = ollama_breaker.call(_open_stream)
        with resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    token = data.get("response", "")
                    if token:
                        yield token
                    if data.get("done"):
                        break
                except json.JSONDecodeError:
                    continue
    except CircuitOpenError as exc:
        logger.warning("stream_lyrics: %s", exc)
        yield f"\n[Error: Ollama unavailable (circuit open)]"
    except Exception as exc:
        logger.error("Ollama failed: %s", exc)
        yield f"\n[Error: {exc}]"
