# Project Status

Updated: 2026-09-24

Project: Harness Studio, a Tauri desktop workflow builder for multi-agent AI
systems.

Current phase: deployment-readiness hardening. The product is usable for local
development and demos, but not ready for broad release.

## Verified Baseline

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | Passed, 513 tests / 46 files (verified 2026-09-24) |
| `cargo test` | Passed, 63 tests (verified 2026-09-24) |
| `npm run build` | Passed |
| `npm run tauri -- dev` | Launched desktop binary and WebView2 (earlier pass, not re-run) |
| `npm run tauri -- build` | Produced MSI and NSIS installers (earlier pass, not re-run) |
| CLI | Read-only v0 commands tested |
| MCP | stdio read/test tools tested (8 tools) |

Build warnings still present:

- Empty Vite chunk: `vendor-react`.
- Main `index` and `monacoLocal` chunks larger than 500 kB.

## Implemented

- Canvas editor with examples, validation, auto-layout, undo/redo, and YAML load/save.
- AuditStrip filters with kind chips, All chip, agent chips, ordering toggle, and empty states.
- Dependency-aware bounded parallel workflow execution with per-node prompt/model/output/status.
- Provider adapters for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints.
- Ollama Cloud support for `https://ollama.com/api`, `gemma4:31b-cloud`, and endpoint-scoped credentials.
- Rule-based Workflow Wizard with templates for blog automation, purchasing, research, coding, finance/logistics/MATLAB-related planning, and Harness Studio self-improvement.
- Rule-based Guide Assistant with no live AI calls.
- Read-only CLI v0.
- MCP stdio read/test v0 (8 tools).
- Tauri installer packaging.

## Honest Limitations

- Independent forward-edge branches can run concurrently up to `executionSettings.maxParallel`.
- Parallel scheduling is JavaScript async concurrency, not OS process isolation.
- Agents are not isolated OS processes.
- Streaming is simulated.
- Context snapshots are partial and not a complete durable request trace.
- Artifact inspector uses mock placeholders during execution.
- API keys are stored in localStorage/env, not OS keychain.
- Gemini is catalog/planned only.
- MCP write tools and workflow execution are not implemented.
- Agent shell execution (`bash`/`run_command`) is disabled until a per-command consent system exists.
- Pre/post hooks on agent nodes do not run during workflow runs; only Hook-role nodes run their pre-hook.
- Temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}`, and workflow-level `timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved but not applied at runtime.
- The VS Code extension is an experimental scaffold; most commands do not work yet.

## Most Important Recent Fixes

2026-09-24 defect-fix pass (details in `docs/REVIEW_FULL_AUDIT_2026-09.md` and `CHANGELOG.md`):

- Disabled agent shell execution (`bash`/`run_command` refused; `execute_inline_command` IPC removed).
- Hooks: only Hook-role nodes run during workflows; consent-required or failed hooks stop the run; hook processes no longer inherit provider API keys; Windows `.bat`/`.ps1`/`.sh` hooks run; hook runs are audited.
- Providers: Claude model IDs normalized, OpenAI `max_completion_tokens`/`reasoning_effort`, env-only keys work, preflight only contacts providers the run uses, billing fallback only to local Ollama.
- Execution: file prompts read from the workspace, per-node timeouts enforced, failed runs end as `error`, single-run guard, gateway join/unmatched-route fixes.
- Editor, save, undo, shortcuts, session restore, and command-palette fixes; MCP JSON-RPC protocol fixes, and all 8 MCP tools are now documented.
- Release builds no longer enable DevTools; `resolve_safe_path` blocks symlink/junction escapes for new files.

Earlier fixes:

- Added MCP path traversal rejection for `validate_workflow`.
- Added MCP tests for initialize, tools/list, validation, traversal rejection,
  unsafe filter rejection, and unknown-tool errors.
- Validated MCP `run_tests` works on Windows while rejecting unsafe filters.
- Added Rust hook consent guard at command boundary.
- Fixed workflow hook-node failure handling so failed hooks are not marked done.
- Removed broad Tauri shell execute/kill permissions from default capabilities.
- Added package scripts: `check:ts`, `test`, `test:rust`, and `check`.
- Replaced stale default Tauri README with Harness Studio status.
- Fixed feedback-edge validation so semantic `edge.data.edgeKind = "feedback"` edges do not create false cycle errors.
- Hardened gateway skip scheduling so branch-only descendants of skipped routes do not run accidentally.
- Added scheduler protection against silently completing pure forward cycles.

## Current Release Blockers

1. Clean-machine installer smoke test.
2. Code signing.
3. OS keychain storage.
4. More E2E coverage for bounded parallel execution, cancellation, and gateway routing.
5. Durable run traces and artifacts.
6. E2E UI automation and screenshot capture that does not depend on manual inspection.
7. Per-command consent system before re-enabling agent shell execution.

See `docs/DEPLOYMENT_READINESS.md` for the detailed checklist.


