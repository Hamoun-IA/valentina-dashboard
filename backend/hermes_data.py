"""
Hermes Data Layer — Extracts analytics from Hermes Agent state DB and config.
"""
import sqlite3
import os
import json
import yaml
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

HERMES_DIR = Path.home() / ".hermes"
STATE_DB = HERMES_DIR / "state.db"
CONFIG_FILE = HERMES_DIR / "config.yaml"
ENV_FILE = HERMES_DIR / ".env"

# Provider metadata
PROVIDERS = {
    "anthropic": {"name": "Anthropic", "color": "#d97706", "icon": "🧠", "tier": "premium"},
    "openai-codex": {"name": "OpenAI Codex", "color": "#10b981", "icon": "💻", "tier": "free"},
    "zai": {"name": "Z.ai GLM", "color": "#3b82f6", "icon": "⚡", "tier": "plan"},
    "minimax": {"name": "MiniMax", "color": "#8b5cf6", "icon": "🔮", "tier": "plan"},
    "gemini": {"name": "Google Gemini", "color": "#ef4444", "icon": "💎", "tier": "paygo"},
    "openrouter": {"name": "OpenRouter", "color": "#06b6d4", "icon": "🌐", "tier": "free"},
    "deepseek": {"name": "DeepSeek", "color": "#22c55e", "icon": "🔍", "tier": "paygo"},
    "xai": {"name": "xAI Grok", "color": "#f43f5e", "icon": "🚀", "tier": "paygo"},
    "nous": {"name": "NousResearch", "color": "#a855f7", "icon": "🔬", "tier": "credits"},
    "fal": {"name": "FAL.ai", "color": "#f97316", "icon": "🎨", "tier": "paygo"},
    "elevenlabs": {"name": "ElevenLabs", "color": "#ec4899", "icon": "🎙️", "tier": "paygo"},
    "runpod": {"name": "RunPod", "color": "#14b8a6", "icon": "🖥️", "tier": "paygo"},
}

MODELS_MAP = {
    "claude-opus-4-6": {"provider": "anthropic", "role": "Cerveau principal"},
    "gpt-5.3-codex": {"provider": "openai-codex", "role": "Coding"},
    "glm-5-turbo": {"provider": "zai", "role": "Coding (plan)"},
    "MiniMax-M2.7": {"provider": "minimax", "role": "Généraliste"},
    "gemini-3.1-pro-preview": {"provider": "gemini", "role": "Analyse"},
    "gemini-3-flash-preview": {"provider": "gemini", "role": "Tâches rapides"},
    "deepseek-chat": {"provider": "deepseek", "role": "Polyvalent"},
    "grok-4-1-fast-reasoning": {"provider": "xai", "role": "Workhorse"},
    "grok-4-1-fast-non-reasoning": {"provider": "xai", "role": "Workhorse"},
    "qwen/qwen3.6-plus:free": {"provider": "openrouter", "role": "Volume/Batch"},
}


def _get_db():
    if not STATE_DB.exists():
        return None
    conn = sqlite3.connect(str(STATE_DB))
    conn.row_factory = sqlite3.Row
    return conn


def get_overview() -> dict[str, Any]:
    """Dashboard overview stats."""
    conn = _get_db()
    if not conn:
        return {"error": "No Hermes state DB found"}

    try:
        cur = conn.cursor()

        # Total sessions
        cur.execute("SELECT COUNT(*) FROM sessions")
        total_sessions = cur.fetchone()[0]

        # Total messages
        cur.execute("SELECT COUNT(*) FROM messages")
        total_messages = cur.fetchone()[0]

        # Total tokens
        cur.execute("""
            SELECT 
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                COALESCE(SUM(reasoning_tokens), 0) as total_reasoning,
                COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
                COALESCE(SUM(tool_call_count), 0) as total_tools,
                COALESCE(SUM(estimated_cost_usd), 0) as total_cost
            FROM sessions
        """)
        row = cur.fetchone()

        # Today's activity
        today_start = datetime.now().replace(hour=0, minute=0, second=0).timestamp()
        cur.execute("SELECT COUNT(*) FROM sessions WHERE started_at >= ?", (today_start,))
        today_sessions = cur.fetchone()[0]

        cur.execute("""
            SELECT COUNT(*) FROM messages m 
            JOIN sessions s ON m.session_id = s.id 
            WHERE m.timestamp >= ?
        """, (today_start,))
        today_messages = cur.fetchone()[0]

        # Most used model
        cur.execute("""
            SELECT model, COUNT(*) as cnt, SUM(message_count) as msgs 
            FROM sessions WHERE model IS NOT NULL
            GROUP BY model ORDER BY cnt DESC LIMIT 5
        """)
        model_usage = [{"model": r[0], "sessions": r[1], "messages": r[2]} for r in cur.fetchall()]

        # Sessions by source
        cur.execute("""
            SELECT source, COUNT(*) as cnt FROM sessions 
            GROUP BY source ORDER BY cnt DESC
        """)
        by_source = {r[0]: r[1] for r in cur.fetchall()}

        return {
            "total_sessions": total_sessions,
            "total_messages": total_messages,
            "total_input_tokens": row[0],
            "total_output_tokens": row[1],
            "total_reasoning_tokens": row[2],
            "total_cache_read_tokens": row[3],
            "total_tool_calls": row[4],
            "total_estimated_cost": round(row[5], 4),
            "today_sessions": today_sessions,
            "today_messages": today_messages,
            "model_usage": model_usage,
            "sessions_by_source": by_source,
        }
    finally:
        conn.close()


