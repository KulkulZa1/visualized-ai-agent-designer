#!/usr/bin/env bash
# destructive_guard.sh — block destructive operations
set -euo pipefail

INPUT="${HOOK_INPUT:-${1:-}}"
DANGER_PATTERNS=("rm -rf" "rmdir" "DROP TABLE" "TRUNCATE" "DELETE FROM" "format" "mkfs")

for pattern in "${DANGER_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: destructive operation detected: $pattern" >&2
    echo "Set ALLOW_DESTRUCTIVE=1 to override." >&2
    [[ "${ALLOW_DESTRUCTIVE:-0}" == "1" ]] && echo "Override active — proceeding." && exit 0
    exit 1
  fi
done

echo "SAFE: no destructive patterns detected."
exit 0
