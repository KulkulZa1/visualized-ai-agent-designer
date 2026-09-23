#!/usr/bin/env bash
# destructive_guard.sh — block destructive operations
set -euo pipefail

INPUT="${HOOK_INPUT:-${1:-}}"
# Extended regexes, matched case-insensitively against each line of INPUT.
CMD='(^|[^[:alnum:]_-])'                                  # start of a command word
RM="${CMD}rm[[:space:]](.*[[:space:]])?"                  # rm, then any arguments
RECURSIVE='(-[[:alpha:]]*r[[:alpha:]]*|--r[[:alpha:]]*)'  # -r, -R, -vr, --recursive
FORCE='(-[[:alpha:]]*f[[:alpha:]]*|--f[[:alpha:]]*)'      # -f, -vf, --force
DANGER_PATTERNS=(
  "${RM}-[[:alpha:]]*(r[[:alpha:]]*f|f[[:alpha:]]*r)"            # rm -rf, rm -fr
  "${RM}${RECURSIVE}[[:space:]](.*[[:space:]])?${FORCE}"         # rm -r -f, rm --recursive --force
  "${RM}${FORCE}[[:space:]](.*[[:space:]])?${RECURSIVE}"         # rm -f -r, rm --force --recursive
  "rmdir" "DROP TABLE" "TRUNCATE" "DELETE FROM" "mkfs"
  "${CMD}find[[:space:]].*[[:space:]]-delete"                    # find / -delete
  "${CMD}git[[:space:]]+clean"                                   # git clean -fdx
  "${CMD}(Remove-Item|ri|rd|del|erase)[[:space:]](.*[[:space:]])?-r"  # Remove-Item -Recurse
  "${CMD}(del|erase|rd)[[:space:]].*/s([[:space:]/]|$)"          # del /s /q, rd /s
  "format[[:space:]]+[a-z]:" "Format-Volume"                     # format c: (not "formatter")
)

for pattern in "${DANGER_PATTERNS[@]}"; do
  if grep -qiE -- "$pattern" <<<"$INPUT"; then
    echo "BLOCKED: destructive operation detected: $pattern" >&2
    echo "Set ALLOW_DESTRUCTIVE=1 to override." >&2
    [[ "${ALLOW_DESTRUCTIVE:-0}" == "1" ]] && echo "Override active — proceeding." && exit 0
    exit 1
  fi
done

echo "SAFE: no destructive patterns detected."
exit 0
