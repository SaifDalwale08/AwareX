"""
AwareX Local Event Store
=========================
SQLite-backed durable journal for safety events.

Write-first guarantee:
    Every safety event is written to SQLite BEFORE Supabase is attempted.
    If Supabase is unavailable the event remains PENDING and is retried on sync.

Statuses:
    PENDING  — saved locally, not yet in Supabase
    SYNCED   — confirmed in Supabase
    FAILED   — sync attempted but Supabase rejected (data error, not connectivity)

Thread-safe: uses a module-level lock so FastAPI async workers don't race.
"""

import sqlite3
import json
import uuid
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("awarex.local_store")

# ── Database location ─────────────────────────────────────────
_DB_DIR  = Path(__file__).parent.parent / "data"
_DB_PATH = _DB_DIR / "awarex_local.db"

_lock = threading.Lock()

# ── Schema ────────────────────────────────────────────────────
_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS events (
    event_id   TEXT PRIMARY KEY,
    timestamp  TEXT NOT NULL,
    worker_id  TEXT,
    event_type TEXT,
    severity   TEXT,
    payload    TEXT,       -- full JSON blob
    status     TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    synced_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
"""


def _connect() -> sqlite3.Connection:
    _DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # concurrent reads + writes
    return conn


def _init_db() -> None:
    with _connect() as conn:
        conn.executescript(_CREATE_SQL)
    logger.info("[LocalStore] database ready: %s", _DB_PATH)


_init_db()


# ── Public API ────────────────────────────────────────────────

def write_event(
    payload: dict,
    worker_id: str = "",
    event_type: str = "safety_violation",
    severity: str = "WARNING",
    event_id: str | None = None,
) -> str:
    """
    Write a safety event to the local journal.
    Returns the event_id.
    Always succeeds (raises only on catastrophic filesystem failure).
    """
    eid = event_id or str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    with _lock:
        with _connect() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO events
                    (event_id, timestamp, worker_id, event_type, severity,
                     payload, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
                """,
                (eid, now, worker_id, event_type, severity,
                 json.dumps(payload), now),
            )
    return eid


def mark_synced(event_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        with _connect() as conn:
            conn.execute(
                "UPDATE events SET status='SYNCED', synced_at=? WHERE event_id=?",
                (now, event_id),
            )


def mark_failed(event_id: str) -> None:
    with _lock:
        with _connect() as conn:
            conn.execute(
                "UPDATE events SET status='FAILED' WHERE event_id=?",
                (event_id,),
            )


def get_pending() -> list[dict]:
    with _lock:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT * FROM events WHERE status='PENDING' ORDER BY created_at"
            ).fetchall()
    return [dict(r) for r in rows]


def pending_count() -> int:
    with _lock:
        with _connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM events WHERE status='PENDING'"
            ).fetchone()[0]


def last_sync_time() -> str | None:
    with _lock:
        with _connect() as conn:
            row = conn.execute(
                "SELECT MAX(synced_at) FROM events WHERE status='SYNCED'"
            ).fetchone()
    return row[0] if row else None


def stats() -> dict:
    with _lock:
        with _connect() as conn:
            total   = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            pending = conn.execute("SELECT COUNT(*) FROM events WHERE status='PENDING'").fetchone()[0]
            synced  = conn.execute("SELECT COUNT(*) FROM events WHERE status='SYNCED'").fetchone()[0]
            failed  = conn.execute("SELECT COUNT(*) FROM events WHERE status='FAILED'").fetchone()[0]
    return {
        "total":   total,
        "pending": pending,
        "synced":  synced,
        "failed":  failed,
        "db_path": str(_DB_PATH),
    }
