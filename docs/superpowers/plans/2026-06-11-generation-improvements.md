# Nyx-Step Generation Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eight user-approved improvements to tagging and song creation: quality-score fix suggestions, five new linter rules, artist-profile full apply, negative prompting, golden presets, auto-tag from reference, history insights, and seed A/B compare.

**Architecture:** Backend changes extend existing modules (`core/prompt_linter.py`, `routes/quality.py`, `core/ollama.py`, `core/comfyui.py`, `core/db.py`, `routes/presets.py`, `routes/history.py`, `routes/analyze.py`). Frontend changes extend the existing per-tab JS modules (`static/*.js`) plus one new `static/compare.js`. All backend logic is unit-tested; frontend is verified via the running service on Nyx.

**Tech Stack:** FastAPI, SQLite (WAL), Ollama (gemma4), vanilla JS modules, pytest.

**Conventions:**
- Tests live in `tests/`; run with `python3 -m pytest tests/ -q` from `/home/legion/legionprojects/nyx-step`.
- After backend changes that affect the running service: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health`.
- Frontend cache-busting: when you modify a JS file, bump its `?v=N` in `templates/index.html` (line ~2014-2039).
- Tests needing the Nyx-local ComfyUI tree use the existing `nyx_only` marker defined at the top of `tests/test_core.py`.
- Commit after every task with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Five new linter rules

**Files:**
- Modify: `core/prompt_linter.py`
- Modify: `nyx_step.py` (`_LintRequest` gains `duration`)
- Modify: `static/lint.js` (send duration)
- Modify: `templates/index.html` (bump lint.js version)
- Test: `tests/test_linter_rules.py` (new file)

The five rules:
1. **Lyrics but no vocal tag** (tip) — sung lyrics with no vocal descriptor means the model picks a random voice.
2. **Structure vs duration** (warning) — N structural sections need ≈12s each; warn when `sections × 12 > duration`.
3. **Genre↔instrument conflicts** (warning) — curated conflict pairs.
4. **Long sung lines** (tip) — lines over ~16 estimated syllables get crammed by ACE-Step.
5. **Genre position** (tip) — genre token appearing at index ≥5 wastes attention; genre belongs first.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_linter_rules.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_linter_rules.py -q`
Expected: FAIL — `lint() got an unexpected keyword argument 'duration'` and assertion failures.

- [ ] **Step 3: Implement the rules**

In `core/prompt_linter.py`, add module constants after `_VALID_LANG_CODES`:

```python
_VOCAL_KEYWORDS = {
    "vocal", "vocals", "voice", "choir", "a cappella", "acappella",
    "rap", "spoken word", "soprano", "alto", "tenor", "baritone", "bass vocal",
}

_GENRE_KEYWORDS = {
    "rock", "pop", "jazz", "edm", "hip hop", "hip-hop", "metal", "folk",
    "country", "classical", "electronic", "house", "techno", "trance",
    "blues", "funk", "soul", "r&b", "rnb", "reggae", "ambient", "orchestral",
    "lo-fi", "lofi", "synthwave", "punk", "disco", "dubstep", "drum and bass",
    "gospel", "latin", "ska", "grunge", "indie", "swing", "bluegrass",
}

# (genre keywords, conflicting instrument keywords, label)
_CONFLICT_PAIRS = [
    ({"acoustic", "folk", "unplugged", "bluegrass"},
     {"808", "drum machine", "synthesizer", "vocoder", "dubstep"},
     "acoustic/folk genre with electronic instruments"),
    ({"orchestral", "classical", "chamber", "symphony"},
     {"distorted guitar", "808", "drum machine", "dubstep", "scratching"},
     "orchestral/classical genre with electronic or distorted instruments"),
    ({"lo-fi", "lofi", "chillhop"},
     {"screaming", "blast beats", "distorted guitar"},
     "lo-fi genre with aggressive elements"),
    ({"a cappella", "acappella"},
     {"guitar", "drums", "piano", "synthesizer", "bass", "orchestra"},
     "a cappella with instrument tags"),
]

_SECONDS_PER_SECTION = 12

_SYLLABLE_PATTERN = re.compile(r"[aeiouy]+", re.IGNORECASE)
_MAX_LINE_SYLLABLES = 16


def _estimate_syllables(line: str) -> int:
    return sum(len(_SYLLABLE_PATTERN.findall(w)) for w in line.split())
```

Change the `lint` signature and add three rule dispatchers:

```python
    def lint(self, tags: str, lyrics: str, duration: float = 0.0) -> list[LintResult]:
        results: list[LintResult] = []
        tokens = _tokenize_tags(tags)
        brackets = _find_bracket_contents(lyrics)
        structural = [
            b for b in brackets
            if any(b.strip().lower().startswith(s) for s in _STRUCTURAL_BRACKETS)
        ]

        self._lint_tags(tags, tokens, results)
        self._lint_lyrics(lyrics, brackets, structural, results)
        self._lint_combined(tokens, structural, lyrics, brackets, results)
        self._lint_vocal_presence(tokens, lyrics, results)
        self._lint_structure_duration(structural, duration, results)
        self._lint_conflicts(tokens, results)
        self._lint_line_length(lyrics, results)
        self._lint_genre_position(tokens, results)
        return results
```

Add the five rule methods to the class (after `_lint_combined`):

```python
    # ── New rules ─────────────────────────────────────────────────────────────

    def _lint_vocal_presence(self, tokens, lyrics, results) -> None:
        sung = _BRACKET_CONTENT_PATTERN.sub("", lyrics).strip()
        if not sung:
            return
        joined = " ".join(t.lower() for t in tokens)
        if not any(kw in joined for kw in _VOCAL_KEYWORDS):
            results.append(LintResult(
                "tip", "combined",
                "Lyrics present but no vocal tag found",
                "Add a vocal descriptor (e.g. 'female vocal', 'male vocal', 'choir') "
                "or the model will pick a random voice",
            ))

    def _lint_structure_duration(self, structural, duration, results) -> None:
        if duration <= 0 or len(structural) < 2:
            return
        needed = len(structural) * _SECONDS_PER_SECTION
        if needed > duration:
            results.append(LintResult(
                "warning", "combined",
                f"{len(structural)} sections won't fit a {duration:.0f}s duration",
                f"Sections need ~{_SECONDS_PER_SECTION}s each (~{needed}s total) — "
                f"raise Duration or remove sections",
            ))

    def _lint_conflicts(self, tokens, results) -> None:
        joined = " ".join(t.lower() for t in tokens)
        for genre_kws, instr_kws, label in _CONFLICT_PAIRS:
            if (any(g in joined for g in genre_kws)
                    and any(i in joined for i in instr_kws)):
                results.append(LintResult(
                    "warning", "tags",
                    f"Possible style conflict: {label}",
                    "Mixing these is occasionally intentional — if not, remove one side "
                    "for a cleaner generation",
                ))
                return

    def _lint_line_length(self, lyrics, results) -> None:
        for line in lyrics.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("["):
                continue
            syllables = _estimate_syllables(stripped)
            if syllables > _MAX_LINE_SYLLABLES:
                excerpt = stripped[:50] + ("…" if len(stripped) > 50 else "")
                results.append(LintResult(
                    "tip", "lyrics",
                    f"Line has ~{syllables} syllables: \"{excerpt}\"",
                    f"ACE-Step crams long lines — keep sung lines under "
                    f"~{_MAX_LINE_SYLLABLES} syllables or split them",
                ))
                return

    def _lint_genre_position(self, tokens, results) -> None:
        genre_idx = None
        for i, t in enumerate(tokens):
            tl = t.lower()
            if any(g in tl for g in _GENRE_KEYWORDS):
                genre_idx = i
                break
        if genre_idx is not None and genre_idx >= 5:
            results.append(LintResult(
                "tip", "tags",
                f"Genre tag '{tokens[genre_idx]}' is at position {genre_idx + 1}",
                "Attention favors early tokens — put the genre first, then "
                "instruments, mood, production",
            ))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_linter_rules.py tests/ -q`
