"""DeepSeek balance monitor."""
from __future__ import annotations

from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class DeepSeekMonitor(ProviderMonitor):
    id = "deepseek"
    name = "DeepSeek"
    env_var = "DEEPSEEK_API_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        r = await client.get(
            "https://api.deepseek.com/user/balance",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        r.raise_for_status()
        data = r.json()
        infos = data.get("balance_infos") or []
        if not infos:
            return self._error("no balance_infos")
        usd = next((i for i in infos if i.get("currency") == "USD"), infos[0])
        balance = float(usd.get("total_balance", 0))
        out = self._base()
        out.update(
            {
                "type": "balance_usd",
                "balance": balance,
                "currency": usd.get("currency", "USD"),
                "raw": data,
            }
        )
        return out
