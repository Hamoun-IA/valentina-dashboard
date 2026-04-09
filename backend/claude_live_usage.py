"""Scrape Claude Code /usage TUI via tmux for live subscription quota data."""

from __future__ import annotations

import re
import shutil
import subprocess
import time
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

TMUX_SESSION = "claude-usage-scrape"
WORKING_DIR = "/root/valentina-dashboard"
CACHE_PATH = Path.home() / ".hermes" / "claude_live_usage_cache.json"
STATE_PATH = Path.home() / ".hermes" / "claude_live_usage_state.json"
# Timing
CLAUDE_STARTUP_WAIT = 4.0
TRUST_PROMPT_WAIT = 2.0
USAGE_RENDER_WAIT = 3.0
CAPTURE_RETRIES = 3
CAPTURE_RETRY_DELAY = 1.5
SUCCESS_TTL_SECONDS = 5 * 60
FAILURE_BACKOFF_SECONDS = 15 * 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_cached_snapshot() -> Dict[str, Any] | None:
    try:
        if not CACHE_PATH.exists():
            return None
        data = json.loads(CACHE_PATH.read_text())
        if not isinstance(data, dict):
            return None
        if not data.get("available"):
            return None
        return data
    except Exception:
        return None


def _save_cached_snapshot(payload: Dict[str, Any]) -> None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(payload))
    except Exception:
        pass


def _load_state() -> Dict[str, Any]:
    try:
        if not STATE_PATH.exists():
            return {}
        data = json.loads(STATE_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_state(payload: Dict[str, Any]) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(payload))
    except Exception:
        pass


