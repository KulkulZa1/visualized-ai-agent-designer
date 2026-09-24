# Harness Studio User Manual

Updated: 2026-09-24

## What Harness Studio Is

Harness Studio is a local-first Tauri desktop app for visual multi-agent AI
workflows. Users create agent graphs, configure prompts/tools/hooks/models, and
run the workflow against configured providers.

## Current Truth

- Execution uses dependency-aware bounded parallel scheduling for independent forward-edge branches.
- Agents have separate node IDs, prompts, models, outputs, status, logs, and snapshots, but are not separate OS processes.
- Feedback edges do not create scheduling dependencies, and gateway routing can skip unmatched branches.
- Streaming is simulated after the full provider response arrives.
- Context inspector is useful but not a complete durable trace yet.
- Artifact viewer still uses mock placeholders during execution.
- Agents can use workspace file tools (read, list, grep, `fs.write`, `fs.append`); the `bash`/`run_command` tool is disabled and refused. An agent only runs the tools you gave it.
- An agent with the `subagent_dispatch` tool can start helper agents while it runs: each gets a fresh context, a subset of the agent's tools and the same model, and reports back. Helpers cannot start helpers; at most 5 per node run, 3 at a time. The node's activity panel lists each helper with its status, task, tools, time and report (or error); a helper still working when you press Stop shows as stopped, and so does the node itself; starts and tool calls are also in the audit log.
- During runs only Hook-role nodes run their pre-hook. Hooks on agent nodes run only when you click **Run hook** in the Hooks tab, and a hook marked "require consent" is not run automatically (the node fails and the run stops).
- Temperature, per-node fallback model, gateway condition text, prompt `{{variables}}`, and workflow-level timeout/retry settings are saved but not applied at runtime yet.
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

Available tools (8): `project_status`, `list_workflows`, `validate_workflow`,
`run_tests`, `run_cargo_tests`, `list_providers` (metadata and credential
references only), `list_artifacts` (file metadata only; empty until runs persist
artifacts), and `get_recent_logs` (audit-log entries with best-effort, not
guaranteed, secret redaction). No write tools and no workflow execution.

## Verification Commands

```powershell
npm run check:ts
npm test
npm run test:rust
npm run build
npm run tauri -- build
```

Latest verified baseline (2026-09-24): TypeScript passed, Vitest 498 tests /
44 files passed, 63 Rust tests passed, and the frontend build passed. Tauri dev
launch and the MSI/NSIS package build were verified in an earlier pass and not
re-run.


