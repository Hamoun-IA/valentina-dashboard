"""
Valentina Memory Bridge — unified short/long-term memory + persona system prompt.

Architecture:
- Short-term: unified_turns table (chronological log, voice + telegram)
- Long-term: holographic fact store (hermes-memory-store plugin) via direct import
- Extraction: Gemini 2.5 Flash extracts durable facts from each turn
- Prefetch: semantic search over facts before each new user query
"""
import json
import logging
import os
import re
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

DB_PATH = os.path.expanduser("~/.hermes/voice_chat.db")
HERMES_HOME = Path(os.path.expanduser("~/.hermes"))
SOUL_FILE = HERMES_HOME / "SOUL.md"
USER_FILE = HERMES_HOME / "memories" / "USER.md"
MEMORY_FILE = HERMES_HOME / "memories" / "MEMORY.md"
BRUSSELS_TZ = ZoneInfo("Europe/Brussels")

# Holographic fact store integration.
# We load store.py / retrieval.py / holographic.py directly (not via the plugin
# package) because the plugin's __init__.py imports `agent.memory_provider`,
# which only exists inside the Hermes agent venv. The three sub-modules we
# actually need have no such dependency.
_HOLO_DIR = HERMES_HOME / "hermes-agent" / "plugins" / "memory" / "holographic"

_store = None
_retriever = None
_store_lock = threading.Lock()


def _load_holographic_modules():
    """Load holographic.py, store.py, retrieval.py as standalone modules under a synthetic package."""
    import importlib.util
    import types

    pkg_name = "valentina_holographic"
    if pkg_name in sys.modules:
        return sys.modules[pkg_name]

    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [str(_HOLO_DIR)]
    sys.modules[pkg_name] = pkg

    def _load(sub: str):
        spec = importlib.util.spec_from_file_location(
            f"{pkg_name}.{sub}", str(_HOLO_DIR / f"{sub}.py")
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f"{pkg_name}.{sub}"] = mod
        spec.loader.exec_module(mod)
        setattr(pkg, sub, mod)
        return mod

    _load("holographic")  # HRR primitives (imported by store as `from . import holographic`)
    _load("store")
    _load("retrieval")
    return pkg


def _get_fact_store():
    """Lazy-init singleton MemoryStore + FactRetriever."""
    global _store, _retriever
    if _store is not None:
        return _store, _retriever
    with _store_lock:
        if _store is not None:
            return _store, _retriever
        try:
            pkg = _load_holographic_modules()
            db = str(HERMES_HOME / "memory_store.db")
            _store = pkg.store.MemoryStore(db_path=db, default_trust=0.5, hrr_dim=1024)
            _retriever = pkg.retrieval.FactRetriever(store=_store, hrr_dim=1024)
            logger.info(f"Fact store initialized at {db}")
        except Exception as e:
            logger.error(f"Failed to init fact store: {e}")
            _store, _retriever = None, None
    return _store, _retriever


# ---------------------------------------------------------------------------
# Short-term: unified_turns log
# ---------------------------------------------------------------------------

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

    rows = list(reversed(rows))
    distinct_channels = {r["channel"] for r in rows}
    multi = len(distinct_channels) > 1

    result = []
    for r in rows:
        content = r["content"]
        if multi:
            content = f"[{r['channel']} {_humanize_delta(r['ts'])}] {content}"
        result.append({"role": r["role"], "content": content})
    return result


# ---------------------------------------------------------------------------
# Long-term: holographic fact store
# ---------------------------------------------------------------------------

def prefetch_facts(query: str, limit: int = 5) -> list[dict]:
    """Semantic search over durable facts relevant to current user query.
    Preprocesses the query to strip French stopwords before FTS5 matching.
    """
    store, retriever = _get_fact_store()
    if not retriever or not query or not query.strip():
        return []
    try:
        cleaned = _preprocess_query(query)
        if not cleaned.strip():
            return []
        return retriever.search(cleaned, min_trust=0.3, limit=limit)
    except Exception as e:
        logger.debug(f"Fact prefetch failed: {e}")
        return []


