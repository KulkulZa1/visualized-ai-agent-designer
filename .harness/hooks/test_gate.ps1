# test_gate.ps1 — full verification gate for Harness Studio
# Runs: TypeScript check + Vitest + Rust cargo test
# Blocks the pipeline if any check fails.
# Called as a pre-hook before Visual Inspector and Code Critic.

$WORKSPACE = if ($env:WORKSPACE) { $env:WORKSPACE } else { "D:\toy_project\AI_agent" }
$PASS = 0
$FAIL = 0

Write-Host ""
Write-Host "═══════════════════════════════════════════════════"
Write-Host "  TEST GATE — Harness Studio verification suite"
Write-Host "═══════════════════════════════════════════════════"

# 1. TypeScript type check
Write-Host ""
Write-Host "▶ TypeScript (npx tsc --noEmit)..."
Push-Location $WORKSPACE
npx tsc --noEmit 2>&1
$tsOk = $LASTEXITCODE -eq 0
Pop-Location
if ($tsOk) {
    Write-Host "  ✓ TypeScript: PASS (0 errors)"
    $PASS++
} else {
    Write-Host "  ✗ TypeScript: FAIL"
    $FAIL++
}

# 2. Vitest unit tests
Write-Host ""
Write-Host "▶ Vitest (npx vitest run)..."
Push-Location $WORKSPACE
npx vitest run 2>&1
$vitestOk = $LASTEXITCODE -eq 0
Pop-Location
if ($vitestOk) {
    Write-Host "  ✓ Vitest: PASS"
    $PASS++
} else {
    Write-Host "  ✗ Vitest: FAIL"
    $FAIL++
}

# 3. Rust cargo tests
Write-Host ""
Write-Host "▶ Rust (cargo test)..."
Push-Location "$WORKSPACE\src-tauri"
cargo test 2>&1
$cargoOk = $LASTEXITCODE -eq 0
Pop-Location
if ($cargoOk) {
    Write-Host "  ✓ cargo test: PASS"
    $PASS++
} else {
    Write-Host "  ✗ cargo test: FAIL"
    $FAIL++
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════"
Write-Host "  RESULT: $PASS/3 checks passed · $FAIL failed"
Write-Host "═══════════════════════════════════════════════════"

if ($FAIL -gt 0) {
    Write-Host "  ✗ TEST GATE: BLOCKED — fix failures before proceeding"
    exit 1
}

Write-Host "  ✓ TEST GATE: PASSED — proceeding to review"
exit 0
