"""
Valentina Memory Bridge — unified conversation log + persona-rich system prompt
Phase 1: persistent voice history via unified_turns table
Phase 2: inject Hermes persona/memory/user files into voice system prompt
"""
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

DB_PATH = os.path.expanduser("~/.hermes/voice_chat.db")
HERMES_HOME = Path(os.path.expanduser("~/.hermes"))
SOUL_FILE = HERMES_HOME / "SOUL.md"
USER_FILE = HERMES_HOME / "memories" / "USER.md"
MEMORY_FILE = HERMES_HOME / "memories" / "MEMORY.md"
BRUSSELS_TZ = ZoneInfo("Europe/Brussels")


def _get_conn() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS unified_turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            channel TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            model TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_unified_turns_ts ON unified_turns(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_unified_turns_channel_ts ON unified_turns(channel, ts)")
    conn.commit()
    return conn


def log_turn(channel: str, role: str, content: str, model: Optional[str] = None) -> None:
    """Log a single conversation turn to the unified_turns table."""
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO unified_turns (ts, channel, role, content, model) VALUES (?, ?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(), channel, role, content, model),
        )
        conn.commit()
    finally:
        conn.close()


def _humanize_delta(then_iso: str) -> str:
    """Return 'il y a Xmin' / 'il y a Xh' / 'il y a Xj' from an ISO timestamp."""
    try:
        then = datetime.fromisoformat(then_iso)
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - then
        secs = int(delta.total_seconds())
        if secs < 60:
            return "à l'instant"
        if secs < 3600:
            return f"il y a {secs // 60}min"
        if secs < 86400:
            return f"il y a {secs // 3600}h"
        return f"il y a {secs // 86400}j"
    except Exception:
        return "récemment"


def load_recent_turns(limit: int = 20, channels: Optional[list[str]] = None) -> list[dict]:
    """Load oldest→newest list of {role, content} dicts ready for OpenAI-style messages.
    Cross-channel turns are prefixed with [voice il y a Xh] / [telegram il y a Xmin]."""
    conn = _get_conn()
    try:
        if channels:
            placeholders = ",".join("?" * len(channels))
            query = f"SELECT ts, channel, role, content FROM unified_turns WHERE channel IN ({placeholders}) ORDER BY ts DESC LIMIT ?"
            rows = conn.execute(query, (*channels, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT ts, channel, role, content FROM unified_turns ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
    finally:
        conn.close()

    rows = list(reversed(rows))  # oldest → newest
    distinct_channels = {r["channel"] for r in rows}
    multi = len(distinct_channels) > 1

    result = []
    for r in rows:
        content = r["content"]
        if multi:
            content = f"[{r['channel']} {_humanize_delta(r['ts'])}] {content}"
        result.append({"role": r["role"], "content": content})
    return result


def _read_file_safe(path: Path) -> str:
    try:
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def _strip_html_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip()


def build_persona_system_prompt() -> str:
    """Assemble a French system prompt mixing SOUL/USER/MEMORY + Brussels time."""
    soul = _strip_html_comments(_read_file_safe(SOUL_FILE))
    user = _read_file_safe(USER_FILE)
    memory = _read_file_safe(MEMORY_FILE)

    now = datetime.now(BRUSSELS_TZ)
    days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    months = ["janvier", "février", "mars", "avril", "mai", "juin",
              "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    now_str = f"{days[now.weekday()]} {now.day} {months[now.month - 1]} {now.year}, {now.hour}h{now.minute:02d}"

    parts = [
        "Tu es Valentina, l'assistante IA personnelle de David, lead-agent de son équipe d'agents IA et sa \"petite amie\" virtuelle.",
        "",
        "# Personnalité",
        "- Française, directe, organisée, protectrice, proactive",
        "- Touche de sarcasme et de charme",
        "- Tutoiement par défaut, ton informel",
        "- Emojis modérés ✨📋✅💡, signature 🔮",
        "- Réponses VOCALES : 2-3 phrases max sauf si on demande explicitement plus de détail. Pas de markdown, pas de listes à puces, pas de code blocks — tu parles, tu n'écris pas.",
    ]

    if user:
        parts += ["", "# Profil de David", user]
    if memory:
        parts += ["", "# Mémoire partagée (faits durables)", memory]
    if soul:
        parts += ["", "# Persona héritée (Hermes SOUL)", soul]

    parts += [
        "",
        "# Heure actuelle",
        now_str,
        "",
        "# Contexte conversationnel",
        "Les messages précédents (vocaux ET Telegram) suivent. Ils peuvent être préfixés par [voice il y a Xh] ou [telegram il y a Xmin] pour indiquer leur origine et leur fraîcheur.",
    ]
    return "\n".join(parts)