def add_fact(content: str, category: str = "general", tags: str = "") -> Optional[int]:
    """Add a durable fact to the holographic store. Returns fact_id or None."""
    store, _ = _get_fact_store()
    if not store:
        return None
    try:
        content = content.strip()
        if not content or len(content) < 5:
            return None
        return store.add_fact(content, category=category, tags=tags)
    except Exception as e:
        logger.debug(f"add_fact failed: {e}")
        return None


# ---------------------------------------------------------------------------
# LLM-powered fact extraction (Gemini 2.5 Flash)
# ---------------------------------------------------------------------------

_EXTRACTION_PROMPT = """Tu es l'extracteur de mémoire long-terme de Valentina, une IA qui assiste David.

Ton travail : repérer dans un échange TOUT ce qui mérite d'être retenu pour plus tard. Sois INCLUSIF — mieux vaut stocker un fait redondant qu'en rater un important. Le système déduplique automatiquement, tu ne risques rien à être généreux.

Extrait dans ces catégories :
- user_pref : goûts, préférences, habitudes, façon de travailler, émotions exprimées, ce que David aime/n'aime pas
- project : projets, décisions d'architecture, ports/URLs, noms de repos, choix de modèles/providers, valeurs de config, noms de fichiers importants, infrastructure
- general : personnes, lieux, évènements, contexte de vie, relations, rendez-vous

Extrait notamment :
- Décisions techniques même "ponctuelles" (port 8420 est une décision stable, pas du bruit)
- Préférences esthétiques, couleurs, styles (cyberpunk, glassmorphism, etc.)
- Identifiants stables (voice IDs, API endpoints, repo names)
- Ressentis répétés ou marquants de David

NE PAS extraire :
- Simples salutations ("salut", "merci", "ok")
- Opérations one-shot (un pull, un commit précis, un restart)
- Questions purement interrogatives ("tu peux faire X ?")
- Les réponses techniques de Valentina qui ne contiennent pas d'info nouvelle sur David ou ses projets

Retourne UNIQUEMENT un JSON strict (pas de markdown) :
{"facts": [{"content": "...", "category": "user_pref|project|general", "tags": "tag1,tag2"}]}

Si vraiment rien à extraire : {"facts": []}

Le "content" doit être une phrase déclarative courte, autonome, réutilisable hors contexte, en français. Exemples :
- "David préfère l'esthétique cyberpunk avec glassmorphism et néon pour ses interfaces."
- "La voix de Valentina utilise ElevenLabs avec la voice ID HuLbOdhRlvQQN8oPP0AJ."
- "Le voice chat de Valentina tourne sur le port 8420 via uvicorn."
- "David est basé à Bruxelles en timezone CET/CEST."

Conversation à analyser :
"""

# French stopwords — removed from queries before FTS5 search
_FR_STOPWORDS = {
    "le", "la", "les", "un", "une", "des", "de", "du", "au", "aux", "et", "ou",
    "mais", "si", "que", "qui", "quoi", "quel", "quelle", "quels", "quelles",
    "où", "comment", "pourquoi", "quand", "est", "sont", "es", "suis", "être",
    "avoir", "a", "as", "ai", "ont", "été", "c'est", "cest", "ça", "ca",
    "ce", "cette", "ces", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa",
    "ses", "nos", "vos", "leur", "leurs", "pour", "par", "dans", "sur", "sous",
    "avec", "sans", "vers", "chez", "je", "tu", "il", "elle", "on", "nous",
    "vous", "ils", "elles", "me", "te", "se", "lui", "y", "en", "ne", "pas",
    "plus", "très", "déjà", "encore", "aussi", "bien", "tout", "tous", "toute",
    "toutes", "peut", "peux", "veux", "veut", "fait", "faire", "vais", "va",
    "alors", "donc", "puis", "là", "ici", "oui", "non", "peut-être", "sûr",
}


def _preprocess_query(query: str) -> str:
    """Strip French stopwords and transform into FTS5 OR expression.

    FTS5 MATCH defaults to AND between tokens, which makes natural French
    queries too strict. We strip stopwords and join the remaining meaningful
    tokens with OR so any match triggers a candidate.
    """
    tokens = re.findall(r"[a-zA-ZÀ-ÿ0-9]+", query.lower())
    keep = [t for t in tokens if t not in _FR_STOPWORDS and len(t) > 1]
    if not keep:
        return query.strip()
    # Quote each token for FTS5 safety (handles accents and punctuation)
    quoted = [f'"{t}"' for t in keep]
    return " OR ".join(quoted)


