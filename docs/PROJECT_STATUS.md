# Project Status

**Updated:** 2026-05-17
**Project:** Harness Studio — Visual AI Harness Engineering Tool
**Current Phase:** Phase 4 — Hook & Permission Management
**Status:** First hook/permission slice implemented and verified in the visible Tauri app

---

## Completed Phases

### Phase 0 — Research & Planning ✅
Tool research, architecture decision, Atelier + Observatory design system.

### Phase 1 — HTML Prototype ✅
`prototype/index.html` — Atelier design, self-contained, interactive.

### Phase 2 — Visual Workflow Editor ✅
- Dark Atelier theme (CSS tokens, `#0e0f13` bg, `#e5a142` amber accent)
- 8 node types with role glyphs ◆ ◇ ● ◐ ▣ ✕ ⊕ ⬡
- 4 typed edges (data/memory/control/feedback)
- Dagre auto-layout, workflow validation (cycle detection, security)
- AuditStrip with filterable events

### Phase 3+ — Example Files & Format Spec ✅
- [x] **`examples/parallel-research.harness.yaml`** — fan-out with gateway, 8 nodes, 12 edges, all 4 edge types
- [x] **`examples/spec-to-pr.harness.yaml`** — sequential pipeline, 5 nodes, 5 edges, hooks
- [x] **`examples/self-critic.harness.yaml`** — critic loop, 5 nodes, 6 edges, hook + memory + feedback + control
- [x] **`docs/AGENT_WORKFLOW_SPEC.md`** rewritten — complete format reference, all fields, all enums, load rules, common mistakes
- [x] **`src/hooks/useExamples.ts`** — inline YAML, validates with Zod, loads into canvas
- [x] **`src/components/palette/ExamplePicker.tsx`** — modal with Load button, pattern badge, node/edge counts
- [x] **Ctrl+E** shortcut → ExamplePicker; "Examples" button in TopBar
- [x] **26 example tests** → 57/57 Vitest tests pass, 0 TypeScript errors

### Phase 3 — Agent Configuration System ✅
- [x] **CLAUDE.md generator** — all agents, tools, security notes, execution settings
- [x] **AGENTS.md generator** — topology diagram + per-agent spec tables
- [x] **LangGraph Python export** — runnable `StateGraph` with checkpointing
- [x] **CrewAI Python export** — `Crew` with `Agent`/`Task`, process type auto-detected
- [x] **5 hook templates** — consent gate, URL allowlist, path scope, destructive guard, iter counter
- [x] **GeneratePanel modal** — preview + write all generators; Ctrl+G shortcut
- [x] **⌘K Command Palette** — keyboard-driven access to all actions; Ctrl+K shortcut
- [x] **Workflow import** — click `.harness.yaml` in file tree to load into canvas
- [x] **useGenerator hook** — all writes via Rust IPC → audit log
- [x] **13 new generator tests** → 31/31 Vitest tests pass

---

## Current Step: Phase 4 — Hook & Permission Management

The running app was used to load **Harness Studio — Active Project** with `Ctrl+E` → **Load**. That harness is now the intended workflow for managing Harness Studio development from Phase 4 onward.

Implemented in this slice:

1. Visual permission matrix (node × tool grid with risk coloring)
2. One-click guard insertion for ungated high-risk tool grants
3. Hook execution controls in the Hooks tab with consent, env vars, live output, and audit writes
4. Rust hook runner with real timeout enforcement
5. Per-node environment variables for hook execution

Remaining Phase 4 work:

1. Hook file creator template chooser that writes into `.harness/hooks/`
2. Dedicated hook execution log viewer
3. Tool capability inheritance from orchestrator to workers

---

## Verification Results (Phase 4)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run` | ✅ 63/63 tests pass (6 test files) |
| `cargo test` | ✅ 7/7 tests pass |
| `npm run build` | ✅ TypeScript + Vite build passed |
| `rustfmt --check src\commands\process_commands.rs` | ✅ changed Rust file formatted |
| `cargo fmt --check` | ⚠️ reports unrelated existing Rust formatting diffs |

---

### Visible Desktop Launch - 2026-05-16

- Command: `npm run tauri -- dev`
- Visible window: yes, **Agent Workflow Builder** opened as a real Tauri desktop app.
- Screenshot verification: completed. Screenshot showed a nonblank dark Harness Studio UI with top bar, sidebar, canvas, config panel, and audit/status areas.
- Runtime evidence: Vite listened on `http://localhost:1420`; Cargo launched `target\debug\agent-workflow-builder.exe`.
- Log file: `.harness\run-logs\tauri-dev-visible-20260516-183711.log` (final active launch).
- Static build: `npm run build` passed after escalation; sandboxed run failed with `spawn EPERM` while spawning esbuild.
- Initial launch error: sandboxed `npm run tauri -- dev` failed with `Error: spawn EPERM` when Vite/esbuild tried to spawn. Running the launch outside the sandbox resolved it.
- Remaining risk: Windows process enumeration in this session reported `MainWindowHandle: 0` even while the screenshot showed the window, so use screenshot evidence for visual confirmation.

