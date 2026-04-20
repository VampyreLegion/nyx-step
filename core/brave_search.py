from __future__ import annotations
import logging

import requests

import config

logger = logging.getLogger(__name__)

_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
_HEADERS = {
    "X-Subscription-Token": config.BRAVE_API_KEY,
    "Accept": "application/json",
}


def search_artist(artist: str) -> str:
    """Search Brave for artist musical profile, return concatenated snippets."""
    try:
        resp = requests.get(
            _SEARCH_URL,
            headers=_HEADERS,
            params={"q": f"{artist} band instruments genre musical style vocals", "count": 5},
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get("web", {}).get("results", [])
        snippets = [r["description"] for r in results[:5] if r.get("description")]
        return " | ".join(snippets)
    except Exception as exc:
        logger.warning("Brave search failed for artist '%s': %s", artist, exc)
        return ""
