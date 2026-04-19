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

_LANG_PATTERN = re.compile(r'\[([a-z]{2,3})\]')
_BRACKET_CONTENT_PATTERN = re.compile(r'\[([^\[\]]*)\]')


def _tokenize_tags(tags: str) -> list[str]:
    return [t.strip() for t in tags.split(",") if t.strip()]


def _find_bracket_contents(lyrics: str) -> list[str]:
    return _BRACKET_CONTENT_PATTERN.findall(lyrics)


class PromptLinter:

    def lint(self, tags: str, lyrics: str) -> list[LintResult]:
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
                    "Supported ACE-Step codes: [zh] [ko] [es] [fr] [de] [ja] [en]",
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