### Phase 4 Visible Runtime Check - 2026-05-16

- Command: `npm run tauri -- dev`
- Log file: `.harness\run-logs\tauri-dev-phase4-visible-20260516-185641.log`
- Screenshot verification: completed.
- Loaded workflow: **Harness Studio — Active Project** via `Ctrl+E` and **Load**.
- Observed UI state: nonblank Tauri app window with 12 workflow nodes, 18 edges, left node list, canvas, minimap, top-bar controls, and right config panel.
- Permission Matrix: opened from the top bar; screenshot showed 12 nodes, 42 grants, 5 high-risk nodes, and 1 ungated node.
- Interaction check: clicked **Add guard** for Test Worker; Permission Matrix updated to 0 ungated nodes and Test Worker showed `gated`.

### Provider Error Handling - 2026-05-16

- Root cause: the reported OpenAI and Anthropic failures are billing/quota failures, not code crashes or malformed requests.
- OpenAI 429 `insufficient_quota` now maps to a non-retry billing message and can fall back to Ollama.
- OpenAI temporary rate limits remain retryable with exponential backoff.
- Anthropic low-credit/Plans & Billing responses now map to a non-retry billing message and can fall back to Ollama.
- Ollama fallback defaults: `OLLAMA_BASE_URL=http://localhost:11434`, `OLLAMA_MODEL=qwen2.5-coder:7b`.
- Health check behavior: selected provider is checked before workflow execution; Ollama reports `ollama pull qwen2.5-coder:7b` when the model is missing.
- Local Ollama evidence: `ollama list` shows `qwen2.5-coder:7b`; `http://localhost:11434/api/tags` returned `200` with that model installed; `POST /v1/chat/completions` returned `200` with a `choices` response for `qwen2.5-coder:7b`.
- Verification note: `npx tsc --noEmit`, `npx vitest run` (67/67), `cargo test` (11/11), `npm run build`, and Rust format checks for changed Rust files passed. Non-elevated Vitest/build/Cargo attempts are still blocked by sandbox process-spawn or target-write restrictions, so those checks require elevated execution in this environment.
- Runtime verification: `npm run tauri -- dev` launched a visible **Agent Workflow Builder** Tauri window. Screenshot verification showed the nonblank Harness Studio UI, then **Harness Studio - Active Project** was loaded via `Ctrl+E` and **Load** with 12 nodes and 18 edges visible.

---

### Multi-Provider Context and Artifact Planning Slice - 2026-05-17

- Scope: documentation, typed scaffolding, and mock UI only. Live provider execution behavior was intentionally not changed.
- Provider architecture: added a typed provider catalog plan for official OpenAI, OpenAI-compatible endpoints, Ollama, cloud placeholders, Kilo/Kilo Gateway placeholder, and Anthropic.
- Credential policy: provider configs use credential references such as `env:OPENAI_API_KEY`; no new raw key storage was added.
- Context inspector: selected node panel now has a **context** tab that separates prompt, final context preview, upstream inputs, tool permissions, files, output stream, artifacts, and debug info.
- Artifact viewer: added mock artifact metadata and a preview/raw view to show the intended artifact system without persistence claims.
- VS Code readiness: architecture now documents reusable core boundaries, provider adapters outside UI components, future webview reuse, and future commands.
- Verification: `npx tsc --noEmit`, `npx vitest run` (73/73), and `npm run build` passed. `npm run tauri -- dev` opened the real **Agent Workflow Builder** desktop app, and screenshot verification showed a nonblank Harness Studio shell with **Harness Studio - Active Project** loaded at 12 nodes and 18 edges.
- Visual verification gap: the top-level desktop app and active workflow canvas were screenshot-confirmed, but nested Settings provider registry and selected-node context/artifact tab screenshots still need a clean pass because desktop click interactions were unstable during this run.
- Current limitation: context and artifact data are labeled mock/preview until execution trace persistence and artifact storage are implemented.

### Session 3 UX Polish and Execution Improvements — 2026-05-17