Expected: all pass (existing lint tests must not regress).

- [ ] **Step 5: Wire duration through the API**

In `nyx_step.py`, change `_LintRequest` and the `/lint` handler:

```python
class _LintRequest(_BaseModel):
    tags: str = ""
    lyrics: str = ""
    duration: float = 0.0

@app.post("/lint")
async def lint(req: _LintRequest):
    results = _linter.lint(req.tags, req.lyrics, duration=req.duration)
    return {"results": [{"severity": r.severity, "field": r.field,
                         "message": r.message, "suggestion": r.suggestion}
                        for r in results]}
```

In `static/lint.js`, change `lintAndShow` body to send duration:

```javascript
async function lintAndShow(tags, lyrics) {
  const resp = await fetch("/lint", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({tags, lyrics, duration: mwState.duration || 0}),
  });
  const data = await resp.json();
  renderLintResults(data.results);
}
```

In `templates/index.html`, bump `lint.js?v=1` → `lint.js?v=2`.

- [ ] **Step 6: Verify service + commit**

Run: `python3 -m pytest tests/ -q && sudo systemctl restart nyx-step && sleep 2 && curl -s -X POST http://127.0.0.1:8001/lint -H "Content-Type: application/json" -d '{"tags":"dreamy, warm, reverb, slow build, analog, synthwave","lyrics":"[Verse]\nhello","duration":30}'`
Expected: JSON containing the genre-position tip and the no-vocal-tag tip.

```bash
git add core/prompt_linter.py nyx_step.py static/lint.js templates/index.html tests/test_linter_rules.py
git commit -m "feat: five new linter rules (vocal presence, structure/duration, conflicts, line length, genre position)"
```

---

### Task 2: Quality score → fix suggestions with Apply & Retake

**Files:**
- Modify: `routes/quality.py` (raw metrics + `suggest_fixes`)
- Modify: `static/jobs.js` (render suggestions, Apply & Retake button)
- Modify: `templates/index.html` (bump jobs.js version)
- Test: `tests/test_quality_suggest.py` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_quality_suggest.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_quality_suggest.py -q`
Expected: FAIL — `cannot import name 'suggest_fixes'`.

- [ ] **Step 3: Implement metrics collection and suggest_fixes**

In `routes/quality.py`, inside `_score_quality`, add a `metrics` dict alongside `scores`/`details` and populate it in each section (the raw values already exist as locals):

```python
    scores: dict[str, float] = {}
    details: dict[str, str] = {}
    metrics: dict[str, float] = {}
```

In section 1 (loudness), after `details["loudness"] = ...`: `metrics["lufs"] = round(float(lufs), 1)`
In section 2 (dynamics), after `details["dynamics"] = ...`: `metrics["lra"] = round(lra, 1)`
In section 3 (spectral), after `details["spectral"] = ...`:
```python
        metrics["lo_r"], metrics["mid_r"], metrics["hi_r"] = round(float(lo_r), 2), round(float(mid_r), 2), round(float(hi_r), 2)
        metrics["centroid"] = round(float(centroid), 0)
```
In section 4 (saturation), after `details["saturation"] = ...`: `metrics["clipped_pct"] = round(clipped_pct, 3)`
In section 5 (coherence), after `details["coherence"] = ...`:
```python
        metrics["cv"] = round(cv, 2)
        metrics["silence_pct"] = round(silence_pct, 1)
```

Change the return to include suggestions:

```python
    return {
        "composite": round(composite, 1),
        "scores": scores,
        "details": details,
        "grade": "A" if composite >= 8 else "B" if composite >= 6.5 else "C" if composite >= 5 else "D",
        "suggestions": suggest_fixes(scores, metrics),
    }
