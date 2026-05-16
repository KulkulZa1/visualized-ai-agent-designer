# Architecture

## Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Desktop shell | Tauri 2.0 | 8-12 MB bundle, security-by-design, <0.5s startup |
| Frontend | React 19 + TypeScript | Ecosystem, component model |
| Workflow canvas | React Flow v12 (`@xyflow/react`) | Industry standard for node editors |
| State management | Zustand 5 + zundo | Action-based mutations, undo/redo |
| Schema validation | Zod 4 | Runtime type safety at IPC boundaries |
| Rust backend | Tauri commands via `std::fs` | Scoped file access, audit log, hook execution |
| Styling | Tailwind CSS v4 | Utility-first, zero-config purging |
| In-app editor | Monaco Editor | VS Code-grade editing for .md and .yaml |

## System Diagram

```
┌──────────────────────────────────────────────────────┐
│                   Tauri Window                        │
│  ┌──────────────────────────────────────────────┐    │
│  │              React Frontend                   │    │
│  │                                               │    │
│  │  ┌──────────┐  ┌──────────────┐  ┌────────┐  │    │
│  │  │ Sidebar  │  │   Canvas     │  │ Config │  │    │
│  │  │ FileTree │  │ (React Flow) │  │ Panel  │  │    │
│  │  └──────────┘  └──────────────┘  └────────┘  │    │
│  │                                               │    │
│  │  Zustand Stores: workflowStore / workspaceStore / uiStore  │
│  │                                               │    │
│  │  IPC Layer: src/ipc/tauriCommands.ts          │    │
│  └──────────────┬────────────────────────────────┘    │
│                 │ invoke() / listen()                  │
│  ┌──────────────▼────────────────────────────────┐    │
│  │            Rust Backend                        │    │
│  │  fs_commands  workflow_commands  audit_commands │    │
│  │  process_commands                              │    │
│  └──────────────┬────────────────────────────────┘    │
└─────────────────┼──────────────────────────────────────┘
                  │
          ┌───────▼───────┐
          │  Local Disk   │
          │  workspace/   │
          │  *.yaml       │
          │  *.md         │
          │  .agent-audit/│
          └───────────────┘
```

## Data Flow

### Save Workflow
1. User presses Ctrl+S
2. `useKeyboardShortcuts` → `useWorkflowStore.toWorkflowDef()`
3. `workflowDefSchema.parse()` validates structure
4. `invoke("save_workflow", ...)` → Rust
5. Rust: resolve path, validate within workspace, atomic write (`.tmp` → rename)
6. `workflow:saved` event emitted → `markClean()`

### Load Workflow
1. User double-clicks a `.yaml` file in file tree
2. `invoke("load_workflow", ...)` → Rust reads + serde_yaml parses
3. `workflowDefSchema.parse()` validates incoming data
4. `loadWorkflow(def)` → Zustand replaces nodes/edges

### Hook Execution (with consent gate)
1. User clicks "Run hook" in HooksTab
2. Consent dialog shows hook path + content preview
3. On confirm: `invoke("execute_hook", ...)` → Rust
4. Rust: validate path within workspace, spawn process with 30s timeout
5. Returns `{exitCode, stdout, stderr, durationMs}`
6. Audit entry appended to `.agent-audit/audit.log.jsonl`

## Security Boundaries

- **Filesystem**: All Rust commands call `resolve_safe_path()` which asserts paths stay within the user-selected workspace root
- **Shell execution**: Only via the consent-gated `execute_hook` command; no arbitrary command execution from the frontend
- **Tauri capabilities**: `capabilities/default.json` restricts what JavaScript can call
- **API keys**: Never stored in workflow YAML; reference `.env.local` (gitignored)

## Multi-Provider Architecture Plan

The first multi-provider slice is documentation, typed scaffolding, and mock UI only. It does not change live execution behavior.

Target layers:

