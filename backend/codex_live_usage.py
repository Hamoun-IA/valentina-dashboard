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


def _normalize_window(window: dict[str, Any] | None) -> dict[str, Any]:
    if not window:
        return {}
    used = window.get("usedPercent")
    if used is None:
        used = window.get("used_percent")

    duration = window.get("windowDurationMins")
    if duration is None and window.get("limit_window_seconds") is not None:
        try:
            duration = float(window.get("limit_window_seconds")) / 60.0
        except (TypeError, ValueError):
            duration = None

    resets_at = window.get("resetsAt")
    if resets_at is None:
        resets_at = window.get("reset_at")

    return {
        "used_percent": used,
        "window_minutes": duration,
        "resets_at": _iso_from_epoch(resets_at),
    }


def _normalize_snapshot(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not snapshot:
        return None
    primary = snapshot.get("primary") or snapshot.get("primary_window") or {}
    secondary = snapshot.get("secondary") or snapshot.get("secondary_window") or {}
    credits = snapshot.get("credits") or {}

    primary_norm = _normalize_window(primary)
    secondary_norm = _normalize_window(secondary)
    primary_used = primary_norm.get("used_percent")
    secondary_used = secondary_norm.get("used_percent")

    return {
        "limit_id": snapshot.get("limitId") or snapshot.get("limit_id") or snapshot.get("metered_feature"),
        "limit_name": snapshot.get("limitName") or snapshot.get("limit_name") or snapshot.get("metered_feature"),
        "plan_type": snapshot.get("planType") or snapshot.get("plan_type"),
        "primary_used_percent": primary_used,
        "primary_remaining_percent": (100 - primary_used) if isinstance(primary_used, (int, float)) else None,
        "primary_window_minutes": primary_norm.get("window_minutes"),
        "primary_resets_at": primary_norm.get("resets_at"),
        "secondary_used_percent": secondary_used,
        "secondary_remaining_percent": (100 - secondary_used) if isinstance(secondary_used, (int, float)) else None,
        "secondary_window_minutes": secondary_norm.get("window_minutes"),
        "secondary_resets_at": secondary_norm.get("resets_at"),
        "credits": {
            "has_credits": credits.get("hasCredits") if credits.get("hasCredits") is not None else credits.get("has_credits"),
            "unlimited": credits.get("unlimited"),
            "balance": credits.get("balance"),
        } if snapshot.get("credits") is not None else None,
    }


def _extract_json_body_from_error(message: str | None) -> dict[str, Any] | None:
    if not message or "body=" not in message:
        return None
    body = message.split("body=", 1)[1].strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def _slugify_limit_key(value: str | None) -> str | None:
    if not value:
        return None
    out = []
    prev_sep = False
    for ch in value.lower():
        if ch.isalnum():
            out.append(ch)
            prev_sep = False
        elif not prev_sep:
            out.append("_")
            prev_sep = True
    return "".join(out).strip("_") or None


def _normalize_wham_payload(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return None

    root_snapshot = {
        "plan_type": payload.get("plan_type"),
        "primary_window": (payload.get("rate_limit") or {}).get("primary_window"),
        "secondary_window": (payload.get("rate_limit") or {}).get("secondary_window"),
        "credits": payload.get("credits"),
    }
    normalized = _normalize_snapshot(root_snapshot) or {}
    normalized["account_id"] = payload.get("account_id")
    normalized["user_id"] = payload.get("user_id")
    normalized["source_format"] = "wham_usage_error_fallback"

    by_limit_id: dict[str, Any] = {}
    code_review = payload.get("code_review_rate_limit")
    if code_review:
        review_norm = _normalize_snapshot({
            "limit_id": "review",
            "limit_name": "Code Review",
            "plan_type": payload.get("plan_type"),
            "primary_window": code_review.get("primary_window"),
            "secondary_window": code_review.get("secondary_window"),
            "credits": payload.get("credits"),
        })
        if review_norm:
            by_limit_id["review"] = review_norm

    for idx, extra in enumerate(payload.get("additional_rate_limits") or [], start=1):
        key = extra.get("metered_feature") or _slugify_limit_key(extra.get("limit_name")) or f"extra_{idx}"
        extra_norm = _normalize_snapshot({
            "limit_id": key,
            "limit_name": extra.get("limit_name"),
            "plan_type": payload.get("plan_type"),
            "primary_window": (extra.get("rate_limit") or {}).get("primary_window"),
            "secondary_window": (extra.get("rate_limit") or {}).get("secondary_window"),
            "credits": payload.get("credits"),
            "metered_feature": extra.get("metered_feature"),
        })
        if extra_norm:
            by_limit_id[key] = extra_norm

    normalized["rate_limits_by_limit_id"] = by_limit_id or None
    return normalized


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
                if obj.get("id") == "2":
                    if isinstance(obj.get("result"), dict):
                        result_obj = obj["result"]
                        break
                    if isinstance(obj.get("error"), dict):
                        recovered = _normalize_wham_payload(_extract_json_body_from_error(obj["error"].get("message")))
                        if recovered is not None:
                            return {
                                "available": True,
                                "source": "codex_app_server_error_fallback",
                                "fetched_at": fetched_at,
                                **recovered,
                            }
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
