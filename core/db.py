from __future__ import annotations
import json
import logging
import pathlib
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)


def utcnow() -> datetime:
    """Naive UTC now — keeps stored ISO format consistent with existing rows."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

_DB_PATH: pathlib.Path | None = None
_local = threading.local()


def init_db(path: pathlib.Path) -> None:
    global _DB_PATH
    _DB_PATH = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                prompt_id   TEXT PRIMARY KEY,
                user_email  TEXT NOT NULL,
                song_name   TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'queued',
                output_files TEXT NOT NULL DEFAULT '[]',
                error_msg   TEXT NOT NULL DEFAULT '',
                seed        INTEGER NOT NULL DEFAULT 0,
                caption     TEXT NOT NULL DEFAULT '',
                lyrics      TEXT NOT NULL DEFAULT '',
                params      TEXT NOT NULL DEFAULT '{}',
                submitted_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_email);
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

            CREATE TABLE IF NOT EXISTS history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_id   TEXT NOT NULL,
                user_email  TEXT NOT NULL,
                song_name   TEXT NOT NULL DEFAULT '',
                caption     TEXT NOT NULL DEFAULT '',
                lyrics      TEXT NOT NULL DEFAULT '',
                seed        INTEGER NOT NULL DEFAULT 0,
                output_files TEXT NOT NULL DEFAULT '[]',
                params      TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_email);
            CREATE INDEX IF NOT EXISTS idx_history_ts   ON history(created_at DESC);
        """)


@contextmanager
def _get_conn():
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield _local.conn
        _local.conn.commit()
    except Exception:
        _local.conn.rollback()
        raise


# ── Job CRUD ──────────────────────────────────────────────────────────────────

def upsert_job(prompt_id: str, user_email: str, song_name: str, seed: int = 0,
               caption: str = "", lyrics: str = "", params: dict | None = None) -> None:
    with _get_conn() as conn:
        conn.execute(
            """INSERT INTO jobs (prompt_id, user_email, song_name, seed, caption, lyrics,
               params, submitted_at) VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(prompt_id) DO NOTHING""",
            (prompt_id, user_email, song_name, seed, caption, lyrics,
             json.dumps(params or {}), utcnow().isoformat()),
        )


def update_job(prompt_id: str, **kwargs) -> None:
    if not kwargs:
        return
    for k in ("output_files", "params"):
        if k in kwargs and isinstance(kwargs[k], (list, dict)):
            kwargs[k] = json.dumps(kwargs[k])
    cols = ", ".join(f"{k}=?" for k in kwargs)
    with _get_conn() as conn:
        conn.execute(f"UPDATE jobs SET {cols} WHERE prompt_id=?",
                     (*kwargs.values(), prompt_id))


def get_job(prompt_id: str) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE prompt_id=?", (prompt_id,)).fetchone()
    return _row_to_job(row) if row else None


def get_user_jobs(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE user_email=? ORDER BY submitted_at DESC", (user_email,)
        ).fetchall()
    return [_row_to_job(r) for r in rows]


def get_active_jobs() -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE status IN ('queued','running')"
        ).fetchall()
    return [_row_to_job(r) for r in rows]


def get_job_by_filename(filename: str) -> dict | None:
    # output_files is a JSON array of strings — match the exact quoted filename
    pattern = "%" + json.dumps(filename) + "%"
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE output_files LIKE ?", (pattern,)
        ).fetchall()
    for row in rows:
        job = _row_to_job(row)
        if filename in job.get("output_files", []):
            return job
    return None


def user_owns_file(user_email: str, filename: str) -> bool:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT output_files FROM jobs WHERE user_email=?", (user_email,)
        ).fetchall()
    return any(filename in json.loads(r["output_files"]) for r in rows)


def user_owns_job(user_email: str, prompt_id: str) -> bool:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM jobs WHERE prompt_id=? AND user_email=?", (prompt_id, user_email)
        ).fetchone()
    return row is not None


def purge_old_jobs(ttl_days: int = 7) -> int:
    cutoff = (utcnow() - timedelta(days=ttl_days)).isoformat()
    with _get_conn() as conn:
        n = conn.execute("DELETE FROM jobs WHERE submitted_at < ?", (cutoff,)).rowcount
    return n


def _row_to_job(row) -> dict:
    d = dict(row)
    d["output_files"] = json.loads(d["output_files"])
    d["params"] = json.loads(d["params"])
    return d


# ── History CRUD ──────────────────────────────────────────────────────────────

def append_history(prompt_id: str, user_email: str, song_name: str, caption: str,
                   lyrics: str, seed: int, output_files: list, params: dict) -> None:
    with _get_conn() as conn:
        conn.execute(
            """INSERT INTO history (prompt_id, user_email, song_name, caption, lyrics,
               seed, output_files, params, created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
            (prompt_id, user_email, song_name, caption, lyrics, seed,
             json.dumps(output_files), json.dumps(params), utcnow().isoformat()),
        )


def get_history_page(user_email: str, limit: int = 20, offset: int = 0) -> tuple[list[dict], bool]:
    fetch = limit + 1
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM history WHERE user_email=?
               ORDER BY created_at DESC LIMIT ? OFFSET ?""",
            (user_email, fetch, offset),
        ).fetchall()
    has_more = len(rows) > limit
    records = []
    for row in rows[:limit]:
        d = dict(row)
        d["output_files"] = json.loads(d["output_files"])
        d["params"] = json.loads(d["params"])
        d.pop("user_email", None)
        records.append(d)
    return records, has_more


def clear_user_history(user_email: str) -> int:
    with _get_conn() as conn:
        n = conn.execute("DELETE FROM history WHERE user_email=?", (user_email,)).rowcount
    return n
