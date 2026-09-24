# Quick Start

Harness Studio is a local-first desktop app for building and running
multi-agent workflows.

## Prerequisites

- Node.js and npm
- Rust toolchain
- Windows WebView2 runtime for Tauri on Windows
- Optional: Ollama for local/private model execution

## Launch

```powershell
npm install
npm run tauri -- dev
```

The app should open as a Tauri desktop window. If you only need to inspect the
frontend in a browser during development:

```powershell
npm run dev
```

## First Workflow

1. Click `Create from Goal`.
2. Type a goal such as `I want to automate blog writing.`
3. Select `Blog Writing Pipeline`.
4. Review the recommended agents, setup requirements, expected artifacts,
   verification method, and privacy notes.
5. Click `Load this workflow`.

Verified behavior: this creates a 7-node / 8-edge workflow and the run dialog
shows the current execution mode, for example `bounded parallel up to 4`, plus
`streaming simulated`.

## Provider Setup

### Ollama Local

Local/private path. Requires Ollama running on the machine.

```powershell
ollama pull qwen2.5-coder:7b
```

Use base URL `http://localhost:11434`.

### Ollama Cloud

Hosted/cloud path. Requires an Ollama Cloud key.

- Base URL: `https://ollama.com/api`
- Model: `gemma4:31b-cloud`
- Credential: Settings auth token field or `OLLAMA_API_KEY`

Prompts and context leave the device.

### Remote Ollama Gateway

Not local/private. Use an explicit base URL and, when required,
`OLLAMA_REMOTE_API_KEY`. Capabilities vary by gateway.

### OpenAI and Anthropic

Cloud providers. Require API keys and send prompts/context to the provider.
Do not hard-code keys or commit them.

## Run

Click `Run`, provide the initial prompt, and start the workflow.

Current execution mode is dependency-aware bounded parallel scheduling.
Independent forward-edge branches can run concurrently up to the workflow's
`maxParallel` setting. Outputs are tracked per node, and AuditStrip shows events
by kind and agent.

## What Is Real vs Preview

| Area | State |
|---|---|
| Canvas, examples, YAML validation | Real |
| Provider calls | Real when configured |
| CLI and MCP | Real read/test surfaces |
| Streaming | Simulated |
| Context inspector | Partial preview/run state |
| Artifacts | Mock placeholders until run persistence is wired |
| API key storage | localStorage/env, not OS keychain |

## Verify From Terminal

```powershell
npm run check:ts
npm test
npm run test:rust
npm run build
npm run harness -- project status
npm run harness -- provider list --json
npm run harness -- workflow validate examples\purchasing-decision.harness.yaml
```

For MCP:

```powershell
npm run mcp
```

See `docs/TROUBLESHOOTING.md` if launch, provider setup, or MCP connection
fails.
