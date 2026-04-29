from __future__ import annotations
import logging
import threading
import time

logger = logging.getLogger(__name__)


class CircuitBreaker:
    """Simple three-state circuit breaker (closed → open → half-open).

    closed:    requests pass through normally
    open:      requests fail immediately (raises CircuitOpenError)
    half-open: one probe request allowed; resets to closed on success
    """

    def __init__(self, name: str, failure_threshold: int = 3, recovery_timeout: float = 30.0):
        self.name = name
        self._threshold = failure_threshold
        self._recovery = recovery_timeout
        self._failures = 0
        self._state = "closed"   # closed | open | half-open
        self._opened_at: float = 0.0
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        with self._lock:
            if self._state == "open" and time.time() - self._opened_at >= self._recovery:
                self._state = "half-open"
            return self._state

    def call(self, fn, *args, **kwargs):
        state = self.state
        if state == "open":
            raise CircuitOpenError(self.name)
        try:
            result = fn(*args, **kwargs)
            with self._lock:
                self._failures = 0
                self._state = "closed"
            return result
        except Exception as exc:
            with self._lock:
                self._failures += 1
                if self._failures >= self._threshold or state == "half-open":
                    self._state = "open"
                    self._opened_at = time.time()
                    logger.warning("Circuit %r opened after %d failures", self.name, self._failures)
            raise


class CircuitOpenError(Exception):
    def __init__(self, name: str):
        super().__init__(f"Circuit '{name}' is open — service unavailable")
        self.circuit_name = name


# Module-level breakers for each external dependency
comfyui_breaker = CircuitBreaker("comfyui", failure_threshold=3, recovery_timeout=30.0)
ollama_breaker  = CircuitBreaker("ollama",  failure_threshold=3, recovery_timeout=20.0)
brave_breaker   = CircuitBreaker("brave",   failure_threshold=2, recovery_timeout=60.0)
