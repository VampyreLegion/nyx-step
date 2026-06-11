from __future__ import annotations
import re
from dataclasses import dataclass


@dataclass
class LintResult:
    severity: str    # "error" | "warning" | "tip"
    field: str       # "tags" | "lyrics" | "combined"
    message: str
    suggestion: str


_SECTION_KEYWORDS = {
    "solo", "verse", "chorus", "intro", "outro", "bridge",
    "drop", "breakdown", "interlude", "pre-chorus",
}

_TEMPO_SLOW = {"slow", "relaxed", "ambient", "chill", "downtempo"}
_TEMPO_FAST = {"fast", "uptempo", "driving", "energetic", "aggressive"}

_STRUCTURAL_BRACKETS = {
    "intro", "verse", "pre-chorus", "chorus", "bridge", "outro", "interlude",
}

_VALID_LANG_CODES = {"zh", "ko", "es", "fr", "de", "ja", "en"}

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

_LANG_PATTERN = re.compile(r'\[([a-z]{2,3})\]')
_BRACKET_CONTENT_PATTERN = re.compile(r'\[([^\[\]]*)\]')


def _tokenize_tags(tags: str) -> list[str]:
    return [t.strip() for t in tags.split(",") if t.strip()]


def _find_bracket_contents(lyrics: str) -> list[str]:
    return _BRACKET_CONTENT_PATTERN.findall(lyrics)


