# Project Status

Updated: 2026-05-18

Project: Harness Studio, a Tauri desktop workflow builder for multi-agent AI
systems.

Current phase: deployment-readiness hardening. The product is usable for local
development and demos, but not ready for broad release.

## Verified Baseline

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | Passed, 229 tests / 26 files |
| `cargo test` | Passed, 25 tests |
| `npm run build` | Passed |
| `npm run tauri -- dev` | Launched desktop binary and WebView2 |
| `npm run tauri -- build` | Produced MSI and NSIS installers |
| CLI | Read-only v0 commands tested |
| MCP | stdio read/test tools tested |

Build warnings still present:

- Empty Vite chunk: `vendor-react`.
- Main JS chunk larger than 500 kB.

## Implemented

- Canvas editor with examples, validation, auto-layout, undo/redo, and YAML load/save.
- AuditStrip filters with kind chips, All chip, agent chips, ordering toggle, and empty states.
- Sequential workflow execution with per-node prompt/model/output/status.
- Provider adapters for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints.
- Ollama Cloud support for `https://ollama.com/api`, `gemma4:31b-cloud`, and endpoint-scoped credentials.
- Rule-based Workflow Wizard with templates for blog automation, purchasing, research, coding, finance/logistics/MATLAB-related planning, and Harness Studio self-improvement.
- Rule-based Guide Assistant with no live AI calls.
- Read-only CLI v0.
- MCP stdio read/test v0.
- Tauri installer packaging.

## Honest Limitations

- Execution is sequential, not parallel.
- `executionSettings.maxParallel` is schema/reserved only.
- Agents are not isolated OS processes.
- Streaming is simulated.
- Context snapshots are partial and not a complete durable request trace.
- Artifact inspector uses mock placeholders during execution.
- API keys are stored in localStorage/env, not OS keychain.
- Gemini is catalog/planned only.
- MCP write tools and workflow execution are not implemented.

## Most Important Recent Fixes

- Added MCP path traversal rejection for `validate_workflow`.
- Added MCP tests for initialize, tools/list, validation, traversal rejection,
  unsafe filter rejection, and unknown-tool errors.
- Validated MCP `run_tests` works on Windows while rejecting unsafe filters.
- Added Rust hook consent guard at command boundary.
- Fixed workflow hook-node failure handling so failed hooks are not marked done.
- Removed broad Tauri shell execute/kill permissions from default capabilities.
- Added package scripts: `check:ts`, `test`, `test:rust`, and `check`.
- Replaced stale default Tauri README with Harness Studio status.

## Current Release Blockers

1. Clean-machine installer smoke test.
2. Code signing.
3. OS keychain storage.
4. True parallel scheduler or continued explicit sequential labeling.
5. Durable run traces and artifacts.
6. E2E UI automation and screenshot capture that does not depend on manual inspection.

See `docs/DEPLOYMENT_READINESS.md` for the detailed checklist.

