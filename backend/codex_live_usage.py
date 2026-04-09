"""Read live Codex account rate limits through the local Codex app-server protocol."""
from __future__ import annotations

import json
import select
import shutil
import subprocess
import time
from datetime import datetime, timezone
from typing import Any

CODEX_APP_SERVER_CMD = ["codex", "app-server"]
READ_TIMEOUT_SECONDS = 8.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_from_epoch(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def _normalize_snapshot(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not snapshot:
        return None
    primary = snapshot.get("primary") or {}
    secondary = snapshot.get("secondary") or {}
    credits = snapshot.get("credits") or {}

    primary_used = primary.get("usedPercent")
    secondary_used = secondary.get("usedPercent")

    return {
        "limit_id": snapshot.get("limitId"),
        "limit_name": snapshot.get("limitName"),
        "plan_type": snapshot.get("planType"),
        "primary_used_percent": primary_used,
        "primary_remaining_percent": (100 - primary_used) if isinstance(primary_used, (int, float)) else None,
        "primary_window_minutes": primary.get("windowDurationMins"),
        "primary_resets_at": _iso_from_epoch(primary.get("resetsAt")),
        "secondary_used_percent": secondary_used,
        "secondary_remaining_percent": (100 - secondary_used) if isinstance(secondary_used, (int, float)) else None,
        "secondary_window_minutes": secondary.get("windowDurationMins"),
        "secondary_resets_at": _iso_from_epoch(secondary.get("resetsAt")),
        "credits": {
            "has_credits": credits.get("hasCredits"),
            "unlimited": credits.get("unlimited"),
            "balance": credits.get("balance"),
        } if snapshot.get("credits") is not None else None,
    }


def get_codex_live_usage() -> dict[str, Any]:
    """Query Codex app-server for current account rate limits without spending a turn."""
    fetched_at = _now_iso()
    if not shutil.which("codex"):
        return {
            "available": False,
            "source": "codex_app_server",
            "fetched_at": fetched_at,
            "reason": "codex CLI not found on PATH",
        }

    proc = None
    try:
        proc = subprocess.Popen(
            CODEX_APP_SERVER_CMD,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert proc.stdin and proc.stdout

        messages = [
            {
                "id": "1",
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "valentina-dashboard", "title": "Valentina Dashboard", "version": "1.0"},
                    "capabilities": {"experimentalApi": True, "optOutNotificationMethods": []},
                },
            },
            {"method": "initialized"},
            {"id": "2", "method": "account/rateLimits/read", "params": None},
        ]
        for msg in messages:
            proc.stdin.write(json.dumps(msg) + "\n")
            proc.stdin.flush()
            time.sleep(0.15)

        deadline = time.time() + READ_TIMEOUT_SECONDS
        result_obj: dict[str, Any] | None = None
        stderr_lines: list[str] = []
        streams = [s for s in (proc.stdout, proc.stderr) if s is not None]
        while time.time() < deadline:
            ready, _, _ = select.select(streams, [], [], 0.4)
            for stream in ready:
                line = stream.readline()
                if not line:
                    continue
                if stream is proc.stderr:
                    stderr_lines.append(line.strip())
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("id") == "2" and isinstance(obj.get("result"), dict):
                    result_obj = obj["result"]
                    break
            if result_obj is not None:
                break

        if not result_obj:
            return {
                "available": False,
                "source": "codex_app_server",
                "fetched_at": fetched_at,
                "reason": "no account/rateLimits/read response received",
                "stderr_excerpt": "\n".join(stderr_lines[-5:]) if stderr_lines else None,
            }

        rate_limits = _normalize_snapshot(result_obj.get("rateLimits")) or {}
        by_limit_id_raw = result_obj.get("rateLimitsByLimitId") or {}
        by_limit_id = {
            key: _normalize_snapshot(value)
            for key, value in by_limit_id_raw.items()
            if _normalize_snapshot(value) is not None
        }

        return {
            "available": True,
            "source": "codex_app_server",
            "fetched_at": fetched_at,
            **rate_limits,
            "rate_limits_by_limit_id": by_limit_id or None,
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "available": False,
            "source": "codex_app_server",
            "fetched_at": fetched_at,
            "reason": f"failed to query Codex app-server: {exc}",
        }
    finally:
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=1)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
