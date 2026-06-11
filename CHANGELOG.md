# Changelog

All notable changes to Harness Studio are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Monaco editor now bundled locally** — it previously loaded from `cdn.jsdelivr.net` at runtime, which is unreachable air-gapped and blocked by the CSP (`script-src 'self'`) in every packaged build. Opening `.md`/`.yaml` files now works fully offline. `monaco-editor` is an explicit dependency; CSP `worker-src` gained `'self'`.
- **Generation calls are time-bounded** — `call_openai_api` / `call_anthropic_api` / `call_ollama_api` had no HTTP timeout; a server that accepted the connection but never responded hung the workflow forever. Now: 10 s connect timeout, 600 s response timeout.
- **Custom endpoint preflight** — runs with provider mode "Custom" now health-check the endpoint up front and abort with one clear error (including a missing-URL guard) instead of failing once per node mid-run.
- **404 health-check hint** — a custom base URL missing the `/v1` prefix now produces "check that the base URL includes the API prefix" instead of a bare HTTP 404.
- **Test suite hygiene** — vitest no longer sweeps up stale test copies under `.claude/worktrees/`, which reported 3 phantom file failures on every run.

### Planned
- Live streaming execution traces
- Artifact viewer in sidebar
- Git diff viewer for workflow changes
- Secure credential storage via Tauri Stronghold
- VS Code extension reuse of core boundaries

## [0.1.0] - 2026-05-17

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
