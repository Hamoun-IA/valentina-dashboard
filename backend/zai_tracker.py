"""Local Z.ai usage tracking backed by SQLite."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any, Dict

DB_PATH = Path("/root/valentina-dashboard/data/zai_usage.db")
LIMIT_5H = 400
LIMIT_7D = 2000
WINDOW_5H_SECONDS = 5 * 60 * 60
WINDOW_7D_SECONDS = 7 * 24 * 60 * 60
PRUNE_AFTER_SECONDS = 8 * 24 * 60 * 60


def _ensure_db() -> sqlite3.Connection:
    """Return a connection with the usage table initialized."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS zai_usage (
            id INTEGER PRIMARY KEY,
            ts REAL NOT NULL,
            model TEXT,
            input_tokens INT NOT NULL,
            output_tokens INT NOT NULL,
            status INT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def log_usage(model: str | None, input_tokens: int, output_tokens: int, status: int) -> None:
    """Persist one Z.ai request attempt and prune stale rows."""
    now = time.time()
    conn = _ensure_db()
    try:
        conn.execute(
            """
            INSERT INTO zai_usage (ts, model, input_tokens, output_tokens, status)
            VALUES (?, ?, ?, ?, ?)
            """,
            (now, model, input_tokens, output_tokens, status),
        )
        conn.execute("DELETE FROM zai_usage WHERE ts < ?", (now - PRUNE_AFTER_SECONDS,))
        conn.commit()
    finally:
        conn.close()


def get_stats() -> Dict[str, Any]:
    """Return rolling Z.ai request counts and reset timestamps."""
    now = time.time()
    conn = _ensure_db()
    try:
        used_5h = conn.execute(
            "SELECT COUNT(*) FROM zai_usage WHERE ts >= ?",
            (now - WINDOW_5H_SECONDS,),
        ).fetchone()[0]
        used_7d = conn.execute(
            "SELECT COUNT(*) FROM zai_usage WHERE ts >= ?",
            (now - WINDOW_7D_SECONDS,),
        ).fetchone()[0]
        oldest_5h = conn.execute(
            "SELECT MIN(ts) FROM zai_usage WHERE ts >= ?",
            (now - WINDOW_5H_SECONDS,),
        ).fetchone()[0]
        oldest_7d = conn.execute(
            "SELECT MIN(ts) FROM zai_usage WHERE ts >= ?",
            (now - WINDOW_7D_SECONDS,),
        ).fetchone()[0]
        last_call_ts = conn.execute("SELECT MAX(ts) FROM zai_usage").fetchone()[0]
    finally:
        conn.close()

    remaining_5h = max(0, LIMIT_5H - used_5h)
    remaining_7d = max(0, LIMIT_7D - used_7d)
    return {
        "used_5h": used_5h,
        "limit_5h": LIMIT_5H,
        "remaining_5h": remaining_5h,
        "used_7d": used_7d,
        "limit_7d": LIMIT_7D,
        "remaining_7d": remaining_7d,
        "reset_5h_at": oldest_5h + WINDOW_5H_SECONDS if oldest_5h is not None else None,
        "reset_7d_at": oldest_7d + WINDOW_7D_SECONDS if oldest_7d is not None else None,
        "last_call_ts": last_call_ts,
    }
