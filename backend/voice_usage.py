"""
Valentina Voice Chat — Usage Tracking (SQLite)
"""
import sqlite3
import os
from datetime import datetime
from pathlib import Path

DB_PATH = os.path.expanduser("~/.hermes/voice_chat.db")


def _get_conn():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS voice_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            user_text TEXT,
            assistant_text TEXT,
            model_used TEXT,
            input_chars INTEGER DEFAULT 0,
            output_chars INTEGER DEFAULT 0,
            tts_chars INTEGER DEFAULT 0,
            fallback_used INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def log_voice_interaction(user_text: str, assistant_text: str, model_used: str, fallback_used: bool):
    """Log a voice chat interaction to the database."""
    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO voice_sessions
               (timestamp, user_text, assistant_text, model_used, input_chars, output_chars, tts_chars, fallback_used)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.utcnow().isoformat(),
                user_text,
                assistant_text,
                model_used,
                len(user_text),
                len(assistant_text),
                len(assistant_text),  # TTS chars = output chars
                1 if fallback_used else 0,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def get_voice_stats() -> dict:
    """Return aggregate voice chat statistics."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT COUNT(*) as total, COALESCE(SUM(input_chars),0) as total_input, "
            "COALESCE(SUM(output_chars),0) as total_output, COALESCE(SUM(tts_chars),0) as total_tts "
            "FROM voice_sessions"
        ).fetchone()

        models = conn.execute(
            "SELECT model_used, COUNT(*) as count, COALESCE(SUM(output_chars),0) as chars "
            "FROM voice_sessions GROUP BY model_used ORDER BY count DESC"
        ).fetchall()

        fallbacks = conn.execute(
            "SELECT COUNT(*) as count FROM voice_sessions WHERE fallback_used = 1"
        ).fetchone()

        today = datetime.utcnow().strftime("%Y-%m-%d")
        today_row = conn.execute(
            "SELECT COUNT(*) as count FROM voice_sessions WHERE timestamp LIKE ?",
            (f"{today}%",)
        ).fetchone()

        return {
            "total_interactions": row["total"],
            "today_interactions": today_row["count"],
            "total_input_chars": row["total_input"],
            "total_output_chars": row["total_output"],
            "total_tts_chars": row["total_tts"],
            "total_fallbacks": fallbacks["count"],
            "model_breakdown": [
                {"model": m["model_used"], "count": m["count"], "chars": m["chars"]}
                for m in models
            ],
        }
    finally:
        conn.close()
