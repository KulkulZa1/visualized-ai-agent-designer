# AGENT.md — Harness Studio

> This file is written for Codex and other AI coding agents.
> Read it before touching any file. Update it when you finish work.

---

## Project Summary

**Harness Studio** is a local-first visual desktop application for designing, configuring, and managing AI agent workflows — called *harnesses*. A harness is everything around the model: orchestration, prompts, tools, hooks, memory, sandboxes, and permission gates. The model is a dependency; this tool makes the harness visible, editable, and reproducible.

The medium is the filesystem. Every node on the canvas maps to a file in `.harness/`. Every edit is a real diff. Nothing lives only in the UI.

**Two UI directions:**
- **Atelier** — builder-first, Linear/Zed-inspired, amber accent (`#e5a142`), tight type. For authoring.
- **Observatory** — telemetry-first, Datadog/Grafana-inspired, cyan accent (`#4dd4ff`). For monitoring.

**Tech stack:**
- Desktop shell: Tauri 2.0 (Rust backend, ~10 MB bundle)
- Frontend: React 19 + TypeScript + Vite
- Canvas: React Flow v12 (`@xyflow/react`)
- State: Zustand 5 + zundo (undo/redo)
- Validation: Zod 4
- Styling: Tailwind CSS v4
- Editor: Monaco Editor (`@monaco-editor/react`)
- Tests: Vitest + Rust `cargo test`

**Workspace:** `D:\toy_project\AI_agent`

---

## Current Phase

**Phase 5: Execution Engine + Context Persistence Service + UX Polish** — verified 2026-05-17.

The running Tauri app manages the **Harness Studio — Active Project** harness with 12 nodes and 18 edges. Session 3 additions:

- **Auto-scroll AuditStrip** — scrolls to bottom (oldest-first) or top (newest-first) on new entries using `useRef` + `useEffect`. Animated amber progress bar while execution is running (`isRunning` from executionStore).
- **Keyboard help overlay** — `KeyboardHelp.tsx` modal triggered by `Ctrl+/` (`Ctrl+?`); shows 3 sections (Navigation, Canvas/Execution, Panels) in a 500px dark modal. `?` button added to TopBar between ⌘K and Examples.
- **Snapshot JSON export** — "Export JSON" button in ContextInspectorTab → downloads all non-cancelled snapshots as `snapshots-{nodeId}.json` via browser Blob API (works in Tauri WebView without plugin).
- **Token tracking in nodes** — after each successful agent run, estimates `Math.ceil(chars/4)` tokens and updates `node.tokens.used` via `updateNodeData`. Also stored in `AgentRun.tokenEstimate`.
- **Resizable config panel** — CSS `resize: horizontal` on ConfigPanel outer div (240–600px range, native browser drag).
- **Provider/model info in RunPanel** — `AgentRun` extended with `providerUsed`, `modelUsed`, `tokenEstimate`. RunPanel shows `model via provider` and `~N est. tokens` when done.
- **Tests** — 118 → 124 Vitest tests (6 new token estimate + type tests).

Current slice adds (prior, still active):

- **Execution engine** — Run button calls Claude/OpenAI/Ollama API per node in topological order. Node status visualised in real time (running/done/error) with glow effects. RunPanel shows per-agent output, elapsed time, and a Cancel button.
- **API error handling** — OpenAI 429 `insufficient_quota` and Anthropic insufficient-credit responses are classified as non-retryable billing errors with clear user messages. Temporary rate limits retry with 1s/2s/4s exponential backoff. Ollama is a first-class fallback with health check before workflow start.
- **Model routing** — Internal tier names (`gpt-5.5-xhigh/high/mid`) resolve to real API IDs (`gpt-5.5`, `gpt-5.4-mini`) in the execution engine. `reasoning_effort` is passed for o-series and GPT-5.5 models. Visual Inspector stays on `claude-sonnet-4.6`.
- **Think depth** — RoleTab exposes a `None/Low/Medium/High` chip selector for GPT-5.5 and o-series nodes; sets `reasoning_effort` on API calls.
- **Snapshot repository service** — `src/services/context-builder/snapshotRepository.ts` provides in-memory `SnapshotRepository` (interface ready for Tauri file/SQLite). ContextInspectorTab seeds a demo snapshot on first open and shows status/id.
- **Provider extension** — Catalog now includes Google Gemini (`type:"gemini"`, NOT OpenAI-compatible) and Ollama remote (`type:"ollama-remote"`) as disabled scaffolding entries. No live adapters.
- **UX fixes** — AuditStrip order toggle, larger output panels (RunPanel 80→200, AgentOutputPanel 160→280, TextBlock 170→240), Copy buttons, SettingsPanel provider registry section.
- **Tests** — 92/92 Vitest pass (was 73); 19 new snapshot-repository tests added.

