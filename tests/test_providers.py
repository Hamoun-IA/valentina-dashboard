"""Basic sanity tests for provider monitors."""
import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.providers.base import ProviderMonitor  # noqa: E402
from backend.providers.deepseek import DeepSeekMonitor  # noqa: E402
from backend.providers.elevenlabs import ElevenLabsMonitor  # noqa: E402
from backend.providers.fal import FalMonitor  # noqa: E402
from backend.providers.openrouter import OpenRouterMonitor  # noqa: E402
from backend.providers.runpod import RunPodMonitor  # noqa: E402
from backend.providers.tavily import TavilyMonitor  # noqa: E402
from backend.providers.zai_proxy import ZaiProxyMonitor  # noqa: E402
from backend.providers.live_api import build_monitors, get_live_providers  # noqa: E402


MONITOR_CLASSES = [
    DeepSeekMonitor,
    OpenRouterMonitor,
    ElevenLabsMonitor,
    FalMonitor,
    RunPodMonitor,
    TavilyMonitor,
    ZaiProxyMonitor,
]


@pytest.mark.parametrize("cls", MONITOR_CLASSES)
def test_monitor_instantiation(cls):
    m = cls(api_key=None)
    assert isinstance(m, ProviderMonitor)
    assert m.id
    assert m.name


@pytest.mark.parametrize("cls", MONITOR_CLASSES)
def test_monitor_missing_key_returns_error(cls, monkeypatch):
    # Tavily has a hardcoded fallback -> skip the "no key" contract
    if cls is TavilyMonitor:
        pytest.skip("Tavily uses a hardcoded fallback key")
    # Strip env var if present
    if cls.env_var:
        monkeypatch.delenv(cls.env_var, raising=False)
    m = cls(api_key=None)
    result = asyncio.get_event_loop().run_until_complete(m.fetch()) \
        if not hasattr(asyncio, "run") else asyncio.run(m.fetch())
    assert result["status"] == "error"
    assert result["error"]
    assert result["id"] == cls.id


def test_build_monitors_returns_seven():
    assert len(build_monitors()) == 7


def test_get_live_providers_shape(monkeypatch):
    # Use cached/fresh fetch; monkey-patch monitors to synchronous stubs to avoid network
    import backend.providers.live_api as live

    class StubMonitor:
        id = "stub"
        name = "Stub"

        async def fetch(self):
            return {"id": "stub", "name": "Stub", "status": "ok", "type": "balance_usd", "balance": 1.0, "fetched_at": "x", "error": None}

    monkeypatch.setattr(live, "build_monitors", lambda: [StubMonitor()])
    result = asyncio.run(live.get_live_providers(force=True))
    assert "providers" in result
    assert "updated_at" in result
    assert any(p["id"] == "stub" for p in result["providers"])
