"""Auto-discovery for route modules.

Every module in this package exposes a FastAPI `router`.  This package walks
its own directory, imports each module, and yields its `router` so the app can
register everything in one place instead of a hand-maintained import list.
"""

from __future__ import annotations

import importlib
import pkgutil
from typing import Iterator

from fastapi import APIRouter


def discover_routers(package_name: str = __name__) -> list[APIRouter]:
    """Return every router exported by modules inside this package.

    Modules whose namespace-colliding name is ``__init__`` are skipped, and a
    module is only included when it actually defines ``router``.
    """
    routers: list[APIRouter] = []
    for mod_info in pkgutil.iter_modules(__path__, prefix=f"{package_name}."):
        mod_name = mod_info.name
        if mod_name.endswith(".__init__"):
            continue
        try:
            module = importlib.import_module(mod_name)
        except Exception:
            continue
        router = getattr(module, "router", None)
        if isinstance(router, APIRouter):
            routers.append(router)
    return routers