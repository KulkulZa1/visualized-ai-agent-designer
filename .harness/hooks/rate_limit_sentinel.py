#!/usr/bin/env python3
"""
rate_limit_sentinel.py — Detects Anthropic API rate limit status.

Reads .harness/state/rate_limit.json. If a rate limit is active:
  - Sets CLAUDE_RATE_LIMITED=1 in the session environment
  - Signals workers to use their fallback models (GPT 5.5 tiers)

Rate limit state file format:
{
    "anthropic": {
        "limited": true,
        "since": "2026-05-16T14:30:00Z",
        "reset_at": "2026-05-16T15:30:00Z"
    }
}

Workers check the environment variable CLAUDE_RATE_LIMITED to decide
whether to use their primary (Claude) or fallback (GPT) model.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE   = Path(os.environ.get("WORKSPACE", "."))
STATE_FILE  = WORKSPACE / ".harness" / "state" / "rate_limit.json"
ENV_VAR     = "CLAUDE_RATE_LIMITED"

def load_state() -> dict:
    try:
        state = json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return state if isinstance(state, dict) else {}

def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))

def check_rate_limit(state: dict) -> tuple[bool, str]:
    """Returns (is_limited, reason)."""
    anthropic = state.get("anthropic", {})
    if not anthropic.get("limited"):
        return False, "no rate limit active"

    reset_at_str = anthropic.get("reset_at")
    if reset_at_str:
        try:
            reset_at = datetime.fromisoformat(reset_at_str.replace("Z", "+00:00"))
            if reset_at.tzinfo is None:
                reset_at = reset_at.replace(tzinfo=timezone.utc)  # naive timestamps are UTC
            now = datetime.now(timezone.utc)
            if now >= reset_at:
                # Rate limit has expired — clear it
                anthropic["limited"] = False
                state["anthropic"] = anthropic
                save_state(state)
                return False, f"rate limit expired at {reset_at_str}"
            seconds_left = int((reset_at - now).total_seconds())
            return True, f"rate limited until {reset_at_str} (~{seconds_left}s remaining)"
        except ValueError:
            pass

    return True, "rate limit active (no reset time)"

def main() -> int:
    # Hook stdout is a pipe; on Windows it defaults to the ANSI code page (e.g. cp949),
    # which cannot encode the status symbols printed below.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    state = load_state()
    is_limited, reason = check_rate_limit(state)

    # Write sentinel result for downstream agents
    sentinel_file = WORKSPACE / ".harness" / "state" / "sentinel_result.json"
    sentinel_file.parent.mkdir(parents=True, exist_ok=True)
    sentinel_file.write_text(json.dumps({
        "limited": is_limited,
        "reason": reason,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2))

    if is_limited:
        os.environ[ENV_VAR] = "1"
        print(f"⚠  RATE LIMIT ACTIVE: {reason}")
        print(f"   Workers will use fallback models (GPT 5.5 tiers)")
        print(f"   Set {ENV_VAR}=1 in worker environment")
    else:
        os.environ.pop(ENV_VAR, None)
        print(f"✓  No rate limit: {reason}")
        print(f"   Workers will use primary models (Claude)")

    return 0  # sentinel always succeeds — it's informational, not a blocker

if __name__ == "__main__":
    sys.exit(main())