### Full UI Verification — 2026-05-17

- Launch: `npm run tauri -- dev`, PID 34332, maximized at 2576×1408.
- Active Project loaded via `Ctrl+Shift+E`: 12 nodes, 18 edges confirmed on canvas.
- Settings provider registry: screenshot-confirmed — 8 providers visible (OpenAI, Anthropic, OpenAI-compatible, Ollama local, Cloud placeholder, Ollama remote, Google Gemini, Kilo).
- Context inspector: screenshot-confirmed — CONTEXT tab for Project Orchestrator node shows all sections (Prompt, Final Context, Inputs, Tools, Files, Output Stream, Artifacts, Debug Info).
- AuditStrip order toggle: confirmed at screen (358, 1319) via Snapshot UI tree — button labeled "↓ Newest first".
- No screenshots were impossible to capture; all three pending verification gaps are now closed.

### Visible Desktop Launch Verification - 2026-05-16

- Launch command used: `npm run tauri -- dev`
- Result: real Tauri desktop window opened visibly as **Agent Workflow Builder**.
- Visual evidence: desktop screenshot captured after launch showed the nonblank dark Harness Studio UI with the `harness-studio` top bar, left sidebar, central canvas, right config panel, and bottom audit/status areas.
- Process evidence: Vite served `http://localhost:1420`, Cargo ran `target\debug\agent-workflow-builder.exe`, and `agent-workflow-builder.exe` was running from `D:\toy_project\AI_agent\src-tauri\target\debug\agent-workflow-builder.exe`.
- Logs: `.harness\run-logs\tauri-dev-visible-20260516-183711.log` (final active launch), plus earlier failed/hidden-attempt logs in `.harness\run-logs\`.
- Initial issue: first sandboxed launch failed with `Error: spawn EPERM` when Vite tried to spawn esbuild. The escalated launch succeeded.
- Remaining verification note: this PowerShell session reported `MainWindowHandle: 0` even while the screenshot showed the Tauri window, so screenshot evidence is the authoritative visual verification for this run.
- Next operating step in the app: press `Ctrl+E`, choose **Harness Studio — Active Project**, then click **Load**. From Phase 4 (Hook & Permission Management), use that loaded harness to manage Harness Studio development.

### Phase 4 Runtime Verification - 2026-05-16

- Launch command used: `npm run tauri -- dev`
- Log file: `.harness\run-logs\tauri-dev-phase4-visible-20260516-185641.log`
- Visual evidence: screenshot captured after loading **Harness Studio - Active Project** showed 12 nodes and 18 edges on the canvas.
- Permission evidence: screenshot captured with the new **Permission Matrix** modal open showed 12 nodes, 42 grants, 5 high-risk nodes, and 1 ungated node.
- Interaction evidence: clicking **Add guard** for the ungated Test Worker changed the summary to 0 ungated nodes and marked the node as gated.
- Verification commands: `npx tsc --noEmit`, `npx vitest run`, `cargo test`, `npm run build`, and `rustfmt --check src\commands\process_commands.rs`.
- Remaining note: full `cargo fmt --check` still reports formatting diffs in unrelated existing Rust files; only the changed `process_commands.rs` file was formatted.

### Provider Error Handling - 2026-05-16

- OpenAI quota/billing responses now show a clear non-retry billing message instead of raw provider text.
- OpenAI temporary rate limits remain retryable with exponential backoff.
- Anthropic low-credit responses now show a clear non-retry billing message.
- Ollama is the preferred local fallback with default `http://localhost:11434` and `qwen2.5-coder:7b`.
- Provider health checks verify keys or local Ollama availability before workflow execution.
- Local fallback verification: `qwen2.5-coder:7b` is installed in Ollama; `/api/tags` and `/v1/chat/completions` returned `200`; the visible Tauri app launched with **Harness Studio - Active Project** loaded.
- Automated verification: `npx tsc --noEmit`, `npx vitest run` (67/67), `cargo test` (11/11), `npm run build`, and Rust format checks for changed files passed.
- Do not print real API keys; use masked forms such as `sk-p****abcd` in diagnostics.

