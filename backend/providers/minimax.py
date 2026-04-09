"""Local MiniMax plan monitor backed by Hermes state.db usage."""
from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict

import httpx

from .base import ProviderMonitor

STATE_DB = Path.home() / ".hermes" / "state.db"
WINDOW_5H_SECONDS = 5 * 3600
WINDOW_7D_SECONDS = 7 * 24 * 3600
LIMIT_5H_REQUESTS = 4500
LIMIT_7D_REQUESTS = LIMIT_5H_REQUESTS * 10


def _collect_minimax_stats() -> Dict[str, Any]:
    if not STATE_DB.exists():
        return {
            "available": False,
            "reason": f"missing state db: {STATE_DB}",
        }

    conn = sqlite3.connect(str(STATE_DB))
    conn.row_factory = sqlite3.Row
    try:
        now = time.time()
        cutoff_5h = now - WINDOW_5H_SECONDS
        cutoff_7d = now - WINDOW_7D_SECONDS

        where_clause = "(s.billing_provider = 'minimax' OR s.model LIKE 'MiniMax%')"

        used_5h = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_clause}
              AND m.role = 'user'
              AND m.timestamp >= ?
            """,
            (cutoff_5h,),
        ).fetchone()[0]

        oldest_5h = conn.execute(
            f"""
            SELECT MIN(m.timestamp)
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_clause}
              AND m.role = 'user'
              AND m.timestamp >= ?
            """,
            (cutoff_5h,),
        ).fetchone()[0]

        used_7d = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_clause}
              AND m.role = 'user'
              AND m.timestamp >= ?
            """,
            (cutoff_7d,),
        ).fetchone()[0]

        oldest_7d = conn.execute(
            f"""
            SELECT MIN(m.timestamp)
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_clause}
              AND m.role = 'user'
              AND m.timestamp >= ?
            """,
            (cutoff_7d,),
        ).fetchone()[0]

        total_prompts = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_clause}
              AND m.role = 'user'
            """
        ).fetchone()[0]

        session_count = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM sessions s
            WHERE {where_clause}
            """
        ).fetchone()[0]

        last_seen = conn.execute(
            f"""
            SELECT MAX(m.timestamp)
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_clause}
            """
        ).fetchone()[0]

        models = conn.execute(
            f"""
            SELECT s.model, COUNT(*) AS cnt
            FROM sessions s
            WHERE {where_clause}
            GROUP BY s.model
            ORDER BY cnt DESC
            """
        ).fetchall()

        return {
            "available": True,
            "requests_used_5h": int(used_5h or 0),
            "requests_remaining": max(0, LIMIT_5H_REQUESTS - int(used_5h or 0)),
            "requests_limit": LIMIT_5H_REQUESTS,
            "reset_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((oldest_5h or now) + WINDOW_5H_SECONDS)) if oldest_5h else None,
            "requests_used_7d": int(used_7d or 0),
            "requests_remaining_7d": max(0, LIMIT_7D_REQUESTS - int(used_7d or 0)),
            "requests_limit_7d": LIMIT_7D_REQUESTS,
            "reset_at_7d": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((oldest_7d or now) + WINDOW_7D_SECONDS)) if oldest_7d else None,
            "session_count": int(session_count or 0),
            "total_prompts": int(total_prompts or 0),
            "last_seen_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_seen)) if last_seen else None,
            "models": {row[0] or "unknown": row[1] for row in models},
            "note": "tracker local Hermes · docs MiniMax: weekly quota = 10× le quota 5h pour les nouveaux plans",
        }
    finally:
        conn.close()


class MiniMaxMonitor(ProviderMonitor):
    id = "minimax"
    name = "MiniMax"
    env_var = None

    async def fetch(self) -> Dict[str, Any]:
        try:
            return await self._fetch(None)
        except Exception as e:  # noqa: BLE001
            return self._error(f"{type(e).__name__}: {e}")

    async def _fetch(self, client: httpx.AsyncClient | None) -> Dict[str, Any]:
        stats = await asyncio.to_thread(_collect_minimax_stats)
        out = self._base()
        if not stats.get("available"):
            out.update({"status": "error", "error": stats.get("reason", "MiniMax tracker unavailable")})
            return out

        out.update(
            {
                "status": "ok" if stats["requests_remaining"] > 0 else "warning",
                "type": "rate_limits",
                **stats,
            }
        )
        return out
