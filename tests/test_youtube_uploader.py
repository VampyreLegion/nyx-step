from __future__ import annotations
import pathlib

import pytest

from core import youtube_uploader as ytu


LRC = """[ti:Test Song]
[ar:Nyx Studios]
[00:00.00]First line here
[00:03.50]Second line
[00:07.20]Third and final
"""


class TestLrcSplit:
    def test_parse_lrc(self):
        lines = ytu._parse_lrc(LRC)
        assert [(t, s) for t, s in lines] == [
            (0.0, "First line here"),
            (3.5, "Second line"),
            (7.2, "Third and final"),
        ]

    def test_skip_metadata_and_empty(self):
        lines = ytu._parse_lrc("[ar:Nyx]\n\n[00:00.00]   \n[00:01.00]real line\n")
        assert lines == [(1.0, "real line")]


class TestAss:
    def test_lrc_to_ass_header(self):
        ass = ytu.lrc_to_ass(LRC)
        assert "[Script Info]" in ass
        assert "Style: Karaoke" in ass
        assert "[Events]" in ass

    def test_lrc_to_ass_dialogue(self):
        ass = ytu.lrc_to_ass(LRC)
        assert "Dialogue: 0,0:00:00.00,0:00:03.50,Karaoke" in ass
        assert "\\k" in ass

    def test_empty_input(self):
        assert ytu.lrc_to_ass("") == ""


class TestSrt:
    def test_lrc_to_srt_blocks(self):
        srt = ytu.lrc_to_srt(LRC)
        assert "1\n00:00:00,000 --> 00:00:03,500\nFirst line here" in srt
        assert "2\n00:00:03,500 --> 00:00:07,200\nSecond line" in srt
        assert "3\n" in srt

    def test_srt_empty(self):
        assert ytu.lrc_to_srt("") == ""


class TestCoverFfmpeg:
    def test_generate_cover_ffmpeg(self, tmp_path):
        out = tmp_path / "cover.png"
        ytu.generate_cover_ffmpeg("dark synthwave, driving bass", "Neon Nights", out)
        assert out.exists()
        assert out.stat().st_size > 1000

    def test_cover_colon_escaping(self):
        # Colons must not break the ffmpeg filter chain
        out = pathlib.Path("/tmp") / "cover_colon.png"
        try:
            ytu.generate_cover_ffmpeg("test: tag: stuff:", "Song: Reborn", out)
            assert out.exists()
        finally:
            out.unlink(missing_ok=True)


@pytest.mark.skipif(
    not pathlib.Path("/usr/bin/ffmpeg").exists(), reason="ffmpeg not available"
)
class TestBuildVideo:
    def test_build_video_with_karaoke(self, tmp_path):
        # Make a tiny mp3 (3s sine) with ffmpeg
        audio = tmp_path / "test.mp3"
        import subprocess
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", str(audio)],
            capture_output=True, text=True, timeout=60, check=True,
        )
        cover = tmp_path / "cover.png"
        ytu.generate_cover_ffmpeg("sine test", "Test", cover)
        ass = tmp_path / "karaoke.ass"
        ass.write_text(ytu.lrc_to_ass(LRC))

        out = tmp_path / "video.mp4"
        ytu.build_video(audio, cover, out, ass)
        assert out.exists()
        assert out.stat().st_size > 5000

    def test_build_video_no_subtitles(self, tmp_path):
        from pathlib import Path
        audio = tmp_path / "test.mp3"
        import subprocess
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", "-c:a", "libmp3lame", str(audio)],
            capture_output=True, text=True, timeout=60, check=True,
        )
        cover = tmp_path / "cover.png"
        ytu.generate_cover_ffmpeg("", "Plain", cover)
        out = tmp_path / "video.mp4"
        ytu.build_video(audio, cover, out)
        assert out.exists()


@pytest.mark.skipif(
    not pathlib.Path("/usr/bin/ffmpeg").exists(), reason="ffmpeg not available"
)
class TestManualPrep:
    def test_prepare_video_without_google(self, tmp_path):
        import subprocess
        audio = tmp_path / "song.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", str(audio)],
            capture_output=True, text=True, timeout=60, check=True,
        )
        audio.with_suffix(".lrc").write_text(LRC, encoding="utf-8")

        out = tmp_path / "manual" / "song.mp4"
        job = {
            "audio_path": str(audio),
            "song_name": "Manual Song",
            "caption": "test tags",
            "lyrics": "",
            "bpm": 120,
            "karaoke": True,
            "ai_cover": False,
        }
        result = ytu.prepare_video_for_manual_upload(job, out)
        assert result == out
        assert out.exists()
        assert out.stat().st_size > 5000
        # SRT sidecar written next to the mp4 for YouTube Studio CC
        assert out.with_suffix(".srt").exists()
        assert "First line here" in out.with_suffix(".srt").read_text(encoding="utf-8")

    def test_prepare_missing_audio_raises(self, tmp_path):
        job = {"audio_path": str(tmp_path / "nope.mp3"), "song_name": "x"}
        with pytest.raises(RuntimeError):
            ytu.prepare_video_for_manual_upload(job, tmp_path / "o.mp4")