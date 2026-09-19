from __future__ import annotations
import pathlib
import subprocess

import pytest

from core import tagger

_FFMPEG = pathlib.Path("/usr/bin/ffmpeg")
pytestmark = pytest.mark.skipif(not _FFMPEG.exists(), reason="ffmpeg not available")


def _make_audio(path: pathlib.Path, codec: str) -> pathlib.Path:
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:a", codec, str(path)],
        capture_output=True, text=True, timeout=60, check=True,
    )
    return path


def _meta(**overrides) -> dict:
    meta = {
        "song_name": "Neon Nights",
        "caption": "psytrance, 140 BPM",
        "seed": 42,
        "lyrics": "line one\nline two",
        "submitted_at": "2026-09-17T12:00:00",
        "params": {
            "bpm": 140, "key": "C", "scale": "Minor", "genre": "psytrance",
            "instruments": ["synth", "bass"], "vocal_tags": ["female"],
        },
    }
    meta.update(overrides)
    return meta


class TestMp3Tags:
    def test_defaults_artist_album_year(self, tmp_path):
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "a.mp3", "libmp3lame")
        assert tagger.tag_file(mp3, _meta()) is True
        tags = MP3(mp3).tags
        assert tags.getall("TPE1")[0].text == ["Legion and Nyx"]
        assert tags.getall("TPE2")[0].text == ["Legion and Nyx"]
        assert tags.getall("TALB")[0].text == ["Nyx-Step AI"]
        assert str(tags.getall("TDRC")[0]) == "2026"

    def test_override_top_level(self, tmp_path):
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "b.mp3", "libmp3lame")
        tagger.tag_file(mp3, _meta(artist="David Bowie", album="Ziggy"))
        tags = MP3(mp3).tags
        assert tags.getall("TPE1")[0].text == ["David Bowie"]
        assert tags.getall("TALB")[0].text == ["Ziggy"]

    def test_override_via_params(self, tmp_path):
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "c.mp3", "libmp3lame")
        meta = _meta()
        meta["params"]["artist"] = "Param Artist"
        meta["params"]["album"] = "Param Album"
        tagger.tag_file(mp3, meta)
        tags = MP3(mp3).tags
        assert tags.getall("TPE1")[0].text == ["Param Artist"]
        assert tags.getall("TALB")[0].text == ["Param Album"]

    def test_lyrics_and_musical_tags(self, tmp_path):
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "d.mp3", "libmp3lame")
        tagger.tag_file(mp3, _meta())
        tags = MP3(mp3).tags
        assert str(tags.getall("USLT")[0]) == "line one\nline two"
        assert tags.getall("TBPM")[0].text == ["140"]
        assert tags.getall("TKEY")[0].text == ["C Minor"]
        assert {t.desc for t in tags.getall("TXXX")} == {"Instruments", "Vocal Tags"}

    def test_retag_does_not_duplicate(self, tmp_path):
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "e.mp3", "libmp3lame")
        tagger.tag_file(mp3, _meta())
        tagger.tag_file(mp3, _meta(artist="Solo"))
        tags = MP3(mp3).tags
        assert len(tags.getall("TPE1")) == 1
        assert tags.getall("TPE1")[0].text == ["Solo"]
        assert len(tags.getall("USLT")) == 1


class TestFlacTags:
    def test_flac_fields(self, tmp_path):
        from mutagen.flac import FLAC
        flac = _make_audio(tmp_path / "f.flac", "flac")
        tagger.tag_file(flac, _meta(artist="Legion"))
        audio = FLAC(flac)
        assert audio["artist"] == ["Legion"]
        assert audio["albumartist"] == ["Legion"]
        assert audio["album"] == ["Nyx-Step AI"]
        assert audio["date"] == ["2026"]
        assert audio["lyrics"] == ["line one\nline two"]


class TestEdges:
    def test_no_meta_returns_false(self, tmp_path):
        assert tagger.tag_file(tmp_path / "nope.mp3", None) is False

    def test_unsupported_extension(self, tmp_path):
        p = tmp_path / "x.ogg"
        p.write_bytes(b"junk")
        assert tagger.tag_file(p, _meta()) is False

    def test_year_falls_back_to_now(self, tmp_path):
        from datetime import datetime
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "g.mp3", "libmp3lame")
        meta = _meta()
        del meta["submitted_at"]
        tagger.tag_file(mp3, meta)
        assert str(MP3(mp3).tags.getall("TDRC")[0]) == str(datetime.now().year)

    def test_tag_bytes_returns_bytes(self, tmp_path):
        from mutagen.mp3 import MP3
        mp3 = _make_audio(tmp_path / "h.mp3", "libmp3lame")
        data = tagger.tag_bytes(mp3, _meta())
        assert data and len(data) > 100
        assert MP3(mp3).tags.getall("TPE1") == []  # original untouched
