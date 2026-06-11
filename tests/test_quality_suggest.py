import nyx_step  # noqa: F401 — resolves circular import before routes.quality is loaded
from routes.quality import suggest_fixes


def test_quiet_track_suggests_punchy():
    s = suggest_fixes(
        scores={"loudness": 4.0, "dynamics": 8, "spectral": 8, "saturation": 10, "coherence": 9},
        metrics={"lufs": -19.0},
    )
    assert any("punchy" in f.get("add_tags", []) for f in s)


def test_bass_heavy_suggests_bright():
    s = suggest_fixes(
        scores={"loudness": 9, "dynamics": 8, "spectral": 4.0, "saturation": 10, "coherence": 9},
        metrics={"lo_r": 0.55, "mid_r": 0.30, "hi_r": 0.15},
    )
    assert any("bright" in f.get("add_tags", []) for f in s)


def test_treble_heavy_suggests_warm():
    s = suggest_fixes(
        scores={"loudness": 9, "dynamics": 8, "spectral": 4.0, "saturation": 10, "coherence": 9},
        metrics={"lo_r": 0.15, "mid_r": 0.45, "hi_r": 0.40},
    )
    assert any("warm" in f.get("add_tags", []) for f in s)


def test_compressed_suggests_dynamics():
    s = suggest_fixes(
        scores={"loudness": 9, "dynamics": 3.0, "spectral": 8, "saturation": 10, "coherence": 9},
        metrics={"lra": 2.0},
    )
    assert any("dynamic" in " ".join(f.get("add_tags", [])) for f in s)


def test_good_scores_no_suggestions():
    s = suggest_fixes(
        scores={"loudness": 9, "dynamics": 9, "spectral": 9, "saturation": 10, "coherence": 9},
        metrics={},
    )
    assert s == []


def test_every_suggestion_has_text():
    s = suggest_fixes(
        scores={"loudness": 2, "dynamics": 2, "spectral": 2, "saturation": 2, "coherence": 2},
        metrics={"lufs": -25, "lra": 1, "lo_r": 0.6, "mid_r": 0.3, "hi_r": 0.1,
                 "clipped_pct": 1.0, "cv": 1.5, "silence_pct": 30},
    )
    assert s and all(f["text"] for f in s)
