from pathlib import Path
import shutil
import subprocess
import tempfile

_YT_DLP = shutil.which("yt-dlp") or shutil.which("yt-dlp", path="/home/legion/.local/bin")
if _YT_DLP is None:
    raise RuntimeError("yt-dlp not found — install with: pip install yt-dlp")


def download_audio(url: str, output_dir: str | Path | None = None) -> str:
    """Download audio from a YouTube URL.

    Returns the path to the downloaded audio file (always .mp3 via ffmpeg
    re-encode).  Raises RuntimeError on failure.
    """
    output_dir = Path(output_dir or tempfile.mkdtemp())
    output_dir.mkdir(parents=True, exist_ok=True)

    template = str(output_dir / "%(title)s.%(ext)s")

    cmd = [
        _YT_DLP,
        "-x",                          # extract audio
        "--audio-format", "mp3",       # re-encode to mp3
        "--audio-quality", "0",        # best quality
        "--no-playlist",
        "--print", "after_move:filename",
        "-o", template,
        url,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise RuntimeError("yt-dlp timed out after 5 minutes")

    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {result.stderr.strip()}")

    # Find the actual .mp3 in the output directory
    lines = [l.strip() for l in result.stdout.splitlines() if l.strip()]
    if not lines:
        # Fallback: glob the output dir
        mp3s = list(output_dir.glob("*.mp3"))
        if mp3s:
            return str(mp3s[0])
        raise RuntimeError("yt-dlp produced no output and no mp3 file found")

    candidate = lines[-1]
    if Path(candidate).exists():
        return candidate

    # The printed name might have the wrong extension — look for mp3
    stem = Path(candidate).stem
    mp3 = output_dir / f"{stem}.mp3"
    if mp3.exists():
        return str(mp3)

    # Last resort: glob
    mp3s = list(output_dir.glob("*.mp3"))
    if mp3s:
        return str(mp3s[0])

    raise RuntimeError(f"yt-dlp finished but no mp3 found. Tried: {candidate}")