```

Add `suggest_fixes` as a module-level function above `_score_quality`:

```python
def suggest_fixes(scores: dict, metrics: dict) -> list[dict]:
    """Map low dimension scores to concrete tag/parameter remedies.

    Each suggestion: {"dimension", "text", "add_tags": [...], "param_hint": str}
    add_tags may be empty when the fix is parameter-side only.
    """
    fixes: list[dict] = []

    if scores.get("loudness", 10) < 7:
        lufs = metrics.get("lufs", -14)
        if lufs < -16:
            fixes.append({
                "dimension": "loudness",
                "text": f"Track is quiet ({lufs} LUFS vs −14 target)",
                "add_tags": ["punchy", "powerful"],
                "param_hint": "",
            })
        elif lufs > -12:
            fixes.append({
                "dimension": "loudness",
                "text": f"Track is hot ({lufs} LUFS vs −14 target)",
                "add_tags": ["spacious", "dynamic"],
                "param_hint": "",
            })

    if scores.get("dynamics", 10) < 6:
        fixes.append({
            "dimension": "dynamics",
            "text": f"Over-compressed (LRA ≈ {metrics.get('lra', '?')} LU)",
            "add_tags": ["dynamic", "expressive"],
            "param_hint": "Try CFG 3–4 or sampler euler_ancestral for more variation",
        })

    if scores.get("spectral", 10) < 6:
        lo, hi = metrics.get("lo_r", 0.35), metrics.get("hi_r", 0.20)
        if lo > 0.45:
            fixes.append({
                "dimension": "spectral",
                "text": f"Bass-heavy mix ({lo:.0%} energy below 250 Hz)",
                "add_tags": ["bright", "crisp", "airy"],
                "param_hint": "Consider removing heavy bass instrument tags",
            })
        elif hi > 0.30:
            fixes.append({
                "dimension": "spectral",
                "text": f"Treble-heavy mix ({hi:.0%} energy above 4 kHz)",
                "add_tags": ["warm", "full", "deep bass"],
                "param_hint": "",
            })
        else:
            fixes.append({
                "dimension": "spectral",
                "text": "Unbalanced frequency spectrum",
                "add_tags": ["balanced mix", "full"],
                "param_hint": "",
            })

    if scores.get("saturation", 10) < 8:
        fixes.append({
            "dimension": "saturation",
            "text": f"Clipping detected ({metrics.get('clipped_pct', '?')}% samples)",
            "add_tags": [],
            "param_hint": "Regenerate — clipping is rare and usually seed-specific",
        })

    if scores.get("coherence", 10) < 6:
        if metrics.get("silence_pct", 0) > 20:
            fixes.append({
                "dimension": "coherence",
                "text": f"Excessive silence ({metrics.get('silence_pct')}%)",
                "add_tags": ["continuous", "flowing"],
                "param_hint": "Check structural brackets aren't creating empty sections",
            })
        else:
            fixes.append({
                "dimension": "coherence",
                "text": f"Inconsistent energy (CV {metrics.get('cv', '?')})",
                "add_tags": [],
                "param_hint": "Increase Steps; use er_sde + linear_quadratic",
            })

    return fixes
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_quality_suggest.py tests/ -q`
Expected: all pass.

- [ ] **Step 5: Frontend — render suggestions + Apply & Retake**

In `static/jobs.js`, replace the score-button success branch (`scoreEl.innerHTML = ...` line inside the `qBtn` click handler) with:

```javascript
        const dims = Object.entries(d.scores).map(([k, v]) => `${k} ${v}`).join(" · ");
        let html = `<strong>Quality ${d.grade} (${d.composite}/10)</strong> — ${dims}`;
        if (d.suggestions?.length) {
          const allTags = [...new Set(d.suggestions.flatMap(f => f.add_tags || []))];
          html += d.suggestions.map(f =>
            `<div style="margin-top:3px">💡 ${f.text}` +
            (f.add_tags?.length ? ` — add <i style="color:var(--accent2)">${f.add_tags.join(", ")}</i>` : "") +
            (f.param_hint ? `<br><span style="color:var(--muted)">${f.param_hint}</span>` : "") +
            `</div>`).join("");
          if (allTags.length) {
            html += `<button class="secondary small" style="margin-top:4px;font-size:11px;padding:2px 8px"
                      onclick="applyFixAndRetake('${promptId}', ${JSON.stringify(allTags).replace(/"/g, "&quot;")}, this)">✨ Apply &amp; Retake</button>`;
          }
        }
        scoreEl.innerHTML = html;
```

Add `applyFixAndRetake` next to `retakeJob` (same file, module scope):

```javascript
async function applyFixAndRetake(promptId, addTags, btn) {
  const payload = _jobPayloads[promptId];
  if (!payload) { alert("No stored parameters for this job."); return; }
  if (btn) { btn.disabled = true; btn.textContent = "✨ Retaking…"; }
  try {
    // Same seed isolates the tag change; fetch the actual seed used
    let seed = payload.seed || 0;
    try {
      const files = _jobFiles?.[promptId];
      if (files?.length) {
        const meta = await fetch("/meta/" + encodeURIComponent(files[0])).then(r => r.json());
        if (meta.seed) seed = meta.seed;
      }
    } catch (_) {}
    const existing = payload.tags.split(",").map(t => t.trim().toLowerCase());
    const merged = payload.tags.trim() + ", " +
      addTags.filter(t => !existing.includes(t.toLowerCase())).join(", ");
    const resp = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        ...payload, tags: merged, seed, lock_seed: true,
        song_name: "Fix of " + (payload.song_name || "Untitled"),
      }),
    });
    const data = await resp.json();
    if (data.error) { alert("Retake error: " + data.error); return; }
    _jobPayloads[data.prompt_id] = {...payload, tags: merged, seed, lock_seed: true};
    showToast("Fix retake queued with same seed", "success");
  } catch (e) { alert("Retake error: " + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "✨ Apply & Retake"; } }
}
```

**Note:** check whether `_jobFiles` exists in jobs.js (a map of promptId → files). If it doesn't, capture `files` into a module map where the score button is created (the `files` variable is in scope there): add `_jobFilesByPrompt[promptId] = files;` near the score button creation and declare `const _jobFilesByPrompt = {};` at module top, then use it in `applyFixAndRetake`.

Bump `jobs.js?v=13` → `?v=14` in `templates/index.html`.

- [ ] **Step 6: Verify live + commit**

Run: `python3 -m pytest tests/ -q && sudo systemctl restart nyx-step && sleep 2`
Then: `FNAME=$(sqlite3 nyx_step.db "SELECT json_extract(output_files,'$[0]') FROM jobs WHERE output_files != '[]' LIMIT 1"); curl -s "http://127.0.0.1:8001/quality/$FNAME" | python3 -m json.tool | head -30`
Expected: JSON now contains a `suggestions` array.

```bash
git add routes/quality.py static/jobs.js templates/index.html tests/test_quality_suggest.py
git commit -m "feat: quality score fix suggestions with Apply & Retake (same seed)"
```

---

### Task 3: Artist profile full apply (genre + key + scale)

**Files:**
- Modify: `static/easy.js`
- Modify: `templates/index.html` (bump easy.js version)

No backend change — `lookup_artist` already returns `genre_tag` and `vocal_key`.

- [ ] **Step 1: Extend the apply payload**

In `static/easy.js`, in `_doArtistLookup`, change the Apply button creation to carry genre and vocal_key:

```javascript
    if (allAceTags.length) {
      html += `<button class="secondary small" data-apply-state="${encodeURIComponent(JSON.stringify({instrTags, vocalTags, genreTag, vocalKey: data.vocal_key || ""}))}" data-apply-type="${applyType}" style="margin-top:2px">Apply to state</button>`;
    }
