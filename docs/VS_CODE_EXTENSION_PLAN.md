# VS Code Extension Readiness Plan

> **Status:** Experimental scaffold in `vscode-extension/` (extension host, webview
> panel, credential service, provider bridge). Most commands do not work yet: the
> command names do not match the webview. The host confines file access to the open
> workspace folder and sends the stored OpenAI key only to api.openai.com.
> **Goal:** Document the boundaries that must hold so a future VS Code extension
> can reuse Harness Studio's workflow, provider, context, and artifact logic
> without forking the codebase.

---

## 1. Current readiness

| Layer | Reusable as-is | Notes |
|---|---|---|
| Workflow types (`src/types/`) | ✅ | Pure TypeScript, no React or Tauri imports. |
| Zod schemas (`src/schemas/`) | ✅ | Pure validation; safe to import in any runtime. |
| Provider catalog (`src/services/model-providers/providerCatalog.ts`) | ✅ | Plain data. |
| Snapshot repository (`src/services/context-builder/snapshotRepository.ts`) | ✅ | In-memory implementation is portable. |
| File snapshot repository (`fileSnapshotRepository.ts`) | ⚠️ | Imports `@/ipc/tauriCommands`. Needs to be wrapped behind a `FileService` interface before VS Code can substitute it with `vscode.workspace.fs`. |
| Artifact service | ⚠️ | Same coupling — uses Tauri IPC for disk writes. |
| Context builder | ✅ | Pure functions over node + upstream output. |
| `useWorkflowExecution` hook | ❌ | Tightly coupled to Zustand stores and `invoke()` API calls. Needs extraction. |
| UI components (`src/components/`) | ⚠️ | Most are pure React; the webview would render them. A handful import Tauri-specific helpers (`tauriCommands`, `mockTauri`). |
| Rust `src-tauri/` | ❌ | Not reachable from VS Code. Functionality must be re-expressed as service interfaces. |

**Blockers** (must be addressed before a VS Code extension is feasible):

1. Extract `FileService` interface. Today direct `@/ipc/tauriCommands`
   imports leak into snapshot/artifact services.
2. Extract `ProviderAdapter` interface. Largely done: `useWorkflowExecution`
   calls `callProvider()` (`src/services/model-providers/providerAdapter.ts`),
   which takes `invoke` as a parameter; the Rust provider commands are still
   the only transport.
3. Extract `CredentialService`. Today the renderer reads `localStorage`
   directly for keys.
4. Extract `AuditService`. Today audit writes go via Tauri command.
5. Move `useWorkflowExecution` logic out of the React hook into a framework-
   agnostic engine module; the React hook should be a thin orchestrator.

None of these require breaking the existing app. Each is a refactor where
the Tauri implementation becomes the default adapter.

---

## 2. Target architecture

```
packages/
  core/                     # pure TS, no React, no Tauri, no vscode
    types/                  # AgentRole, WorkflowDef, ProviderConfig, …
    schemas/                # Zod
    services/
      file/                 # interface + Tauri adapter + vscode adapter
      provider/             # interface + openai/anthropic/ollama/gemini adapters
      credential/           # interface + localStorage adapter + vscode-secrets adapter
      snapshot/             # interface + in-memory + file adapters
      artifact/             # same
      audit/                # interface + file adapter
    engine/
      workflowEngine.ts     # topoSort + per-node execution + hook gates
      contextBuilder.ts     # prompt + upstream + tool composition

apps/
  desktop/                  # current Tauri + React app, depends on @harness/core
  vscode-extension/         # future; uses webview + vscode.workspace.fs

cli/                        # see CLI_MCP_PLAN.md; depends on @harness/core
mcp/                        # see CLI_MCP_PLAN.md; depends on @harness/core
```

This monorepo layout is the **target**, not a demand to refactor today.
For the next 1–2 sessions the existing single-package layout is fine
provided new service code stays free of Tauri imports.

---

## 3. Extension capability matrix

The VS Code extension, when it exists, should support:

| Feature | Implementation note |
|---|---|
| Open workflow builder in a webview | Reuse current React shell. Inject a `vscode` bridge instead of `@tauri-apps/api`. |
| Edit `AGENT.md` | Standard VS Code editor + a side panel that links agents to the file. |
| Edit per-agent prompt files | Standard VS Code editor. |
| View workflows in a TreeView | Sidebar `harness.workflows` view backed by `list_workflows()`. |
| Run selected nodes | Reuse `workflowEngine`. Run inside an extension host worker, not the webview. |
| View artifacts | Custom editor for `.harness/artifacts/`. |
| View logs | Output channel `Harness Studio` + a TreeView for past runs. |
| Inspect context | Reuse ContextInspectorTab as a webview panel. |
| Select providers | Quick Pick + `vscode.SecretStorage` for credentials. |
| Access project files | `vscode.workspace.fs` via `FileService` adapter. |
| Integrate with terminal | `vscode.window.createTerminal` for hook commands (consent gated). |
| Run inside agentic coding workflows | MCP server (see `CLI_MCP_PLAN.md`) registered as an MCP source for Cursor / Claude Code. |

---

## 4. Security constraints specific to VS Code

- **Credentials**: must come from `vscode.SecretStorage` only. Never read
  from `.env.local` from inside the extension; never write keys to disk.
- **Webview CSP**: restrictive `Content-Security-Policy` header; convert all
  resource URIs through `webview.asWebviewUri`.
- **File access**: scoped to `vscode.workspace.workspaceFolders[0]`. Reject
  paths outside.
- **Hook execution**: must go through a new `CommandService` adapter that
  reuses the existing consent dialog model. No raw `child_process.exec`
  exposed to the webview.

---

## 5. Recommended next steps (do not implement yet)

1. Sketch the `FileService` interface, write Tauri adapter (current behavior),
   add Vitest. Don't change call sites yet.
2. Sketch the `ProviderAdapter` interface, split `call_openai_api` /
   `call_anthropic_api` / `call_ollama_api` Rust commands into a per-adapter
   layer behind a common contract.
3. Once 1 and 2 land, extract `workflowEngine` from `useWorkflowExecution`.
4. Only after the engine extraction is stable, create
   `apps/vscode-extension/` and start the webview shell. (An experimental
   scaffold already exists at `vscode-extension/`; see Status above.)

Estimated total effort to reach "extension is unblocked": **3–5 sessions**.
Estimated effort to ship a usable extension after that: **another 3–5 sessions**.

The single highest-leverage refactor is **(2) ProviderAdapter** because it
also unblocks the CLI, the MCP server, and live streaming work in Phase 6.

---

## 6. Open questions

- Should the VS Code extension and desktop app share the React UI bundle, or
  ship two builds? (Shared is appealing but the webview environment differs
  in subtle ways — start with two builds, deduplicate later.)
- Where do snapshots live when the user has no Tauri but is in VS Code?
  Likely `${workspaceFolder}/.harness/snapshots/` — identical layout, swap
  the FS adapter only.
- Does the VS Code extension need its own MCP client, or does it just
  publish an MCP server other clients can use? (Latter is simpler and is
  the design in `CLI_MCP_PLAN.md`.)
