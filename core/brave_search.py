from __future__ import annotations
import logging

import httpx

import config
from core.circuit_breaker import brave_breaker, CircuitOpenError

logger = logging.getLogger(__name__)

_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"


def search_artist(artist: str) -> str:
    """Search Brave for artist musical profile, return concatenated snippets."""
    if not config.BRAVE_API_KEY:
        logger.debug("Brave API key not configured, skipping web search")
        return ""
    try:
        def _get():
            with httpx.Client(timeout=10) as client:
                resp = client.get(
                    _SEARCH_URL,
                    headers={"X-Subscription-Token": config.BRAVE_API_KEY, "Accept": "application/json"},
                    params={"q": f"{artist} band instruments genre musical style vocals", "count": 5},
                )
                resp.raise_for_status()
                return resp.json()
        data = brave_breaker.call(_get)
        results = data.get("web", {}).get("results", [])
        snippets = [r["description"] for r in results[:5] if r.get("description")]
        return " | ".join(snippets)
    except CircuitOpenError:
        return ""
    except Exception as exc:
        logger.warning("Brave search failed for artist '%s': %s", artist, exc)
        return ""
