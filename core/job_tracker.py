from __future__ import annotations
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime

import config
import core.db as db
from core.comfyui import ComfyUIClient

_JOB_TTL_DAYS = 7
_PURGE_INTERVAL = 6 * 3600  # purge every 6 hours

logger = logging.getLogger(__name__)


@dataclass
class JobInfo:
    prompt_id: str
    user_email: str
    song_name: str
    submitted_at: datetime = field(default_factory=db.utcnow)
    status: str = "queued"       # queued | running | done | error
    output_files: list[str] = field(default_factory=list)
    error_msg: str = ""
    seed: int = 0
    caption: str = ""
    lyrics: str = ""
    params: dict = field(default_factory=dict)


def _dict_to_jobinfo(d: dict) -> JobInfo:
    submitted_at = d.get("submitted_at", "")
    try:
        submitted_at = datetime.fromisoformat(submitted_at)
    except (ValueError, TypeError):
        submitted_at = db.utcnow()
    return JobInfo(
        prompt_id=d["prompt_id"],
        user_email=d["user_email"],
        song_name=d.get("song_name", ""),
        submitted_at=submitted_at,
        status=d.get("status", "queued"),
        output_files=d.get("output_files", []),
        error_msg=d.get("error_msg", ""),
        seed=d.get("seed", 0),
        caption=d.get("caption", ""),
        lyrics=d.get("lyrics", ""),
        params=d.get("params", {}),
    )


class JobTracker:

    def __init__(self, poll_interval: int = 3):
        db.init_db(config.DB_PATH)
        self._client = ComfyUIClient()
        self._poll_interval = poll_interval
        self._last_purge = 0.0
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def register(
        self,
        prompt_id: str,
        user_email: str,
        song_name: str,
        seed: int = 0,
        caption: str = "",
        lyrics: str = "",
        params: dict = None,
    ):
        db.upsert_job(
            prompt_id=prompt_id,
            user_email=user_email,
            song_name=song_name,
            seed=seed,
            caption=caption,
            lyrics=lyrics,
            params=params,
        )

    def get(self, prompt_id: str) -> JobInfo | None:
        d = db.get_job(prompt_id)
        return _dict_to_jobinfo(d) if d else None

    def update(self, prompt_id: str, **kwargs):
        db.update_job(prompt_id, **kwargs)

    def get_user_jobs(self, user_email: str) -> list[JobInfo]:
        return [_dict_to_jobinfo(d) for d in db.get_user_jobs(user_email)]

    def get_all_jobs(self) -> list[JobInfo]:
        with db._get_conn() as conn:
            rows = conn.execute("SELECT * FROM jobs").fetchall()
        return [_dict_to_jobinfo(db._row_to_job(r)) for r in rows]

    def user_owns_file(self, user_email: str, filename: str) -> bool:
        return db.user_owns_file(user_email, filename)

    def user_owns(self, user_email: str, prompt_id: str) -> bool:
        return db.user_owns_job(user_email, prompt_id)

    def get_queue_counts(self) -> dict:
        q = self._client.get_queue()
        return {
            "running": len(q.get("queue_running", [])),
            "pending": len(q.get("queue_pending", [])),
        }

    def purge_old_jobs(self):
        n = db.purge_old_jobs(_JOB_TTL_DAYS)
        if n:
            logger.info("Purged %d jobs older than %d days", n, _JOB_TTL_DAYS)

    def _write_history(self, job: JobInfo):
        try:
            db.append_history(
                prompt_id=job.prompt_id,
                user_email=job.user_email,
                song_name=job.song_name,
                caption=job.caption,
                lyrics=job.lyrics,
                seed=job.seed,
                output_files=job.output_files,
                params=job.params,
            )
        except Exception as exc:
            logger.warning("Failed to write history: %s", exc)

    def _poll_loop(self):
        import time
        self.purge_old_jobs()
        self._last_purge = time.time()
        while True:
            try:
                self._poll_once()
            except Exception as exc:
                logger.warning("Poll error: %s", exc)
            time.sleep(self._poll_interval)
            now = time.time()
            if now - self._last_purge >= _PURGE_INTERVAL:
                self.purge_old_jobs()
                self._last_purge = now

    def _poll_once(self):
        q = self._client.get_queue()
        running_ids = {item[1] for item in q.get("queue_running", [])}
        pending_ids = {item[1] for item in q.get("queue_pending", [])}

        active = [_dict_to_jobinfo(d) for d in db.get_active_jobs()]

        for job in active:
            pid = job.prompt_id
            if pid in running_ids:
                self.update(pid, status="running")
            elif pid in pending_ids:
                self.update(pid, status="queued")
            else:
                history = self._client.get_history(pid)
                if history:
                    files = self._client.extract_output_files(history, pid)
                    if not files:
                        files = self._client.find_cached_output_files(history, pid)
                    if files:
                        self.update(pid, status="done", output_files=files)
                        completed = self.get(pid)
                        if completed:
                            self._write_history(completed)
                    else:
                        self.update(pid, status="error", error_msg="No output files in history")
