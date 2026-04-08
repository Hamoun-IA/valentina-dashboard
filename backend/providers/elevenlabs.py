"""ElevenLabs character quota monitor."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

import httpx

from .base import ProviderMonitor


class ElevenLabsMonitor(ProviderMonitor):
    id = "elevenlabs"
    name = "ElevenLabs"
    env_var = "ELEVENLABS_API_KEY"

    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        r = await client.get(
            "https://api.elevenlabs.io/v1/user/subscription",
            headers={"xi-api-key": self.api_key},
        )
        if r.status_code == 401:
            # Key lacks user_read permission – degraded but known
            out = self._base()
            out.update(
                {
                    "status": "degraded",
                    "type": "quota_chars",
                    "error": "API key missing user_read permission",
                }
            )
            return out
        r.raise_for_status()
        data = r.json()
        used = int(data.get("character_count", 0))
        limit = int(data.get("character_limit", 0))
        reset_unix = data.get("next_character_count_reset_unix")
        reset_iso = None
        if reset_unix:
            reset_iso = (
                datetime.fromtimestamp(int(reset_unix), tz=timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        out = self._base()
        out.update(
            {
                "type": "quota_chars",
                "used": used,
                "limit": limit,
                "reset_at": reset_iso,
                "raw": data,
            }
        )
        return out
