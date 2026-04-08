"""OpenRouter credits monitor (uses provisioning key)."""
from __future__ import annotations

from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class OpenRouterMonitor(ProviderMonitor):
    id = "openrouter"
    name = "OpenRouter"
    env_var = "OPENROUTER_PROVISIONING_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        r = await client.get(
            "https://openrouter.ai/api/v1/credits",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        r.raise_for_status()
        data = r.json()
        d = data.get("data", {})
        total = float(d.get("total_credits", 0))
        used = float(d.get("total_usage", 0))
        out = self._base()
        out.update(
            {
                "type": "balance_usd",
                "balance": round(total - used, 4),
                "total": total,
                "used": round(used, 4),
                "currency": "USD",
                "raw": data,
            }
        )
        return out
