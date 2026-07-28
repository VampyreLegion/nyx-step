from __future__ import annotations
import threading
import time
from collections import defaultdict

import config

_windows: dict[str, list[float]] = defaultdict(list)
_lock = threading.Lock()
_calls_since_purge = 0
_PURGE_EVERY = 200


def _purge_stale(now: float) -> None:
    cutoff = now - config.RATE_LIMIT_WINDOW
    stale = [k for k, ts in _windows.items() if not ts or ts[-1] <= cutoff]
    for k in stale:
        del _windows[k]


def check(key: str) -> bool:
    """Sliding-window rate check. Returns True if allowed, False if limited."""
    global _calls_since_purge
    now = time.time()
    cutoff = now - config.RATE_LIMIT_WINDOW
    with _lock:
        _calls_since_purge += 1
        if _calls_since_purge >= _PURGE_EVERY:
            _purge_stale(now)
            _calls_since_purge = 0
        ts = _windows[key]
        _windows[key] = [t for t in ts if t > cutoff]
        if len(_windows[key]) >= config.RATE_LIMIT_MAX:
            return False
        _windows[key].append(now)
        return True
