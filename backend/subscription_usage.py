"""Parse local Codex subscription-usage signals from on-disk logs."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable

CODEX_STATE_DB = Path.home() / ".codex" / "state_5.sqlite"
CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"


def _parse_iso_ts(value: Any) -> float | None:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iso_from_epoch(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except OSError:
        return


def _codex_rollout_paths() -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()

    if CODEX_STATE_DB.exists():
        try:
            conn = sqlite3.connect(str(CODEX_STATE_DB))
            rows = conn.execute("SELECT rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path != ''").fetchall()
            conn.close()
            for (raw_path,) in rows:
                if not raw_path:
                    continue
                p = Path(raw_path)
                key = str(p)
                if p.exists() and key not in seen:
                    seen.add(key)
                    found.append(p)
        except sqlite3.Error:
            pass

    if CODEX_SESSIONS_DIR.exists():
        for p in CODEX_SESSIONS_DIR.rglob("*.jsonl"):
            key = str(p)
            if key not in seen:
                seen.add(key)
                found.append(p)

    return sorted(found)


def get_codex_usage() -> Dict[str, Any]:
    """Return the latest Codex Plus quota snapshot parsed from rollout logs."""
    paths = _codex_rollout_paths()
    if not paths:
        return {
            "available": False,
            "provider": "codex",
            "reason": "no Codex rollout files found",
            "session_count": 0,
        }

    latest_snapshot: dict[str, Any] | None = None
    latest_ts = -1.0

    for path in paths:
        for obj in _iter_jsonl(path):
            payload = obj.get("payload") or {}
            if payload.get("type") != "token_count":
                continue
            rate_limits = payload.get("rate_limits") or {}
            ts = _parse_iso_ts(obj.get("timestamp")) or 0.0
            if ts < latest_ts:
                continue
            latest_ts = ts
            primary = rate_limits.get("primary") or {}
            secondary = rate_limits.get("secondary") or {}
            latest_snapshot = {
                "available": True,
                "provider": "codex",
                "plan_type": rate_limits.get("plan_type"),
                "primary_used_percent": primary.get("used_percent"),
                "primary_window_minutes": primary.get("window_minutes"),
                "primary_resets_at": _iso_from_epoch(primary.get("resets_at")),
                "secondary_used_percent": secondary.get("used_percent"),
                "secondary_window_minutes": secondary.get("window_minutes"),
                "secondary_resets_at": _iso_from_epoch(secondary.get("resets_at")),
                "last_seen_at": obj.get("timestamp"),
                "session_count": len(paths),
            }

    if latest_snapshot:
        return latest_snapshot

    return {
        "available": False,
        "provider": "codex",
        "reason": "no token_count events found in Codex rollouts",
        "session_count": len(paths),
    }

def get_subscription_usage() -> Dict[str, Any]:
    """Return dashboard subscription telemetry for the active consumer plans only."""
    from backend.codex_live_usage import get_codex_live_usage
    from backend.zai_live_usage import get_zai_live_usage

    return {
        "codex": get_codex_live_usage(),
        "codex_local": get_codex_usage(),
        "zai": get_zai_live_usage(),
    }
