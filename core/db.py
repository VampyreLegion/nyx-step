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

            CREATE TABLE IF NOT EXISTS tag_presets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL,
                tags        TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tag_presets_user ON tag_presets(user_email);

            CREATE TABLE IF NOT EXISTS song_templates (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL,
                data        TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_song_templates_user ON song_templates(user_email);

            CREATE TABLE IF NOT EXISTS song_versions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                song_name   TEXT NOT NULL,
                version     INTEGER NOT NULL,
                prompt_id   TEXT,
                params      TEXT NOT NULL DEFAULT '{}',
                notes       TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_versions_user_song ON song_versions(user_email, song_name);

            CREATE TABLE IF NOT EXISTS mood_arcs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL,
                data        TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mood_user ON mood_arcs(user_email);

            CREATE TABLE IF NOT EXISTS collections (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email  TEXT NOT NULL,
                name        TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_email);

            CREATE TABLE IF NOT EXISTS collection_items (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                history_id    INTEGER NOT NULL,
                position      INTEGER NOT NULL DEFAULT 0,
                added_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_citems_coll ON collection_items(collection_id);
        """)
    with _get_conn() as conn:
        for stmt in (
            "ALTER TABLE history ADD COLUMN quality REAL",
            "ALTER TABLE history ADD COLUMN bookmarked INTEGER DEFAULT 0",
            "ALTER TABLE history ADD COLUMN notes TEXT DEFAULT ''",
        ):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
    _ensure_builtin_templates()


def _ensure_builtin_templates() -> None:
    """Seed starter templates once (stored under the shared __builtin__ user).
    Also updates existing builtins if the code-side data has changed (e.g. duration caps)."""
    with _get_conn() as conn:
        existing = {}
        for r in conn.execute(
            "SELECT id, name, data FROM song_templates WHERE user_email=?",
            (_BUILTIN_USER,),
        ).fetchall():
            existing[r["name"]] = r
        now = utcnow().isoformat()
        for tpl in BUILTIN_TEMPLATES:
            if tpl["name"] in existing:
                row = existing[tpl["name"]]
                old_data = json.loads(row["data"])
                new_data = tpl["data"]
                if old_data != new_data:
                    conn.execute(
                        "UPDATE song_templates SET data=? WHERE id=?",
                        (json.dumps(new_data), row["id"]),
                    )
                continue
            conn.execute(
                "INSERT INTO song_templates (user_email, name, data, created_at) VALUES (?,?,?,?)",
                (_BUILTIN_USER, tpl["name"], json.dumps(tpl["data"]), now),
            )


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


# ── Tag library (saved tag combos) ───────────────────────────────────────────

def create_tag_preset(user_email: str, name: str, tags: str) -> int:
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO tag_presets (user_email, name, tags, created_at) VALUES (?,?,?,?)",
            (user_email, name, tags, utcnow().isoformat()),
        )
        return int(cur.lastrowid)


def list_tag_presets(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, tags, created_at FROM tag_presets "
            "WHERE user_email=? ORDER BY created_at DESC", (user_email,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_tag_preset(user_email: str, preset_id: int) -> bool:
    with _get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM tag_presets WHERE id=? AND user_email=?", (preset_id, user_email),
        )
        return cur.rowcount > 0


# ── Song templates ───────────────────────────────────────────────────────────

_BUILTIN_USER = "__builtin__"

BUILTIN_TEMPLATES = [
    {
        "name": "5-min Acid House",
        "data": {
            "_version": 1,
            "song_name": "Acid House Journey",
            "tags": "acid house, 128 BPM, A Minor, 4/4 time, tb-303 bassline, acid squelch, four-on-the-floor, filtered pads",
            "genre": "acid house", "bpm": 128, "key": "A", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - iv - VII - III", "notes": "",
            "instruments": ["tb-303 bass", "analog drums", "filter sweep pad"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Chill Lo-Fi Beat",
        "data": {
            "_version": 1,
            "song_name": "Late Night Lo-Fi",
            "tags": "lo-fi hip hop, 75 BPM, F Minor, 4/4 time, dusty vinyl crackle, warm Rhodes chords, mellow swing drums, tape saturation",
            "genre": "lo-fi hip hop", "bpm": 75, "key": "F", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i7 - IV7 - vi7 - V7", "notes": "laid-back swing groove",
            "instruments": ["rhodes piano", "vinyl crackle", "brushed drums", "upright bass"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 180.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Epic Trance Journey",
        "data": {
            "_version": 1,
            "song_name": "Euphoric Ascent",
            "tags": "uplifting trance, 138 BPM, E Minor, 4/4 time, supersaw leads, rolling bassline, euphoric breakdown, sidechain pads, epic build-up",
            "genre": "uplifting trance", "bpm": 138, "key": "E", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "long tension build into euphoric drop",
            "instruments": ["supersaw lead", "rolling bass", "ethereal pad", "trance pluck"],
            "vocal_tags": ["ethereal"],
            "lyrics": "[Intro]\n(instrumental)\n\n[Break]\nRising above the horizon\nWe chase the light together\n\n[Drop]\n(instrumental)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Industrial Techno Banger",
        "data": {
            "_version": 1,
            "song_name": "Steel Foundry",
            "tags": "industrial techno, 132 BPM, G Minor, 4/4 time, distorted kick, metallic percussion, dark atmosphere, relentless drive",
            "genre": "industrial techno", "bpm": 132, "key": "G", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - i - VI - VII", "notes": "punishing kick, mechanical texture",
            "instruments": ["distorted kick", "metallic percussion", "gritty bass", "dark drone"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.2, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.9, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Jazz Vocal Ballad",
        "data": {
            "_version": 1,
            "song_name": "Midnight Confession",
            "tags": "jazz ballad, 72 BPM, Bb Major, 4/4 time, brushed drums, upright bass, smoky club, tender saxophone",
            "genre": "jazz ballad", "bpm": 72, "key": "A#", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "IIm7 - V7 - Imaj7 - VImaj7", "notes": "rubato intro, gentle swing",
            "instruments": ["saxophone", "upright bass", "brushed drums", "grand piano"],
            "vocal_tags": ["smooth", "crooning", "female vocal"],
            "lyrics": "[Verse]\nUnder streetlamp amber glow\nYou whispered soft and slow\n\n[Chorus]\nMidnight found us dancing close\nHolding on to what we know",
            "steps": 8, "cfg_scale": 2.0, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Ambient Soundscape",
        "data": {
            "_version": 1,
            "song_name": "Drift",
            "tags": "ambient soundscape, 60 BPM, C Lydian, slow evolving drones, glassy textures, deep reverb, weightless atmosphere",
            "genre": "ambient", "bpm": 60, "key": "C", "scale": "Major",
            "mode": "Lydian", "time_sig": "4/4",
            "chords": "Imaj7 - IImaj7", "notes": "very slow evolution, no percussion",
            "instruments": ["evolving drone", "glass pad", "shimmer texture"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 1.8, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Drum & Bass Roller",
        "data": {
            "_version": 1,
            "song_name": "Neon Cascade",
            "tags": "liquid drum and bass, 174 BPM, D Minor, 4/4 time, rolling breakbeat, deep sub bass, lush pads, soulful vocal chops",
            "genre": "drum and bass", "bpm": 174, "key": "D", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "fast break with melodic top line",
            "instruments": ["amen break", "deep sub bass", "atmospheric pad", "vocal chop"],
            "vocal_tags": ["soulful", "chopped"],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Synthwave Night Drive",
        "data": {
            "_version": 1,
            "song_name": "Chrome Horizon",
            "tags": "synthwave, 108 BPM, B Minor, 4/4 time, analog arpeggios, gated reverb snare, pulsing bass, retro neon atmosphere",
            "genre": "synthwave", "bpm": 108, "key": "B", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "rolling 16th-note arp, wide stereo",
            "instruments": ["analog synth arp", "gated snare", "retro bass", "pad wash"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Dark Psytrance",
        "data": {
            "_version": 1,
            "song_name": "Third Eye Protocol",
            "tags": "dark psytrance, 148 BPM, F# Minor, 4/4 time, psychedelic acid squelch, driving kick, hypnotic FX, layered textures",
            "genre": "psytrance", "bpm": 148, "key": "F#", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - i - VII - VI", "notes": "trippy acid runs, build and release",
            "instruments": ["acid squelch", "psy kick", "trance lead", "FX sweep"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.2, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.9, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Orchestral Epic",
        "data": {
            "_version": 1,
            "song_name": "Rise of the Fallen",
            "tags": "epic orchestral, 90 BPM, C Minor, 4/4 time, full string section, brass fanfare, cinematic percussion, choir, war drums",
            "genre": "cinematic orchestral", "bpm": 90, "key": "C", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "massive build from solo cello to full orchestra",
            "instruments": ["string section", "brass", "timpani", "war drums", "choir"],
            "vocal_tags": ["epic choir"],
            "lyrics": "[Intro]\n(solo cello)\n\n[Verse]\nFrom ashes we arise\nThrough fire we are forged\n\n[Chorus]\n(sweeping strings)\nRise — we were never fallen\n\n[Outro]\n(full orchestra, fff)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Deep House Sunset",
        "data": {
            "_version": 1,
            "song_name": "Golden Hour",
            "tags": "deep house, 122 BPM, Ab Major, 4/4 time, warm Rhodes chords, groovy bassline, filtered hi-hats, sunset terrace vibes",
            "genre": "deep house", "bpm": 122, "key": "G#", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "Imaj7 - VIm7 - iiim7 - IVmaj7", "notes": "smooth groove, warm low end",
            "instruments": ["rhodes piano", "deep bass", "shaker", "filtered hat"],
            "vocal_tags": ["soft spoken"],
            "lyrics": "[Verse]\nSun setting on the terrace\nGold light on the water\n\n[Chorus]\nStay a little longer\nFeel it in your bones",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Breakbeat Hardcore",
        "data": {
            "_version": 1,
            "song_name": "Rave Architect",
            "tags": "oldskool breakbeat hardcore, 150 BPM, G Minor, 4/4 time, Amen break, piano stab, deep sub, rave stabs, 90s energy",
            "genre": "breakbeat hardcore", "bpm": 150, "key": "G", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - VII - VI", "notes": "chopped breaks, piano breakdown",
            "instruments": ["amen break", "piano stab", "rave stab", "sub bass"],
            "vocal_tags": ["MC hype"],
            "lyrics": "[Drop]\nBass — drop the bass\nFeel it in your chest\n\n[Bridge]\n(piano breakdown)\n\n[Drop]\n(let the breaks roll)",
            "steps": 8, "cfg_scale": 2.0, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.9, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Afrobeat Groove",
        "data": {
            "_version": 1,
            "song_name": "Lagos Sunrise",
            "tags": "afrobeat, 105 BPM, D Major, 4/4 time, talking drum, horn section, funky guitar, polyrhythmic percussion, joyful energy",
            "genre": "afrobeat", "bpm": 105, "key": "D", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "I - IV - V - IV", "notes": "interlocking rhythms, call and response horns",
            "instruments": ["talking drum", "horn section", "funky guitar", "congas", "shekere"],
            "vocal_tags": ["powerful", "group vocals"],
            "lyrics": "[Verse]\nWake up, the sun is calling\nEvery voice is rising tall\n\n[Chorus]\nWe move together\nHeartbeat of the city\n\n[Bridge]\n(horn solo)\n\n[Chorus]\nWe move together",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Minimal Dubstep",
        "data": {
            "_version": 1,
            "song_name": "Hollow Ground",
            "tags": "minimal dubstep, 140 BPM, E Minor, half-time feel, deep wobble bass, sparse drums, dark atmosphere, sub pressure",
            "genre": "dubstep", "bpm": 140, "key": "E", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VII - III - i", "notes": "half-time at 70 BPM feel, heavy sub",
            "instruments": ["wobble bass", "half-time drums", "dark pad", "sub drop"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.2, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Bossa Nova Dream",
        "data": {
            "_version": 1,
            "song_name": "Ipanema Twilight",
            "tags": "bossa nova, 130 BPM, G Major, 4/4 time, nylon guitar, soft brushed snare, warm upright bass, gentle sway",
            "genre": "bossa nova", "bpm": 130, "key": "G", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "Imaj7 - iiim7 - vim7 - IImaj7", "notes": "syncopated guitar pattern, relaxed feel",
            "instruments": ["nylon guitar", "brushed snare", "upright bass", "flute"],
            "vocal_tags": ["soft", "whispered", "female vocal"],
            "lyrics": "[Verse]\nBarefoot on warm sand\nThe tide comes breathing in\n\n[Chorus]\nIpanema twilight\nColors on the wind\n\n[Outro]\n(soft flute solo)",
            "steps": 8, "cfg_scale": 2.0, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Glitch Hop",
        "data": {
            "_version": 1,
            "song_name": "Digital Wobble",
            "tags": "glitch hop, 110 BPM, C Minor, 4/4 time, chopped samples, heavy bass, bitcrushed drums, glitchy stutters",
            "genre": "glitch hop", "bpm": 110, "key": "C", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - iv - V - iv", "notes": "stutter edits, detuned bass hits",
            "instruments": ["glitch drums", "wobble bass", "chopped vocal", "bitcrush FX"],
            "vocal_tags": ["chopped"],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 240.0, "seed": 0, "lock_seed": False,
            "temperature": 0.9, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Reggae Dub",
        "data": {
            "_version": 1,
            "song_name": "Kingston Echo",
            "tags": "reggae dub, 78 BPM, A Minor, 4/4 time, skank guitar, heavy bass, echo delay, drum fill, tropical atmosphere",
            "genre": "reggae dub", "bpm": 78, "key": "A", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VII - III - VII", "notes": "offbeat skank, heavy bassweight",
            "instruments": ["skank guitar", "dub bass", "echo delay", "rimshot"],
            "vocal_tags": ["toasting"],
            "lyrics": "[Verse]\nBassline rolling deep\nEcho through the streets\n\n[Chorus]\nDubwise — everything irie\n\n[Drop]\n(heavy dub breakdown)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Trappy Boi Banger",
        "data": {
            "_version": 1,
            "song_name": "Rollin",
            "tags": "trap, 140 BPM, F Minor, 4/4 time, 808 sub, rolling hi-hats, dark piano, hard-hitting, energetic",
            "genre": "trap", "bpm": 140, "key": "F", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "triplet hi-hat rolls, heavy 808 slides",
            "instruments": ["808 bass", "rolling hi-hats", "dark piano", "clap"],
            "vocal_tags": ["autotune", "ad-libs"],
            "lyrics": "[Verse]\nStack it up, never slow\nRunning up the score\n\n[Chorus]\nRollin — we don't stop\n\n[Verse 2]\nMoney long, pockets fat\nYeah we like it like that",
            "steps": 8, "cfg_scale": 2.0, "duration": 180.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Progressive House Anthem",
        "data": {
            "_version": 1,
            "song_name": "Atlas",
            "tags": "progressive house, 126 BPM, A Minor, 4/4 time, layered pads, euphoric build, filtered arpeggios, festival energy",
            "genre": "progressive house", "bpm": 126, "key": "A", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "slowly evolving layers, long buildup to peak",
            "instruments": ["layered pad", "arpeggiated synth", "driving bass", "crash cymbal"],
            "vocal_tags": ["ethereal"],
            "lyrics": "[Intro]\n(filtered arp, slow build)\n\n[Verse]\nWe carry the light\nThrough every fading night\n\n[Build]\n rising rising rising\n\n[Drop]\n(instrumental peak)\n\n[Outro]\n(filter sweep down)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "French House Disco",
        "data": {
            "_version": 1,
            "song_name": "Daft Playground",
            "tags": "french house, 124 BPM, E Major, 4/4 time, filtered disco loops, funky bass, sidechain compression, upbeat groovy",
            "genre": "french house", "bpm": 124, "key": "E", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "I - V - vi - IV", "notes": "filter sweep intro, funky groove",
            "instruments": ["filtered disco loop", "funky bass", "crisp hi-hats", "clap"],
            "vocal_tags": ["chopped vocal"],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Hardstyle Anthem",
        "data": {
            "_version": 1,
            "song_name": "Freedom",
            "tags": "hardstyle, 150 BPM, F Minor, 4/4 time, distorted kick, euphoric leads, reverse bass, raw energy, festival anthem",
            "genre": "hardstyle", "bpm": 150, "key": "F", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "reverse bass intro, euphoric melody build",
            "instruments": ["distorted kick", "reverse bass", "euphoric lead", "crash"],
            "vocal_tags": ["euphoric"],
            "lyrics": "[Intro]\n(reverse bass build)\n\n[Break]\nClose your eyes and feel the sound\n\n[Drop]\n(instrumental)\n\n[Break 2]\nWe are forever\n\n[Drop]\n(full energy)",
            "steps": 8, "cfg_scale": 2.2, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.9, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Downtempo Trip-Hop",
        "data": {
            "_version": 1,
            "song_name": "Smoke Signal",
            "tags": "trip-hop, 82 BPM, D Minor, 4/4 time, slow breakbeat, dub bass, smoky atmosphere, scratched vinyl, moody cinematic",
            "genre": "trip-hop", "bpm": 82, "key": "D", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i7 - iv7 - VII7 - III", "notes": "slow沉重 groove, vinyl textures",
            "instruments": ["slow breakbeat", "dub bass", "vinyl crackle", "distant piano"],
            "vocal_tags": ["whispered", "female vocal"],
            "lyrics": "[Verse]\nSmoke rising through the window\nCity hums a lullaby\n\n[Chorus]\nHold me in the static\nBetween the wires\n\n[Verse 2]\nEvery signal fading slow\nLost between the lines",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Chiptune 8-Bit",
        "data": {
            "_version": 1,
            "song_name": "Level Up",
            "tags": "chiptune, 140 BPM, C Major, 4/4 time, square wave lead, arpeggiated melodies, retro gaming, upbeat joyful",
            "genre": "chiptune", "bpm": 140, "key": "C", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "I - V - vi - IV", "notes": "fast arps, bouncy square lead",
            "instruments": ["square wave", "triangle bass", "noise percussion", "arp lead"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 180.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Salsa Romántica",
        "data": {
            "_version": 1,
            "song_name": "Corazón de Fuego",
            "tags": "salsa, 95 BPM, Bb Major, 4/4 time, congas, timbales, brass section, piano montuno, romantic passion",
            "genre": "salsa", "bpm": 95, "key": "A#", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "IIm7 - V7 - Imaj7 - VIm7", "notes": "piano montuno pattern, clave rhythm",
            "instruments": ["congas", "timbales", "brass section", "piano montuno", "bongos"],
            "vocal_tags": ["passionate", "male vocal"],
            "lyrics": "[Verse]\nTu mirada me encendió\nFuego en el corazón\n\n[Chorus]\nCorazón de fuego\nBaila conmigo\n\n[Montuno]\n(piano y trombones)\n\n[Chorus]\nCorazón de fuego",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "UK Garage",
        "data": {
            "_version": 1,
            "song_name": "Shuffle Theory",
            "tags": "uk garage, 132 BPM, G Minor, 4/4 time, 2-step shuffle, chopped vocal samples, deep sub bass, skipper drums, night drive energy",
            "genre": "uk garage", "bpm": 132, "key": "G", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VII - III - VI", "notes": "shuffled 2-step pattern, vocal chops",
            "instruments": ["2-step drums", "deep sub", "chopped vocal", "stab pad"],
            "vocal_tags": ["chopped", "pitched up"],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Flamenco Passion",
        "data": {
            "_version": 1,
            "song_name": "Duende",
            "tags": "flamenco, 88 BPM, Phrygian, 4/4 time, nylon guitar rasgueado, palmas, cajón, intense passion, dark beauty",
            "genre": "flamenco", "bpm": 88, "key": "E", "scale": "Major",
            "mode": "Phrygian", "time_sig": "4/4",
            "chords": "i - bII - bIII - i", "notes": "rasgueado strumming, palmas claps, compás cycle",
            "instruments": ["nylon guitar", "palmas", "cajón", "bombo"],
            "vocal_tags": ["passionate", "cante jondo"],
            "lyrics": "[Verse]\nFrom the深 earth I sing\nFire in every word\n\n[Compás]\n(palmas y guitarra)\n\n[Verse]\nDuende — the spirit takes me\n\n[Outro]\n(guitar solo, fade)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Future Bass",
        "data": {
            "_version": 1,
            "song_name": "Luminance",
            "tags": "future bass, 150 BPM, Ab Major, 4/4 time, supersaw chords, vocal chops, heavy sidechain, pitched vocal leads, dreamy",
            "genre": "future bass", "bpm": 150, "key": "G#", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "Imaj7 - VIm7 - IVmaj7 - V", "notes": "wobbly supersaw chords, vocal chop melody",
            "instruments": ["supersaw pad", "vocal chop", "sub bass", "trap snare"],
            "vocal_tags": ["pitched", "chopped"],
            "lyrics": "[Intro]\n(filtered vocal chop)\n\n[Verse]\nLight bending through the glass\nEvery color shifting fast\n\n[Drop]\n(instrumental supersaw)\n\n[Verse 2]\nWe are luminous\nWe are infinite",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Minimal Techno",
        "data": {
            "_version": 1,
            "song_name": "Function",
            "tags": "minimal techno, 128 BPM, D Minor, 4/4 time, stripped percussion, deep groove, hypnotic repetition, subtle evolution, dark club",
            "genre": "minimal techno", "bpm": 128, "key": "D", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - i - i - VII", "notes": "barely-there elements, long subtle builds",
            "instruments": ["click percussion", "sub pulse", "deep stab", "filtered noise"],
            "vocal_tags": [],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Moombahton",
        "data": {
            "_version": 1,
            "song_name": "Fuego Lento",
            "tags": "moombahton, 108 BPM, A Minor, 4/4 time, reggaeton kick pattern, dutch house leads, tropical party, heavy bass",
            "genre": "moombahton", "bpm": 108, "key": "A", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "dembow rhythm, dutch lead stabs",
            "instruments": ["reggaeton kick", "dutch lead", "dembow snare", "sub bass"],
            "vocal_tags": ["party"],
            "lyrics": "[Verse]\nFuego lento, sube el volumen\nLa noche es solo nuestra\n\n[Chorus]\nFuego — fuego — fuego\nBaila con el ritmo\n\n[Drop]\n(dembow drop)\n\n[Chorus]\nFuego — fuego",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Footwork / Juke",
        "data": {
            "_version": 1,
            "song_name": "160BPM",
            "tags": "footwork, 160 BPM, F Minor, 4/4 time, chopped vocal samples, rapid-fire kicks, restless energy, Chicago underground",
            "genre": "footwork", "bpm": 160, "key": "F", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - iv - i - VII", "notes": "rapid chopped repetition, constant motion",
            "instruments": ["808 kick", "chopped vocal", "clap", "sub pulse"],
            "vocal_tags": ["chopped"],
            "lyrics": "",
            "steps": 8, "cfg_scale": 2.0, "duration": 180.0, "seed": 0, "lock_seed": False,
            "temperature": 0.9, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Afro House",
        "data": {
            "_version": 1,
            "song_name": "Ancestral Pulse",
            "tags": "afro house, 122 BPM, F# Minor, 4/4 time, organic percussion, deep bass, spiritual atmosphere, tribal rhythms, hypnotic",
            "genre": "afro house", "bpm": 122, "key": "F#", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "tribal percussion loops, deep spiritual groove",
            "instruments": ["djembe", "talking drum", "deep bass", "shaker", "wood block"],
            "vocal_tags": ["chanting"],
            "lyrics": "[Verse]\nFeel the pulse beneath the earth\nAncestors calling us\n\n[Chorus]\nWe dance to remember\nWe move to survive\n\n[Percussion Break]\n(drums only)\n\n[Chorus]\nAncestral pulse",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Liquid Funk",
        "data": {
            "_version": 1,
            "song_name": "Crystal Current",
            "tags": "liquid funk, 174 BPM, Bb Major, 4/4 time, melodic breaks, lush pads, soulful chords, flowing energy, warm bass",
            "genre": "liquid funk", "bpm": 174, "key": "A#", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "Imaj7 - VIm7 - IVmaj7 - V", "notes": "fast breakbeat with warm melodic top",
            "instruments": ["melodic breakbeat", "warm bass", "rhodes chord", "atmospheric pad"],
            "vocal_tags": ["soulful"],
            "lyrics": "[Verse]\nWater flowing through my veins\nCarrying the melody\n\n[Drop]\n(instrumental warmth)\n\n[Verse 2]\nCrystal clear and neverending\nThis current carries me",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Bassline / Speed Garage",
        "data": {
            "_version": 1,
            "song_name": "Weighty",
            "tags": "speed garage, 135 BPM, E Minor, 4/4 time, wobbly bass, chopped vocal stabs, skipper hats, UK underground, energetic",
            "genre": "speed garage", "bpm": 135, "key": "E", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VII - III - VI", "notes": "wobbly 2-step bass, skip beats",
            "instruments": ["wobble bass", "skipper hats", "vocal stab", "sub low"],
            "vocal_tags": ["MC hype"],
            "lyrics": "[Drop]\nBassline — weighty\n\n[Bridge]\n(skipper breakdown)\n\n[Drop]\nBassline — weighty\n\n[Outro]\n(sub fade)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Electro Swing",
        "data": {
            "_version": 1,
            "song_name": "Speakeasy",
            "tags": "electro swing, 125 BPM, D Major, 4/4 time, vintage swing samples, modern bass, brass stabs, upbeat retro, danceable",
            "genre": "electro swing", "bpm": 125, "key": "D", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "I - vi - IV - V", "notes": "swing rhythm with modern drop",
            "instruments": ["swing drums", "brass stab", "upright bass", "vinyl texture"],
            "vocal_tags": ["vintage female"],
            "lyrics": "[Verse]\nStep into the speakeasy\nWhere the old meets the new\n\n[Chorus]\nSwing that body\nFeel the rhythm take control\n\n[Drop]\n(electro drop)\n\n[Chorus]\nSwing that body",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Witch House",
        "data": {
            "_version": 1,
            "song_name": "Void Temple",
            "tags": "witch house, 130 BPM, C# Minor, 4/4 time, detuned synths, pitched-down vocals, dark reverb, occult atmosphere, ethereal",
            "genre": "witch house", "bpm": 130, "key": "C#", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "slow dark reverb-drenched textures",
            "instruments": ["detuned synth", "pitched vocal", "dark reverb pad", "tape hiss"],
            "vocal_tags": ["pitched down", "reverb-drenched"],
            "lyrics": "[Verse]\nIn the temple of the void\nWhere shadows come alive\n\n[Chorus]\nWe are the witches\nOf the digital night\n\n[Outro]\n(ambient fade into static)",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Dancehall",
        "data": {
            "_version": 1,
            "song_name": "Baddest",
            "tags": "dancehall, 100 BPM, A Minor, 4/4 time, dembow rhythm, heavy 808, toasting vocals, Caribbean energy, party anthem",
            "genre": "dancehall", "bpm": 100, "key": "A", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VII - III - VII", "notes": "dembow riddim, sparse hard-hitting",
            "instruments": ["dembow drum", "808 sub", "synth stab", "rimshot"],
            "vocal_tags": ["toasting", "patois"],
            "lyrics": "[Verse]\nStep up inna di place\nDi bassline shake di place\n\n[Chorus]\nWe di baddest — nobody test\n\n[Verse 2]\nFrom di morning to di night\nDi rhythm feel so right\n\n[Chorus]\nWe di baddest",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Darkwave",
        "data": {
            "_version": 1,
            "song_name": "Obsidian",
            "tags": "darkwave, 118 BPM, D Minor, 4/4 time, gothic synth, deep bass, mournful melody, post-punk energy, cold beauty",
            "genre": "darkwave", "bpm": 118, "key": "D", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - iv - v - i", "notes": "cold analog textures, driving bass",
            "instruments": ["analog synth", "driving bass", "gothic pad", "drum machine"],
            "vocal_tags": ["haunting", "baritone"],
            "lyrics": "[Verse]\nObsidian skies above\nCold light on the sea\n\n[Chorus]\nWe dance in the darkness\nWhere shadows are free\n\n[Bridge]\n(synth solo)\n\n[Chorus]\nWe dance in the darkness",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Samba Electronica",
        "data": {
            "_version": 1,
            "song_name": "Carnival Circuit",
            "tags": "samba electronica, 130 BPM, G Major, 4/4 time, surdo kick, electronic whistles, tropical synths, carnival energy, festive",
            "genre": "samba electronica", "bpm": 130, "key": "G", "scale": "Major",
            "mode": "", "time_sig": "4/4",
            "chords": "I - IV - V - IV", "notes": "fast samba beat with electronic layers",
            "instruments": ["surdo", "caixa", "electronic whistle", "tropical synth", "pandeiro"],
            "vocal_tags": ["group vocals", "celebratory"],
            "lyrics": "[Verse]\nFeel the rhythm of the circuit\nCarnival is here\n\n[Chorus]\nSamba —电子 — samba\nDance until the morning\n\n[Percussion Break]\n(surdo and whistles)\n\n[Chorus]\nSamba —电子 — samba",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
    {
        "name": "Baile Funk",
        "data": {
            "_version": 1,
            "song_name": "Favela Beats",
            "tags": "baile funk, 130 BPM, E Minor, 4/4 time, tuntzão beat, heavy bass, raw energy, favela vibes, percussive vocal chops",
            "genre": "baile funk", "bpm": 130, "key": "E", "scale": "Minor",
            "mode": "", "time_sig": "4/4",
            "chords": "i - VI - III - VII", "notes": "tuntzão rhythm, raw lo-fi texture",
            "instruments": ["tuntzão drum", "heavy 808", "vocal chop", "metallic stab"],
            "vocal_tags": ["aggressive", "chopped"],
            "lyrics": "[Verse]\nFavela beat — feeling heat\nBass so deep — can't compete\n\n[Chorus]\nBaile — baile — baile\n\n[Drop]\n(tuntzão drop)\n\n[Chorus]\nBaile — baile — baile",
            "steps": 8, "cfg_scale": 2.0, "duration": 300.0, "seed": 0, "lock_seed": False,
            "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        },
    },
]


def _row_to_template(row) -> dict:
    d = dict(row)
    d["data"] = json.loads(d["data"])
    d["builtin"] = d["user_email"] == _BUILTIN_USER
    d.pop("user_email", None)
    return d


def create_song_template(user_email: str, name: str, data: dict) -> int:
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO song_templates (user_email, name, data, created_at) VALUES (?,?,?,?)",
            (user_email, name, json.dumps(data), utcnow().isoformat()),
        )
        return int(cur.lastrowid)


def list_song_templates(user_email: str) -> list[dict]:
    """User templates first, then the built-in starter kit."""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, data, user_email, created_at FROM song_templates "
            "WHERE user_email=? OR user_email=? ORDER BY created_at DESC",
            (user_email, _BUILTIN_USER),
        ).fetchall()
    items = [_row_to_template(r) for r in rows]
    items.sort(key=lambda d: d["builtin"])  # own templates above built-ins
    return items


def get_song_template_for_apply(user_email: str, template_id: int) -> dict | None:
    """Apply is read-only, so built-in templates are usable by everyone."""
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, data, user_email, created_at FROM song_templates "
            "WHERE id=? AND user_email IN (?, ?)",
            (template_id, user_email, _BUILTIN_USER),
        ).fetchone()
    return _row_to_template(row) if row else None


def delete_song_template(user_email: str, template_id: int) -> bool:
    # Built-ins are shared — scoped to the requesting user, so they never match.
    with _get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM song_templates WHERE id=? AND user_email=?",
            (template_id, user_email),
        )
        return cur.rowcount > 0


# ── Favorites / bookmarks ────────────────────────────────────────────────────

def get_bookmarked_history(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM history WHERE user_email=? AND bookmarked=1 "
            "ORDER BY created_at DESC", (user_email,),
        ).fetchall()
    records = []
    for row in rows:
        d = dict(row)
        d["output_files"] = json.loads(d["output_files"])
        d["params"] = json.loads(d["params"])
        d.pop("user_email", None)
        records.append(d)
    return records


def toggle_history_bookmark(user_email: str, record_id: int) -> bool | None:
    """Flip bookmark state. Returns new state, or None if the record isn't the user's."""
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT bookmarked FROM history WHERE id=? AND user_email=?",
            (record_id, user_email),
        ).fetchone()
        if not row:
            return None
        new_val = 0 if row["bookmarked"] else 1
        conn.execute("UPDATE history SET bookmarked=? WHERE id=?", (new_val, record_id))
        return bool(new_val)


def update_history_notes(user_email: str, record_id: int, notes: str) -> bool:
    with _get_conn() as conn:
        cur = conn.execute(
            "UPDATE history SET notes=? WHERE id=? AND user_email=?",
            (notes, record_id, user_email),
        )
        return cur.rowcount > 0


# ── Song versions ────────────────────────────────────────────────────────────

def get_history_record(user_email: str, record_id: int) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM history WHERE id=? AND user_email=?", (record_id, user_email),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["output_files"] = json.loads(d["output_files"])
    d["params"] = json.loads(d["params"])
    d.pop("user_email", None)
    return d


def save_song_version(user_email: str, song_name: str, prompt_id: str | None,
                      params: dict, notes: str = "") -> int:
    now = utcnow().isoformat()
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM song_versions "
            "WHERE user_email=? AND song_name=?",
            (user_email, song_name),
        ).fetchone()
        next_version = row["v"] + 1
        cur = conn.execute(
            """INSERT INTO song_versions (user_email, song_name, version, prompt_id,
               params, notes, created_at) VALUES (?,?,?,?,?,?,?)""",
            (user_email, song_name, next_version, prompt_id,
             json.dumps(params), notes, now),
        )
        return int(cur.lastrowid)


def list_song_versions(user_email: str, song_name: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, song_name, version, prompt_id, params, notes, created_at "
            "FROM song_versions WHERE user_email=? AND song_name=? ORDER BY version",
            (user_email, song_name),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["params"] = json.loads(d["params"])
        d.pop("user_email", None)
        out.append(d)
    return out


def get_song_version(user_email: str, version_id: int) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM song_versions WHERE id=? AND user_email=?",
            (version_id, user_email),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["params"] = json.loads(d["params"])
    d.pop("user_email", None)
    return d


def list_versioned_songs(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT song_name, COUNT(*) AS n_versions, MAX(created_at) AS last_at "
            "FROM song_versions WHERE user_email=? GROUP BY song_name "
            "ORDER BY last_at DESC",
            (user_email,),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Mood arcs ────────────────────────────────────────────────────────────────

def create_mood_arc(user_email: str, name: str, data: list[dict]) -> int:
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO mood_arcs (user_email, name, data, created_at) VALUES (?,?,?,?)",
            (user_email, name, json.dumps(data), utcnow().isoformat()),
        )
        return int(cur.lastrowid)


def list_mood_arcs(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, data, created_at FROM mood_arcs "
            "WHERE user_email=? ORDER BY created_at DESC",
            (user_email,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = json.loads(d["data"])
        out.append(d)
    return out


def delete_mood_arc(user_email: str, arc_id: int) -> bool:
    with _get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM mood_arcs WHERE id=? AND user_email=?", (arc_id, user_email),
        )
        return cur.rowcount > 0


# ── Collections / playlists ──────────────────────────────────────────────────

def create_collection(user_email: str, name: str, description: str = "") -> int:
    with _get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO collections (user_email, name, description, created_at) VALUES (?,?,?,?)",
            (user_email, name, description, utcnow().isoformat()),
        )
        return int(cur.lastrowid)


def list_collections(user_email: str) -> list[dict]:
    with _get_conn() as conn:
        rows = conn.execute(
            """SELECT c.id, c.name, c.description, c.created_at,
                      COUNT(ci.id) AS item_count
               FROM collections c
               LEFT JOIN collection_items ci ON ci.collection_id = c.id
               WHERE c.user_email=?
               GROUP BY c.id ORDER BY c.created_at DESC""",
            (user_email,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d.pop("user_email", None)
        out.append(d)
    return out


def get_collection(user_email: str, collection_id: int) -> dict | None:
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, description, created_at FROM collections "
            "WHERE id=? AND user_email=?",
            (collection_id, user_email),
        ).fetchone()
    return dict(row) if row else None


def update_collection(user_email: str, collection_id: int, name: str | None = None,
                      description: str | None = None) -> bool:
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if description is not None:
        sets.append("description=?"); vals.append(description)
    if not sets:
        return False
    vals.extend([collection_id, user_email])
    with _get_conn() as conn:
        cur = conn.execute(
            f"UPDATE collections SET {', '.join(sets)} WHERE id=? AND user_email=?", vals,
        )
        return cur.rowcount > 0


def delete_collection(user_email: str, collection_id: int) -> bool:
    with _get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM collections WHERE id=? AND user_email=?",
            (collection_id, user_email),
        )
        if cur.rowcount == 0:
            return False
        conn.execute("DELETE FROM collection_items WHERE collection_id=?", (collection_id,))
        return True


def add_collection_item(user_email: str, collection_id: int, history_id: int) -> int | None:
    """Append a history item; returns item id, or None if not owned / duplicate."""
    with _get_conn() as conn:
        coll = conn.execute(
            "SELECT 1 FROM collections WHERE id=? AND user_email=?",
            (collection_id, user_email),
        ).fetchone()
        if not coll:
            return None
        hist = conn.execute(
            "SELECT 1 FROM history WHERE id=? AND user_email=?",
            (history_id, user_email),
        ).fetchone()
        if not hist:
            return None
        dup = conn.execute(
            "SELECT 1 FROM collection_items WHERE collection_id=? AND history_id=?",
            (collection_id, history_id),
        ).fetchone()
        if dup:
            return None
        row = conn.execute(
            "SELECT COALESCE(MAX(position), -1) AS p FROM collection_items WHERE collection_id=?",
            (collection_id,),
        ).fetchone()
        cur = conn.execute(
            "INSERT INTO collection_items (collection_id, history_id, position, added_at) "
            "VALUES (?,?,?,?)",
            (collection_id, history_id, row["p"] + 1, utcnow().isoformat()),
        )
        return int(cur.lastrowid)


def remove_collection_item(user_email: str, collection_id: int, item_id: int) -> bool:
    with _get_conn() as conn:
        owned = conn.execute(
            "SELECT 1 FROM collections WHERE id=? AND user_email=?",
            (collection_id, user_email),
        ).fetchone()
        if not owned:
            return False
        cur = conn.execute(
            "DELETE FROM collection_items WHERE id=? AND collection_id=?",
            (item_id, collection_id),
        )
        return cur.rowcount > 0


def reorder_collection_items(user_email: str, collection_id: int,
                             item_ids: list[int]) -> bool:
    """Set positions to match the given item-id order. Ids not in the list keep position."""
    with _get_conn() as conn:
        owned = conn.execute(
            "SELECT 1 FROM collections WHERE id=? AND user_email=?",
            (collection_id, user_email),
        ).fetchone()
        if not owned:
            return False
        for pos, item_id in enumerate(item_ids):
            conn.execute(
                "UPDATE collection_items SET position=? WHERE id=? AND collection_id=?",
                (pos, item_id, collection_id),
            )
    return True


def get_collection_items(user_email: str, collection_id: int) -> list[dict] | None:
    """Ordered playlist items joined with their history records."""
    with _get_conn() as conn:
        owned = conn.execute(
            "SELECT 1 FROM collections WHERE id=? AND user_email=?",
            (collection_id, user_email),
        ).fetchone()
        if not owned:
            return None
        rows = conn.execute(
            """SELECT ci.id AS item_id, ci.history_id, ci.position, ci.added_at,
                      h.song_name, h.caption, h.seed, h.output_files, h.params, h.created_at
               FROM collection_items ci
               JOIN history h ON h.id = ci.history_id
               WHERE ci.collection_id=?
               ORDER BY ci.position, ci.id""",
            (collection_id,),
        ).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["output_files"] = json.loads(d["output_files"])
        d["params"] = json.loads(d["params"])
        items.append(d)
    return items
