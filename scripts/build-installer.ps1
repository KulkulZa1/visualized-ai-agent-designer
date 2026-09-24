#Requires -Version 5.1
<#
.SYNOPSIS
    Build a Harness Studio installer for Windows.

.DESCRIPTION
    Default (release) — optimised binary, WARN-level logging, no DevTools:
        .\scripts\build-installer.ps1

    Development build — debug symbols, DEBUG-level logging to file,
    DevTools auto-open on startup, window title "Harness Studio [DEV]":
        .\scripts\build-installer.ps1 -Dev

    Air-gapped machines (no internet at install time):
        .\scripts\build-installer.ps1         -Offline
        .\scripts\build-installer.ps1 -Dev    -Offline

    Output locations:
        Release : src-tauri\target\release\bundle\nsis\  and  \msi\
        Dev     : src-tauri\target\debug\bundle\nsis\    and  \msi\

.PARAMETER Dev
    Build with debug symbols and developer features enabled:
      - Window title "Harness Studio [DEV]"
      - DevTools pane opens automatically on launch (right-click Inspect available)
      - Log level DEBUG (written to %APPDATA%\com.kulkulza.harness-studio\logs\)
      - Faster to compile; larger binary; NOT for production deployment.

.PARAMETER Offline
    Embed the full WebView2 offline installer (~150 MB extra).
    Use when the target machine has NO internet access at install time.
    Default uses the embed-bootstrapper (~3 MB); if WebView2 is absent it
    downloads it silently on first install.

.PARAMETER SkipDepsCheck
    Skip Node / Rust / Cargo prerequisite checks.
#>

param(
    [switch]$Dev,
    [switch]$Offline,
    [switch]$SkipDepsCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Step { param([string]$msg) Write-Host "  $msg"       -ForegroundColor Cyan   }
function Write-Ok   { param([string]$msg) Write-Host "  OK  $msg"   -ForegroundColor Green  }
function Write-Warn { param([string]$msg) Write-Host "  WARN $msg"  -ForegroundColor Yellow }
function Write-Fail { param([string]$msg) Write-Host "  FAIL $msg"  -ForegroundColor Red    }

# Write UTF-8 WITHOUT a BOM. Windows PowerShell 5.1's `Set-Content -Encoding utf8`
# prepends a BOM, which Tauri's JSON config parser rejects with
# "expected value at line 1 column 1". Use .NET to write clean UTF-8.
function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

$BuildLabel = if ($Dev) { "DEVELOPMENT" } else { "RELEASE" }

Write-Host ""
Write-Host "  Harness Studio — $BuildLabel Installer Build" -ForegroundColor White
Write-Host "  $("=" * ("  Harness Studio — $BuildLabel Installer Build".Length - 2))" -ForegroundColor DarkGray
if ($Dev) {
    Write-Host "  DevTools ON  |  DEBUG logging  |  debug symbols" -ForegroundColor Yellow
} else {
    Write-Host "  Optimised binary  |  WARN logging  |  no DevTools" -ForegroundColor DarkGray
}
Write-Host ""

# ── Locate repo root ──────────────────────────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir
Push-Location $RepoRoot

# ── Prerequisite checks ───────────────────────────────────────────────────────

if (-not $SkipDepsCheck) {
    Write-Step "Checking build prerequisites..."

    foreach ($cmd in @("node", "npm", "cargo")) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Write-Fail "$cmd not found in PATH."
            Write-Host ""
            Write-Host "  Install the following on your BUILD machine (not the target):" -ForegroundColor Yellow
            Write-Host "    Node.js        https://nodejs.org  (LTS, x64)"
            Write-Host "    Rust           https://rustup.rs"
            Write-Host "    VS Build Tools https://aka.ms/vs/17/release/vs_BuildTools.exe"
            Write-Host "      Workload: 'Desktop development with C++'"
            exit 1
        }
    }

    Write-Ok "node $(node --version)  |  $(cargo --version)"
}

