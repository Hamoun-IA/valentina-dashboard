"""Local Z.ai quota monitor backed by the usage tracker."""
from __future__ import annotations

import asyncio
from typing import Any, Dict

import httpx

from backend.zai_tracker import get_stats

from .base import ProviderMonitor


class ZaiProxyMonitor(ProviderMonitor):
    id = "zai"
    name = "Z.ai (Anthropic proxy)"
    env_var = "ZAI_API_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        """Return locally tracked rolling quota status."""
        stats = await asyncio.to_thread(get_stats)
        out = self._base()
        out.update(
            {
                "status": "ok" if stats["remaining_5h"] > 0 else "warning",
                "type": "rate_limits",
                **stats,
            }
        )
        return out