- **Auto-scroll AuditStrip**: `useRef` + `useEffect` watches `entries.length`; scrolls to bottom in oldest-first mode, top in newest-first. Animated amber progress bar shows while `isRunning`.
- **Keyboard help overlay** (`KeyboardHelp.tsx`): `Ctrl+/` (`Ctrl+?`) opens a 500px modal listing shortcuts across Navigation, Execution, and Panels sections. `?` button added to TopBar.
- **Snapshot JSON export**: "Export JSON" button in ContextInspectorTab downloads all non-cancelled snapshots for the selected node as `snapshots-{nodeId}.json` via browser Blob.
- **Token tracking**: `useWorkflowExecution` estimates `Math.ceil(chars/4)` after each agent run; updates `node.tokens.used` and stores `tokenEstimate` in `AgentRun`.
- **Resizable config panel**: CSS `resize: horizontal` on ConfigPanel (240–600px).
- **Provider/model info in RunPanel**: `AgentRun` gains `providerUsed`, `modelUsed`, `tokenEstimate`; RunPanel shows them per agent row when done.
- **Tests**: 118 → 124 Vitest tests (6 new in `tokenEstimate.test.ts`). `npx tsc --noEmit`: 0 errors.

### Snapshot Repository, Provider Extension, and UX Fixes — 2026-05-17

- **Tests**: 92/92 Vitest tests pass (was 73). `npx tsc --noEmit`: 0 errors. `npm run build`: passed (existing large-chunk warning only). `cargo build`: passed.
- **Snapshot repository service** (`src/services/context-builder/snapshotRepository.ts`): in-memory `SnapshotRepository` with `PersistedSnapshot`, `SnapshotStatus`, `SnapshotPromptLayers` types. Drop-in replaceable with Tauri file or SQLite. Singleton `snapshotRepo` exported. `snapshotFromContextSnapshot` converter maps live inspection data to persisted shape. ContextInspectorTab seeds a demo snapshot on first open per node and shows status/createdAt/id info row.
- **Provider catalog extended**: `ProviderType` and `DEFAULT_PROVIDER_CATALOG` now include Google Gemini (`type:"gemini"`, byok, dedicated adapter required — NOT OpenAI-compatible) and Ollama remote (`type:"ollama-remote"`, hosted, reverse-proxy auth optional). Both are disabled scaffolding entries — no live adapters.
- **UX fixes**: AuditStrip max-height 180→320, order toggle (↑/↓ Newest/Oldest first), `workflow_loaded` kind color. RunPanel output area max-height 80→200, slice last-10-lines, Copy button. AgentOutputPanel max-height 160→280, Copy button. ContextInspectorTab TextBlock max-height 170→240. SettingsPanel provider registry collapsible section shows all 8 catalog entries.
- **Full UI verification completed 2026-05-17**: Real Tauri desktop app launched (`npm run tauri -- dev`, PID 34332). Active Project harness loaded via `Ctrl+Shift+E` — 12 nodes, 18 edges confirmed on canvas. Settings provider registry screenshot-confirmed showing OpenAI, Anthropic, OpenAI-compatible, Ollama local, Cloud placeholder, Ollama remote, Google Gemini, Kilo. Selected-node (Project Orchestrator) Context Inspector tab screenshot-confirmed: all sections visible (Prompt, Final Context, Inputs, Tools, Files, Output Stream, Artifacts, Debug Info). AuditStrip "↓ Newest first" toggle confirmed at screen (358, 1319) via Snapshot UI tree.
- **No secrets added. No live provider calls added.**

---

## Known Issues

- LangGraph export: gateway routing left as `# TODO` comment — conditional edges need runtime input
- CrewAI export: process type detection is heuristic
- Monaco Ctrl+S shortcut uses raw key code — verify on Mac

---

## Architecture

```
prototype/index.html         ← Phase 1 reference (always openable)
src/
  types/                     ← AgentRole×8, ToolPermission×17, WorkflowDef
  schemas/                   ← Zod validators (IPC boundary safety)
  store/                     ← Zustand: workflow(undo/redo), workspace, ui, audit
  ipc/                       ← Typed invoke wrappers + Vitest mocks
  hooks/                     ← useWorkflow, useGenerator, useKeyboardShortcuts
  utils/
    generators/              ← claudeMd, agentsMd, langGraph, crewAi, hookTemplates
    autoLayout.ts            ← Dagre LR layout
    validateWorkflow.ts      ← cycle detection, security warnings
    nodeColors.ts            ← Atelier role metadata
  components/
    canvas/                  ← WorkflowCanvas, CanvasToolbar, DataFlowEdge×4
    nodes/                   ← BaseAgentNode (Atelier), 8 roles, NodeIcon SVGs
    config-panel/            ← 5-tab inspector (Role/Prompt/Tools/Hooks/Memory)
    generate/                ← GeneratePanel modal (Ctrl+G)
    palette/                 ← CommandPalette (Ctrl+K)
    layout/                  ← TopBar, Sidebar, StatusBar, AuditStrip
src-tauri/
  src/commands/              ← fs, workflow, audit(.harness/), process(hooks)
  capabilities/              ← Scoped Tauri permissions
```
