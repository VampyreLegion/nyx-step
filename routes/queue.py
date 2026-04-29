from __future__ import annotations
from fastapi import APIRouter, Request
from nyx_step import tracker, get_user_email

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
                "user_email": j.user_email,
                "song_name": j.song_name,
                "status": j.status,
            }
            for j in all_jobs[offset: offset + limit]
        ],
        "total_my_jobs": len(my_jobs),
        "total_all_jobs": len(all_jobs),
        "comfyui": counts,
    }
