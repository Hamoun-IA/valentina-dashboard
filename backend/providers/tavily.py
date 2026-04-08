"""Tavily usage monitor."""
from __future__ import annotations

import os
from typing import Any, Dict

import httpx

from .base import ProviderMonitor

FALLBACK_KEY = "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"


class TavilyMonitor(ProviderMonitor):
    id = "tavily"
    name = "Tavily"
    env_var = "TAVILY_API_KEY"

    def __init__(self, api_key=None):
        super().__init__(api_key)
        if not self.api_key:
            # Hardcoded fallback per task spec
            self.api_key = FALLBACK_KEY

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        r = await client.get(
            "https://api.tavily.com/usage",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        r.raise_for_status()
        data = r.json()
        account = data.get("account", {}) or {}
        used = int(account.get("plan_usage", 0))
        limit = account.get("plan_limit")
        if limit is not None:
            limit = int(limit)
        out = self._base()
        out.update(
            {
                "type": "quota_credits",
                "used": used,
                "limit": limit,
                "plan": account.get("current_plan"),
                "raw": data,
            }
        )
        return out
