#!/usr/bin/env bash
# pre_run_consent.sh — user consent gate
# Called before the workflow starts. Exits non-zero to abort.
set -euo pipefail

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  HARNESS: Workflow run requested"
echo "  Agent   : ${AGENT_ID:-unknown}"
echo "  Workspace: ${WORKSPACE:-.}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "Proceed? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted by user."
  exit 1
fi

echo "Consent granted. Starting workflow."
