#!/usr/bin/env bash
# test_gate.sh — full verification gate for Harness Studio
# Runs: TypeScript check + Vitest + Rust cargo test
# Blocks the pipeline if any check fails.
# Called as a pre-hook before Visual Inspector and Code Critic.
set -euo pipefail

WORKSPACE="${WORKSPACE:-D:\\toy_project\\AI_agent}"
PASS=0
FAIL=0

echo ""
echo "═══════════════════════════════════════════════════"
echo "  TEST GATE — Harness Studio verification suite"
echo "═══════════════════════════════════════════════════"

# 1. TypeScript type check
echo ""
echo "▶ TypeScript (npx tsc --noEmit)..."
if cd "$WORKSPACE" && npx tsc --noEmit 2>&1; then
  echo "  ✓ TypeScript: PASS (0 errors)"
  PASS=$((PASS + 1))
else
  echo "  ✗ TypeScript: FAIL"
  FAIL=$((FAIL + 1))
fi

# 2. Vitest unit tests
echo ""
echo "▶ Vitest (npx vitest run)..."
if cd "$WORKSPACE" && npx vitest run 2>&1; then
  echo "  ✓ Vitest: PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ Vitest: FAIL"
  FAIL=$((FAIL + 1))
fi

# 3. Rust cargo tests
echo ""
echo "▶ Rust (cargo test)..."
if cd "$WORKSPACE/src-tauri" && cargo test 2>&1; then
  echo "  ✓ cargo test: PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ cargo test: FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULT: ${PASS}/3 checks passed · ${FAIL} failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo "  ✗ TEST GATE: BLOCKED — fix failures before proceeding"
  exit 1
fi

echo "  ✓ TEST GATE: PASSED — proceeding to review"
exit 0