### Multi-Provider Context and Artifact Planning - 2026-05-17

- First slice is intentionally limited to docs, types, tests, and mock UI.
- Provider catalog scaffolding now covers official OpenAI, OpenAI-compatible endpoints, Ollama, cloud placeholder, Kilo/Kilo Gateway placeholder, and Anthropic.
- UI components must not call provider APIs directly. Future live calls should go through provider adapter services.
- Provider configs use credential references such as `env:OPENAI_API_KEY`; do not add new raw-key fields or plaintext secret persistence.
- Selected nodes now have a **context** inspector tab for prompt layers, final context preview, upstream inputs, tools, files, output stream, artifacts, and debug info.
- Artifact viewer is mock-only in this slice. Do not claim artifact persistence until run-scoped storage is implemented.
- Future VS Code extension work should reuse core types/services and keep file, command, credential, provider, and artifact operations behind shell adapters.

### Snapshot Service and Provider Extension - 2026-05-17

- **Persisted snapshot service boundary added**: `src/services/context-builder/snapshotRepository.ts` provides an in-memory `SnapshotRepository` with a clean interface ready for future Tauri file or SQLite backing. Singleton `snapshotRepo` exported. `snapshotFromContextSnapshot` converter maps live context snapshots to the persisted format without API calls.
- **Gemini and Ollama-remote provider entries added**: `ProviderType` extended with `"gemini"` and `"ollama-remote"`. `DEFAULT_PROVIDER_CATALOG` now includes Google Gemini (byok, not OpenAI-compatible — requires dedicated adapter) and Ollama remote endpoint (hosted, reverse-proxy auth optional). Both are disabled/not_configured scaffolding only; no live adapters implemented.
- **UX fixes applied**: AuditStrip (max-height 320, order toggle, `workflow_loaded` color); RunPanel (max-height 200, last 10 lines, Copy button); AgentOutputPanel (max-height 280, Copy button); ContextInspectorTab TextBlock (max-height 240); SettingsPanel (collapsible Provider Registry section via `ProviderRegistrySection` helper component).
- **ContextInspectorTab**: seeds a demo `PersistedSnapshot` in `snapshotRepo` on first open for each node (status: "mock"), and shows a snapshot info row below the mock-data banner.

---

## Completed Work

### Phase 0 — Research & Planning ✅
- Researched existing tools: LangGraph, CrewAI, AutoGen, Flowise, Dify, n8n, Langflow
- Identified user pain points: config sprawl, no visual overview, hard debugging, manual permissions
- Evaluated Tauri vs Electron vs VS Code extension (chose Tauri)
- Defined design system (see `.design/Documents/design.md`)
- Architecture decision: Atelier + Observatory dual-mode UI

### Tauri + React Scaffold ✅ (pre-Phase-2 code, on hold)
All code below exists but is NOT the focus yet. Review the HTML prototype first.
- TypeScript types (`src/types/`)
- Zod schemas (`src/schemas/`)
- Zustand stores with undo/redo (`src/store/`)
- Tauri IPC layer with typed wrappers (`src/ipc/`)
- Rust commands: filesystem, workflow YAML save/load, audit log, hook execution (`src-tauri/src/commands/`)
- Tauri capability scoping (`src-tauri/capabilities/default.json`)
- React Flow canvas with 6 agent node types (`src/components/`)
- 5-tab config panel (`src/components/config-panel/`)
- File tree + Monaco editor (`src/components/file-tree/`, `src/components/editor/`)
- 17 Vitest tests passing, 5 Rust tests passing, 0 TypeScript errors
- Visible Tauri smoke test completed on 2026-05-16 with `npm run tauri -- dev`.

### Phase 1 — HTML Prototype ✅ (pending human review)
- `prototype/index.html` — self-contained, no build step required
- Design faithful to `.design/` files (Atelier direction)
- All 3 workflow patterns switchable at runtime
- Phase progress and review checklist modals

---

## Current Prototype

**File:** `prototype/index.html`

Open this file directly in any modern browser — no server needed.

