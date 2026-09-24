#!/usr/bin/env python3
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
        if parsed.scheme not in ("http", "https") or "\\" in parsed.netloc:
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
