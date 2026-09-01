"""Shared submission helper for generator routes.

Every generator route (generate / remix / extract / lego / cover / …) ends the
same way: send the built workflow to ComfyUI, fail with a JSON error if it is
unreachable, register the prompt with the job tracker, and return the prompt id
with the current queue position.  This module factors that out so the routes
only keep the parts that actually differ.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

from nyx_step import tracker


def submit_and_register(
    client: Any,
    user_email: str,
    workflow: dict,
    song_name: str,
    *,
    seed: int = 0,
    caption: str = "",
    lyrics: str = "",
    params: dict | None = None,
    include_queue_position: bool = True,
    upstream_error_status: int = 400,
) -> dict | JSONResponse:
    """Send ``workflow`` to ComfyUI and register the resulting prompt.

    Returns ``{"prompt_id": ...}`` (plus ``queue_position`` when requested), or
    a :class:`JSONResponse` error when ComfyUI rejects / drops the submission.
    """
    send_result = client.send_workflow(workflow)
    if "error" in send_result:
        return JSONResponse(
            {"error": "ComfyUI unreachable: " + send_result["error"]},
            status_code=upstream_error_status,
        )

    prompt_id = send_result.get("prompt_id", "")
    tracker.register(
        prompt_id, user_email, song_name,
        seed=seed, caption=caption, lyrics=lyrics, params=params,
    )

    out: dict = {"prompt_id": prompt_id}
    if include_queue_position:
        out["queue_position"] = tracker.get_queue_counts()["pending"]
    return out