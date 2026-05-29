# AGENT.md - Harness Studio

**Repository:** https://github.com/KulkulZa1/visualized-ai-agent-designer
**Working directory:** clone of the above — use this, not any older local copy.

Read this before touching files. Keep it aligned with
`docs/DEPLOYMENT_READINESS.md`.

## Project

Harness Studio is a local-first Tauri 2 desktop app for building, validating,
running, and inspecting multi-agent AI workflows.

Product goal: beginners can load or generate a workflow, configure a provider,
and run it; experts can inspect per-agent context, tools, logs, artifacts,
provider/model choices, CLI/MCP access, and safety boundaries.

## Current Verified Baseline

Last execution pass: 2026-05-18.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | Passed, 229 tests / 26 files |
| `cargo test` | Passed, 25 tests |
| `npm run build` | Passed; Vite large chunk and empty `vendor-react` warnings remain |
| `npm run tauri -- dev` | Launched `target\\debug\\agent-workflow-builder.exe` and WebView2 |
| `npm run tauri -- build` | Produced MSI and NSIS installers |
| CLI | Read-only commands tested |
| MCP | stdio server and read/test tools tested |

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | Tauri 2, Rust backend, WebView2 on Windows |
| Frontend | React 19, TypeScript, Vite |
| Canvas | `@xyflow/react` |
| State | Zustand + zundo |
| Validation | Zod |
| CLI | `cli/harness.mjs`, read-only |
| MCP | `mcp/server.mjs`, stdio read/test v0 |

## What Works

- Canvas editor with node/edge editing, validation, undo/redo, auto-layout, examples, and YAML load/save.
- Rule-based Workflow Wizard / Create from Goal, including blog automation and Harness Studio self-improvement templates.
- Rule-based Guide Assistant. It makes no live AI calls.
- Provider settings and adapters for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints.
- Ollama Cloud model `gemma4:31b-cloud`; alias `gemma4-31b:cloud` normalizes to the canonical model.
- CLI v0:
  - `npm run harness -- project status`
  - `npm run harness -- provider list`
  - `npm run harness -- workflow validate <file>`
- MCP v0 tools:
  - `project_status`
  - `list_workflows`
  - `validate_workflow`
  - `run_tests`
  - `run_cargo_tests`
- Tauri package build for Windows MSI and NSIS installer.

## Honest Limitations

- Execution uses `runParallel()` from `src/services/execution/parallelScheduler.ts`, which runs independent branches concurrently up to `executionSettings.maxParallel`. Feedback edges are excluded from dependency calculations. Gateway routing prunes skipped branches.
- Agents are independent in node ID, role, prompt, model, output, status, audit entries, and snapshots. They are not separate OS processes.
- Streaming is simulated in the UI after a full provider response is received.
- Context snapshots are partial and not a complete durable provider request trace.
- Artifact viewer still uses mock placeholders during execution; real artifact persistence is not wired into the run loop.
- API keys are stored in localStorage/env during development. OS keychain storage is not implemented.
- Gemini is catalog/planned only; no live direct Gemini adapter.
- MCP has no write tools and no workflow execution.

## Development Rules

1. Do not create `AGEND.md`; use `AGENT.md`.
2. Do not claim mock/partial features are production-ready.
3. Do not commit secrets or print raw API key values.
4. Keep CLI/MCP read-only unless a permission and audit system exists.
5. Do not add hidden cloud calls or background provider checks.
6. Do not add arbitrary command execution.
7. Use `resolve_safe_path()` for Rust file paths.
8. Hook execution must stay explicit and consent-gated.
9. Prefer small, reviewable fixes over rewrites.
10. Verify with real commands before declaring completion.

## Key Files

| File | Purpose |
|---|---|
| `src/hooks/useWorkflowExecution.ts` | Workflow runner (uses `runParallel`) |
| `src/services/model-providers/providerAdapter.ts` | Provider call adapter |
| `src/utils/providerConfig.ts` | Provider selection and Ollama URL/key helpers |
| `src/services/wizard/goalTemplates.ts` | Rule-based goal templates |
| `src/components/guide/GuidePanel.tsx` | Rule-based guide assistant |
| `cli/harness.mjs` | Read-only CLI |
| `mcp/server.mjs` | MCP stdio server |
| `src-tauri/src/commands/api_commands.rs` | Provider calls and Ollama Cloud handling |
| `src-tauri/src/commands/process_commands.rs` | Hook execution |
| `docs/DEPLOYMENT_READINESS.md` | Current readiness source of truth |

## Next Best Work

1. Replace simulated streaming with real provider streaming (SSE from Tauri).
2. Persist real per-run artifacts and context traces into `.harness/artifacts/`.
3. Move API keys from localStorage to an OS keychain (Tauri Stronghold).
4. Add installer smoke tests on a clean Windows user profile.
5. Wire real GitHub Actions CI (tsc + vitest + cargo test on every push).

