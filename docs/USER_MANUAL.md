# Harness Studio User Manual

Updated: 2026-05-18

## What Harness Studio Is

Harness Studio is a local-first Tauri desktop app for visual multi-agent AI
workflows. Users create agent graphs, configure prompts/tools/hooks/models, and
run the workflow against configured providers.

## Current Truth

- Execution is sequential topological order, not parallel.
- Agents have separate node IDs, prompts, models, outputs, status, logs, and snapshots, but are not separate OS processes.
- Streaming is simulated after the full provider response arrives.
- Context inspector is useful but not a complete durable trace yet.
- Artifact viewer still uses mock placeholders during execution.
- CLI is read-only.
- MCP is read/test-only.

## Main UI Areas

| Area | Purpose |
|---|---|
| TopBar | Workflow name, counts, help, examples, wizard, settings, save, run |
| Sidebar | Workspace files, workflow node list, artifacts summary |
| Canvas | Visual workflow graph |
| Config Panel | Role, Prompt, Tools, Hooks, Memory, Context tabs for selected node |
| AuditStrip | Event log with kind and agent filters |
| StatusBar | Save state, workflow summary, active run state |
| Guide Assistant | Rule-based help panel |

## Starting From Zero

1. Launch with `npm run tauri -- dev`.
2. Open `Create from Goal`.
3. Type a goal, such as `I want to automate blog writing.`
4. Review the recommended workflow and privacy/setup notes.
5. Load the workflow.
6. Configure provider settings.
7. Click Run and provide the initial prompt.

## Provider Choices

| Provider | Local/cloud | Key required | Notes |
|---|---|---|---|
| Ollama local | Local | No | Requires Ollama installed and model pulled |
| Ollama Cloud | Cloud | Yes | `https://ollama.com/api`, `gemma4:31b-cloud`, `OLLAMA_API_KEY` |
| Remote Ollama | Cloud/hosted | Maybe | Requires base URL and possibly `OLLAMA_REMOTE_API_KEY` |
| OpenAI | Cloud | Yes | Capabilities depend on selected model/account |
| Anthropic | Cloud | Yes | Claude models |
| OpenAI-compatible | Gateway | Maybe | Capabilities vary; do not assume streaming/tools |
| Gemini | Planned | Yes | Catalog only; direct adapter not implemented |

## CLI

```powershell
npm run harness -- project status
npm run harness -- provider list --json
npm run harness -- workflow validate examples\purchasing-decision.harness.yaml
```

CLI v0 does not mutate files, call providers, execute workflows, run hooks, or
print secrets.

## MCP

```powershell
npm run mcp
```

Available tools: `project_status`, `list_workflows`, `validate_workflow`,
`run_tests`, `run_cargo_tests`. No write tools and no workflow execution.

## Verification Commands

```powershell
npm run check:ts
npm test
npm run test:rust
npm run build
npm run tauri -- build
```

Latest verified baseline: TypeScript passed, Vitest 229 tests passed, Rust 25
tests passed, frontend build passed, Tauri dev launched, and Tauri package build
produced MSI/NSIS installers.