**What it demonstrates:**
1. Three-column layout: file tree sidebar | workflow canvas | config panel
2. Draggable agent nodes with role glyphs (◆ ◇ ● ◐ ▣ ✕ ⊕)
3. Typed edges: solid (data), dashed purple (memory), dashed gray (control), solid red (feedback)
4. Five-tab inspector: Role, Prompt, Tools, Hooks, Memory
5. Collapsible audit/trace strip with real log entries
6. Phase progress modal (click "📊 Phases" in header)
7. Review checklist modal (click "✅ Review" in header)

**Design tokens (Atelier):**
- `bg: #0e0f13`, `surface: #15171c`, `surface2: #1c1f26`, `accent: #e5a142`
- Role tints: orchestrator `#e5a142`, worker `#5fbf7f`, critic `#e07575`, memory `#b88bd9`, gateway `#7c9eff`, hook `#d97757`
- Font: Inter/system-ui for UI, JetBrains Mono for code/numbers/paths

---

## Tasks Suitable for Codex

These tasks are self-contained and safe to delegate now:

### HTML Prototype Improvements
1. **Add Observatory mode** — implement `ObservatoryApp` from `.design/Components/observatory.jsx` as a second tab in `prototype/index.html`. Observatory uses cyan accent `#4dd4ff` and shows token ring gauges + swimlane timeline.
2. **Add Command Palette (⌘K)** — implement from `.design/Components/expansions.jsx`. Triggered by pressing `k` key when canvas focused.
3. **Add Run Preflight modal** — cost estimate + hook consent ledger + dry-run preview. See `expansions.jsx` for reference.
4. **Trajectory Replay panel** — step-by-step inspector. See `expansions.jsx`.
5. **Add node to canvas** — clicking "Add: Worker" in toolbar should create a new node at center of viewport with a generated ID.

### Tests
6. **Write Vitest tests for `yamlSerializer.ts`** — test roundtrip with all 3 workflow patterns, edge cases (empty agents, no connections, unicode in names).
7. **Write Vitest tests for `workspaceStore`** — test `setWorkspacePath` sets recentWorkspaces correctly, `clearWorkspace` resets state, persistence via localStorage mock.

### Documentation
8. **Update `AGENT_WORKFLOW_SPEC.md`** — add Observatory mode section, add edge type reference, add node type reference matching the design system glyphs.

---

## Tasks NOT Yet Suitable for Codex

Do not broaden Phase 4 beyond hook and permission management unless explicitly requested:

- New agent execution engine work.
- Broad architecture rewrites.
- New npm or Cargo dependency installations.
- Git initialization or commits.
- Tauri config or capability changes unrelated to hook execution.
- Feature work outside the loaded **Harness Studio - Active Project** workflow.

---

## Important Files

| File/Dir | Purpose | Status |
|---|---|---|
| `prototype/index.html` | HTML prototype — Phase 1 deliverable | ✅ Created |
| `.design/Documents/design.md` | Full design guide — Atelier + Observatory | ✅ Read-only reference |
| `.design/Components/atelier.jsx` | Atelier component reference | ✅ Read-only |
| `.design/Components/observatory.jsx` | Observatory component reference | ✅ Read-only |
| `.design/Components/workflows.jsx` | Workflow data model | ✅ Read-only |
| `.design/Components/shared.jsx` | Shared icons + edge math | ✅ Read-only |
| `.design/Components/expansions.jsx` | Command palette + preflight + replay | ✅ Read-only |
| `src/types/agent.ts` | TypeScript: AgentRole, ToolPermission, AgentNodeData | ✅ |
| `src/types/workflow.ts` | TypeScript: WorkflowDef, AgentNode | ✅ |
| `src/schemas/workflowSchema.ts` | Zod schema for workflow YAML | ✅ |
| `src/store/workflowStore.ts` | Zustand workflow state + undo/redo | ✅ |
| `src/ipc/tauriCommands.ts` | Typed Tauri invoke wrappers | ✅ |
| `src-tauri/src/commands/fs_commands.rs` | Path-safe filesystem commands | ✅ |
| `src-tauri/src/commands/workflow_commands.rs` | YAML save/load | ✅ |
| `src-tauri/capabilities/default.json` | Tauri security scoping | ✅ |
| `docs/ARCHITECTURE.md` | System design, data flow | ✅ |
| `docs/SECURITY.md` | Threat model, mitigations | ✅ |
| `AGENT.md` | This file — Codex delegation doc | ✅ |

