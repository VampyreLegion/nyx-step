from __future__ import annotations
import requests
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from nyx_step import tracker, get_user_email
import config

router = APIRouter()


@router.get("/queue")
async def get_queue(request: Request, limit: int = 50, offset: int = 0):
    user_email = get_user_email(request)
    my_jobs = tracker.get_user_jobs(user_email)
    all_jobs = tracker.get_all_jobs()
    counts = tracker.get_queue_counts()
    return {
        "my_jobs": [
            {
                "prompt_id": j.prompt_id,
                "song_name": j.song_name,
                "status": j.status,
                "submitted_at": j.submitted_at.isoformat(),
                "output_files": j.output_files,
                "seed": j.seed,
            }
            for j in my_jobs[offset: offset + limit]
        ],
        "all_jobs": [
            {
                "prompt_id": j.prompt_id,
                "song_name": j.song_name,
                "status": j.status,
            }
            for j in all_jobs[offset: offset + limit]
        ],
        "total_my_jobs": len(my_jobs),
        "total_all_jobs": len(all_jobs),
        "comfyui": counts,
    }


@router.delete("/queue/{prompt_id}")
async def cancel_job(prompt_id: str, request: Request):
    user_email = get_user_email(request)
    job = tracker.get(prompt_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    if job.user_email != user_email:
        return JSONResponse({"error": "Not your job"}, status_code=403)
    if job.status in ("done", "error"):
        return JSONResponse({"error": f"Job already {job.status}"}, status_code=409)

    # Cancel in ComfyUI — delete from running and pending queues
    cancelled = False
    try:
        r = requests.post(f"{config.COMFYUI_URL}/queue", json={"delete": [prompt_id]}, timeout=5)
        cancelled = r.ok
    except Exception:
        pass

    tracker.update(prompt_id, status="error", error_msg="Cancelled by user")
    return {"cancelled": True, "prompt_id": prompt_id, "comfyui_ack": cancelled}
