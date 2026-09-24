# Architecture

Updated: 2026-09-24

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2, Rust backend |
| Frontend | React 19, TypeScript, Vite |
| Canvas | React Flow |
| State | Zustand + zundo |
| Validation | Zod |
| CLI | Node script, read-only |
| MCP | Node stdio JSON-RPC server, read/test |

## Current Runtime Architecture

- `workflowStore` holds graph state and serializes/deserializes workflow YAML.
- `useWorkflowExecution.ts` runs workflows through the dependency-aware `runParallel()` scheduler.
- Provider calls go through `src/services/model-providers/providerAdapter.ts` and Rust IPC commands.
- Rust commands own filesystem access, workflow load/save, audit writes, provider calls, and hook execution.
- CLI and MCP are separate Node entrypoints; they do not require a Tauri runtime.

## Execution Model

Current mode: bounded parallel scheduling.

Every executable node gets its own prompt/model/output/status in memory. The
runner stores outputs in a map keyed by node id and passes upstream outputs to
downstream nodes. Independent forward-edge fan-out branches can run concurrently
up to `executionSettings.maxParallel`. Feedback edges are ignored for dependency
scheduling, and gateway routes skip branches whose labels do not match the
selected route.

Inside a node, `src/services/execution/agentLoop.ts` runs the model ⇄ tool loop:

- **Native tool calls** (nodes with runnable tools): the Rust `chat_turn` command
  sends JSON-schema tool definitions and a real message history in each
  provider's format (Anthropic `tool_use`/`tool_result`, OpenAI `tool_calls` +
  `role: "tool"`, Ollama `tool_calls` + `tool_name`); every call of a turn is
  answered. Only tools offered to the agent run.
- **Text protocol** (`<tool_call>` tags, one tool per step): nodes without tools,
  models or servers that refuse tool definitions (remembered for the run), a
  first-call billing error (so the local Ollama fallback applies), and the VS Code
  extension, whose invoke shim has no `chat_turn`.
- **Sub-agents** (`subagent_dispatch`, `src/services/execution/subAgents.ts`): an
  agent starts helpers with a fresh context, a subset of its tools and its
  provider, model, deadline and Stop; each report returns as the tool result.
  One level deep, at most 5 per node run and 3 at a time.

Important boundaries:

- This is JavaScript async concurrency inside the renderer, not OS process isolation.
- Provider streaming is still simulated after a full provider response returns.
- The scheduler now rejects pure forward cycles instead of silently finishing.

## Provider Model

Implemented provider paths:

- OpenAI cloud.
- Anthropic cloud.
- Ollama local.
- Ollama Cloud using `https://ollama.com/api` and `gemma4:31b-cloud`.
- OpenAI-compatible custom endpoints.

Planned/scaffolded:

- Direct Gemini adapter.
- Gateway-specific capability detection.

## Persistence

Implemented:

- Workflow YAML load/save via Rust IPC.
- `.harness/audit.log.jsonl` append path for audit entries.
- Context snapshots saved under `.harness/snapshots/` when a workspace is open (in memory otherwise).
- Artifact service scaffolding (not wired into runs).

Partial/mock:

- Execution does not yet persist complete run traces.
- Artifact inspector uses mock placeholders during execution.
- Context snapshots are not yet complete durable model payload traces.

## Security Boundaries

- Rust file paths must go through `resolve_safe_path()`, which resolves the
  deepest existing ancestor for new files (no symlink/junction escape).
- Hook execution goes through `execute_hook`, requires an explicit consent flag,
  and times out after the Hook node's `timeoutSeconds` (default 30 s, max 1 h;
  30 s for manual runs from the Hooks tab). Hook processes do not inherit provider API keys.
  During workflow runs only Hook-role nodes run their pre-hook.
- Agents have no shell tool: `bash`/`run_command` calls are refused and the
  `execute_inline_command` IPC command was removed. Agent file tools (read, list,
  grep, `fs.write`, `fs.append`) are confined to the open workspace, and an agent
  can only run the tools offered to it. A sub-agent gets a subset of its parent's
  tools and cannot start sub-agents.
- Default Tauri capabilities do not allow frontend shell execute/kill.
- CLI is read-only.
- MCP has no write tools and no workflow execution.
- Provider credentials are references/env/local runtime state, not workflow YAML.

## Future Architecture Work

1. Extract workflow execution into a testable core service shared by UI/CLI/MCP.
2. Add real streaming provider adapters.
3. Persist scheduler/run traces and artifacts by run id and source node id.
4. Add deeper failure/cancellation recovery for bounded parallel runs.
5. Move secrets to OS keychain/Stronghold.
