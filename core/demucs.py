from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path
from typing import Generator

import config


def run_demucs(
    input_path: Path,
    model: str,
    output_dir: Path = config.DEMUCS_OUTPUT_DIR,
) -> Generator[str, None, None]:
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "demucs",
        "--mp3",
        "-n", model,
        "-o", str(output_dir),
        str(input_path),
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    for line in iter(proc.stdout.readline, ""):
        stripped = line.rstrip()
        if stripped:
            yield stripped
    proc.stdout.close()
    proc.wait()
    if proc.returncode != 0:
        yield f"[error] demucs exited with code {proc.returncode}"
    else:
        track_name = input_path.stem
        stem_dir = output_dir / model / track_name
        if stem_dir.exists():
            stems = sorted(stem_dir.glob("*.mp3")) or sorted(stem_dir.glob("*.wav"))
            yield f"[done] {len(stems)} stems in {stem_dir}"
        else:
            yield f"[warn] stem directory not found: {stem_dir}"
