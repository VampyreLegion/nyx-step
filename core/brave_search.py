from __future__ import annotations
import logging

import httpx

import config

logger = logging.getLogger(__name__)

_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"


def search_artist(artist: str) -> str:
    """Search Brave for artist musical profile, return concatenated snippets."""
    if not config.BRAVE_API_KEY:
        logger.debug("Brave API key not configured, skipping web search")
        return ""
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.get(
                _SEARCH_URL,
                headers={"X-Subscription-Token": config.BRAVE_API_KEY, "Accept": "application/json"},
                params={"q": f"{artist} band instruments genre musical style vocals", "count": 5},
            )
            resp.raise_for_status()
            results = resp.json().get("web", {}).get("results", [])
            snippets = [r["description"] for r in results[:5] if r.get("description")]
            return " | ".join(snippets)
    except Exception as exc:
        logger.warning("Brave search failed for artist '%s': %s", artist, exc)
        return ""
