"""RunPod balance monitor (GraphQL, auth via query param)."""
from __future__ import annotations

from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class RunPodMonitor(ProviderMonitor):
    id = "runpod"
    name = "RunPod"
    env_var = "RUNPOD_API_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        r = await client.post(
            f"https://api.runpod.io/graphql?api_key={self.api_key}",
            json={"query": "{ myself { clientBalance currentSpendPerHr } }"},
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        data = r.json()
        me = (data.get("data") or {}).get("myself") or {}
        if "clientBalance" not in me:
            return self._error(f"unexpected response: {str(data)[:120]}")
        balance = float(me.get("clientBalance") or 0)
        spend = float(me.get("currentSpendPerHr") or 0)
        out = self._base()
        out.update(
            {
                "type": "balance_usd",
                "balance": round(balance, 4),
                "spend_per_hour": spend,
                "currency": "USD",
                "raw": data,
            }
        )
        return out
