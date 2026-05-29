# Architecture

Updated: 2026-05-18

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
- `useWorkflowExecution.ts` runs workflows in sequential topological order.
- Provider calls go through `src/services/model-providers/providerAdapter.ts` and Rust IPC commands.
- Rust commands own filesystem access, workflow load/save, audit writes, provider calls, and hook execution.
- CLI and MCP are separate Node entrypoints; they do not require a Tauri runtime.

## Execution Model

Current mode: sequential.

Every executable node gets its own prompt/model/output/status in memory. The
runner stores outputs in a map keyed by node id and passes upstream outputs to
downstream nodes. Independent fan-out branches are not scheduled concurrently.
`executionSettings.maxParallel` is reserved schema only.

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
- Snapshot/artifact service scaffolding.

Partial/mock:

- Execution does not yet persist complete run traces.
- Artifact inspector uses mock placeholders during execution.
- Context snapshots are not yet complete durable model payload traces.

## Security Boundaries

- Rust file paths must go through `resolve_safe_path()`.
- Hook execution goes through `execute_hook`, requires an explicit consent flag,
  and has a timeout.
- Default Tauri capabilities do not allow frontend shell execute/kill.
- CLI is read-only.
- MCP has no write tools and no workflow execution.
- Provider credentials are references/env/local runtime state, not workflow YAML.

## Future Architecture Work

1. Extract workflow execution into a testable core service shared by UI/CLI/MCP.
2. Add a parallel scheduler honoring `executionSettings.maxParallel`.
3. Add real streaming provider adapters.
4. Persist run traces and artifacts by run id and source node id.
5. Move secrets to OS keychain/Stronghold.
