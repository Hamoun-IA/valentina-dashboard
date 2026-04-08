"""Abstract base class for provider monitors."""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

DEFAULT_TIMEOUT = 10.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ProviderMonitor(ABC):
    """Base class for a single provider monitor."""

    id: str = "unknown"
    name: str = "Unknown"
    env_var: Optional[str] = None

    def __init__(self, api_key: Optional[str] = None):
        if api_key is None and self.env_var:
            api_key = os.getenv(self.env_var)
        self.api_key = api_key

    def _base(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "status": "ok",
            "fetched_at": _now_iso(),
            "error": None,
        }

    def _error(self, msg: str) -> Dict[str, Any]:
        base = self._base()
        base.update({"status": "error", "error": msg})
        return base

    async def fetch(self) -> Dict[str, Any]:
        if not self.api_key:
            return self._error(f"Missing API key ({self.env_var})")
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
                return await self._fetch(client)
        except httpx.TimeoutException:
            return self._error("timeout")
        except httpx.HTTPError as e:
            return self._error(f"http error: {e}")
        except Exception as e:  # noqa: BLE001
            return self._error(f"{type(e).__name__}: {e}")

    @abstractmethod
    async def _fetch(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        ...
