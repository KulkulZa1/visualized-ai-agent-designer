# Architecture

Updated: 2026-09-25

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
- `src/engine/runWorkflow.ts` runs workflows through the dependency-aware `runParallel()` scheduler. The `useWorkflowExecution` hook gives it the canvas and settings, and a host that updates the stores.
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
selected route. A node with outgoing feedback edges is a reviewer: when its
verdict is REVISE (or names a feedback edge's label), the path from each fired
edge's target back to the reviewer re-runs with the review, the reviewer's
other inputs the target does not see (e.g. the critique behind a gateway's
route) and the target's previous output, then the reviewer runs again — at most `MAX_REVISION_ROUNDS`
(2) times (`src/services/execution/routing.ts`). The scheduler awaits the whole
loop, so downstream nodes and gateway routing use the final round.

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
  One level deep, at most 5 per node run and 3 at a time. Each helper is recorded
  on the node's run (`AgentRun.subAgents`) and listed in the activity panel.
- **Streaming**: with a channel, Rust `chat_turn` uses the provider's streaming
  API and sends text as it arrives; `chat_stream.rs` rebuilds the non-streaming
  JSON from the events, so the usual parsers read it. A node's own native turns
  stream into its output; helpers and the text protocol don't. A server that
  cannot stream is asked again without streaming for the rest of the run.
- **Compaction** (`compaction.ts`): before a model call, once the conversation
  passes 75% of the node's Token budget, older steps become a progress note the
  model writes; the newest tool exchange stays verbatim.
- **Project instructions** (`projectInstructions.ts`): the workspace's
  `AGENTS.md` (max 32 KB) is added to the system message of agents and helpers
  with a workspace tool.
- **Change log** (`changeLog.ts`, `revertChanges.ts`): every `fs.write`,
  `fs.append` and `edit_file` of a run is recorded (content before the run and
  latest); the Changes dialog shows a diff and reverts per file or all.

Important boundaries:

- This is JavaScript async concurrency inside the renderer, not OS process isolation.
- Text-protocol replies (and helpers') are still shown after they arrive, typed out in chunks.
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
- Agent shell commands (`bash`/`run_command`, `src/services/execution/commandTool.ts`)
  run only after the user approves each exact command, once or for the rest of
  the run (`commandConsentStore`, `CommandConsentDialog`). Time spent waiting
  for the answer does not count against the node's time. Stop kills a running
  command's process tree (`cancel_command`). The Rust `execute_command` runs the line in the
  workspace folder (Windows: `cmd.exe /d /s /c` in a cmd started after
  `chcp 65001`, so output is UTF-8; elsewhere `sh -c`), without provider keys
  or input, until the node's remaining time runs out. It is not sandboxed.
  `execute_inline_command` stays removed.
- Agent file tools (read, list, grep, `fs.write`, `fs.append`, `edit_file`) are confined to
  the open workspace, and an agent can only run the tools offered to it. A
  sub-agent gets a subset of its parent's tools (never `bash`) and cannot start
  sub-agents.
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
