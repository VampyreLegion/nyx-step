from __future__ import annotations
import threading
import time
from collections import defaultdict

import config

_windows: dict[str, list[float]] = defaultdict(list)
_lock = threading.Lock()


def check(key: str) -> bool:
    """Sliding-window rate check. Returns True if allowed, False if limited."""
    now = time.time()
    cutoff = now - config.RATE_LIMIT_WINDOW
    with _lock:
        ts = _windows[key]
        _windows[key] = [t for t in ts if t > cutoff]
        if len(_windows[key]) >= config.RATE_LIMIT_MAX:
            return False
        _windows[key].append(now)
        return True
