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

Last execution pass: 2026-09-26 (the `npm run tauri -- dev` and
`npm run tauri -- build` rows come from an earlier pass and were not re-run;
`tauri build --debug --no-bundle` was re-run on 2026-09-25).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | Passed, 668 tests / 65 files |
| `cargo test` | Passed, 95 tests (the app build) |
| `cargo test --no-default-features --features core` | Passed, 95 + 1 tests; no Tauri, WebView or GTK in the dependency tree |
| `npm run build` | Passed; Vite empty `vendor-react` and large `index`/`monacoLocal` chunk warnings remain |
| `npm run build:core`, `npm run build:cli` | Passed: `harness-core` (5.6 MB release binary) and `cli/dist/harness-run.mjs` |
| `npm run tauri -- dev` | Launched `target\\debug\\agent-workflow-builder.exe` and WebView2 |
| `npm run tauri -- build` | Produced MSI and NSIS installers |
| CLI | Read-only commands tested; `harness run` end to end against a fake `harness-core` |
| `harness run` (live) | 2026-09-26: the real `harness-core` and a free keyless endpoint; an agent fixed a bug and ran an allowed `node --test`, and `--resume` reused it (see `docs/DEVELOPMENT_LOG.md`) |
| MCP | stdio server and read/test tools tested |

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | Tauri 2, Rust backend, WebView2 on Windows |
| Frontend | React 19, TypeScript, Vite |
| Canvas | `@xyflow/react` |
| State | Zustand + zundo |
| Validation | Zod |
| CLI | `cli/harness.mjs`: read-only commands, and `run` for headless workflow runs |
| MCP | `mcp/server.mjs`, stdio read/test v0 |

## What Works

- Canvas editor with node/edge editing, validation, undo/redo, auto-layout, examples, and YAML load/save.
- Rule-based Workflow Wizard / Create from Goal, including blog automation and Harness Studio self-improvement templates.
- Rule-based Guide Assistant. It makes no live AI calls.
- Provider settings and adapters for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints.
- Agent file tools (`read_file`/`fs.read`, `list_files`, `grep`, `fs.write`, `fs.append`, and `edit_file` for nodes with `fs.write`), confined to the open workspace, called through native tool calling (Rust `chat_turn`; loop in `src/services/execution/agentLoop.ts`) with the `<tool_call>` text protocol as fallback.
- Coding core:
  - Every file a run's agents write is in the run's change log (`changeLog.ts`). The Changes dialog shows a diff and reverts per file or all (`revertChanges.ts`, Rust `delete_workspace_file`).
  - Native tool-calling turns stream live (`chat_stream.rs`).
  - Past 75% of a node's Token budget, older steps become a progress note (`compaction.ts`).
  - The workspace's `AGENTS.md` is given to agents with workspace tools (`projectInstructions.ts`).
- Sub-agents: `subagent_dispatch` (`src/services/execution/subAgents.ts`) starts helpers with a fresh context and a subset of the parent's tools; one level deep, max 5 per node run, 3 at a time. Helpers are recorded on the node's run (`AgentRun.subAgents`) and listed in `AgentActivityPanel`.
- Ollama Cloud model `gemma4:31b-cloud`; alias `gemma4-31b:cloud` normalizes to the canonical model.
- Air-gapped operation against a local OpenAI-compatible server: the "Custom" provider POSTs to `<base-url>/chat/completions` from the Rust backend (not the WebView, so CSP does not block it), key optional. Ship via the offline installer (`build-installer.ps1 -Offline`). See `docs/AIRGAPPED.md`.
- CLI:
  - `npm run harness -- project status`
  - `npm run harness -- provider list`
  - `npm run harness -- workflow validate <file>`
  - `npm run harness -- run <workflow> --task "…"` (see below)
- Headless runs (`docs/HEADLESS.md`): `harness run` runs a workflow without the app.
  - It uses the same engine (`src/engine/runWorkflow.ts`) and `harness-core`: the app's Rust commands built without Tauri, over JSON lines on stdin/stdout.
  - Keys come from the environment. Agent commands run only if passed exactly with `--allow-command`.
  - Output is readable lines or `--json` events, with exit codes for CI.
- Run records: every run, in the app with a workspace open and in `harness run`, is saved to `.harness/runs/<runId>/run.json`. `harness run --resume <runId>` reuses the agents that finished and did not change.
- CI: `.github/workflows/ci.yml` runs on Linux: types, the TypeScript and Rust tests (with and without Tauri), and `harness run` against the real `harness-core`. `examples/ci/harness-run.yml` is a template for other repositories.
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