def get_sessions(limit: int = 20) -> list[dict]:
    """Recent sessions with details."""
    conn = _get_db()
    if not conn:
        return []

    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, source, model, billing_provider, message_count, 
                   tool_call_count, input_tokens, output_tokens, reasoning_tokens,
                   estimated_cost_usd, title, 
                   datetime(started_at, 'unixepoch') as started,
                   datetime(ended_at, 'unixepoch') as ended,
                   end_reason
            FROM sessions 
            ORDER BY started_at DESC LIMIT ?
        """, (limit,))

        sessions = []
        for row in cur.fetchall():
            sessions.append({
                "id": row[0][:8] + "...",
                "source": row[1],
                "model": row[2],
                "provider": row[3],
                "messages": row[4],
                "tool_calls": row[5],
                "input_tokens": row[6],
                "output_tokens": row[7],
                "reasoning_tokens": row[8],
                "cost": round(row[9], 4) if row[9] else 0,
                "title": row[10] or "Sans titre",
                "started": row[11],
                "ended": row[12],
                "end_reason": row[13],
            })
        return sessions
    finally:
        conn.close()


def get_providers_status() -> list[dict]:
    """Status and info for all configured providers."""
    results = []
    for pid, meta in PROVIDERS.items():
        results.append({
            "id": pid,
            "name": meta["name"],
            "color": meta["color"],
            "icon": meta["icon"],
            "tier": meta["tier"],
            "status": "active",
        })
    return results


def get_token_usage_by_provider() -> list[dict]:
    """Token usage broken down by billing provider."""
    conn = _get_db()
    if not conn:
        return []

    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT billing_provider,
                   COUNT(*) as sessions,
                   COALESCE(SUM(input_tokens), 0) as input_t,
                   COALESCE(SUM(output_tokens), 0) as output_t,
                   COALESCE(SUM(tool_call_count), 0) as tools,
                   COALESCE(SUM(estimated_cost_usd), 0) as cost
            FROM sessions 
            WHERE billing_provider IS NOT NULL
            GROUP BY billing_provider
        """)
        return [
            {
                "provider": r[0],
                "sessions": r[1],
                "input_tokens": r[2],
                "output_tokens": r[3],
                "tool_calls": r[4],
                "cost": round(r[5], 4),
            }
            for r in cur.fetchall()
        ]
    finally:
        conn.close()


def get_activity_timeline(days: int = 7) -> list[dict]:
    """Hourly activity over the last N days."""
    conn = _get_db()
    if not conn:
        return []

    try:
        cur = conn.cursor()
        since = (datetime.now() - timedelta(days=days)).timestamp()
        cur.execute("""
            SELECT 
                strftime('%Y-%m-%d %H:00', timestamp, 'unixepoch') as hour,
                COUNT(*) as msg_count
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE m.timestamp >= ?
            GROUP BY hour
            ORDER BY hour
        """, (since,))
        return [{"hour": r[0], "messages": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()


def get_tool_usage() -> list[dict]:
    """Most used tools across all sessions."""
    conn = _get_db()
    if not conn:
        return []

    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT tool_name, COUNT(*) as cnt
            FROM messages 
            WHERE tool_name IS NOT NULL AND tool_name != ''
            GROUP BY tool_name
            ORDER BY cnt DESC
            LIMIT 15
        """)
        return [{"tool": r[0], "count": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()


def get_cron_jobs() -> list[dict]:
    """Active cron jobs."""
    cron_dir = HERMES_DIR / "cron"
    jobs_file = cron_dir / "jobs.json"
    if not jobs_file.exists():
        return []
    try:
        with open(jobs_file) as f:
            data = json.load(f)
        return data if isinstance(data, list) else data.get("jobs", [])
    except:
        return []