class PromptLinter:

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

    # ── Tags ──────────────────────────────────────────────────────────────────

    def _lint_tags(self, tags: str, tokens: list[str], results: list[LintResult]) -> None:
        n = len(tokens)

        if n > 15:
            results.append(LintResult(
                "error", "tags",
                f"{n} tag tokens — hard limit exceeded",
                "The model ignores tokens beyond ~15; remove the least important ones",
            ))
        elif n > 12:
            results.append(LintResult(
                "warning", "tags",
                f"{n} tag tokens — above recommended maximum",
                "Trim to 12 or fewer; attention dilutes above this",
            ))
        elif 0 < n < 3:
            results.append(LintResult(
                "tip", "tags",
                f"Only {n} tag token(s) found",
                "Use 5–12 tokens for best results (instrumentation, mood, production, era)",
            ))

        if any("[" in t or "]" in t for t in tokens):
            results.append(LintResult(
                "error", "tags",
                "Bracket syntax found in Tags field",
                "Bracket syntax belongs in the Lyrics field only",
            ))

        for t in tokens:
            tl = t.lower()
            matched = next(
                (kw for kw in _SECTION_KEYWORDS
                 if re.search(r'\b' + re.escape(kw) + r'\b', tl)),
                None,
            )
            if matched:
                results.append(LintResult(
                    "error", "tags",
                    f"Section keyword '{t}' in Tags field",
                    "Use [Brackets] in the Lyrics field for song sections and solos",
                ))
                break

        if any("(" in t or ")" in t for t in tokens):
            results.append(LintResult(
                "error", "tags",
                "Parentheses syntax found in Tags field",
                "(word) harmony/BGV syntax belongs in the Lyrics field",
            ))

        seen: set[str] = set()
        dupes: list[str] = []
        for t in tokens:
            tl = t.lower()
            if tl in seen:
                dupes.append(t)
            seen.add(tl)
        if dupes:
            dupe_str = ", ".join(f"'{d}'" for d in dupes)
            results.append(LintResult(
                "warning", "tags",
                f"Duplicate token(s): {dupe_str}",
                "Remove duplicates to free attention budget for more descriptors",
            ))

        token_set = {t.lower() for t in tokens}
        has_slow = bool(token_set & _TEMPO_SLOW)
        has_fast = bool(token_set & _TEMPO_FAST)
        if has_slow and has_fast:
            results.append(LintResult(
                "warning", "tags",
                "Conflicting tempo descriptors detected",
                "Pick one tempo direction — conflicting cues produce muddy results",
            ))

    # ── Lyrics ────────────────────────────────────────────────────────────────

    def _lint_lyrics(
        self,
        lyrics: str,
        brackets: list[str],
        structural: list[str],
        results: list[LintResult],
    ) -> None:
        if not lyrics.strip():
            return

        if not structural:
            results.append(LintResult(
                "tip", "lyrics",
                "No structural brackets found",
                "Add at least [Verse] and [Chorus] to guide the song's timeline structure",
            ))

        if "[[" in lyrics or "]]" in lyrics:
            results.append(LintResult(
                "error", "lyrics",
                "Nested brackets detected",
                "Brackets cannot be nested — use a single [Tag] per section",
            ))

        opens = lyrics.count("[")
        closes = lyrics.count("]")
        if opens != closes:
            results.append(LintResult(
                "error", "lyrics",
                f"Mismatched brackets: {opens} opening vs {closes} closing",
                "Every [ must have a matching ]",
            ))

        if "[]" in lyrics:
            results.append(LintResult(
                "warning", "lyrics",
                "Empty brackets [] found",
                "Empty brackets have no effect — add content or remove them",
            ))

        bare_solos = [b for b in brackets if b.strip().lower() == "solo"]
        if bare_solos:
            results.append(LintResult(
                "tip", "lyrics",
                "[Solo] found without instrument name",
                "Specify the instrument: e.g. [Guitar Solo] or [Piano Solo]",
            ))

        for code in _LANG_PATTERN.findall(lyrics):
            if code not in _VALID_LANG_CODES:
                results.append(LintResult(
                    "warning", "lyrics",
                    f"Unrecognized language code [{code}]",
                    "Supported Nyx-Step codes: [zh] [ko] [es] [fr] [de] [ja] [en]",
                ))

        if re.search(r'\([^)]+\)', lyrics):
            results.append(LintResult(
                "tip", "lyrics",
                "Parenthetical content found in lyrics",
                "Content in () is stripped before generation — ACE-Step sings everything verbatim",
            ))

        outro_match = re.search(r'\[Outro\]', lyrics, re.IGNORECASE)
        if outro_match:
            after = lyrics[outro_match.end():]
            non_outro_bracket = re.search(
                r'\[(?!(?:outro\]|outro\s))[^\]]+\]', after, re.IGNORECASE
            )
            if non_outro_bracket:
                results.append(LintResult(
                    "warning", "lyrics",
                    "Structural section found after [Outro]",
                    "[Outro] should be the final structural section",
                ))

        for line in lyrics.splitlines():
            words = line.split()
            if len(words) >= 3:
                alpha_words = [w for w in words if w.isalpha()]
                if len(alpha_words) >= 3 and all(w.isupper() for w in alpha_words):
                    excerpt = line[:50] + ("…" if len(line) > 50 else "")
                    results.append(LintResult(
                        "tip", "lyrics",
                        f"Entire line in ALL CAPS: \"{excerpt}\"",
                        "UPPERCASE works best on single words for emphasis, not entire lines",
                    ))
                    break

    # ── Combined ──────────────────────────────────────────────────────────────

    def _lint_combined(
        self,
        tokens: list[str],
        structural: list[str],
        lyrics: str,
        brackets: list[str],
        results: list[LintResult],
    ) -> None:
        if len(tokens) < 3 and len(structural) >= 5:
            results.append(LintResult(
                "warning", "combined",
                "Tags too sparse for the song structure complexity",
                "Add more style, instrument, and mood tokens to match your lyrics structure",
            ))

        if brackets:
            text_between = _BRACKET_CONTENT_PATTERN.sub("", lyrics).strip()
            if not text_between:
                results.append(LintResult(
                    "warning", "combined",
                    "Lyrics has brackets but no content between sections",
                    "Add lyric text or instrument directions between bracket tags",
                ))

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
                f"Genre tag '{tokens[genre_idx]}' is at position {genre_idx + 1} — genre belongs first",
                "Attention favors early tokens — put the genre first, then "
                "instruments, mood, production",
            ))