1. **UI layer**: Settings, node inspector, context inspector, artifact viewer, and future workspace/editor panels.
2. **Workflow canvas layer**: React Flow graph, node selection, status badges, minimap, and edge semantics.
3. **Node/block state layer**: Zustand workflow state plus future execution snapshots for each node.
4. **Agent configuration layer**: Agent role, instruction file, prompt source, tool grants, hooks, default provider, and model override.
5. **Model provider abstraction layer**: Provider catalog, capability flags, model registry, health checks, credential references, and later adapter implementations.
6. **Execution engine layer**: Topological execution, hook gates, provider adapter dispatch, retry/fallback policy, streaming event capture.
7. **Context builder layer**: Prompt layers, upstream outputs, selected files, tool results, final model payload, token estimate, warnings.
8. **Artifact manager layer**: Generated work products linked to workflow runs and source nodes.
9. **File/project service layer**: Workspace file access behind Tauri IPC today and a future VS Code workspace adapter later.
10. **Security/permission layer**: Tool grants, hook consent, path safety, network transparency, credential references, and future Stronghold storage.
11. **Future extension adapter layer**: VS Code commands, tree views, webviews, secret storage, and workspace APIs.

Provider configs live as typed metadata first. UI components must not call provider APIs directly. Later live calls should go through provider adapters shaped around:

- `ProviderConfig` metadata and capability flags
- credential references like `env:OPENAI_API_KEY` or future `secure:openai`
- provider health checks
- model listing when supported
- request/stream execution when implemented

Supported provider targets:

- **Official OpenAI**: separate adapter for Responses API, streaming SSE, tool/function calling, authenticated model listing, and role-separated system/developer/user messages.
- **OpenAI-compatible**: configurable base URL, credential reference, model ID, and explicit capability flags because compatible endpoints differ.
- **Ollama**: local provider, default `http://localhost:11434`, native `/api/tags` discovery, native or `/v1` compatible calls only behind capability checks.
- **Cloud placeholder**: reserved for Azure, Bedrock, Vertex, and managed gateways without prematurely implementing provider-specific behavior.
- **Kilo / Kilo Code**: gateway-compatible placeholder only. Treat Kilo Gateway as OpenAI-compatible where documented; do not invent private Kilo Code APIs.

## Context Inspector Plan

The context inspector must keep context sources separate rather than merging everything into one text blob.

Sections:

- **Prompt**: static prompt, system prompt, developer notes, user prompt.
- **Final Context**: generated model payload preview, token estimate, warnings.
- **Inputs**: upstream node outputs, user input, tool results.
- **Tools**: allowed tool permissions for the selected node.
- **Files**: selected or referenced files included in context.
- **Output Stream**: current streaming output or future trace stream.
- **Artifacts**: generated work products from this node.
- **Debug Info**: provider, model, local/cloud flag, and planner notes.

Current implementation is a mock/read-only preview built from selected node state and current execution output. Persisted live request capture is future work.

## Artifact System Plan

Artifacts are typed workflow outputs, not generic blobs.

Artifact metadata:

- `id`, `title`, `type`, `sourceNodeId`
- `content`, `previewMode`
- `createdAt`, `updatedAt`, `version`
- optional `filePath`
- `status`

Future persistence should store artifacts under a run-specific `.harness/` path and index them by workflow run and source node. The current slice uses mock artifacts only.

## VS Code Extension Readiness

Do not build a VS Code extension yet. Keep the app ready for one by separating core logic from shell-specific services:

- workflow and provider types stay in reusable TypeScript modules
- provider adapters should not depend on React components
- file/project operations stay behind service interfaces
- command execution remains permissioned and shell-specific
- artifact management uses a service layer
- UI panels should be portable to a VS Code webview later

Future VS Code commands:

- Create Agent
- Open Workflow
- Run Node
- Inspect Context
- Open Artifact
- Edit Agent Instruction
- Sync AGENT.md
