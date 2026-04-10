"""xAI management/billing monitor."""
from __future__ import annotations

from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class XaiMonitor(ProviderMonitor):
    id = "xai"
    name = "xAI"
    env_var = "XAI_MANAGEMENT_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": "ValentinaDashboard/1.0",
        }

        validation = await client.get(
            "https://management-api.x.ai/auth/management-keys/validation",
            headers=headers,
        )
        validation.raise_for_status()
        validation_data = validation.json()
        team_id = validation_data.get("teamId")
        if not team_id:
            return self._error(f"unexpected validation response: {str(validation_data)[:160]}")

        balance_resp = await client.get(
            f"https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance",
            headers=headers,
        )
        balance_resp.raise_for_status()
        balance_data = balance_resp.json()

        preview_resp = await client.get(
            f"https://management-api.x.ai/v1/billing/teams/{team_id}/postpaid/invoice/preview",
            headers=headers,
        )
        preview_resp.raise_for_status()
        preview_data = preview_resp.json()

        def _usd_from_cents(value: Any) -> float | None:
            try:
                return abs(int(value)) / 100.0
            except (TypeError, ValueError):
                return None

        total_obj = balance_data.get("total") or {}
        gross_prepaid_usd = _usd_from_cents(total_obj.get("val"))

        core_invoice = preview_data.get("coreInvoice") or {}
        preview_prepaid_usd = _usd_from_cents((core_invoice.get("prepaidCredits") or {}).get("val"))
        preview_used_usd = _usd_from_cents((core_invoice.get("prepaidCreditsUsed") or {}).get("val")) or 0.0

        if preview_prepaid_usd is not None:
            balance_usd = max(preview_prepaid_usd - preview_used_usd, 0.0)
        else:
            balance_usd = gross_prepaid_usd or 0.0

        out = self._base()
        out.update(
            {
                "type": "balance_usd",
                "balance": round(balance_usd, 4),
                "currency": "USD",
                "key_name": validation_data.get("name"),
                "scope": validation_data.get("scope"),
                "team_id": team_id,
                "redacted_api_key": validation_data.get("redactedApiKey"),
                "raw": {
                    "validation": validation_data,
                    "balance": balance_data,
                    "invoice_preview": preview_data,
                    "gross_prepaid_usd": gross_prepaid_usd,
                    "preview_prepaid_usd": preview_prepaid_usd,
                    "preview_used_usd": preview_used_usd,
                },
            }
        )
        return out
