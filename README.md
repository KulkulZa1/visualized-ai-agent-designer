# Harness Studio

Harness Studio is a local-first Tauri desktop app for designing, validating,
running, and inspecting multi-agent AI workflows.

The current app is not just a mockup: the canvas, workflow YAML load/save,
provider adapters, read-only CLI, read/test MCP server, Tauri desktop launch,
and installer build have all been exercised locally. Some important surfaces
are still intentionally partial, especially true parallel scheduling, real
provider streaming, durable run artifacts, and OS keychain storage.

## Current Status

Source of truth: [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md)

Verified on 2026-05-18:

| Area | Result |
|---|---|
| TypeScript | `npx tsc --noEmit` passed |
| Frontend/unit tests | `npx vitest run` passed, 229 tests / 26 files |
| Rust tests | `cargo test` passed, 25 tests |
| Frontend build | `npm run build` passed |
| Tauri dev app | `npm run tauri -- dev` launched `agent-workflow-builder.exe` and WebView2 |
| Tauri package | `npm run tauri -- build` produced MSI and NSIS installers |
| CLI | `project status`, `provider list`, valid and missing workflow cases tested |
| MCP | stdio initialize, `tools/list`, `project_status`, `validate_workflow`, path rejection, and `run_tests` tested |

## Real vs Mock

| Feature | State |
|---|---|
| Visual workflow editor | Implemented |
| YAML examples and validation | Implemented |
| Agent execution | Implemented sequentially in topological order |
| Agent independence | Logical per-node prompt/model/output/log state, not process isolation |
| True parallel scheduling | Not implemented |
| Provider calls | Implemented for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints |
| Gemini direct adapter | Planned/catalog only |
| Streaming | Simulated UI chunks after full provider response |
| Context inspector | Useful preview plus partial run data; not a complete durable trace |
| Artifact viewer | Mock placeholders; real persistence service exists but execution is not wired to it |
| API key storage | localStorage/env development path; OS keychain not implemented |
| CLI | Read-only v0 |
| MCP | Read/test v0, no writes, no workflow execution |

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

## Provider Setup

- Ollama local: install Ollama, run `ollama pull qwen2.5-coder:7b`, use `http://localhost:11434`.
- Ollama Cloud: use `https://ollama.com/api`, model `gemma4:31b-cloud`, and `OLLAMA_API_KEY` or the Settings auth token field.
- Remote Ollama gateways: treat as cloud/hosted; use explicit base URL and, if needed, `OLLAMA_REMOTE_API_KEY`.
- OpenAI/Anthropic: require API keys and send prompts/context to cloud providers.

Do not commit secrets. The CLI and MCP print credential references only.

## Documentation

- [Quick Start](docs/QUICK_START.md)
- [Installation](docs/INSTALLATION.md)
- [MCP Usage](docs/MCP_USAGE.md)
- [Security](docs/SECURITY.md)
- [Project Status](docs/PROJECT_STATUS.md)
- [Deployment Readiness](docs/DEPLOYMENT_READINESS.md)

