from __future__ import annotations
import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import config
from core.comfyui import ComfyUIClient

_JOB_TTL_DAYS = 7
_PURGE_INTERVAL = 6 * 3600  # purge every 6 hours

logger = logging.getLogger(__name__)


@dataclass
class JobInfo:
    prompt_id: str
    user_email: str
    song_name: str
    submitted_at: datetime = field(default_factory=datetime.utcnow)
    status: str = "queued"       # queued | running | done | error
    output_files: list[str] = field(default_factory=list)
    error_msg: str = ""
    seed: int = 0
    caption: str = ""
    lyrics: str = ""
    params: dict = field(default_factory=dict)


class JobTracker:

    def __init__(self, poll_interval: int = 3):
        self._jobs: dict[str, JobInfo] = {}
        self._lock = threading.Lock()
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
        with self._lock:
            self._jobs[prompt_id] = JobInfo(
                prompt_id=prompt_id,
                user_email=user_email,
                song_name=song_name,
                seed=seed,
                caption=caption,
                lyrics=lyrics,
                params=params or {},
            )

    def get(self, prompt_id: str) -> JobInfo | None:
        with self._lock:
            return self._jobs.get(prompt_id)

    def update(self, prompt_id: str, **kwargs):
        with self._lock:
            job = self._jobs.get(prompt_id)
            if job:
                for k, v in kwargs.items():
                    setattr(job, k, v)

    def get_user_jobs(self, user_email: str) -> list[JobInfo]:
        with self._lock:
            return [j for j in self._jobs.values() if j.user_email == user_email]

    def get_all_jobs(self) -> list[JobInfo]:
        with self._lock:
            return list(self._jobs.values())

    def user_owns_file(self, user_email: str, filename: str) -> bool:
        with self._lock:
            return any(
                filename in j.output_files and j.user_email == user_email
                for j in self._jobs.values()
            )

    def user_owns(self, user_email: str, prompt_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(prompt_id)
            return job is not None and job.user_email == user_email

    def get_queue_counts(self) -> dict:
        q = self._client.get_queue()
        return {
            "running": len(q.get("queue_running", [])),
            "pending": len(q.get("queue_pending", [])),
        }

    def purge_old_jobs(self):
        cutoff = datetime.utcnow() - timedelta(days=_JOB_TTL_DAYS)
        with self._lock:
            old = [pid for pid, j in self._jobs.items() if j.submitted_at < cutoff]
            for pid in old:
                del self._jobs[pid]
        if old:
            logger.info("Purged %d jobs older than %d days", len(old), _JOB_TTL_DAYS)

    def _write_history(self, job: JobInfo):
        try:
            record = {
                "timestamp": datetime.utcnow().isoformat(),
                "prompt_id": job.prompt_id,
                "song_name": job.song_name,
                "user_email": job.user_email,
                "caption": job.caption,
                "lyrics": job.lyrics,
                "seed": job.seed,
                "output_files": job.output_files,
                "params": job.params,
            }
            with open(config.HISTORY_LOG, "a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as exc:
            logger.warning("Failed to write history log: %s", exc)

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

        with self._lock:
            active = [j for j in self._jobs.values() if j.status in ("queued", "running")]

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
                        with self._lock:
                            completed = self._jobs.get(pid)
                        if completed:
                            self._write_history(completed)
                    else:
                        self.update(pid, status="error", error_msg="No output files in history")
