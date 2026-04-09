"""Fetch live Z.ai quota data from the dashboard quota endpoint."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict

import requests

ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
TIMEOUT = 15


UNIT_LABELS = {
    3: "hours",
    5: "month",
    6: "week",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_from_ms(value: Any) -> str | None:
    try:
        if value is None:
            return None
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def _normalize_tokens_limit(limit: dict[str, Any]) -> dict[str, Any]:
    used_percent = float(limit.get("percentage") or 0)
    return {
        "type": limit.get("type"),
        "unit": limit.get("unit"),
        "number": limit.get("number"),
        "used_percent": used_percent,
        "remaining_percent": max(0.0, 100.0 - used_percent),
        "reset_at": _iso_from_ms(limit.get("nextResetTime")),
        "raw": limit,
    }


def _normalize_time_limit(limit: dict[str, Any]) -> dict[str, Any]:
    total = int(limit.get("usage") or 0)
    used = int(limit.get("currentValue") or 0)
    remaining = int(limit.get("remaining") or max(0, total - used))
    percent = float(limit.get("percentage") or ((used / total) * 100.0 if total > 0 else 0.0))
    return {
        "type": limit.get("type"),
        "unit": limit.get("unit"),
        "number": limit.get("number"),
        "total": total,
        "used": used,
        "remaining": remaining,
        "used_percent": percent,
        "remaining_percent": max(0.0, 100.0 - percent),
        "reset_at": _iso_from_ms(limit.get("nextResetTime")),
        "usage_details": limit.get("usageDetails") or [],
        "raw": limit,
    }


def get_zai_live_usage() -> Dict[str, Any]:
    fetched_at = _now_iso()
    api_key = os.getenv("ZAI_API_KEY")
    if not api_key:
        return {
            "available": False,
            "source": "zai_dashboard_quota_api",
            "fetched_at": fetched_at,
            "reason": "ZAI_API_KEY missing",
        }

    try:
        resp = requests.get(
            ZAI_QUOTA_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=TIMEOUT,
        )
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "source": "zai_dashboard_quota_api",
            "fetched_at": fetched_at,
            "reason": f"request failed: {type(exc).__name__}: {exc}",
        }

    if not data.get("success"):
        return {
            "available": False,
            "source": "zai_dashboard_quota_api",
            "fetched_at": fetched_at,
            "reason": data.get("msg") or f"code={data.get('code')}",
            "raw": data,
        }

    limits = data.get("data", {}).get("limits") or []
    token_limits = [x for x in limits if x.get("type") == "TOKENS_LIMIT"]
    time_limits = [x for x in limits if x.get("type") == "TIME_LIMIT"]

    five_hour = next((x for x in token_limits if x.get("unit") == 3 and x.get("number") == 5), None)
    weekly = next((x for x in token_limits if x.get("unit") == 6), None)
    monthly_search = next((x for x in time_limits if x.get("unit") == 5), None)

    return {
        "available": bool(five_hour or weekly or monthly_search),
        "source": "zai_dashboard_quota_api",
        "fetched_at": fetched_at,
        "level": data.get("data", {}).get("level"),
        "five_hour": _normalize_tokens_limit(five_hour) if five_hour else None,
        "weekly": _normalize_tokens_limit(weekly) if weekly else None,
        "monthly_search": _normalize_time_limit(monthly_search) if monthly_search else None,
        "raw": data,
    }
