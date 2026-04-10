"""Dispatcher: orchestrates all provider monitors with SQLite 5-min cache."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from .base import ProviderMonitor
from .elevenlabs import ElevenLabsMonitor
from .fal import FalMonitor
from .openrouter import OpenRouterMonitor
from .runpod import RunPodMonitor
from .tavily import TavilyMonitor
from .xai import XaiMonitor
from .zai_proxy import ZaiProxyMonitor

CACHE_TTL_SECONDS = 300  # 5 minutes
DB_PATH = Path.home() / ".hermes" / "dashboard.db"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_monitors() -> List[ProviderMonitor]:
    return [
        OpenRouterMonitor(),
        ElevenLabsMonitor(),
        FalMonitor(),
        RunPodMonitor(),
        TavilyMonitor(),
        XaiMonitor(),
        ZaiProxyMonitor(),
    ]


def _ensure_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_snapshots (
            provider_id TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            fetched_at TIMESTAMP NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def _load_cache() -> Dict[str, Dict[str, Any]]:
    conn = _ensure_db()
    try:
        rows = conn.execute(
            "SELECT provider_id, data_json, fetched_at FROM provider_snapshots"
        ).fetchall()
    finally:
        conn.close()
    out = {}
    for pid, data_json, fetched_at in rows:
        try:
            out[pid] = {
                "data": json.loads(data_json),
                "fetched_at_ts": float(fetched_at),
            }
        except (json.JSONDecodeError, ValueError):
            continue
    return out


def _save_cache(snapshots: List[Dict[str, Any]]) -> None:
    conn = _ensure_db()
    try:
        now = time.time()
        for snap in snapshots:
            pid = snap.get("id")
            if not pid:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO provider_snapshots (provider_id, data_json, fetched_at) VALUES (?, ?, ?)",
                (pid, json.dumps(snap), now),
            )
        conn.commit()
    finally:
        conn.close()


async def _fetch_all() -> List[Dict[str, Any]]:
    monitors = build_monitors()
    results = await asyncio.gather(
        *(m.fetch() for m in monitors), return_exceptions=True
    )
    out: List[Dict[str, Any]] = []
    for m, r in zip(monitors, results):
        if isinstance(r, Exception):
            out.append(
                {
                    "id": m.id,
                    "name": m.name,
                    "status": "error",
                    "error": f"{type(r).__name__}: {r}",
                    "fetched_at": _now_iso(),
                }
            )
        else:
            out.append(r)
    return out


async def get_live_providers(force: bool = False) -> Dict[str, Any]:
    """Return unified live-provider payload. Uses 5-min cache unless force=True."""
    cache = {} if force else _load_cache()
    now = time.time()

    providers: List[Dict[str, Any]] = []
    expected_ids = {m.id for m in build_monitors()}
    cache_ok = (
        not force
        and expected_ids.issubset(cache.keys())
        and all(
            (now - cache[pid]["fetched_at_ts"]) < CACHE_TTL_SECONDS
            for pid in expected_ids
        )
    )

    if cache_ok:
        for pid in expected_ids:
            providers.append(cache[pid]["data"])
        updated_at = _now_iso()
        source = "cache"
    else:
        providers = await _fetch_all()
        _save_cache(providers)
        updated_at = _now_iso()
        source = "live"

    # Stable ordering
    order = [
        "openrouter",
        "elevenlabs",
        "fal",
        "runpod",
        "tavily",
        "xai",
        "zai_proxy",
    ]
    providers.sort(key=lambda p: order.index(p["id"]) if p.get("id") in order else 999)

    return {
        "updated_at": updated_at,
        "source": source,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
        "providers": providers,
    }