# ── Patch tauri.conf.json (WebView2 mode) ─────────────────────────────────────
# We restore the original value after the build so the file stays clean in git.

$tauriConf   = Join-Path $RepoRoot "src-tauri\tauri.conf.json"
$confText    = Get-Content $tauriConf -Raw
$conf        = $confText | ConvertFrom-Json
$originalWv2 = $conf.bundle.windows.webviewInstallMode.type

$targetWv2 = if ($Offline) { "offlineInstaller" } else { "embedBootstrapper" }
if ($Offline) { Write-Warn "Offline mode: embedding full WebView2 installer (~150 MB extra)." }

$conf.bundle.windows.webviewInstallMode.type = $targetWv2
Write-Utf8NoBom -Path $tauriConf -Text ($conf | ConvertTo-Json -Depth 20)

# Everything that can fail runs inside try/finally so tauri.conf.json is restored
# on success, failure, `exit` and Ctrl+C alike. Native commands are not redirected
# with 2>&1: under $ErrorActionPreference = "Stop" in PowerShell 5.1 that turns the
# first stderr line (e.g. an npm warning) into a terminating error.
try {
    # ── Install JS dependencies ───────────────────────────────────────────────

    Write-Step "Installing Node dependencies..."
    npm ci --prefer-offline | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm ci failed"; exit 1 }
    Write-Ok "Node dependencies ready"

    # ── Build ─────────────────────────────────────────────────────────────────

    $buildArgs = if ($Dev) { @("run", "tauri", "--", "build", "--debug") } `
                 else      { @("run", "tauri", "--", "build") }

    Write-Step "Compiling ($BuildLabel, this takes 5-15 min on first run)..."
    Write-Host ""

    & npm @buildArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Build failed. Check errors above."
        exit 1
    }
} finally {
    Write-Utf8NoBom -Path $tauriConf -Text $confText
}

Write-Host ""

# ── Collect output files ──────────────────────────────────────────────────────

$profile   = if ($Dev) { "debug" } else { "release" }
$bundleDir = Join-Path $RepoRoot "src-tauri\target\$profile\bundle"

$outputs = @()
foreach ($sub in @("nsis", "msi")) {
    $dir = Join-Path $bundleDir $sub
    if (Test-Path $dir) {
        Get-ChildItem $dir -Include "*.exe","*.msi" -Recurse | ForEach-Object { $outputs += $_ }
    }
}

if ($outputs.Count -eq 0) {
    Write-Warn "Build succeeded but no installer files found under $bundleDir"
    exit 0
}

Write-Host "  $BuildLabel build complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Installer files:" -ForegroundColor White

foreach ($file in $outputs) {
    $sizeMB = [math]::Round($file.Length / 1MB, 1)
    $hash   = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
    Write-Host ""
    Write-Host "    $($file.Name)" -ForegroundColor Cyan
    Write-Host "    Path  : $($file.FullName)"
    Write-Host "    Size  : ${sizeMB} MB"
    Write-Host "    SHA256: $hash"
}

Write-Host ""

if ($Dev) {
    Write-Host "  Dev build notes:" -ForegroundColor Yellow
    Write-Host "    - Window title shows [DEV] to distinguish from production"
    Write-Host "    - DevTools open automatically on launch (right-click -> Inspect also works)"
    Write-Host "    - Log level: DEBUG  ->  %APPDATA%\com.kulkulza.harness-studio\logs\"
    Write-Host "    - Binary is NOT optimised; do not distribute as a production build"
} else {
    Write-Host "  Target machine requirements:" -ForegroundColor DarkGray
    if ($Offline) {
        Write-Host "    - Windows 10 / 11 (no internet needed at install time)"
    } else {
        Write-Host "    - Windows 10 / 11"
        Write-Host "    - Internet access only if WebView2 is not already installed"
        Write-Host "      (Windows 11 ships with WebView2 — usually a no-op)"
    }
    Write-Host "    - Run the .exe installer as Administrator"
    Write-Host "    - Installs for all users (Program Files)"
}

Write-Host ""

Pop-Location