---

## Development Rules

1. **Types before components.** Edit `src/types/` before any component.
2. **Schema validates all IPC.** Never `invoke()` without validating through Zod.
3. **All file I/O through Rust commands.** Never use `@tauri-apps/plugin-fs` from the frontend directly.
4. **Path traversal protection is mandatory.** All Rust `invoke()` paths go through `resolve_safe_path()`.
5. **Hook execution requires user consent.** `execute_hook` command must never be called without the consent dialog.
6. **Audit every write.** Every `write_workspace_file` call appends to `.agent-audit/audit.log.jsonl`.
7. **Read existing code before writing new code.** Check for existing utilities before creating new ones.

---

## Code Quality Rules

- No files > 300 lines. Split if longer.
- No hardcoded strings that should be constants.
- No `any` in TypeScript without a comment explaining why.
- No inline CSS in React (use Tailwind classes or the design token system).
- Tool names are always lowercase mono: `web_search`, `fs.read`. Never `Web Search`.
- Role labels are always capitalized: `Orchestrator`, `Worker`. Never `ORCHESTRATOR`.
- Token counts are always formatted with `.toFixed(1)` + `k` suffix.
- Costs are always formatted with `$` prefix and 2 decimal places.

---

## Security Rules

- **Never store API keys in any config file.** Use `.env.local` (gitignored).
- **Never commit `.env.local`, `audit-log.*`, or `*.tmp`** — they are in `.gitignore`.
- **Never call `execute_hook` from the frontend without showing the consent dialog.**
- **Never trust agent output as a file path or command** — always validate through Zod.
- **Hook scripts must be within the workspace root** — enforced by `resolve_safe_path()`.

---

## Documentation Rules

- Update `docs/PROJECT_STATUS.md` at the end of every session.
- Update `docs/DEVELOPMENT_LOG.md` with date-stamped entries for every significant change.
- Update this `AGENT.md` when:
  - A phase completes
  - New tasks become suitable for Codex delegation
  - Important files change location or purpose
  - Security rules change

---

## Next Recommended Actions

1. **Human:** Review the running Tauri app with **Harness Studio - Active Project** loaded.
2. **Human:** Open the **Permission Matrix** and confirm the guard workflow matches expectations.
3. **Codex:** Implement the remaining Phase 4 hook file creator and dedicated hook execution log viewer.
4. **Codex:** Add tool capability inheritance rules after the UI workflow is approved.
5. **Codex:** Keep verifying Phase 4 changes in the visible Tauri desktop app, not just in Vite or tests.

---

## Open Questions

- Should the `.harness/` folder structure match the `.design/` workspace files exactly? (Current Tauri code uses `.agent-audit/` — rename to `.harness/`?)
- Observatory vs Atelier: should these be two separate windows or a keyboard-toggle within one window?
- Token cost display: should costs be per-run or cumulative per session?
- Workflow YAML format: should it match the `parallel-research.harness.yaml` naming convention from the design?

---

## Handoff Notes for Future AI Agents

**Context:** This project has two parallel artifacts:
1. `prototype/index.html` — the design prototype (Phase 1, React via CDN, no build step)
2. `src/` + `src-tauri/` — the Tauri implementation scaffold (Phase 2+, requires `npm run tauri -- dev`)

The prototype uses different component names and data structures than the Tauri scaffold. When Phase 2 begins, the Tauri scaffold should be aligned with the design system from `.design/` (colors, node types, naming conventions).

**Key alignment issues to fix in Phase 2:**
- Node role naming: scaffold uses `orchestrator/worker/critic/tool_caller/memory/gateway`, design adds `hook`, `aggregator`, and `gateway` has different semantics
- Color tokens: scaffold uses ad-hoc hex values, design has a formal token system (see ATELIER in `atelier.jsx`)
- Config files: scaffold uses `CLAUDE.md`/`AGENTS.md`, design uses `.harness/` directory structure
- Audit log: scaffold uses `.agent-audit/audit.log.jsonl`, design uses `.harness/audit.log.jsonl`

Update this file after completing Phase 2 alignment work.

---

*Last updated: 2026-05-16 | Phase 4 hook and permission slice verified*
