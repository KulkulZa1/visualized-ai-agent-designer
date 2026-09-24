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

Last execution pass: 2026-09-24 (the `npm run tauri -- dev` and
`npm run tauri -- build` rows come from an earlier pass and were not re-run).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | Passed, 492 tests / 44 files |
| `cargo test` | Passed, 63 tests |
| `npm run build` | Passed; Vite empty `vendor-react` and large `index`/`monacoLocal` chunk warnings remain |
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
- Agent file tools (`read_file`/`fs.read`, `list_files`, `grep`, `fs.write`, `fs.append`), confined to the open workspace, called through native tool calling (Rust `chat_turn`; loop in `src/services/execution/agentLoop.ts`) with the `<tool_call>` text protocol as fallback.
- Sub-agents: `subagent_dispatch` (`src/services/execution/subAgents.ts`) starts helpers with a fresh context and a subset of the parent's tools; one level deep, max 5 per node run, 3 at a time. Helpers are recorded on the node's run (`AgentRun.subAgents`) and listed in `AgentActivityPanel`.
- Ollama Cloud model `gemma4:31b-cloud`; alias `gemma4-31b:cloud` normalizes to the canonical model.
- Air-gapped operation against a local OpenAI-compatible server: the "Custom" provider POSTs to `<base-url>/chat/completions` from the Rust backend (not the WebView, so CSP does not block it), key optional. Ship via the offline installer (`build-installer.ps1 -Offline`). See `docs/AIRGAPPED.md`.
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
  - `list_providers` (metadata and credential references only)
  - `list_artifacts` (file metadata only; empty until runs persist artifacts)
  - `get_recent_logs` (`.harness/audit.log.jsonl` entries with best-effort secret redaction, not a guarantee)
- Tauri package build for Windows MSI and NSIS installer.

## Honest Limitations

- Execution uses `runParallel()` from `src/services/execution/parallelScheduler.ts`, which runs independent branches concurrently up to `executionSettings.maxParallel`. Feedback edges are excluded from dependency calculations. Gateway routing prunes skipped branches.
- Agents are independent in node ID, role, prompt, model, output, status, audit entries, and snapshots. They are not separate OS processes.
- Streaming is simulated in the UI after a full provider response is received.
- Context snapshots are partial and not a complete durable provider request trace.
- Artifact viewer still uses mock placeholders during execution; real artifact persistence is not wired into the run loop (so MCP `list_artifacts` is empty for app runs).
- API keys are stored in localStorage/env during development. OS keychain storage is not implemented.
- Gemini is catalog/planned only; no live direct Gemini adapter.
- MCP has no write tools and no workflow execution.
- Agent shell execution is disabled: `bash`/`run_command` calls are refused and not advertised to the model. Re-enabling needs a per-command consent system.
- During workflow runs only Hook-role nodes run their `preHook`. Pre/post hooks on agent nodes run only manually from the Hooks tab; `postHook` never runs during runs. Hooks marked `requireConsent` are not run automatically (the node fails and the run stops).
- Temperature, per-node fallback model, gateway `condition` text, prompt `{{variables}}`, and workflow-level `executionSettings.timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved and labeled in the UI but not applied at runtime.
- The VS Code extension (`vscode-extension/`) is an experimental scaffold; most commands do not work yet (command names do not match the webview).

## Development Rules

1. Do not create `AGEND.md`; use `AGENT.md`.
2. Do not claim mock/partial features are production-ready.
3. Do not commit secrets or print raw API key values.
4. Keep CLI read-only and MCP limited to read/test tools unless a permission and audit system exists.
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
| `docs/AIRGAPPED.md` | Offline / air-gapped deployment runbook |
| `scripts/build-installer.ps1` | Installer build; `-Offline` embeds WebView2 |

## Next Best Work

1. Replace simulated streaming with real provider streaming (SSE from Tauri).
2. Persist real per-run artifacts and context traces into `.harness/artifacts/`.
3. Move API keys from localStorage to an OS keychain (Tauri Stronghold).
4. Add installer smoke tests on a clean Windows user profile.
5. Wire real GitHub Actions CI (tsc + vitest + cargo test on every push).


