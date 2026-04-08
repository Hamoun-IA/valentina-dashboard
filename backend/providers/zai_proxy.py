"""Experimental Z.ai Anthropic-proxy rate-limit headers probe."""
from __future__ import annotations

from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class ZaiProxyMonitor(ProviderMonitor):
    id = "zai"
    name = "Z.ai (Anthropic proxy)"
    env_var = "ZAI_API_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        # Send a minimal request and inspect response headers for anthropic-ratelimit-*
        payload = {
            "model": "claude-sonnet-4-5",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        }
        try:
            r = await client.post(
                "https://api.z.ai/api/anthropic/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=payload,
            )
        except httpx.HTTPError as e:
            return self._error(f"probe failed: {e}")

        headers = {k.lower(): v for k, v in r.headers.items()}
        rl = {k: v for k, v in headers.items() if k.startswith("anthropic-ratelimit-")}

        out = self._base()
        if not rl:
            out.update(
                {
                    "status": "degraded",
                    "type": "rate_limits",
                    "note": "no anthropic-ratelimit-* headers exposed by proxy; fallback to local tracker",
                    "http_status": r.status_code,
                }
            )
            return out

        def _int(k):
            v = rl.get(k)
            try:
                return int(v) if v is not None else None
            except ValueError:
                return v

        out.update(
            {
                "type": "rate_limits",
                "requests_remaining": _int("anthropic-ratelimit-requests-remaining"),
                "requests_limit": _int("anthropic-ratelimit-requests-limit"),
                "tokens_remaining": _int("anthropic-ratelimit-tokens-remaining"),
                "tokens_limit": _int("anthropic-ratelimit-tokens-limit"),
                "raw": rl,
            }
        )
        return out