- Execution uses `runParallel()` from `src/services/execution/parallelScheduler.ts`, which runs independent branches concurrently up to `executionSettings.maxParallel`. Feedback edges are excluded from dependency calculations; instead, a verdict of REVISE (or one naming the edge's label) re-runs the path back to the reviewer, up to 2 rounds (`src/services/execution/routing.ts`). Gateway routing prunes skipped branches.
- Agents are independent in node ID, role, prompt, model, output, status, audit entries, and snapshots. They are not separate OS processes.
- Streaming is real for native tool-calling turns; the text-protocol fallback and helper agents still show each reply after it arrives (typed out in chunks).
- Context snapshots are partial and not a complete durable provider request trace. Run records (`.harness/runs/`) keep each agent's status, output and the audit, not the provider requests.
- `harness run` shows each agent's reply when it is done (no streaming). `harness-core`'s Ctrl+C handling is tested on Linux in CI; on Windows it was checked once with a scripted console Ctrl+C, not by an automated test. There are no prebuilt `harness-core` binaries, and the app has no Resume button.
- Artifact viewer still uses mock placeholders during execution; real artifact persistence is not wired into the run loop (so MCP `list_artifacts` is empty for app runs).
- API keys are stored in localStorage/env during development. OS keychain storage is not implemented.
- Gemini is catalog/planned only; no live direct Gemini adapter.
- MCP has no write tools and no workflow execution.
- Agent shell commands (`bash`/`run_command`) run only after the user approves the exact command: once, or for the rest of the run ("Allow for this run" grants that exact text). This goes through `commandConsentStore` + `CommandConsentDialog` and the Rust `execute_command`. Keep it that way: no other auto-approval, and sub-agents never get `bash`. Approved commands are not sandboxed. Stop kills a running command's process tree (`cancel_command`).
- During workflow runs only Hook-role nodes run their `preHook`. Pre/post hooks on agent nodes run only manually from the Hooks tab; `postHook` never runs during runs. Hooks marked `requireConsent` are not run automatically (the node fails and the run stops).
- Temperature, per-node fallback model, gateway `condition` text, prompt `{{variables}}`, and workflow-level `executionSettings.timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved and labeled in the UI but not applied at runtime.
- The VS Code extension (`vscode-extension/`) is an experimental scaffold; most commands do not work yet (command names do not match the webview).

## Development Rules

1. Do not create `AGEND.md`; use `AGENT.md`.
2. Do not claim mock/partial features are production-ready.
3. Do not commit secrets or print raw API key values.
4. The CLI's `project`, `workflow` and `provider` commands stay read-only, and MCP stays limited to read/test tools. `harness run` executes workflows: agent commands run only if the user passed that exact command with `--allow-command`, and every command is audited.
5. Do not add hidden cloud calls or background provider checks.
6. Do not add command execution without the user's approval of that exact command: once, as a run grant the user chose (agent `bash` goes through `commandConsentStore`), or up front with `harness run --allow-command`. Never auto-approve anything else.
7. Use `resolve_safe_path()` for Rust file paths.
8. Hook execution must stay explicit and consent-gated.
9. Prefer small, reviewable fixes over rewrites.
10. Verify with real commands before declaring completion.

## Key Files

| File | Purpose |
|---|---|
| `src/engine/runWorkflow.ts` | Workflow run engine (uses `runParallel`); no React, stores or Tauri |
| `src/engine/runRecord.ts` | Saved run records (`.harness/runs/`) and the resume rule |
| `src/cli/runCli.ts` | `harness run` (bundled by `npm run build:cli`) |
| `src-tauri/src/commands/core_server.rs` | `harness-core`: the run's Rust commands over stdin/stdout (`npm run build:core`) |
| `src/hooks/useWorkflowExecution.ts` | Runs the canvas workflow in the app through the engine |
| `src/services/model-providers/providerAdapter.ts` | Provider call adapter |
| `src/utils/providerConfig.ts` | Provider selection and Ollama URL/key helpers |
| `src/services/wizard/goalTemplates.ts` | Rule-based goal templates |
| `src/components/guide/GuidePanel.tsx` | Rule-based guide assistant |
| `cli/harness.mjs` | CLI: read-only commands, and `run` (headless runs: `src/cli/`, needs `npm run build:cli` and `npm run build:core`) |
| `mcp/server.mjs` | MCP stdio server |
| `src-tauri/src/commands/api_commands.rs` | Provider calls and Ollama Cloud handling |
| `src-tauri/src/commands/process_commands.rs` | Hook execution and approved agent commands (`execute_command`) |
| `docs/DEPLOYMENT_READINESS.md` | Current readiness source of truth |
| `docs/AIRGAPPED.md` | Offline / air-gapped deployment runbook |
| `scripts/build-installer.ps1` | Installer build; `-Offline` embeds WebView2 |

## Next Best Work

1. Git-native runs: a worktree per run, a diff that includes command-made changes, commit/PR.
2. Persist real per-run artifacts and full provider request traces (run records keep outputs and the audit only).
3. Move API keys from localStorage to an OS keychain (Tauri Stronghold).
4. Add installer smoke tests on a clean Windows user profile.