```

- [ ] **Step 2: Apply genre/key/scale in the click handler**

Replace the apply click handler body:

```javascript
    infoEl.querySelector("[data-apply-state]")?.addEventListener("click", e => {
      const {instrTags, vocalTags, genreTag, vocalKey} = JSON.parse(decodeURIComponent(e.target.dataset.applyState));
      const type = e.target.dataset.applyType;
      if (type === "artist") {
        _resetOtherApply("easy-vocal-info");
        mwState.instruments = [...instrTags];
        mwState.vocal_tags = [...vocalTags];
        if (genreTag) mwState.genre = genreTag;
      } else {
        _resetOtherApply("easy-artist-info");
        mwState.instruments = [];
        mwState.vocal_tags = [...vocalTags];
      }
      // Parse "a3-e5, often sings in g major / e minor" → key + scale
      const km = (vocalKey || "").match(/\b([a-g][#♯b♭]?)\s+(major|minor)\b/i);
      if (km) {
        mwState.key = km[1].charAt(0).toUpperCase() + km[1].slice(1).replace("♯", "#");
        mwState.scale = km[2].charAt(0).toUpperCase() + km[2].slice(1).toLowerCase();
        const keyEl = document.getElementById("style-key");
        const scaleEl = document.getElementById("style-scale");
        if (keyEl) keyEl.value = mwState.key;
        if (scaleEl) scaleEl.value = mwState.scale;
      }
      _easyAppliedSource = type;
      document.getElementById("instrument-selected").value = mwState.instruments.join(", ");
      document.getElementById("vocal-selected").value = mwState.vocal_tags.join(", ");
      document.getElementById("overview-tags").value = buildCaption();
      updatePayloadPreview();
      e.target.textContent = "Applied ✓";
      e.target.disabled = true;
    });
```

**Note:** verify `style-scale` option values are capitalized like "Major"/"Minor" (check the `<select id="style-scale">` options in `templates/index.html`) and match the format produced above; adjust capitalization to match the select's option values exactly.

Bump `easy.js?v=2` → `?v=3` in `templates/index.html`.

- [ ] **Step 3: Verify + commit**

Run: `sudo systemctl restart nyx-step` then on the UI (https://music-ai.nyxstudios.net) look up an artist with a known vocal range and click Apply — Key/Scale/Genre fields update.
Headless check: `curl -s http://127.0.0.1:8001/static/easy.js?v=3 | grep -c vocalKey` → expect ≥ 2.

```bash
git add static/easy.js templates/index.html
git commit -m "feat: artist profile apply also sets genre, key, and scale"
```

---

### Task 4: Negative prompting (Avoid field)

**Files:**
- Modify: `core/comfyui.py` (negative conditioning node)
- Modify: `routes/generate.py` (`negative_tags` field)
- Modify: `static/state.js` (mwState default)
- Modify: `static/bindings.js` (bind input)
- Modify: `templates/index.html` (input field + version bumps)
- Test: `tests/test_core.py` (nyx_only — needs the workflow template)

The workflow template wires `ConditioningZeroOut` (node 47) into KSampler's `negative`. When `negative_tags` is set, clone the `TextEncodeAceStepAudio1.5` node with the avoid-tags and rewire KSampler's negative input to it.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_core.py`:

```python
@nyx_only
def test_build_workflow_negative_tags():
    from core.comfyui import ComfyUIClient
    client = ComfyUIClient()
    state = {"negative_tags": "vocals, drums", "bpm": 120, "duration": 30}
    result = client.build_workflow("ambient pad", "", state)
    assert "error" not in result
    wf = result["workflow"]
    assert "neg_encode" in wf
    assert wf["neg_encode"]["inputs"]["tags"] == "vocals, drums"
    assert wf["neg_encode"]["inputs"]["lyrics"] == ""
    ks_id = next(k for k, v in wf.items() if v.get("class_type") == "KSampler")
    assert wf[ks_id]["inputs"]["negative"] == ["neg_encode", 0]


@nyx_only
def test_build_workflow_no_negative_tags_unchanged():
    from core.comfyui import ComfyUIClient
    client = ComfyUIClient()
    result = client.build_workflow("ambient pad", "", {"bpm": 120, "duration": 30})
    assert "error" not in result
    assert "neg_encode" not in result["workflow"]
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_core.py -q -k negative`
Expected: FAIL — `neg_encode` not in workflow.

- [ ] **Step 3: Implement `_apply_negative_tags`**

In `core/comfyui.py`, add a module-level helper next to the other `_apply_*` functions:

```python
def _apply_negative_tags(workflow: dict, state: dict) -> None:
    """Wire an 'avoid' prompt into KSampler's negative conditioning.

    Clones the positive TextEncodeAceStepAudio1.5 node with the negative tags
    (and no lyrics) and points KSampler.negative at it instead of the
    ConditioningZeroOut passthrough.
    """
    neg = (state.get("negative_tags") or "").strip()
    if not neg:
        return
    import copy
    enc_id = _find_node_id(workflow, "TextEncodeAceStepAudio1.5")
    ks_id = _find_node_id(workflow, "KSampler")
    if not enc_id or not ks_id:
        return
    neg_node = copy.deepcopy(workflow[enc_id])
    neg_node["inputs"]["tags"] = neg
    neg_node["inputs"]["lyrics"] = ""
    workflow["neg_encode"] = neg_node
    workflow[ks_id]["inputs"]["negative"] = ["neg_encode", 0]
```

In `build_workflow` (the standard text-to-music builder), call it after the existing `_apply_*` calls complete, immediately before the workflow is returned/sent (read the method body — it ends by returning `{"workflow": workflow, "seed": seed}`; insert `_apply_negative_tags(workflow, state)` just before that return).

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_core.py -q -k negative && python3 -m pytest tests/ -q`
Expected: all pass.

- [ ] **Step 5: API + frontend field**

`routes/generate.py` — add to `GenerateRequest` (after `lora2_scale`):

```python
    negative_tags: str = ""
```

`static/state.js` — add to the `mwState` literal (after `lora2_scale: 1.0,`):

```javascript
  negative_tags: "",
```

`templates/index.html` — find the `param-lora2-scale` input row in the Parameters tab; after that row's closing `</div>` add:

```html
        <div class="field-row">
          <label for="param-negative-tags">🚫 Avoid (negative tags)
            <span class="hint">Comma-separated qualities to steer away from, e.g. "vocals, drums, harsh treble". Experimental — works via CFG negative conditioning.</span>
          </label>
          <input id="param-negative-tags" type="text" placeholder="vocals, muddy bass, distortion">
        </div>
```

**Note:** match the surrounding markup pattern — inspect the neighboring Parameters-tab rows and copy their exact class/structure rather than the generic `field-row` above if they differ.

`static/bindings.js` — add with the other `bind(...)` calls:

```javascript
bind("param-negative-tags", "negative_tags");
```

Also add `negative_tags: "",` to the `defaults` object in the `btn-reset-params` handler and `document.getElementById("param-negative-tags").value = "";` to its DOM resets.

Bump `state.js?v=10` → `?v=11` and `bindings.js?v=12` → `?v=13` in `templates/index.html`.

- [ ] **Step 6: Verify live + commit**

Run: `python3 -m pytest tests/ -q && sudo systemctl restart nyx-step && sleep 2 && curl -s -X POST http://127.0.0.1:8001/generate -H "Content-Type: application/json" -d '{"tags":"ambient","negative_tags":"vocals","duration":30}' | head -c 200`
Expected: a prompt_id (ComfyUI accepts the workflow) — or a clean ComfyUI validation error if ComfyUI rejects the clone (in which case debug the node wiring before committing).

```bash
git add core/comfyui.py routes/generate.py static/state.js static/bindings.js templates/index.html tests/test_core.py
git commit -m "feat: negative prompting via Avoid field (CFG negative conditioning)"
```

---

### Task 5: Golden presets (built-in starter pack)

**Files:**
- Create: `presets_builtin/` — 16 curated `.nyx` files
- Create: `scripts/make_golden_presets.py` (generator, kept for future edits)
- Modify: `routes/presets.py` (merge built-ins, load fallback, delete guard)
- Test: `tests/test_presets_builtin.py` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_presets_builtin.py`:

```python
import json
import pathlib

import config

BUILTIN = pathlib.Path(config._NYX_STEP) / "presets_builtin"


def test_builtin_presets_exist():
    files = list(BUILTIN.glob("*.nyx"))
    assert len(files) >= 16


def test_builtin_presets_valid():
    for p in BUILTIN.glob("*.nyx"):
        d = json.loads(p.read_text())
        assert d["_version"] == 1
        assert d["tags"], f"{p.name} missing tags"
        assert 40 <= d["bpm"] <= 300
        assert d["steps"] >= 1 and d["duration"] >= 30


def test_list_includes_builtin(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    names = client.get("/presets").json()["presets"]
    assert "Golden - Lo-Fi Study" in names


def test_load_builtin(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    d = client.get("/presets/Golden - Lo-Fi Study").json()
    assert d["tags"]


def test_delete_builtin_refused(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from nyx_step import app
    monkeypatch.setattr(config, "PRESETS_DIR", tmp_path)
    client = TestClient(app)
    resp = client.delete("/presets/Golden - Lo-Fi Study")
    assert resp.status_code == 403
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_presets_builtin.py -q`
Expected: FAIL — no `presets_builtin` directory.

- [ ] **Step 3: Generate the 16 golden presets**

Create `scripts/make_golden_presets.py`:

```python
"""Generate the built-in golden preset pack. Run from the repo root:
    python3 scripts/make_golden_presets.py
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "presets_builtin"
OUT.mkdir(exist_ok=True)

BASE = {
    "_version": 1, "lyrics": "", "mode": "", "chords": "", "notes": "",
    "seed": 0, "lock_seed": False, "temperature": 0.85, "top_p": 0.9,
    "top_k": 0, "min_p": 0.0, "audio_format": "mp3", "audio_quality": "V0",
    "vocal_language": "auto", "generate_audio_codes": True, "batch_size": 1,
    "lora_name": "", "lora_scale": 1.0, "lora2_name": "", "lora2_scale": 1.0,
    "sampler_name": "er_sde", "scheduler": "linear_quadratic",
}

# name, tags, genre, bpm, key, scale, time_sig, instruments, vocal_tags, steps, cfg, duration, dit
PRESETS = [
    ("Golden - Lo-Fi Study",
     "lo-fi hip hop, chillhop, vinyl warmth, mellow, jazzy chords, dusty drums, relaxed, late night",
     "Lo-Fi Hip Hop", 82, "D", "Minor", "4/4",
     ["electric piano", "vinyl crackle", "soft drums", "upright bass"], [],
     8, 2.0, 90, "turbo"),
    ("Golden - Synthwave Drive",
     "synthwave, retrowave, 80s, analog synth, neon, driving, nostalgic, gated reverb drums",
     "Synthwave", 105, "A", "Minor", "4/4",
     ["analog synthesizer", "drum machine", "synth bass", "arpeggiator"], [],
     8, 2.0, 120, "turbo"),
    ("Golden - Epic Cinematic",
     "epic orchestral, cinematic, film score, powerful, dramatic, sweeping strings, taiko drums",
     "Cinematic", 95, "D", "Minor", "4/4",
     ["strings", "brass", "taiko drums", "choir", "french horn"], ["choir", "ethereal"],
     30, 7.0, 120, "sft"),
    ("Golden - Jazz Trio Night",
     "jazz trio, late night, smoky club, swing, brushed drums, walking bass, sophisticated",
     "Jazz", 110, "Bb", "Major", "4/4",
     ["piano", "upright bass", "brushed drums"], [],
     30, 7.0, 120, "sft"),
    ("Golden - Festival EDM",
     "edm, big room house, festival, energetic, euphoric, sidechain pump, massive drop",
     "EDM", 128, "F", "Minor", "4/4",
     ["supersaw synth", "kick drum", "synth bass", "white noise riser"], ["female vocal", "powerful"],
     8, 2.0, 120, "turbo"),
    ("Golden - Acoustic Folk",
     "acoustic folk, intimate, warm, fingerpicked guitar, organic, campfire, heartfelt",
     "Folk", 92, "G", "Major", "4/4",
     ["acoustic guitar", "upright bass", "light percussion", "harmonica"], ["male vocal", "warm", "intimate"],
     30, 7.0, 150, "sft"),
    ("Golden - Heavy Metal",
     "heavy metal, aggressive, distorted guitar, double kick, powerful, dark, driving riffs",
     "Metal", 145, "E", "Minor", "4/4",
     ["distorted guitar", "bass guitar", "double kick drums"], ["male vocal", "powerful", "gritty texture"],
     8, 2.5, 150, "turbo"),
    ("Golden - Deep House",
     "deep house, groovy, warm bassline, smooth, four on the floor, soulful, club",
     "House", 122, "A", "Minor", "4/4",
     ["synth bass", "drum machine", "electric piano", "pad"], ["female vocal", "soulful", "smooth"],
     8, 2.0, 180, "turbo"),
    ("Golden - Classical Piano",
     "solo piano, classical, romantic era, expressive, rubato, emotional, concert hall",
     "Classical", 72, "C", "Minor", "3/4",
     ["grand piano"], [],
     50, 7.0, 120, "sft"),
    ("Golden - Reggae Roots",
     "reggae, roots, laid back, skank guitar, dub bass, island, sunny, organ bubble",
     "Reggae", 75, "G", "Major", "4/4",
     ["electric guitar", "bass guitar", "organ", "drums"], ["male vocal", "relaxed"],
     8, 2.0, 150, "turbo"),
    ("Golden - Trap Banger",
     "trap, hard hitting, 808 bass, hi-hat rolls, dark, modern, bouncy",
     "Trap", 140, "F#", "Minor", "4/4",
     ["808 bass", "drum machine", "synthesizer", "bell lead"], ["male vocal", "rap", "confident"],
     8, 2.0, 120, "turbo"),
    ("Golden - Ambient Drift",
     "ambient, atmospheric, ethereal, slow evolving pads, spacious, meditative, no drums",
     "Ambient", 60, "C", "Major", "4/4",
     ["synth pad", "field recordings", "soft piano", "drone"], [],
     30, 5.0, 180, "sft"),
    ("Golden - Funk Groove",
     "funk, groovy, syncopated, slap bass, tight horns, wah guitar, party, 70s",
     "Funk", 108, "E", "Minor", "4/4",
     ["slap bass", "electric guitar", "horn section", "drums", "clavinet"], ["male vocal", "energetic"],
     8, 2.0, 150, "turbo"),
    ("Golden - Country Road",
     "country, americana, twangy guitar, heartland, storytelling, warm, steel guitar",
     "Country", 98, "D", "Major", "4/4",
     ["acoustic guitar", "pedal steel guitar", "bass", "drums", "fiddle"], ["male vocal", "warm"],
     30, 7.0, 165, "sft"),
    ("Golden - R&B Slow Jam",
     "r&b, slow jam, smooth, silky, late night, lush chords, modern soul",
     "R&B", 68, "Eb", "Major", "4/4",
     ["electric piano", "synth bass", "drum machine", "strings"], ["female vocal", "smooth", "breathy", "melismatic"],
     30, 7.0, 165, "sft"),
    ("Golden - Drum and Bass",
     "drum and bass, liquid dnb, rolling breaks, deep sub bass, atmospheric, fast, energetic",
     "Drum and Bass", 174, "A", "Minor", "4/4",
     ["breakbeat drums", "sub bass", "synth pad", "piano"], ["female vocal", "ethereal", "airy tone"],
     8, 2.0, 150, "turbo"),
]

for (name, tags, genre, bpm, key, scale, tsig, instruments, vocals,
     steps, cfg, duration, dit) in PRESETS:
    preset = dict(BASE)
    preset.update({
        "song_name": name, "tags": tags, "genre": genre, "bpm": bpm,
        "key": key, "scale": scale, "time_sig": tsig,
        "instruments": instruments, "vocal_tags": vocals,
        "steps": steps, "cfg_scale": cfg, "duration": duration,
        "dit_model": dit,
    })
    path = OUT / f"{name}.nyx"
    path.write_text(json.dumps(preset, indent=2), encoding="utf-8")
    print("wrote", path.name)
```

Run: `python3 scripts/make_golden_presets.py`
Expected: 16 files written to `presets_builtin/`.

- [ ] **Step 4: Merge built-ins into the presets API**

In `routes/presets.py`, add after `_SAFE`:

```python
BUILTIN_DIR = config._NYX_STEP / "presets_builtin"
```

Replace `list_presets`, `load_preset`, and `delete_preset`:

```python
@router.get("")
async def list_presets():
    files = sorted(config.PRESETS_DIR.glob("*.nyx"), key=lambda p: p.stat().st_mtime, reverse=True)
    user_names = [p.stem for p in files]
    builtin = sorted(p.stem for p in BUILTIN_DIR.glob("*.nyx")) if BUILTIN_DIR.exists() else []
    # User presets first; built-ins that aren't shadowed by a user preset after
    return {"presets": user_names + [b for b in builtin if b not in user_names]}


@router.get("/{name}")
async def load_preset(name: str):
    path = _path(name)
    if not path.exists():
        builtin = BUILTIN_DIR / (_safe_name(name) + ".nyx")
        if builtin.exists():
            return json.loads(builtin.read_text(encoding="utf-8"))
        return JSONResponse({"error": "Not found"}, status_code=404)
    return json.loads(path.read_text(encoding="utf-8"))


@router.delete("/{name}")
async def delete_preset(name: str):
    path = _path(name)
    if path.exists():
        path.unlink()
        return {"deleted": path.stem}
    if (BUILTIN_DIR / (_safe_name(name) + ".nyx")).exists():
        return JSONResponse({"error": "Built-in presets cannot be deleted"}, status_code=403)
    return {"deleted": path.stem}
```

**Note:** `_safe_name` keeps spaces and hyphens, so "Golden - Lo-Fi Study" round-trips.

- [ ] **Step 5: Run tests + commit**

Run: `python3 -m pytest tests/test_presets_builtin.py tests/ -q && sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/presets | python3 -m json.tool | head -25`
Expected: tests pass; preset list includes the 16 Golden entries.

```bash
git add presets_builtin/ scripts/make_golden_presets.py routes/presets.py tests/test_presets_builtin.py
git commit -m "feat: 16 built-in golden presets with curated tag combos"
```

---

### Task 6: Auto-tag from reference audio

**Files:**
- Modify: `core/ollama.py` (`infer_tags`)
- Modify: `routes/analyze.py` (`POST /analyze/suggest-tags`)
- Modify: `static/analyze.js` (Suggest Tags button)
- Modify: `templates/index.html` (button + version bump)
- Test: `tests/test_core.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_core.py`:

```python
def test_infer_tags_parses_json():
    from unittest.mock import patch, MagicMock
    from core.ollama import infer_tags
    fake = MagicMock()
    fake.json.return_value = {"response": '{"tags":"jazz, swing, piano trio","genre":"jazz","mood":"relaxed"}'}
    with patch("core.ollama._post_with_retry", return_value=fake):
        result = infer_tags({"bpm": 110, "key": "Bb", "scale": "Major", "chords": "Bb - Gm - Cm - F"})
    assert result["tags"].startswith("jazz")
    assert result["genre"] == "jazz"


def test_infer_tags_handles_garbage():
    from unittest.mock import patch, MagicMock
    from core.ollama import infer_tags
    fake = MagicMock()
    fake.json.return_value = {"response": "I think this is jazz music!"}
    with patch("core.ollama._post_with_retry", return_value=fake):
        result = infer_tags({"bpm": 110})
    assert "error" in result
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_core.py -q -k infer_tags`
Expected: FAIL — `cannot import name 'infer_tags'`.

- [ ] **Step 3: Implement `infer_tags`**

Add to `core/ollama.py` (after `expand_prompt` — it reuses the same JSON-extraction pattern):

```python
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
```

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_core.py -q -k infer_tags`
Expected: PASS.

- [ ] **Step 5: Add the endpoint**

In `routes/analyze.py`, add (imports at top: `from pydantic import BaseModel`; check existing imports first):

```python
class _SuggestTagsRequest(BaseModel):
    analysis: dict
    model: str = "gemma4:latest"


@router.post("/analyze/suggest-tags")
async def suggest_tags(req: _SuggestTagsRequest):
    from core.ollama import infer_tags
    import asyncio
    from core.executor import get_audio_pool
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(get_audio_pool(), lambda: infer_tags(req.analysis, req.model))
    if "error" in result:
        return JSONResponse({"error": result["error"]}, status_code=502)
    return result
```

**Note:** confirm `JSONResponse` is already imported in `routes/analyze.py`; add the import if missing.

- [ ] **Step 6: Frontend button**

In `static/analyze.js`, after the analysis success branch (`applyBtn.style.display = "";` line), add:

```javascript
    const suggestBtn = document.getElementById("btn-analyze-suggest-tags");
    if (suggestBtn) suggestBtn.style.display = "";
```

At the end of the file add the handler:

```javascript
document.getElementById("btn-analyze-suggest-tags")?.addEventListener("click", async () => {
  if (!_lastAnalysis) return;
  const btn = document.getElementById("btn-analyze-suggest-tags");
  btn.disabled = true; btn.textContent = "🏷 Inferring…";
  try {
    const resp = await fetch("/analyze/suggest-tags", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({analysis: _lastAnalysis}),
    });
    const d = await resp.json();
    if (d.error) { showToast("Tag inference failed: " + d.error, "error"); return; }
    const tagsEl = document.getElementById("overview-tags");
    tagsEl.value = tagsEl.value.trim() ? tagsEl.value.trim() + ", " + d.tags : d.tags;
    if (d.genre) mwState.genre = d.genre;
    updatePayloadPreview();
    showToast("Style tags inferred and added: " + d.tags, "success");
  } catch (e) { showToast("Tag inference failed: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "🏷 Suggest Tags"; }
});
```

In `templates/index.html`, find the Analyze tab's `btn-analyze-apply` button and add a sibling button after it (copy its class/style attributes):

```html
<button id="btn-analyze-suggest-tags" class="secondary" style="display:none">🏷 Suggest Tags</button>
```

Bump `analyze.js?v=4` → `?v=5`.

- [ ] **Step 7: Verify live + commit**

Run: `python3 -m pytest tests/ -q && sudo systemctl restart nyx-step && sleep 2 && curl -s -X POST http://127.0.0.1:8001/analyze/suggest-tags -H "Content-Type: application/json" -d '{"analysis":{"bpm":120,"key":"C","scale":"Major","chords":"C - Am - F - G"}}'`
Expected: JSON with tags/genre/mood (Ollama must be running on Nyx; it is).

```bash
git add core/ollama.py routes/analyze.py static/analyze.js templates/index.html tests/test_core.py
git commit -m "feat: infer style tags from Analyze measurements via Ollama"
```

---

### Task 7: History insights (tag performance from your own data)

**Files:**
- Modify: `core/db.py` (quality column + setter + aggregation)
- Modify: `routes/quality.py` (persist score after computing)
- Modify: `routes/history.py` (`GET /api/history/insights`)
- Modify: `static/history.js` (Insights button + panel)
- Modify: `templates/index.html` (button, panel div, version bump)
- Test: `tests/test_insights.py` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_insights.py`:

```python
import core.db as db


def _seed_history():
    for caption, quality in [
        ("synthwave, dreamy, analog", 8.5),
        ("synthwave, driving, retro", 7.5),
        ("acoustic folk, warm", 4.0),
        ("acoustic folk, gentle", 5.0),
        ("jazz, smooth", None),  # unscored — excluded from averages
    ]:
        db.append_history(
            prompt_id="t-" + caption[:8], user_email="insight@test.com",
            song_name="s", caption=caption, lyrics="", seed=1,
            output_files=[f"f_{abs(hash(caption))}.mp3"], params={},
        )
        if quality is not None:
            db.set_history_quality(f"f_{abs(hash(caption))}.mp3", quality)


def test_set_and_aggregate_quality():
    _seed_history()
    insights = db.get_tag_insights("insight@test.com")
    by_tag = {i["tag"]: i for i in insights}
    assert by_tag["synthwave"]["count"] == 2
    assert by_tag["synthwave"]["avg_quality"] == 8.0
    assert by_tag["acoustic folk"]["avg_quality"] == 4.5
    assert "jazz" not in by_tag  # unscored rows excluded


def test_insights_endpoint():
    from fastapi.testclient import TestClient
    from nyx_step import app
    client = TestClient(app, headers={"Cf-Access-Authenticated-User-Email": "insight@test.com"})
    data = client.get("/api/history/insights").json()
    assert "tags" in data
```

**Note:** TestClient requests originate from "testclient" host, not a trusted proxy — `get_user_email` will return `dev@local`. Check what `request.client.host` is under TestClient (it is `"testclient"`); add `"testclient"` to `_TRUSTED_PROXIES` in `nyx_step.py` so route tests can set identities (it is not a routable address, so this is safe).

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_insights.py -q`
Expected: FAIL — `set_history_quality` doesn't exist.

- [ ] **Step 3: Implement DB layer**

In `core/db.py` `init_db`, after the `executescript`, add the migration guard:

```python
    with _get_conn() as conn:
        try:
            conn.execute("ALTER TABLE history ADD COLUMN quality REAL")
        except sqlite3.OperationalError:
            pass  # column already exists
```

Add functions at the end of the History CRUD section:

```python
def set_history_quality(filename: str, quality: float) -> None:
    pattern = "%" + json.dumps(filename) + "%"
    with _get_conn() as conn:
        conn.execute(
            "UPDATE history SET quality=? WHERE output_files LIKE ?",
            (quality, pattern),
        )


def get_tag_insights(user_email: str, min_count: int = 2) -> list[dict]:
    """Per-tag generation count and average quality, from scored history rows."""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT caption, quality FROM history WHERE user_email=? AND quality IS NOT NULL",
            (user_email,),
        ).fetchall()
    agg: dict[str, list[float]] = {}
    for row in rows:
        for tag in {t.strip().lower() for t in row["caption"].split(",") if t.strip()}:
            agg.setdefault(tag, []).append(row["quality"])
    out = [
        {"tag": tag, "count": len(vals), "avg_quality": round(sum(vals) / len(vals), 1)}
        for tag, vals in agg.items()
        if len(vals) >= min_count
    ]
    out.sort(key=lambda d: -d["avg_quality"])
    return out
```

- [ ] **Step 4: Persist score on compute + endpoint**

In `routes/quality.py` `quality_score` handler, after the `if "error" in result:` check, add:

```python
    try:
        import core.db as db
        db.set_history_quality(filename, result["composite"])
    except Exception:
        pass  # insight storage is best-effort
    return result
```

In `routes/history.py`, add:

```python
@router.get("/api/history/insights")
async def history_insights(request: Request):
    user_email = get_user_email(request)
    tags = db.get_tag_insights(user_email)
    return JSONResponse({
        "tags": tags[:15],
        "weakest": sorted(tags, key=lambda d: d["avg_quality"])[:5],
        "scored_rows": sum(t["count"] for t in tags),
    })
```

- [ ] **Step 5: Run tests**

Run: `python3 -m pytest tests/test_insights.py tests/ -q`
Expected: all pass.

- [ ] **Step 6: Frontend panel**

In `templates/index.html`, find the History tab's Clear All button (search `history`); add next to it:

```html
<button id="btn-history-insights" class="secondary small">📈 Insights</button>
<div id="history-insights" style="display:none;margin:8px 0"></div>
```

In `static/history.js`, append:

```javascript
document.getElementById("btn-history-insights")?.addEventListener("click", async () => {
  const panel = document.getElementById("history-insights");
  panel.style.display = "block";
  panel.textContent = "Crunching…";
  try {
    const d = await fetch("/api/history/insights").then(r => r.json());
    if (!d.tags?.length) {
      panel.innerHTML = "<i style='color:var(--muted)'>No scored generations yet — click 📊 Score on some job cards first; insights build from scored tracks.</i>";
      return;
    }
    const row = t => `<tr><td>${t.tag}</td><td>${t.avg_quality}</td><td>${t.count}</td></tr>`;
    panel.innerHTML =
      `<b>Best-performing tags</b> (from ${d.scored_rows} scored tag uses)` +
      `<table style="font-size:11px;margin:4px 0"><tr><th>Tag</th><th>Avg quality</th><th>Uses</th></tr>` +
      d.tags.map(row).join("") + `</table>` +
      (d.weakest?.length ? `<b>Weakest tags</b><table style="font-size:11px;margin:4px 0">` +
        d.weakest.map(row).join("") + `</table>` : "");
  } catch (e) { panel.textContent = "Insights failed: " + e.message; }
});
```

Bump `history.js?v=2` → `?v=3`.

- [ ] **Step 7: Verify live + commit**

Run: `python3 -m pytest tests/ -q && sudo systemctl restart nyx-step && sleep 2 && curl -s -H "Cf-Access-Authenticated-User-Email: steve.j.petry@gmail.com" http://127.0.0.1:8001/api/history/insights`
Expected: JSON (empty tags list until scores accumulate — correct).

```bash
git add core/db.py routes/quality.py routes/history.py static/history.js templates/index.html nyx_step.py tests/test_insights.py
git commit -m "feat: history insights — per-tag avg quality from scored generations"
```

---

### Task 8: Seed A/B compare

**Files:**
- Create: `static/compare.js`
- Modify: `static/jobs.js` (A/B buttons on job cards)
- Modify: `templates/index.html` (panel div + script tag + version bumps)

Frontend-only — all data (files, seeds, tags) is already available client-side.

- [ ] **Step 1: Create `static/compare.js`**

```javascript
// ── A/B Compare ───────────────────────────────────────────────────────────────
// Pick two finished jobs as A and B; shows side-by-side players + tag diff.
const _abCompare = { A: null, B: null };

function setCompareSlot(slot, promptId, file, name, seed, tags) {
  _abCompare[slot] = { promptId, file, name, seed, tags: tags || "" };
  renderCompare();
}

function _tagTokens(tags) {
  return tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
}

function renderCompare() {
  const panel = document.getElementById("ab-compare-panel");
  if (!panel) return;
  const { A, B } = _abCompare;
  if (!A && !B) { panel.style.display = "none"; return; }
  panel.style.display = "block";

  const col = (slot, j) => {
    if (!j) return `<div style="flex:1;color:var(--muted)">Pick a job as ${slot}</div>`;
    let tagHtml = "";
    if (A && B) {
      const mine = _tagTokens(j.tags);
      const other = _tagTokens(slot === "A" ? B.tags : A.tags);
      tagHtml = mine.map(t =>
        other.includes(t)
          ? `<span style="color:var(--muted)">${t}</span>`
          : `<span style="color:var(--accent2);font-weight:bold">${t}</span>`
      ).join(", ");
    } else {
      tagHtml = `<span style="color:var(--muted)">${j.tags}</span>`;
    }
    return `<div style="flex:1;min-width:0">
      <b>${slot}: ${j.name}</b> <span style="color:var(--muted)">seed ${j.seed}</span><br>
      <audio controls src="/download/${encodeURIComponent(j.file)}" style="width:100%;margin:4px 0"></audio>
      <div style="font-size:11px;word-wrap:break-word">${tagHtml}</div>
    </div>`;
  };

  const sameSeed = A && B && A.seed === B.seed;
  panel.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center">
       <strong>🔬 A/B Compare</strong>
       <span style="font-size:11px;color:${sameSeed ? "var(--success)" : "var(--muted)"}">
         ${A && B ? (sameSeed ? "✓ same seed — differences come from the tags" : "⚠ different seeds — differences may be random") : ""}
       </span>
       <button class="secondary small" style="font-size:11px;padding:2px 8px" onclick="_abCompare.A=null;_abCompare.B=null;renderCompare()">✕ Clear</button>
     </div>
     <div style="display:flex;gap:12px;margin-top:6px">${col("A", A)}${col("B", B)}</div>
     <div style="font-size:10px;color:var(--muted);margin-top:4px">Highlighted tags differ between A and B. Tip: 🎲 lock a seed, change one tag, generate, then compare.</div>`;
}
```

- [ ] **Step 2: Add A/B buttons to job cards**

In `static/jobs.js`, where the Score button is appended (`retakeRow.appendChild(qBtn);`), add after it:

```javascript
    // ── A/B compare buttons ──────────────────────────────────────────────────
    ["A", "B"].forEach(slot => {
      const abBtn = document.createElement("button");
      abBtn.className = "secondary small";
      abBtn.textContent = slot === "A" ? "🅰" : "🅱";
      abBtn.title = `Set this take as side ${slot} in the A/B comparator`;
      abBtn.style.cssText = "font-size:11px;padding:2px 8px;";
      abBtn.addEventListener("click", async () => {
        let seed = _jobPayloads[promptId]?.seed ?? "?";
        try {
          const meta = await fetch("/meta/" + encodeURIComponent(files[0])).then(r => r.json());
          if (meta.seed) seed = meta.seed;
        } catch (_) {}
        const tags = _jobPayloads[promptId]?.tags
          ?? (await fetch("/meta/" + encodeURIComponent(files[0])).then(r => r.json()).catch(() => ({}))).caption
          ?? "";
        setCompareSlot(slot, promptId, files[0], songName || "Untitled", seed, tags);
      });
      retakeRow.appendChild(abBtn);
    });
```

**Note:** confirm the in-scope variable holding the song name at that point in `jobs.js` (it may be `name`, `songName`, or on a `job` object) and the files array variable (`files` is used by the score button — reuse exactly what that code uses).

- [ ] **Step 3: Panel + script registration**

In `templates/index.html`:
- After `<div id="jobs-list"></div>` (line ~87) add:

```html
    <div id="ab-compare-panel" style="display:none;background:var(--panel,#15171f);border:1px solid #2d3041;border-radius:8px;padding:10px;margin:8px 0"></div>
```

- Add the script tag before `jobs.js` (compare.js must load first so `setCompareSlot` exists):

```html
<script src="/static/compare.js?v=1"></script>
```

- Bump `jobs.js?v=…` again.

- [ ] **Step 4: Verify live + commit**

Run: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/static/compare.js?v=1 | head -3 && curl -s http://127.0.0.1:8001/ | grep -c ab-compare-panel`
Expected: compare.js served; panel div present (count 1).
UI check: generate two takes (lock seed, change one tag), press 🅰 on one and 🅱 on the other — side-by-side players with the changed tag highlighted.

```bash
git add static/compare.js static/jobs.js templates/index.html
git commit -m "feat: seed A/B compare — side-by-side takes with tag diff"
```

---

### Final task: full verification + push

- [ ] Run the whole suite: `python3 -m pytest tests/ -q` — expect 42 + ~25 new tests, all passing
- [ ] Restart and smoke-test: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health`
- [ ] Verify each feature live per the task verify steps
- [ ] `git push origin master` and confirm CI goes green (`gh run list --repo VampyreLegion/nyx-step --limit 1`)
- [ ] Bump `/health` version to `3.10.0` in `nyx_step.py` in the final commit
