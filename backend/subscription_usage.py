"""Parse local Codex and Claude Code subscription-usage signals from on-disk logs."""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable

CODEX_STATE_DB = Path.home() / ".codex" / "state_5.sqlite"
CODEX_SESSIONS_DIR = Path.home() / ".codex" / "sessions"
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
WINDOW_5H_SECONDS = 5 * 60 * 60
WINDOW_7D_SECONDS = 7 * 24 * 60 * 60


def _now_ts() -> float:
    return datetime.now(timezone.utc).timestamp()


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


def get_claude_usage() -> Dict[str, Any]:
    """Aggregate Claude Code assistant usage from project JSONL session logs."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return {
            "available": False,
            "provider": "claude_code",
            "reason": "Claude projects directory not found",
            "session_count": 0,
        }

    files = sorted(CLAUDE_PROJECTS_DIR.rglob("*.jsonl"))
    if not files:
        return {
            "available": False,
            "provider": "claude_code",
            "reason": "no Claude session files found",
            "session_count": 0,
        }

    now = _now_ts()
    cutoff_5h = now - WINDOW_5H_SECONDS
    cutoff_7d = now - WINDOW_7D_SECONDS

    session_ids: set[str] = set()
    models: Counter[str] = Counter()
    last_seen_ts: float | None = None
    last_seen_at: str | None = None

    assistant_messages_total = 0
    assistant_messages_5h = 0
    assistant_messages_7d = 0
    input_tokens_total = 0
    output_tokens_total = 0
    cache_read_tokens_total = 0
    cache_creation_tokens_total = 0
    input_tokens_5h = 0
    output_tokens_5h = 0
    input_tokens_7d = 0
    output_tokens_7d = 0

    for path in files:
        seen_keys: set[str] = set()
        for obj in _iter_jsonl(path):
            session_id = obj.get("sessionId")
            if session_id:
                session_ids.add(str(session_id))

            if obj.get("type") != "assistant":
                continue

            message = obj.get("message") or {}
            if message.get("role") != "assistant":
                continue

            usage = message.get("usage") or {}
            if not usage:
                continue

            dedupe_key = str(
                obj.get("requestId")
                or message.get("id")
                or obj.get("uuid")
                or f"{path}:{obj.get('timestamp')}"
            )
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)

            ts_raw = obj.get("timestamp")
            ts = _parse_iso_ts(ts_raw)
            if ts is not None and (last_seen_ts is None or ts > last_seen_ts):
                last_seen_ts = ts
                last_seen_at = ts_raw

            model = message.get("model") or "unknown"
            models[model] += 1

            assistant_messages_total += 1
            input_tokens = int(usage.get("input_tokens") or 0)
            output_tokens = int(usage.get("output_tokens") or 0)
            cache_read = int(usage.get("cache_read_input_tokens") or 0)
            cache_creation = int(usage.get("cache_creation_input_tokens") or 0)

            input_tokens_total += input_tokens
            output_tokens_total += output_tokens
            cache_read_tokens_total += cache_read
            cache_creation_tokens_total += cache_creation

            if ts is not None and ts >= cutoff_7d:
                assistant_messages_7d += 1
                input_tokens_7d += input_tokens
                output_tokens_7d += output_tokens

            if ts is not None and ts >= cutoff_5h:
                assistant_messages_5h += 1
                input_tokens_5h += input_tokens
                output_tokens_5h += output_tokens

    return {
        "available": assistant_messages_total > 0,
        "provider": "claude_code",
        "session_count": len(session_ids) or len(files),
        "assistant_messages_total": assistant_messages_total,
        "assistant_messages_5h": assistant_messages_5h,
        "assistant_messages_7d": assistant_messages_7d,
        "input_tokens_total": input_tokens_total,
        "output_tokens_total": output_tokens_total,
        "cache_read_tokens_total": cache_read_tokens_total,
        "cache_creation_tokens_total": cache_creation_tokens_total,
        "input_tokens_5h": input_tokens_5h,
        "output_tokens_5h": output_tokens_5h,
        "input_tokens_7d": input_tokens_7d,
        "output_tokens_7d": output_tokens_7d,
        "models": dict(models),
        "last_seen_at": last_seen_at,
        "reason": None if assistant_messages_total > 0 else "no assistant usage entries found",
    }


def get_subscription_usage() -> Dict[str, Any]:
    """Return subscription telemetry for Codex, MiniMax, and Claude consumer plans."""
    from backend.claude_live_usage import scrape_claude_live_usage
    from backend.codex_live_usage import get_codex_live_usage
    from backend.minimax_live_usage import get_minimax_live_usage

    return {
        "codex": get_codex_live_usage(),
        "codex_local": get_codex_usage(),
        "minimax": get_minimax_live_usage(),
        "claude_code": get_claude_usage(),
        "claude_live": scrape_claude_live_usage(),
    }
