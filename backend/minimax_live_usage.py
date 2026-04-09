"""Fetch live MiniMax token-plan quota data."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict

import requests

MINIMAX_REMAINS_URL = "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains"
TIMEOUT = 15


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_from_ms(value: Any) -> str | None:
    try:
        if value is None:
            return None
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def _pick_primary_bucket(model_remains: list[dict[str, Any]]) -> dict[str, Any] | None:
    for row in model_remains:
        name = str(row.get("model_name") or "")
        if name.startswith("MiniMax-M"):
            return row
    return model_remains[0] if model_remains else None


def _normalize_bucket(row: dict[str, Any]) -> dict[str, Any]:
    interval_total = int(row.get("current_interval_total_count") or 0)
    weekly_total = int(row.get("current_weekly_total_count") or 0)

    # MiniMax's field naming is misleading here: the dashboard endpoint returns the
    # remaining count in `*_usage_count`, while the UI itself shows % used.
    interval_remaining = int(row.get("current_interval_usage_count") or 0)
    weekly_remaining = int(row.get("current_weekly_usage_count") or 0)
    interval_used = max(0, interval_total - interval_remaining)
    weekly_used = max(0, weekly_total - weekly_remaining)

    return {
        "model_name": row.get("model_name"),
        "primary_total": interval_total,
        "primary_used": interval_used,
        "primary_remaining": interval_remaining,
        "primary_used_percent": (interval_used / interval_total * 100.0) if interval_total > 0 else None,
        "primary_remaining_percent": (interval_remaining / interval_total * 100.0) if interval_total > 0 else None,
        "primary_reset_at": _iso_from_ms(row.get("end_time")),
        "secondary_total": weekly_total,
        "secondary_used": weekly_used,
        "secondary_remaining": weekly_remaining,
        "secondary_used_percent": (weekly_used / weekly_total * 100.0) if weekly_total > 0 else None,
        "secondary_remaining_percent": (weekly_remaining / weekly_total * 100.0) if weekly_total > 0 else None,
        "secondary_reset_at": _iso_from_ms(row.get("weekly_end_time")),
        "raw": row,
    }


def get_minimax_live_usage() -> Dict[str, Any]:
    fetched_at = _now_iso()
    api_key = os.getenv("MINIMAX_API_KEY")
    if not api_key:
        return {
            "available": False,
            "source": "minimax_token_plan_api",
            "fetched_at": fetched_at,
            "reason": "MINIMAX_API_KEY missing",
        }

    try:
        resp = requests.get(
            MINIMAX_REMAINS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=TIMEOUT,
        )
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "source": "minimax_token_plan_api",
            "fetched_at": fetched_at,
            "reason": f"request failed: {type(exc).__name__}: {exc}",
        }

    base_resp = data.get("base_resp") or {}
    if base_resp.get("status_code") not in (None, 0):
        return {
            "available": False,
            "source": "minimax_token_plan_api",
            "fetched_at": fetched_at,
            "reason": base_resp.get("status_msg") or f"status_code={base_resp.get('status_code')}",
            "raw": data,
        }

    model_remains = data.get("model_remains") or []
    primary = _pick_primary_bucket(model_remains)
    if not primary:
        return {
            "available": False,
            "source": "minimax_token_plan_api",
            "fetched_at": fetched_at,
            "reason": "no model_remains returned",
            "raw": data,
        }

    normalized = _normalize_bucket(primary)
    return {
        "available": True,
        "source": "minimax_token_plan_api",
        "fetched_at": fetched_at,
        **normalized,
        "other_models": [
            {
                "model_name": row.get("model_name"),
                "primary_total": int(row.get("current_interval_total_count") or 0),
                "primary_used": int(row.get("current_interval_usage_count") or 0),
                "secondary_total": int(row.get("current_weekly_total_count") or 0),
                "secondary_used": int(row.get("current_weekly_usage_count") or 0),
            }
            for row in model_remains
            if row is not primary
        ],
    }
