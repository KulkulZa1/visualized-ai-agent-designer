#!/usr/bin/env python3
"""path_scope.py — restrict file operations to the workspace."""
import sys, os
from pathlib import Path

WORKSPACE = Path(os.environ.get("WORKSPACE", ".")).resolve()

def is_safe(path_str: str) -> bool:
    try:
        resolved = (WORKSPACE / path_str).resolve()
        return resolved.is_relative_to(WORKSPACE)
    except Exception:
        return False

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HOOK_INPUT", "")
    if not path:
        print("No path provided.", file=sys.stderr)
        sys.exit(1)
    if is_safe(path):
        print(f"SAFE: {path}")
        sys.exit(0)
    else:
        print(f"BLOCKED: path traversal detected: {path}", file=sys.stderr)
        sys.exit(1)