def _ts_from_iso(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _with_cache_fallback(
    fetched_at: str, reason: str, raw_excerpt: str | None
) -> Dict[str, Any]:
    _save_state({"last_failure_at": fetched_at, "last_failure_reason": reason})
    cached = _load_cached_snapshot()
    now_ts = _ts_from_iso(fetched_at) or time.time()
    failure_ts = _ts_from_iso(fetched_at)
    retry_in_seconds = FAILURE_BACKOFF_SECONDS - (now_ts - (failure_ts or now_ts))
    retry_at_iso = _now_iso()
    if retry_in_seconds > 0:
        retry_dt = datetime.fromtimestamp(now_ts + retry_in_seconds, tz=timezone.utc)
        retry_at_iso = retry_dt.isoformat().replace("+00:00", "Z")
    if cached:
        cached_payload = dict(cached)
        cached_payload.update(
            {
                "available": True,
                "stale": True,
                "live_available": False,
                "source": "claude_tui_usage_cache",
                "fetched_at": fetched_at,
                "cached_fetched_at": cached.get("fetched_at"),
                "reason": reason,
                "raw_excerpt": raw_excerpt,
                "backoff_active": True,
                "retry_in_seconds": max(0, int(retry_in_seconds)),
                "retry_at": retry_at_iso,
            }
        )
        return cached_payload

    return {
        "available": False,
        "source": "claude_tui_usage",
        "fetched_at": fetched_at,
        "reason": reason,
        "raw_excerpt": raw_excerpt,
        "stale": False,
        "live_available": False,
        "backoff_active": True,
        "retry_in_seconds": max(0, int(retry_in_seconds)),
        "retry_at": retry_at_iso,
    }


def _run(cmd: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _tmux_has_session() -> bool:
    r = _run(["tmux", "has-session", "-t", TMUX_SESSION])
    return r.returncode == 0


def _tmux_send_keys(keys: str) -> None:
    _run(["tmux", "send-keys", "-t", TMUX_SESSION, keys, ""])


def _tmux_send_enter() -> None:
    _run(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"])


def _tmux_capture() -> str:
    r = _run(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p", "-S", "-200"])
    return r.stdout


def _ensure_claude_session() -> str | None:
    """Ensure a tmux session exists with claude running. Returns error string or None."""
    if not shutil.which("tmux"):
        return "tmux not found on PATH"
    if not shutil.which("claude"):
        return "claude CLI not found on PATH"

    if _tmux_has_session():
        # Session already exists -- check if claude is responsive
        return None

    # Create new session running claude
    r = _run(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            TMUX_SESSION,
            "-x",
            "200",
            "-y",
            "50",
        ]
    )
    if r.returncode != 0:
        return f"tmux new-session failed: {r.stderr.strip()}"

    # Start claude inside the session
    _run(
        [
            "tmux",
            "send-keys",
            "-t",
            TMUX_SESSION,
            f"cd {WORKING_DIR} && claude",
            "Enter",
        ]
    )
    time.sleep(CLAUDE_STARTUP_WAIT)

    # Handle possible trust/workspace prompt -- press Enter to accept default
    pane_text = _tmux_capture()
    if (
        "trust" in pane_text.lower()
        or "workspace" in pane_text.lower()
        or "?" in pane_text
    ):
        _tmux_send_enter()
        time.sleep(TRUST_PROMPT_WAIT)

    return None


def _send_usage_and_capture() -> str:
    """Send /usage command and capture the resulting pane text."""
    # Send Escape first to clear any transient dialog, then /usage.
    _run(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"])
    time.sleep(0.3)
    _run(["tmux", "send-keys", "-t", TMUX_SESSION, "/usage", "Enter"])
    time.sleep(USAGE_RENDER_WAIT)

    # Capture with retries -- sometimes the TUI takes a moment.
    for attempt in range(CAPTURE_RETRIES):
        text = _tmux_capture()
        if "used" in text.lower() and "reset" in text.lower():
            return text
        if attempt < CAPTURE_RETRIES - 1:
            time.sleep(CAPTURE_RETRY_DELAY)

    return _tmux_capture()


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*used", re.IGNORECASE)
_RESETS_RE = re.compile(r"Resets?\s+(.+?\))", re.IGNORECASE)
_SPENT_RE = re.compile(r"\$\s*([\d.]+)\s*/\s*\$\s*([\d.]+)\s*spent", re.IGNORECASE)


def _clean_raw_excerpt(raw: str) -> str:
    """Reduce captured tmux noise and keep only the useful /usage block."""
    lines = [line.rstrip() for line in raw.splitlines() if line.strip()]
    cleaned: list[str] = []
    started = False
    for line in lines:
        lower = line.lower()
        if not started and (
            "status   config   usage   stats" in lower
            or lower.startswith("current session")
        ):
            started = True
        if not started:
            continue
        if "status dialog dismissed" in lower:
            continue
        if line.strip() == "❯ /usage":
            continue
        cleaned.append(line)
    if not cleaned:
        cleaned = lines[-25:]
    return "\n".join(cleaned[-25:])


def _parse_section(text: str) -> Dict[str, Any]:
    """Parse a single usage section line/block into structured data."""
    result: Dict[str, Any] = {}

    m = _PCT_RE.search(text)
    if m:
        result["used_percent"] = float(m.group(1))

    m = _RESETS_RE.search(text)
    if m:
        result["resets_text"] = m.group(1).strip()

    m = _SPENT_RE.search(text)
    if m:
        result["spent_usd"] = float(m.group(1))
        result["limit_usd"] = float(m.group(2))

    return result


# Patterns to identify which section a line belongs to
_SECTION_PATTERNS = [
    ("current_session", re.compile(r"current\s+session", re.IGNORECASE)),
    (
        "current_week_all_models",
        re.compile(r"current\s+week\s*\(all\s+models\)", re.IGNORECASE),
    ),
    ("current_week_sonnet", re.compile(r"current\s+week\s*\(sonnet", re.IGNORECASE)),
    ("extra_usage", re.compile(r"extra\s+usage", re.IGNORECASE)),
]


def _parse_usage_output(raw: str) -> Dict[str, Any]:
    """Parse the full captured TUI output into structured sections."""
    lines = raw.splitlines()

    # First pass: find which lines are section headers and group subsequent lines
    section_blocks: list[tuple[str, list[str]]] = []  # (key, lines_in_section)
    current_key: str | None = None
    current_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        matched_key = None
        for key, pattern in _SECTION_PATTERNS:
            if pattern.search(stripped):
                matched_key = key
                break
        if matched_key:
            if current_key:
                section_blocks.append((current_key, current_lines))
            current_key = matched_key
            current_lines = [stripped]
        elif current_key:
            current_lines.append(stripped)

    if current_key:
        section_blocks.append((current_key, current_lines))

    # Parse each section block
    sections_found: Dict[str, Dict[str, Any]] = {}
    for key, block_lines in section_blocks:
        block_text = " ".join(block_lines)
        parsed = _parse_section(block_text)
        if parsed:
            sections_found[key] = parsed

    return sections_found


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def scrape_claude_live_usage() -> Dict[str, Any]:
    """Main entry point: scrape Claude Code /usage and return structured data."""
    fetched_at = _now_iso()
    now_ts = _ts_from_iso(fetched_at) or time.time()
    cached = _load_cached_snapshot()
    state = _load_state()

    cached_ts = _ts_from_iso(cached.get("fetched_at")) if cached else None
    if cached and cached_ts and (now_ts - cached_ts) < SUCCESS_TTL_SECONDS:
        cached_payload = dict(cached)
        cached_payload.update(
            {
                "available": True,
                "stale": False,
                "live_available": True,
                "source": "claude_tui_usage_cache",
                "fetched_at": fetched_at,
                "cached_fetched_at": cached.get("fetched_at"),
                "reason": "using recent cached Claude /usage snapshot",
                "cached": True,
                "backoff_active": False,
            }
        )
        return cached_payload

    failure_ts = _ts_from_iso(state.get("last_failure_at"))
    if failure_ts and (now_ts - failure_ts) < FAILURE_BACKOFF_SECONDS:
        reason = f"Claude /usage backoff active after recent failure: {state.get('last_failure_reason') or 'unknown error'}"
        retry_in_seconds = int(FAILURE_BACKOFF_SECONDS - (now_ts - failure_ts))
        retry_dt = datetime.fromtimestamp(now_ts + retry_in_seconds, tz=timezone.utc)
        retry_at_iso = retry_dt.isoformat().replace("+00:00", "Z")
        if cached:
            cached_payload = dict(cached)
            cached_payload.update(
                {
                    "available": True,
                    "stale": True,
                    "live_available": False,
                    "source": "claude_tui_usage_cache",
                    "fetched_at": fetched_at,
                    "cached_fetched_at": cached.get("fetched_at"),
                    "reason": reason,
                    "raw_excerpt": None,
                    "backoff_active": True,
                    "retry_in_seconds": retry_in_seconds,
                    "retry_at": retry_at_iso,
                }
            )
            return cached_payload
        return {
            "available": False,
            "source": "claude_tui_usage",
            "fetched_at": fetched_at,
            "reason": reason,
            "raw_excerpt": None,
            "stale": False,
            "live_available": False,
            "backoff_active": True,
            "retry_in_seconds": retry_in_seconds,
            "retry_at": retry_at_iso,
        }

    try:
        err = _ensure_claude_session()
    except (subprocess.TimeoutExpired, OSError) as exc:
        return _with_cache_fallback(
            fetched_at, f"failed to set up tmux session: {exc}", None
        )

    if err:
        return _with_cache_fallback(fetched_at, err, None)

    try:
        raw = _send_usage_and_capture()
    except (subprocess.TimeoutExpired, OSError) as exc:
        return _with_cache_fallback(
            fetched_at, f"failed to capture usage output: {exc}", None
        )

    raw_excerpt = _clean_raw_excerpt(raw)

    sections = _parse_usage_output(raw_excerpt)

    if not sections:
        return _with_cache_fallback(
            fetched_at,
            "could not parse any usage sections from TUI output",
            raw_excerpt,
        )

    payload = {
        "available": True,
        "source": "claude_tui_usage",
        "fetched_at": fetched_at,
        "cached_fetched_at": fetched_at,
        "raw_excerpt": raw_excerpt,
        "stale": False,
        "live_available": True,
        "current_session": sections.get("current_session"),
        "current_week_all_models": sections.get("current_week_all_models"),
        "current_week_sonnet": sections.get("current_week_sonnet"),
        "extra_usage": sections.get("extra_usage"),
        "backoff_active": False,
    }
    _save_cached_snapshot(payload)
    _save_state(
        {
            "last_success_at": fetched_at,
            "last_failure_at": None,
            "last_failure_reason": None,
        }
    )
    return payload


if __name__ == "__main__":
    import json as _json

    result = scrape_claude_live_usage()
    print(_json.dumps(result, indent=2))
