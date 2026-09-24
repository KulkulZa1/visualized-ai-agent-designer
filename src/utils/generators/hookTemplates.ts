/**
 * Hook file templates — pre-written hook scripts for common patterns.
 * Each template generates a real script that can be placed in .harness/hooks/.
 */

export interface HookTemplate {
  id: string;
  name: string;
  description: string;
  filename: string;
  language: "sh" | "py" | "ps1";
  content: string;
}

export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: "pre_run_consent",
    name: "Pre-run consent gate",
    description: "Pauses and requires explicit user approval before the workflow runs.",
    filename: "pre_run_consent.sh",
    language: "sh",
    content: `#!/usr/bin/env bash
# pre_run_consent.sh — user consent gate
# Called before the workflow starts. Exits non-zero to abort.
set -euo pipefail

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  HARNESS: Workflow run requested"
echo "  Agent   : \${AGENT_ID:-unknown}"
echo "  Workspace: \${WORKSPACE:-.}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "Proceed? [y/N] " -n 1 -r
echo ""

if [[ ! \$REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted by user."
  exit 1
fi

echo "Consent granted. Starting workflow."
`,
  },
  {
    id: "url_allowlist",
    name: "URL allowlist",
    description: "Blocks web fetch calls to domains not in the allowlist.",
    filename: "url_allowlist.py",
    language: "py",
    content: `#!/usr/bin/env python3
"""url_allowlist.py — restrict web_fetch to approved domains."""
import sys, os, json

ALLOWED_DOMAINS = [
    "arxiv.org",
    "github.com",
    "docs.anthropic.com",
    "python.org",
    # Add more allowed domains here
]

def check_url(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        # A backslash ends the host for browsers and fetchers, but not for urlparse.
        if parsed.scheme not in ("http", "https") or "\\\\" in parsed.netloc:
            return False
        domain = (parsed.hostname or "").removeprefix("www.")
        return any(domain == d or domain.endswith("." + d) for d in ALLOWED_DOMAINS)
    except Exception:
        return False

if __name__ == "__main__":
    # URL is passed as first argument or via HOOK_INPUT env var
    url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HOOK_INPUT", "")
    if not url:
        print("No URL provided.", file=sys.stderr)
        sys.exit(1)
    if check_url(url):
        print(f"APPROVED: {url}")
        sys.exit(0)
    else:
        print(f"BLOCKED: {url} (not in allowlist)", file=sys.stderr)
        sys.exit(1)
`,
  },
  {
    id: "path_scope",
    name: "Filesystem path scope",
    description: "Restricts file operations to the workspace directory only.",
    filename: "path_scope.py",
    language: "py",
    content: `#!/usr/bin/env python3
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
`,
  },
  {
    id: "destructive_guard",
    name: "Destructive operation guard",
    description: "Blocks rm, truncate, and DROP operations unless explicitly confirmed.",
    filename: "destructive_guard.sh",
    language: "sh",
    content: `#!/usr/bin/env bash
# destructive_guard.sh — block destructive operations
set -euo pipefail

INPUT="\${HOOK_INPUT:-\${1:-}}"
# Extended regexes, matched case-insensitively against each line of INPUT.
CMD='(^|[^[:alnum:]_-])'                                  # start of a command word
RM="\${CMD}rm[[:space:]](.*[[:space:]])?"                  # rm, then any arguments
RECURSIVE='(-[[:alpha:]]*r[[:alpha:]]*|--r[[:alpha:]]*)'  # -r, -R, -vr, --recursive
FORCE='(-[[:alpha:]]*f[[:alpha:]]*|--f[[:alpha:]]*)'      # -f, -vf, --force
DANGER_PATTERNS=(
  "\${RM}-[[:alpha:]]*(r[[:alpha:]]*f|f[[:alpha:]]*r)"            # rm -rf, rm -fr
  "\${RM}\${RECURSIVE}[[:space:]](.*[[:space:]])?\${FORCE}"         # rm -r -f, rm --recursive --force
  "\${RM}\${FORCE}[[:space:]](.*[[:space:]])?\${RECURSIVE}"         # rm -f -r, rm --force --recursive
  "rmdir" "DROP TABLE" "TRUNCATE" "DELETE FROM" "mkfs"
  "\${CMD}find[[:space:]].*[[:space:]]-delete"                    # find / -delete
  "\${CMD}git[[:space:]]+clean"                                   # git clean -fdx
  "\${CMD}(Remove-Item|ri|rd|del|erase)[[:space:]](.*[[:space:]])?-r"  # Remove-Item -Recurse
  "\${CMD}(del|erase|rd)[[:space:]].*/s([[:space:]/]|$)"          # del /s /q, rd /s
  "format[[:space:]]+[a-z]:" "Format-Volume"                     # format c: (not "formatter")
)

for pattern in "\${DANGER_PATTERNS[@]}"; do
  if grep -qiE -- "\$pattern" <<<"\$INPUT"; then
    echo "BLOCKED: destructive operation detected: \$pattern" >&2
    echo "Set ALLOW_DESTRUCTIVE=1 to override." >&2
    [[ "\${ALLOW_DESTRUCTIVE:-0}" == "1" ]] && echo "Override active — proceeding." && exit 0
    exit 1
  fi
done

echo "SAFE: no destructive patterns detected."
exit 0
`,
  },
  {
    id: "iter_counter",
    name: "Iteration counter (loop gate)",
    description: "Tracks loop iterations and blocks runaway loops after MAX_ITER.",
    filename: "iter_counter.py",
    language: "py",
    content: `#!/usr/bin/env python3
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
`,
  },
];

/** Returns the default template for a given hook path extension. */
export function getTemplateForPath(path: string): HookTemplate | null {
  const ext = path.split(".").at(-1) ?? "";
  const langMap: Record<string, HookTemplate["language"]> = { sh: "sh", bash: "sh", py: "py", ps1: "ps1" };
  const lang = langMap[ext];
  if (!lang) return null;
  return HOOK_TEMPLATES.find((t) => t.language === lang) ?? null;
}
