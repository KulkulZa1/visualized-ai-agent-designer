# Changelog

All notable changes to Harness Studio are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Hooks during workflow runs** — only Hook-role nodes run their `preHook`; pre/post hooks on agent nodes run only manually from the Hooks tab and `postHook` never runs during runs. A `requireConsent` hook fails its node instead of running, a failed hook stops the run even with `continueOnError`, and hooks receive only `AGENT_ID`, `WORKSPACE` and their declared env (no per-call `HOOK_INPUT`), with a fixed 30 s timeout.
- **Permission matrix and validator** — pre/post hooks on agent nodes are no longer presented as a "gate" ("Add guard" removed); the validator warns that `bash` is disabled.
- **Unapplied settings are labeled** — temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}` and workflow `timeoutSeconds`/`retryOnFailure`/`maxRetries` are still not applied at runtime, and the UI now says so.
- **MCP server has 8 tools** — added `list_providers` (credential references only), `list_artifacts` (file metadata; empty until runs persist artifacts) and `get_recent_logs` (audit entries with best-effort secret redaction). Still read/test only.
- **Generate** — generated CLAUDE.md names `<slug>.harness.yaml` (same as Save) and no longer claims every hook is consented and logged; the Generate panel asks before overwriting an existing file with different content.
- **Repository** — root `CLAUDE.md` is a short pointer to `AGENT.md` (the generated 12-agent harness moved to `examples/harness-studio-project.CLAUDE.md`); `src-tauri/target-codex-verify*` and `.claude/settings.local.json` untracked; `outputs/` ignored; the empty-state screenshot moved to `docs/assets/empty-state.png`; `.gitattributes` added (LF).

### Fixed
- **Monaco editor now bundled locally** — it previously loaded from `cdn.jsdelivr.net` at runtime, which is unreachable air-gapped and blocked by the CSP (`script-src 'self'`) in every packaged build. Opening `.md`/`.yaml` files now works fully offline. `monaco-editor` is an explicit dependency; CSP `worker-src` gained `'self'`.
- **Generation calls are time-bounded** — `call_openai_api` / `call_anthropic_api` / `call_ollama_api` had no HTTP timeout; a server that accepted the connection but never responded hung the workflow forever. Now: 10 s connect timeout, 600 s response timeout.
- **Custom endpoint preflight** — runs with provider mode "Custom" now health-check the endpoint up front and abort with one clear error (including a missing-URL guard) instead of failing once per node mid-run.
- **404 health-check hint** — a custom base URL missing the `/v1` prefix now produces "check that the base URL includes the API prefix" instead of a bare HTTP 404.
- **Test suite hygiene** — vitest no longer sweeps up stale test copies under `.claude/worktrees/`, which reported 3 phantom file failures on every run.
- **Provider requests** — dotted Claude IDs (`claude-sonnet-4.6`) are sent as API IDs (`claude-sonnet-4-6`); official OpenAI requests use `max_completion_tokens` + `reasoning_effort` (custom OpenAI-compatible endpoints keep `max_tokens`), and reasoning effort is sent only to reasoning models (`gpt-5.5*`, o1/o3/o4).
- **Provider preflight and retries** — keys set only as environment variables now work; health checks contact only providers the run will use (local Ollama is always probed as the billing fallback); 5xx/529 responses are retried; Ollama model availability requires the exact tag.
- **Execution** — file-based prompts are read from the workspace (node fails if unreadable); per-node `timeoutSeconds` is enforced (the late provider result is discarded); `maxTokens` is no longer silently capped at 4096; runs with failed agents end with status `error`; a second run is refused while one is active; Stop also prevents a pending tool call from executing.
- **Routing** — the user's task reaches entry agents even when a hook/memory node sits in front; a gateway join with another live input still runs; a route that matches no edge label follows all branches.
- **Windows hooks** — `.bat`/`.ps1`/`.sh` hooks now run (previously only `.py` worked); large output no longer deadlocks (up to 1 MiB captured per stream).
- **Editor** — unsaved text is kept per tab and closing a dirty tab asks first; binary / non-UTF-8 files show an error instead of an empty editor that Ctrl+S could truncate.
- **Save and undo** — Ctrl+S validates like the Save button and saves never-saved workflows as `<slug>.harness.yaml`; saving a canvas-built workflow no longer drops or rewires edges on reload; loading a workflow starts a fresh undo history and run status no longer fills it.
- **Shortcuts and UI** — Ctrl+Shift+O (also the first-run "Open Workspace" button), Ctrl+L, Ctrl+. and Ctrl+Shift+Z work; undo/redo/duplicate don't fire while typing; the top bar shows the real valid/invalid state; session restore reopens the last workspace and workflow; command-palette Save/Validate/Auto-layout/Open CLAUDE.md/Open AGENTS.md/View audit log work; the Context tab no longer writes mock snapshots; the status bar no longer overlaps the audit strip.
- **Generators** — CrewAI and LangGraph exports parse as valid Python for all 7 examples (not run against real crewai/langgraph).
- **MCP protocol** — notifications get no reply; parse / invalid-request / unknown-tool errors return -32700 / -32600 / -32602; tool failures return `isError` results; `run_tests` rejects filters starting with `-`; npx runs with `--no-install`; `serverInfo.version` is 0.1.0.
- **CLI** — `--workspace <dir>` can appear before the command.
- **Bundled hook scripts** — `url_allowlist.py` checks the parsed hostname and requires http/https; `destructive_guard.sh` no longer fails open on large input and catches more destructive forms; `rate_limit_sentinel.py` no longer crashes on non-UTF-8 consoles; `test_gate` defaults `WORKSPACE` to the repo root.

### Security
- **Agent shell execution disabled** — model-issued `bash`/`run_command` calls are refused and no longer advertised to the model; the `execute_inline_command` IPC command was removed. Re-enabling needs a per-command consent system.
- **Hook environment and audit** — hook processes no longer inherit `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_API_KEY` / `OLLAMA_REMOTE_API_KEY`; hooks need an open workspace (no `meta.projectRoot` fallback); hook runs inside workflows are recorded in the audit strip and appended to `.harness/audit.log.jsonl`.
- **Release builds** — DevTools are no longer enabled (tauri `devtools` feature removed; debug builds still open them).
- **Workspace paths** — `resolve_safe_path` resolves the deepest existing ancestor for new files, so a symlink/junction inside the workspace cannot redirect writes outside it; atomic writes use unique temp names and refuse directory targets.
- **Provider traffic** — the billing-error fallback only goes to a local Ollama server; network errors no longer echo URL query strings.
- **VS Code extension host** (experimental scaffold) — file access is confined to the open workspace folder, and the stored OpenAI key is sent only to api.openai.com.

### Planned
- Live streaming execution traces
- Artifact viewer in sidebar
- Git diff viewer for workflow changes
- Secure credential storage via Tauri Stronghold
- VS Code extension reuse of core boundaries

## [0.1.0] - 2026-05-29

### Added
- **Phase 5 — Execution Engine**: Run button executes workflow agents in topological order via OpenAI, Anthropic, or Ollama APIs. Supports per-node model configuration with GPT-5.5 tier aliases, `reasoning_effort` for o-series, and Visual Inspector locked to Claude.
- **Multi-provider support**: OpenAI (with retry backoff), Anthropic, Ollama local, and Ollama fallback on billing errors. Provider health checks before each run. Settings panel with API key management.
- **Snapshot persistence**: In-memory and file-backed (`FileSnapshotRepository`) execution context snapshots stored at `.harness/snapshots/`. Snapshot history panel in Context Inspector tab with expand, delete, reload, and JSON export.
- **Provider catalog**: 8 providers catalogued (OpenAI, Anthropic, OpenAI-compatible, Ollama local, Ollama remote, Google Gemini, Cloud placeholder, Kilo). Gemini and Ollama remote added as disabled scaffolding.
- **Token tracking**: Per-agent token estimation after each run; updates node `tokens.used` field; shown in RunPanel.
- **UX improvements**: AuditStrip newest/oldest-first toggle with auto-scroll; animated execution progress bar; RunPanel output 80→200px; resizable config panel (CSS resize); keyboard help overlay (Ctrl+/).
- **Bundle optimisation**: Vite `manualChunks` splits vendor-flow (188 KB), vendor-yaml (97 KB), vendor-editor (14 KB) into separate chunks; main bundle 809 KB → 513 KB.
- **Session restore**: Last opened harness auto-loaded on startup from localStorage.
- **Artifact service**: `artifactService.ts` writes node artifacts to `.harness/artifacts/`. ArtifactSidebar component in Sidebar.
- **Tests**: 124 Vitest tests (was 57 at Phase 3 entry).

### Phase 0-4 (prior)
- Research & Planning, HTML prototype, Visual Workflow Editor (8 node types, 4 edge types, Dagre auto-layout)
- Example YAML files, AGENT_WORKFLOW_SPEC, ExamplePicker
- Agent configuration generators (CLAUDE.md, AGENTS.md, LangGraph, CrewAI, hook templates)
- Hook & Permission Management (permission matrix, hook execution with consent, audit log)
- API error handling with provider fallback
