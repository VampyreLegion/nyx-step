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

            CREATE TABLE IF NOT EXISTS daw_projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT 'Untitled Project',
                data        TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_daw_user ON daw_projects(user_email);

            CREATE TABLE IF NOT EXISTS groove_clips (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT 'Groove',
                file_path   TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_groove_user ON groove_clips(user_email);
        """)
    with _get_conn() as conn:
        try:
            conn.execute("ALTER TABLE history ADD COLUMN quality REAL")
        except sqlite3.OperationalError:
            pass  # column already exists


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


def set_history_quality(filename: str, quality: float) -> None:
    pattern = "%" + json.dumps(filename) + "%"
    with _get_conn() as conn:
        conn.execute(
            "UPDATE history SET quality=? WHERE output_files LIKE ?",
            (quality, pattern),
        )


def get_tag_insights(user_email: str, min_count: int = 2) -> list[dict]:
    """Per-tag generation count and average quality, from scored history rows."""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT caption, quality FROM history WHERE user_email=? AND quality IS NOT NULL",
            (user_email,),
        ).fetchall()
    agg: dict[str, list[float]] = {}
    for row in rows:
        for tag in {t.strip().lower() for t in row["caption"].split(",") if t.strip()}:
            agg.setdefault(tag, []).append(row["quality"])
    out = [
        {"tag": tag, "count": len(vals), "avg_quality": round(sum(vals) / len(vals), 1)}
        for tag, vals in agg.items()
        if len(vals) >= min_count
    ]
    out.sort(key=lambda d: -d["avg_quality"])
    return out


# ── DAW projects ────────────────────────────────────────────────────────────

_DAW_EMPTY = {"version": 1, "tempo": 120, "tracks": []}


def create_daw_project(user_email: str, name: str) -> int:
    now = utcnow().isoformat()
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO daw_projects (user_email, name, data, created_at, updated_at) "
            "VALUES (?,?,?,?,?)",
            (user_email, name, json.dumps(_DAW_EMPTY), now, now),
        )
        return int(cur.lastrowid)


def list_daw_projects(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at FROM daw_projects WHERE user_email=? "
            "ORDER BY updated_at DESC", (user_email,),
        ).fetchall()
    return [{"id": r["id"], "name": r["name"], "updated_at": r["updated_at"]} for r in rows]


def get_daw_project(user_email: str, project_id: int) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM daw_projects WHERE id=? AND user_email=?",
            (project_id, user_email),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["data"] = json.loads(d["data"])
    return d


def update_daw_project(user_email: str, project_id: int, name: str | None = None,
                       data: dict | None = None) -> bool:
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if data is not None:
        sets.append("data=?"); vals.append(json.dumps(data))
    sets.append("updated_at=?"); vals.append(utcnow().isoformat())
    vals.extend([project_id, user_email])
    with _get_conn() as conn:
        cur = conn.execute(
            f"UPDATE daw_projects SET {', '.join(sets)} WHERE id=? AND user_email=?", vals,
        )
        return cur.rowcount > 0


def delete_daw_project(user_email: str, project_id: int) -> bool:
    with _get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM daw_projects WHERE id=? AND user_email=?", (project_id, user_email),
        )
        return cur.rowcount > 0


# ── Groove clips (Groove Lab) ────────────────────────────────────────────────

def insert_groove_clip(user_email: str, name: str, file_path: str) -> int:
    now = utcnow().isoformat()
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO groove_clips (user_email, name, file_path, created_at) VALUES (?,?,?,?)",
            (user_email, name, file_path, now),
        )
        return int(cur.lastrowid)


def get_groove_clips(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, file_path, created_at FROM groove_clips "
            "WHERE user_email=? ORDER BY created_at DESC", (user_email,),
        ).fetchall()
    return [dict(r) for r in rows]
