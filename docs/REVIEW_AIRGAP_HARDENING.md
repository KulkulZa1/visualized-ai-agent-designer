# Code Review — Air-Gapped Readiness Hardening

Date: 2026-06-11
Scope: full review of the deployment-critical surface before shipping to an
air-gapped workstation, where post-install fixes are expensive. Reviewed: the
custom OpenAI-compatible provider path (frontend → Rust), the installer chain
(NSIS hooks, static CRT, WebView2 modes, build script), runtime network
assumptions, CSP, persistence, and hook execution.

Verdict: the initial objectives are fulfilled **after** the fixes in this PR.
One defect would have shipped broken on every machine; one would have shipped a
permanent-hang risk. Both are fixed and verified. Residual risks are listed at
the end — honestly, including what was *not* fixed.

---

## Confirmed working (verified by reading code and running tests)

| Objective | Verdict | Evidence |
|---|---|---|
| Custom URL / key / model connect + test | ✅ | `check_provider_health` "openai-compatible" arm probes `<base>/chat/completions` with optional Bearer; `testCustom()` passes the right provider/URL/model. Rust mock-server tests cover auth and no-auth paths. |
| Custom provider used in real runs | ✅ | `callProvider()` routes `openai-compatible` → `call_openai_api` with `baseUrl`; `useWorkflowExecution` resolves model as `customApiModel \|\| node model` and the custom key. |
| All provider HTTP via Rust (CSP-immune) | ✅ | Execution path never uses WebView `fetch()` to provider hosts. The only in-WebView fetches are Ollama tags (`localhost:11434`, CSP-allowed) and OpenRouter catalog (fails gracefully offline). |
| Standalone installer | ✅ | `perMachine` NSIS + MSI, WebView2 `embedBootstrapper` default / `offlineInstaller` with `-Offline`, static CRT (`+crt-static`) removes the VC++ redist dependency. |
| Uninstall / Start Menu structure | ✅ | `installer-hooks.nsh` macros match the Tauri NSIS template (verified `$UpdateMode`, `$NoShortcutMode`, `$AppStartMenuFolder`, `MUI_STARTMENU_GETFOLDER` all exist in the generated `installer.nsi`). Uninstall shortcut is removed in `PREUNINSTALL` so Tauri's non-recursive `RMDir` leaves nothing behind. |
| Dev package | ✅ | `--debug` build: `[DEV]` title, DevTools auto-open, DEBUG logging via `cfg(debug_assertions)`. |
| Hook execution safety | ✅ | Consent-gated, 30 s timeout, `resolve_safe_path` workspace confinement, PowerShell on Windows. |
| No telemetry / phone-home | ✅ | No analytics, no updater, no startup network calls. |

---

## Defects found and fixed in this PR

### 1. CRITICAL — Monaco editor loaded from a CDN at runtime
`@monaco-editor/react` was used without `loader.config`, so its loader fetches
the editor from `cdn.jsdelivr.net` **at runtime**. Consequences:

- **Air-gapped machine:** opening any `.md`/`.yaml` file shows "Loading editor…"
  forever. The runbook claim "no web fonts/CDN" was false.
- **Every machine:** the CSP (`script-src 'self'`) blocks the CDN script anyway,
  so the editor was broken in *all* packaged builds, online or not.

**Fix:** `src/components/editor/monacoLocal.ts` configures the loader with the
`monaco-editor` npm package (now an explicit dependency) and a bundled editor
worker. Verified in the production build: Monaco is a local 3.8 MB lazy chunk,
worker files are emitted to `dist/assets`, and no CDN request is made (the one
remaining `jsdelivr` string in the bundle is the loader's unused default
constant). CSP `worker-src` gained `'self'` for the worker file.

### 2. HIGH — generation calls could hang a run forever
`call_openai_api`, `call_anthropic_api`/`call_claude_api`, and `call_ollama_api`
used `reqwest::Client::new()`, which has **no timeout of any kind**. A server
that accepts the TCP connection but never responds (wedged local inference
server, wrong port pointing at a non-HTTP service) hangs the workflow
permanently — on an air-gapped box the only remedy is killing the app.
Health checks were bounded (10 s) but real generation was not.

**Fix:** shared `generation_client()` — 10 s connect timeout, 600 s response
timeout (generous for slow local CPU models, but bounded).

### 3. MEDIUM — no preflight for the custom endpoint
With provider mode "Custom", `runHealthChecks` never probed the custom server
and there was no missing-URL guard: a dead server or unconfigured URL surfaced
as one failure per node mid-run instead of one clear error up front.

**Fix:** the custom endpoint is health-checked before the run starts (only when
the run will actually use it), and a missing URL aborts immediately with
"Custom endpoint URL is not configured."

### 4. LOW — bare `HTTP 404` on the most common misconfiguration
A base URL missing the `/v1` prefix produced an unhelpful raw 404. The health
check now says: *"check that the base URL includes the API prefix (most servers
use /v1)"*. Covered by a new Rust mock-server test.

### 5. LOW — stale agent-worktree tests polluted the suite
`vitest` swept up test copies under `.claude/worktrees/…` that import modules
absent from this repo, reporting 3 failed files on every run. Excluded
`**/.claude/**` (and `src-tauri`) in the vitest config. Current real suite:
30 files, 284 tests.

---

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 284/284 pass (30 files)
- `cargo test` — 30/30 pass (incl. new 404-hint test)
- `npm run build` — production bundle builds; Monaco + workers emitted locally;
  bundle scan shows no live CDN reference

Not verified here (requires hardware): installing the `-Offline` NSIS build on
a clean offline VM and opening the editor + running a workflow against a local
server. That remains the final acceptance step before shipping.

---

## Residual risks (known, deliberately not fixed here)

1. **API keys in localStorage, not OS keychain** — already tracked in
   `DEPLOYMENT_READINESS.md`. Acceptable on a physically controlled air-gapped
   box; not acceptable for multi-user machines.
2. **Unused Monaco language workers** (`ts/css/html/json`, ~9 MB raw) are
   emitted into `dist` because the full monaco entry is imported. Dead weight in
   the installer (~2–3 MB compressed), not a correctness issue.
3. **`selectProviderForModel` returns `ollamaModel` for `openai-compatible`** —
   compensated at the call site (`customApiModel || rawModel`), so behavior is
   correct, but the helper is misleading if reused elsewhere.
4. **OpenAI cloud reasoning param** uses OpenRouter-style `{"reasoning": ...}`
   rather than OpenAI's `reasoning_effort`; irrelevant air-gapped, may matter
   for cloud GPT-5.5 alias models later.
5. **Health probe consumes one generation request** (`max_tokens: 1`) on the
   custom server — trivial locally, worth knowing.
6. **No code signing** — SmartScreen warning on first run is expected.
