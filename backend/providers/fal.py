"""FAL.ai balance monitor.

The canonical /v1/account/billing endpoint only works for ADMIN keys.
As a fallback we use the alpha user_balance endpoint which returns a raw number
and works with any valid FAL_KEY.
"""
from __future__ import annotations

from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class FalMonitor(ProviderMonitor):
    id = "fal"
    name = "FAL.ai"
    env_var = "FAL_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        headers = {"Authorization": f"Key {self.api_key}"}

        # Try primary (admin-only) endpoint
        try:
            r = await client.get(
                "https://api.fal.ai/v1/account/billing?expand=credits",
                headers=headers,
            )
            if r.status_code == 200:
                data = r.json()
                credits = data.get("credits", {})
                balance = float(credits.get("current_balance", 0))
                out = self._base()
                out.update(
                    {
                        "type": "balance_usd",
                        "balance": balance,
                        "currency": "USD",
                        "raw": data,
                    }
                )
                return out
        except httpx.HTTPError:
            pass

        # Fallback: raw balance endpoint
        r = await client.get(
            "https://rest.alpha.fal.ai/billing/user_balance",
            headers=headers,
        )
        r.raise_for_status()
        txt = r.text.strip()
        try:
            balance = float(txt)
        except ValueError:
            return self._error(f"unexpected body: {txt[:80]}")
        out = self._base()
        out.update(
            {
                "type": "balance_usd",
                "balance": balance,
                "currency": "USD",
                "raw": {"user_balance": balance},
            }
        )
        return out
