# AI Agent Handoff - Harness Studio

Read this file before modifying this project.

Harness Studio is a local-first Tauri 2 desktop app for building, validating,
running, and inspecting multi-agent workflow definitions. The current goal is to
make the product strong enough to help develop and debug itself, without hiding
mocked or incomplete behavior.

## Current Verified Baseline (2026-09-24)

Verified in this pass:

- TypeScript: `npx tsc --noEmit` passed.
- Unit tests: `npx vitest run` passed, 492 tests in 44 files.
- Rust tests: `cargo test` passed, 63 tests.
- Web build: `npm run build` passed with a known large chunk warning.
- Tauri dev launch (earlier pass, not re-run): `npm run tauri -- dev` launched the desktop binary and WebView2.
- Tauri packaging (earlier pass, not re-run): `npm run tauri -- build` produced MSI and NSIS installers.
- CLI v0: `npm run harness -- project status`, `provider list`, and workflow validation were run.
- MCP v0: stdio JSON-RPC initialize, tools/list, project_status, validate_workflow, and run_tests were run.

## Implemented And Verified

- React/Tauri desktop shell with canvas, node palette, inspector, settings, run dialog, audit strip, help, and quick start surfaces.
- Workflow YAML load/save/validation through the Tauri backend and CLI validator.
- Example workflows in the app plus example YAML files for CLI validation.
- Dependency-aware bounded parallel workflow execution for independent forward-edge branches.
- Provider adapter paths for OpenAI, Anthropic, local Ollama, Ollama Cloud, and OpenAI-compatible endpoints.
- Ollama Cloud configuration using `https://ollama.com/api`, `gemma4:31b-cloud`, and endpoint-scoped credentials.
- Rule-based workflow recommender with 8 templates, including blog automation and Harness Studio self-improvement.
- Rule-based guide assistant shell. It does not make live AI calls.
- Read-only CLI v0.
- Read/test MCP v0 with 8 tools: project status, workflow listing, workflow validation, test runners, provider metadata, artifact file metadata, and recent audit-log entries (best-effort secret redaction).
- Agent file tools (read, list, grep, `fs.write`, `fs.append`) confined to the open workspace.
- MCP path-safety checks and safe test-filter validation.
- Hook execution consent guard in Rust and workflow error handling for hook failures.

## Not Implemented Or Partial

- Parallel scheduling is renderer-level JavaScript async concurrency, not OS process isolation.
- Parallel scheduler traces are not yet persisted as durable timeline events.
- Streaming output is simulated in the UI; provider streaming is not wired end-to-end.
- Artifact persistence is partial/mock-oriented and not a durable run artifact system.
- Context snapshots are useful for inspection but are not a complete durable trace system.
- OS keychain or Stronghold storage for provider keys is not implemented.
- MCP write tools are intentionally absent until permissioning and audit are stronger.
- Agent shell execution (`bash`/`run_command`) is disabled until a per-command consent system exists.
- Pre/post hooks on agent nodes do not run during workflow runs (manual Hooks-tab runs only); only Hook-role nodes run their pre-hook.
- Temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}`, and workflow-level `timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved but not applied at runtime.
- The VS Code extension is an experimental scaffold; most commands do not work yet.
- MATLAB execution is not implemented.
- Gemini/Gemma direct cloud adapter is not implemented; use OpenAI-compatible gateways only when configured.
- Code signing and installer smoke-install verification are not complete.

## Execution Mode

The runner uses `runParallel()` from `src/services/execution/parallelScheduler.ts`.
Independent forward-edge branches can run concurrently up to
`executionSettings.maxParallel`. Feedback edges are excluded from dependencies.
Gateway routes skip unmatched branches, and branch-only descendants of skipped
routes are skipped. Do not describe this as OS/process isolation.

## Safety Rules

- Do not add secrets to source, docs, examples, logs, CLI output, or MCP output.
- Do not add hidden cloud calls.
- Do not add arbitrary command execution.
- Do not add MCP write tools without an explicit permission and audit design.
- Do not claim mock or partial features are production-ready.
- Do not create `AGEND.md`; use `AGENT.md`.

## Useful Commands

```powershell
npx tsc --noEmit
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
npm run tauri -- dev
npm run tauri -- build
npm run harness -- project status
npm run harness -- provider list --json
npm run harness -- workflow validate examples\purchasing-decision.harness.yaml
npm run mcp
```

## Documentation To Keep Current

- `AGENT.md`
- `README.md`
- `docs/PROJECT_STATUS.md`
- `docs/DEPLOYMENT_READINESS.md`
- `docs/SECURITY.md`
- `docs/MCP_USAGE.md`
- `docs/QUICK_START.md`
- `docs/TODO.md`
- `docs/ROADMAP.md`
- `docs/DEVELOPMENT_LOG.md`

## Recommended Next Step

Implement a real execution trace model: run ID, per-node attempt ID, durable logs,
context snapshots, artifacts, queued/running/skipped scheduler events,
cancellation state, and failure recovery. This is the foundation for reliable
self-improvement runs.

