from core.prompt_linter import PromptLinter

_L = PromptLinter()


def _messages(results):
    return [r.message for r in results]


# ── Rule 1: lyrics but no vocal tag ─────────────────────────────────────────

def test_lyrics_without_vocal_tag_tips():
    results = _L.lint("synthwave, retro, 120 BPM", "[Verse]\nDriving through the night")
    assert any("vocal" in m.lower() and "no" in m.lower() for m in _messages(results))


def test_lyrics_with_vocal_tag_no_tip():
    results = _L.lint("synthwave, female vocal", "[Verse]\nDriving through the night")
    assert not any("no vocal" in m.lower() for m in _messages(results))


def test_no_lyrics_no_vocal_tip():
    results = _L.lint("synthwave, retro", "")
    assert not any("no vocal" in m.lower() for m in _messages(results))


# ── Rule 2: structure vs duration ────────────────────────────────────────────

def test_too_many_sections_for_duration_warns():
    lyrics = "\n".join(f"[Verse {i}]\nline" for i in range(8))
    results = _L.lint("rock", lyrics, duration=30)
    assert any("section" in m.lower() and "duration" in m.lower() for m in _messages(results))


def test_sections_fit_duration_no_warning():
    lyrics = "[Verse]\nline\n[Chorus]\nline"
    results = _L.lint("rock", lyrics, duration=120)
    assert not any("duration" in m.lower() for m in _messages(results))


def test_zero_duration_skips_rule():
    lyrics = "\n".join(f"[Verse {i}]\nline" for i in range(8))
    results = _L.lint("rock", lyrics)  # no duration passed
    assert not any("duration" in m.lower() for m in _messages(results))


# ── Rule 3: genre/instrument conflicts ───────────────────────────────────────

def test_acoustic_folk_with_808_conflicts():
    results = _L.lint("acoustic folk, 808 bass, gentle", "")
    assert any("conflict" in m.lower() for m in _messages(results))


def test_orchestral_with_distorted_guitar_conflicts():
    results = _L.lint("orchestral, cinematic, distorted guitar", "")
    assert any("conflict" in m.lower() for m in _messages(results))


def test_no_conflict_clean():
    results = _L.lint("acoustic folk, acoustic guitar, gentle", "")
    assert not any("conflict" in m.lower() for m in _messages(results))


# ── Rule 4: long sung lines ──────────────────────────────────────────────────

def test_long_sung_line_tips():
    long_line = "the incomprehensible magnificent extraordinarily beautiful situation continues forever tonight"
    results = _L.lint("pop, female vocal", f"[Verse]\n{long_line}")
    assert any("syllable" in m.lower() for m in _messages(results))


def test_short_lines_no_tip():
    results = _L.lint("pop, female vocal", "[Verse]\nShort line here\nAnother one")
    assert not any("syllable" in m.lower() for m in _messages(results))


# ── Rule 5: genre position ───────────────────────────────────────────────────

def test_genre_buried_late_tips():
    results = _L.lint("dreamy, warm, reverb, slow build, analog, synthwave", "")
    assert any("genre" in m.lower() and "first" in m.lower() for m in _messages(results))


def test_genre_first_no_tip():
    results = _L.lint("synthwave, dreamy, warm, reverb, analog", "")
    assert not any("first" in m.lower() for m in _messages(results))