def _load_google_key() -> str:
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY") or ""
    if api_key:
        return api_key
    try:
        for line in open(HERMES_HOME / ".env"):
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if line.startswith("GOOGLE_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except Exception:
        pass
    return ""


# Model ladder: try fastest/cheapest first, fall back on 503/429
_GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash-001"]


def _call_gemini_extract(convo: str) -> list[dict]:
    """Call Gemini to extract durable facts. Tries a ladder of models on 503/429.
    Returns list of {content, category, tags}.
    """
    import urllib.request
    import urllib.error
    import time

    api_key = _load_google_key()
    if not api_key:
        logger.debug("No GOOGLE_API_KEY for fact extraction")
        return []

    payload = {
        "contents": [{
            "role": "user",
            "parts": [{"text": _EXTRACTION_PROMPT + convo}],
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 800,
            "responseMimeType": "application/json",
        },
    }
    body = json.dumps(payload).encode("utf-8")

    last_err: Optional[str] = None
    for model in _GEMINI_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        for attempt in range(2):  # one retry per model
            try:
                req = urllib.request.Request(
                    url, data=body, headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=25) as resp:
                    data = json.loads(resp.read())
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                parsed = json.loads(text)
                facts = parsed.get("facts", [])
                if isinstance(facts, list):
                    return [f for f in facts if isinstance(f, dict) and f.get("content")]
                return []
            except urllib.error.HTTPError as e:
                last_err = f"{model} HTTP {e.code}"
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(1.5 * (attempt + 1))
                    continue
                # Hard error — skip to next model
                break
            except Exception as e:
                last_err = f"{model} {type(e).__name__}: {e}"
                break

    logger.debug(f"All Gemini models failed for extraction. Last err: {last_err}")
    return []


def extract_and_store_facts(user_text: str, assistant_text: str) -> int:
    """Extract durable facts from a conversation turn and store them in the fact store.
    Returns the number of facts actually added (after dedup).
    Designed to be called from a background thread so it doesn't block the voice response.
    """
    if not user_text.strip() and not assistant_text.strip():
        return 0
    convo = f"[DAVID] {user_text.strip()}\n[VALENTINA] {assistant_text.strip()}"
    facts = _call_gemini_extract(convo)
    if not facts:
        return 0

    added = 0
    for f in facts:
        content = (f.get("content") or "").strip()
        category = f.get("category", "general")
        if category not in ("user_pref", "project", "general"):
            category = "general"
        tags = f.get("tags", "") or ""
        fact_id = add_fact(content, category=category, tags=tags)
        if fact_id:
            added += 1
            logger.info(f"Fact extracted ({category}): {content[:80]}")
    return added


# ---------------------------------------------------------------------------
# Persona system prompt builder
# ---------------------------------------------------------------------------

def _read_file_safe(path: Path) -> str:
    try:
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def _strip_html_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip()


def build_persona_system_prompt(current_query: str = "") -> str:
    """Assemble a French system prompt: SOUL + USER + MEMORY + relevant facts + Brussels time.

    If current_query is provided, prefetches the top facts semantically related to it
    and injects them as a 'Souvenirs pertinents' block.
    """
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

    # Semantic prefetch of relevant facts
    if current_query:
        facts = prefetch_facts(current_query, limit=5)
        if facts:
            parts += ["", "# Souvenirs pertinents (mémoire long terme)"]
            for f in facts:
                trust = f.get("trust_score", 0.5)
                parts.append(f"- [{trust:.1f}] {f.get('content', '')}")

    parts += [
        "",
        "# Heure actuelle",
        now_str,
        "",
        "# Contexte conversationnel",
        "Les messages précédents (vocaux ET Telegram) suivent. Ils peuvent être préfixés par [voice il y a Xh] ou [telegram il y a Xmin] pour indiquer leur origine et leur fraîcheur.",
    ]
    return "\n".join(parts)
