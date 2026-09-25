# Harness Studio

Harness Studio is a local-first Tauri desktop app for designing, validating,
running, and inspecting multi-agent AI workflows.

The current app is not just a mockup: the canvas, workflow YAML load/save,
provider adapters, bounded parallel scheduling, the CLI (read-only commands and
headless runs with `harness run`), read/test MCP server, Tauri desktop launch,
and installer build have all been exercised locally. Some important surfaces are still intentionally partial, especially
real provider streaming, durable run artifacts, process isolation, and OS
keychain storage.

## Current Status

Source of truth: [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md)

Verified on 2026-09-26 (the Tauri dev app and Tauri package rows come from an earlier pass and were not re-run):

| Area | Result |
|---|---|
| TypeScript | `npx tsc --noEmit` passed |
| Frontend/unit tests | `npx vitest run` passed, 668 tests / 65 files |
| Rust tests | `cargo test` passed, 95 tests; the Tauri-free build (`--no-default-features --features core`) passed 95 + 1 |
| Headless runs | `harness run` passed end to end against a fake `harness-core`, and live against the real one with a free endpoint (a fix, an allowed test command, a resume) |
| Frontend build | `npm run build` passed |
| Tauri dev app | `npm run tauri -- dev` launched `agent-workflow-builder.exe` and WebView2 |
| Tauri package | `npm run tauri -- build` produced MSI and NSIS installers |
| CLI | `project status`, `provider list`, valid and missing workflow cases tested |
| MCP | stdio initialize, `tools/list` (8 tools), `project_status`, `validate_workflow`, path rejection, and `run_tests` tested |

## Real vs Mock

| Feature | State |
|---|---|
| Visual workflow editor | Implemented |
| YAML examples and validation | Implemented |
| Agent execution | Implemented with dependency-aware bounded parallel scheduling |
| Agent independence | Logical per-node prompt/model/output/log state, not process isolation |
| Parallel scheduling | Independent forward-edge branches run up to `executionSettings.maxParallel`; feedback edges are not dependencies |
| Revision loops | A node with a feedback edge acts as a reviewer: a verdict of REVISE (or one naming the edge's label) re-runs the path back to the reviewer, up to 2 rounds; downstream nodes wait for the outcome |
| Agent tools | File tools (`read_file`, `list_files`, `grep`, `fs.write`, `fs.append`, and `edit_file` for exact-snippet edits) confined to the open workspace, called with the provider's native tool calling (text-protocol fallback for models without it) |
| Changes and undo | Every file a run's agents change is listed under **Changes (N)** in the run panel, with a side-by-side diff and revert per file or all (files created by the run are deleted) |
| Shell commands | `bash`/`run_command` run a command line in the workspace folder only after you approve that exact command in a dialog, once or for the rest of the run (in `harness run`: only commands passed exactly with `--allow-command`); not sandboxed, no input, no provider keys, stopped at the agent's time limit or killed on Stop; helpers never get it |
| Headless runs | `harness run` runs a workflow without the app, with the same engine and the app's Rust commands (`harness-core`, built without Tauri); keys from the environment, `--json` events, CI exit codes ([docs/HEADLESS.md](docs/HEADLESS.md)) |
| Run records and resume | Every run (the app with a workspace open, and `harness run`) is saved to `.harness/runs/<runId>/run.json`; `harness run --resume` reuses the agents that finished and did not change |
| CI | `.github/workflows/ci.yml` on Linux; `examples/ci/harness-run.yml` is a template for running workflows in other repositories |
| Long runs | Past 75% of a node's Token budget, older steps are summarized into a progress note; the workspace's `AGENTS.md` is given to agents with workspace tools |
| Sub-agents | `subagent_dispatch` starts helper agents with a fresh context and a subset of the parent's tools; one level deep, max 5 per node run, 3 at a time; each helper is listed in the activity panel |
| Hooks during runs | Only Hook-role nodes run their pre-hook; hooks on agent nodes run only manually from the Hooks tab |
| Provider calls | Implemented for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints |
| Gemini direct adapter | Planned/catalog only |
| Streaming | Live for native tool-calling turns (Anthropic, OpenAI-compatible, Ollama); text-protocol replies and helpers are shown after they arrive |
| Temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}`, workflow `timeoutSeconds`/`retryOnFailure`/`maxRetries` | Saved and shown in the UI (labeled), not applied at runtime |
| Context inspector | Useful preview plus partial run data; not a complete durable trace |
| Artifact viewer | Mock placeholders; real persistence service exists but execution is not wired to it |
| API key storage | localStorage/env development path; OS keychain not implemented |
| CLI | Read-only commands, plus `run` for headless runs |
| MCP | Read/test v0 (8 tools), no writes, no workflow execution |
| VS Code extension | Experimental scaffold; most commands do not work yet |

## Run Locally

```powershell
npm install
npm run tauri -- dev
```

Useful verification commands:

```powershell
npm run check:ts
npm test
npm run test:rust
npm run build
npm run tauri -- build
npm run harness -- project status
npm run mcp
```

Headless runs ([docs/HEADLESS.md](docs/HEADLESS.md)):

```powershell
npm run build:cli
npm run build:core
npm run harness -- run examples/purchasing-decision.harness.yaml --task "Pick a laptop" --provider ollama
```

## Provider Setup

- Ollama local: install Ollama, run `ollama pull qwen2.5-coder:7b`, use `http://localhost:11434`.
- Ollama Cloud: use `https://ollama.com/api`, model `gemma4:31b-cloud`, and `OLLAMA_API_KEY` or the Settings auth token field.
- Remote Ollama gateways: treat as cloud/hosted; use explicit base URL and, if needed, `OLLAMA_REMOTE_API_KEY`.
- OpenAI/Anthropic: require API keys and send prompts/context to cloud providers.

Do not commit secrets. The CLI and MCP print credential references only; MCP
`get_recent_logs` returns audit-log entries with best-effort (not guaranteed)
secret redaction.

## Documentation

- [Quick Start](docs/QUICK_START.md)
- [Installation](docs/INSTALLATION.md)
- [Air-Gapped Deployment](docs/AIRGAPPED.md)
- [Headless Runs (`harness run`)](docs/HEADLESS.md)
- [MCP Usage](docs/MCP_USAGE.md)
- [Security](docs/SECURITY.md)
- [Project Status](docs/PROJECT_STATUS.md)
- [Deployment Readiness](docs/DEPLOYMENT_READINESS.md)


