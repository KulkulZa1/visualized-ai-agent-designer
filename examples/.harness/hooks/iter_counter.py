#!/usr/bin/env python3
"""iter_counter.py — prevent runaway agent loops."""
import os, sys
from pathlib import Path

MAX_ITER  = int(os.environ.get("MAX_ITER", "3"))
WORKSPACE = Path(os.environ.get("WORKSPACE", "."))
STATE_FILE = WORKSPACE / ".harness" / "state" / "iter.txt"

def read_iter() -> int:
    try:
        return int(STATE_FILE.read_text().strip())
    except Exception:
        return 0

def write_iter(n: int) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(str(n))

current = read_iter()
print(f"Iteration {current + 1} / {MAX_ITER}")

if current >= MAX_ITER:
    print(f"BLOCKED: max iterations ({MAX_ITER}) reached.", file=sys.stderr)
    sys.exit(1)

write_iter(current + 1)
print("Proceeding.")
sys.exit(0)
