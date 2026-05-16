# Development Log

---

## 2026-05-17 - Bundle Splitting, Session Restore, Artifact Sidebar, Audit Improvements, Snapshot UX

### Result
- Split 809 KB bundle into vendor chunks via Vite `manualChunks` (vendor-react, vendor-flow, vendor-zustand, vendor-editor, vendor-yaml).
- Added session restore: last loaded harness path persisted in localStorage; auto-loaded silently on app startup.
- Added `ArtifactSidebar` panel at the bottom of the Sidebar: collapsible, reads `getPersistedArtifactPaths()`, inline file preview.
- Added module-level path tracking to `artifactService.ts` (`_persistedPaths` Set + `getPersistedArtifactPaths()`).
- Improved `AuditStrip`: severity left-border (error=red, warn=amber, hook=orange, info=transparent); fixed "error" filter to catch `success=false` entries; "warn" filter no longer overlaps with error entries.
- Snapshot delete: "✕" button on each `SnapshotHistoryRow` calls `updateSnapshot(..., { snapshotStatus: "cancelled" })` (soft delete); cancelled snapshots are filtered from the history list.
- Snapshot history reload button (↻) next to "Snapshot History" section title; `loadHistory` extracted as named function.
- Marked Phase 5 complete in ROADMAP.md; added Phase 6 (Execution Tracing — Deep Instrumentation).

### Changes Made
- Modified: `vite.config.ts` — `build.rollupOptions.output.manualChunks`
- Modified: `src/store/workspaceStore.ts` — `lastHarnessPath` state + `setLastHarnessPath` action
- Modified: `src/hooks/useWorkflow.ts` — calls `setLastHarnessPath` after successful save
- Modified: `src/App.tsx` — `useEffect` session-restore on mount (silent, no spinner)
- Modified: `src/services/artifact-manager/artifactService.ts` — `_persistedPaths` Set + `getPersistedArtifactPaths()`
- New: `src/components/layout/ArtifactSidebar.tsx`
- Modified: `src/components/layout/Sidebar.tsx` — added `<ArtifactSidebar>`
- Modified: `src/components/layout/AuditStrip.tsx` — severity borders + corrected filter logic
- Modified: `src/components/config-panel/tabs/ContextInspectorTab.tsx` — snapshot delete + reload
- Modified: `docs/ROADMAP.md` — Phase 5 complete, Phase 6 added
- Modified: `tests/unit/services/artifactService.test.ts` — `getPersistedArtifactPaths` tests
- Modified: `tests/unit/store/workspaceStore.test.ts` — `lastHarnessPath` tests (new describe block)

### Verification
- `npx tsc --noEmit` passed.
- `npx vitest run` passed — 112 existing tests + new tests passing.
- No new npm packages; no live API calls; no secrets.

---

## 2026-05-17 - File-Backed Snapshot Persistence and Execution Wiring

### Result
- Added file-backed snapshot repository (`FileSnapshotRepository`) persisting to `.harness/snapshots/` via Tauri IPC.
- Introduced `snapshotService.ts` façade: routes to file or in-memory depending on workspace availability.
- Wired execution engine to save snapshots non-blocking after each agent completes or fails.
- Added `SnapshotHistory` section at the top of the Context Inspector tab showing up to 5 recent snapshots per node, expandable inline.
- Added `artifactService.ts` for file-backed artifact persistence via Tauri IPC.
- Updated TopBar run stats to show agent completion progress (`● N/M agents`) while a run is active.
- Updated `.gitignore` to exclude `.harness/snapshots/` and `.harness/artifacts/`.
- Added near-term deferred items to TODO.md and persisted-snapshot security note to SECURITY.md.

### Changes Made
- New: `src/services/context-builder/fileSnapshotRepository.ts`
- New: `src/services/context-builder/snapshotService.ts`
- New: `src/services/artifact-manager/artifactService.ts`
- Modified: `src/hooks/useWorkflowExecution.ts` — snapshot wiring (non-blocking, per-agent)
- Modified: `src/components/config-panel/tabs/ContextInspectorTab.tsx` — snapshot history section
- Modified: `src/components/layout/TopBar.tsx` — run progress stat
- New tests: `fileSnapshotRepository.test.ts`, `snapshotService.test.ts`, `artifactService.test.ts`

### Verification
- `npx tsc --noEmit` passed.
- `npx vitest run` passed — existing 92 tests green, new tests added.
- `npm run build` clean (no new warnings beyond existing chunk size note).
- No live API calls introduced; no secrets added; no new npm packages.

---

## 2026-05-17 - Multi-Provider Context and Artifact Planning Slice

### Result
- Implemented the safe first slice for multi-provider orchestration, node context inspection, artifact viewing, and VS Code extension readiness.
- This is documentation, typed scaffolding, and mock UI only; live provider execution was not refactored.

### Changes Made
- Added pure TypeScript provider metadata types and a default provider catalog for OpenAI, OpenAI-compatible, Ollama, cloud placeholder, Kilo placeholder, and Anthropic.
- Added typed inspection and artifact models plus a read-only context snapshot builder.
- Added mock artifacts linked to source nodes.
- Added a **context** tab to the selected-node config panel with Prompt, Final Context, Inputs, Tools, Files, Output Stream, Artifacts, and Debug Info sections.
- Added a provider registry preview to Settings with capability badges and credential references.
- Updated architecture, security, roadmap, status, TODO, and agent handoff documentation.

### Verification
- Targeted red test run first failed because the new provider/context/artifact modules did not exist.
- Targeted green run: `npx vitest run tests\unit\services\providerCatalog.test.ts tests\unit\services\contextSnapshot.test.ts` passed, 6/6 tests.
- `npx tsc --noEmit` passed after adding the mock UI.
- Full test run: `npx vitest run` passed, 73/73 tests.
- Production build: `npm run build` passed. Vite reported only the existing large chunk warning.
- Environment note: non-elevated Vitest/build attempts still fail in this sandbox with Vite/esbuild `spawn EPERM`; rerunning the same commands with approved execution succeeds.
- Source scan: no real OpenAI, Anthropic, or Kilo secrets were found. The scan found one dummy test fixture key and existing legacy `apiKey` field names in runtime state/config code, which remain documented as a future secure-storage risk.
- Visible runtime check: `npm run tauri -- dev` launched the real **Agent Workflow Builder** Tauri desktop app from `src-tauri\target\debug\agent-workflow-builder.exe`.
- Runtime log: `.harness\run-logs\tauri-dev-multiprovider-context-20260517-025240.log`.
- Screenshot verification: completed for the visible desktop app shell and active workflow canvas. The app was nonblank, showed the Harness Studio dark shell, and loaded **Harness Studio - Active Project** with 12 nodes and 18 edges via `Ctrl+Shift+E`.
- Visual limitation: nested provider registry and context/artifact panels were not screenshot-confirmed in this run because desktop click interactions repeatedly selected page text or foregrounded the launcher terminal. The UI code and behavior were covered by TypeScript, Vitest, and build verification, but those nested panels still need a clean human/UI automation screenshot pass.

### Remaining Work
- Persist real execution context snapshots during workflow runs.
- Capture streaming provider events instead of showing mock stream placeholders.
- Persist artifacts under a run-scoped `.harness/` path.
- Replace development localStorage API key storage with secure credential references backed by Tauri Stronghold or platform keychain.
- Implement provider adapters only after the catalog/context/artifact boundaries are stable.
- Capture clean screenshots of Settings provider registry and the selected-node **context** tab once desktop interaction is stable.

---

## 2026-05-16 - Provider Billing Errors and Ollama Fallback

### Root Cause
- OpenAI error is a quota/billing failure: `429` with quota/billing language or `insufficient_quota`.
- Anthropic error is a billing failure: low credit balance / Plans & Billing.
- The app already had provider commands, but error messages were inconsistent and provider selection still preferred hosted models unless the user explicitly forced Ollama.

### Changes Made
- Added shared provider config helpers for key masking, `LLM_PROVIDER`, Ollama defaults, provider selection, and fallback decisions.
- Added exact user-facing messages for OpenAI quota, OpenAI rate limit, Anthropic insufficient credits, and Ollama unavailable.
- Updated Rust API commands to read provider keys from Settings or process env, normalize billing/rate-limit errors, avoid retrying billing failures, and retry only temporary rate limits.
- Added Ollama model health checking with `ollama pull qwen2.5-coder:7b` guidance.
- Updated Settings tests to use provider health checks instead of test completions.
- Updated `.env.example`, `docs/SETUP.md`, and `docs/GUIDE.md` with Ollama fallback and provider troubleshooting.

### Verification
- `npx tsc --noEmit`: passed.
- Provider utility behavioral assertions: passed via `tsc` emit to `.harness/verification/provider-ts` and Node assertions for key masking, `LLM_PROVIDER=ollama`, provider selection, and billing-vs-rate-limit fallback behavior.
- `rustfmt --edition 2021 --check src\commands\api_commands.rs`: passed.
- `ollama pull qwen2.5-coder:7b`: completed successfully.
- Local Ollama check: `ollama list` shows `qwen2.5-coder:7b`; `Invoke-WebRequest http://localhost:11434/api/tags -UseBasicParsing` returned `200` with that model installed; `POST http://localhost:11434/v1/chat/completions` returned `200` with `choices`.
- `npx vitest run`: passed, 67/67 tests.
- `cargo test`: passed, 11/11 tests.
- `npm run build`: passed after elevated execution.
- Visible runtime check: `npm run tauri -- dev` launched **Agent Workflow Builder** from `src-tauri\target\debug`; screenshot verification showed a nonblank Harness Studio UI.
- Active harness check: loaded **Harness Studio - Active Project** via `Ctrl+E` and **Load**; screenshot verification showed 12 nodes and 18 edges.
- Focused Vitest and Cargo tests were added first and reached the expected red state.
- Non-elevated Vitest/build/Cargo remain blocked in this environment by sandbox `spawn EPERM` or Windows target-write access denied, so those checks require elevated execution here.

### Remaining Risk
- Real hosted OpenAI and Anthropic billing failures were handled by classifier/unit tests, not by live paid API calls. Live hosted-provider validation still requires accounts with controlled quota/credit states.
- Full workflow execution on the active harness should be run next with `LLM_PROVIDER=ollama` when human review is ready; the local Ollama server and model are verified.

---

## 2026-05-16 - Phase 4 Hook & Permission Management Slice

### Commands Run
- `npx tsc --noEmit`
- `npx vitest run tests/unit/utils/permissionMatrix.test.ts tests/unit/schemas/workflowSchema.test.ts`
- `npx vitest run`
- `cargo test`
- `npm run build`
- `rustfmt --check src\commands\process_commands.rs`
- `npm run tauri -- dev`

### Result
- Implemented the first Phase 4 slice in the Tauri app.
- Added a top-bar and command-palette Permission Matrix modal.
- Added node-by-tool grant toggles, risk coloring, high-risk summary, and one-click default guard insertion.
- Extended Hooks tab to run pre/post hooks with consent, env vars, output display, and `.harness/audit.log.jsonl` audit writes.
- Updated Rust hook execution to pass custom environment variables and enforce a real timeout by spawning and killing long-running child processes.

### Runtime Verification
- Stopped only confirmed project-owned stale processes before verification: `agent-workflow-builder.exe` from `src-tauri\target\debug`, project `esbuild.exe`, and the Vite port owner for `localhost:1420`.
- Visible desktop launch succeeded with `npm run tauri -- dev`.
- Runtime log: `.harness\run-logs\tauri-dev-phase4-visible-20260516-185641.log`.
- Loaded **Harness Studio — Active Project** via `Ctrl+E` and **Load**.
- Screenshot verification showed the active harness canvas with 12 nodes and 18 edges.
- Permission Matrix screenshot showed 12 nodes, 42 grants, 5 high-risk nodes, and 1 ungated node.
- Clicking **Add guard** for Test Worker changed the Permission Matrix summary to 0 ungated nodes.

### Test Results
- Focused Vitest: 11/11 passing.
- Full Vitest: 63/63 passing.
- Rust tests: 7/7 passing.
- `npm run build`: passed.
- `rustfmt --check src\commands\process_commands.rs`: passed.

### Errors Encountered
- Sandboxed Vitest failed with `spawn EPERM` when Vite tried to spawn esbuild; rerun with escalation passed.
- Sandboxed Cargo initially hit Windows access-denied errors in `target\debug\incremental`; rerun with escalation passed.
- Full `cargo fmt --check` still reports formatting diffs in unrelated existing Rust files, so only the changed `process_commands.rs` file was checked and kept formatted.

### Remaining Risks
- Hook file creator template chooser is still pending.
- Dedicated hook execution log viewer is still pending.
- Tool capability inheritance rules are still pending.

---

## 2026-05-16 - Visible Tauri Desktop Launch Verification

### Commands Run
- `npm run build`
- `npm run tauri -- dev`

### Result
- The real Tauri desktop application opened visibly as **Agent Workflow Builder**.
- Screenshot verification completed. The captured desktop showed the nonblank Harness Studio UI: `harness-studio` top bar, left file/workspace sidebar, central workflow canvas, right config panel, and bottom audit/status strip.

### Evidence
- Vite served `http://localhost:1420`.
- Cargo launched `target\debug\agent-workflow-builder.exe`.
- Runtime log: `.harness\run-logs\tauri-dev-visible-20260516-183711.log` (final active launch).

### Errors Encountered
- Sandboxed `npm run build` failed with `Error: spawn EPERM` when Vite tried to spawn esbuild.
- Sandboxed `npm run tauri -- dev` failed with the same `spawn EPERM`.
- A hidden launcher attempt started the app process without a visible window; it was stopped and relaunched with a visible PowerShell runner.

### Fixes Applied
- No source-code fix was required.
- The successful launch used an approved escalated PowerShell runner so Vite/esbuild, Cargo, and the Tauri desktop process could spawn normally and visibly.

### Remaining Risks
- Windows process enumeration reported `MainWindowHandle: 0` even while the screenshot showed the app window. Screenshot evidence is the reliable visual verification for this run.
- The app is ready for human visual review, but deeper interaction testing was not part of this launch-only task.

### Next Recommended Action
- In the running app, press `Ctrl+E`, choose **Harness Studio — Active Project**, then click **Load**. Use that harness for Phase 4 (Hook & Permission Management) work.

---

## 2026-05-16 — Phase 1 HTML Prototype

### Files Created
- `prototype/index.html` — self-contained Atelier-direction prototype (~700 lines)
- `AGENT.md` (project root) — Codex delegation document

### Files Modified
- `docs/PROJECT_STATUS.md` — updated to Phase 1, added review checklist
- `docs/TODO.md` — restructured for phase-based task management
- `docs/ROADMAP.md` — updated with Phase 0 completed, Phase 1 in review, Phase 2–8 defined
- `docs/DEVELOPMENT_LOG.md` — this entry

### Key Decisions
- **Prototype uses Atelier direction** (amber accent `#e5a142`, refined dark, Linear/Zed lineage). Observatory direction exists in `.design/` but is Phase 5+ scope.
- **Self-contained single HTML file** rather than multi-file JSX (mirrors `.design/index.html` approach but bundled inline). No CDN dependencies except React 18 + Babel standalone (integrity hashes included).
- **Three workflow patterns** (fanout, pipeline, critic loop) are switchable from the top bar dropdown — same patterns as `.design/workflows.jsx`.
- **Phase progress and review checklist** surfaced as modal dialogs accessible from the header — keeps them visible without cluttering the main UI.
- **Design tokens copied exactly** from `.design/Components/atelier.jsx` to ensure prototype matches the design document precisely.

### Design Alignment Notes
The prototype uses `.design/` as the authoritative source. Key values confirmed:
- All role tints match `ROLE_META` in `workflows.jsx`
- Edge colors: data `rgba(255,255,255,0.28)`, memory `#b88bd9` dashed, control `#9097a3` dashed, feedback `#e07575`
- Node structure: header (role chip + label + status dot) / prompt preview / footer (model + tools) / token bar / hook chips
- Inspector tabs: role → prompt → tools → hooks → memory (in that order)
- Audit kinds: `run`, `tokens`, `edge`, `tool`, `fanout`, `consent`, `done`, `warn`, `error`

### Remaining Risks
- Observable alignment issue: Tauri scaffold uses `.agent-audit/` and `CLAUDE.md`/`AGENTS.md` conventions; design uses `.harness/` and `prompts/` conventions. This needs to be resolved before Phase 2.
- Observatory mode not in prototype yet — if human review requests it, add from `.design/Components/observatory.jsx`.
- `prototype/index.html` loads React and Babel from unpkg CDN — requires internet to open. For offline use, these would need to be bundled locally.

### Next Recommended Action
1. Human: Open `prototype/index.html` in a browser
2. Human: Click **✅ Review** and verify 16 checklist items
3. Human: Sign off on Phase 1
4. Then: Start Phase 2 (align Tauri scaffold with design system, get `npm run tauri -- dev` running)

---

## 2026-05-16 — Phase 3: Agent Configuration System

### Files Created
- `src/utils/generators/claudeMd.ts` — CLAUDE.md generator
- `src/utils/generators/agentsMd.ts` — AGENTS.md generator
- `src/utils/generators/langGraph.ts` — LangGraph Python exporter
- `src/utils/generators/crewAi.ts` — CrewAI Python exporter
- `src/utils/generators/hookTemplates.ts` — 5 hook script templates
- `src/utils/generators/index.ts` — barrel export
- `src/hooks/useGenerator.ts` — generator hook (writes via IPC + audit)
- `src/components/generate/GeneratePanel.tsx` — modal with preview + write
- `src/components/palette/CommandPalette.tsx` — ⌘K palette with keyboard nav
- `tests/unit/generators/generators.test.ts` — 13 generator tests

### Files Modified
- `src/App.tsx` — added modal state, ⌘K / Ctrl+G keyboard handlers
- `src/components/layout/TopBar.tsx` — ⌘K + Generate buttons
- `src/components/layout/Sidebar.tsx` — `.harness.yaml` click → load workflow

### Test Results
- 31 Vitest tests: all pass (was 18; +13 generator tests)
- 5 Rust tests: all pass
- `npx tsc --noEmit`: 0 errors

### Key Decisions
- **LangGraph over generic export**: LangGraph is the most production-ready graph-based agent framework; CrewAI covers the role-based pattern. Together they cover 80% of use cases.
- **Preview before write**: GeneratePanel shows content before writing to disk — user can inspect and copy without committing
- **Heuristic process type in CrewAI**: Fan-out/aggregator topology → `Process.hierarchical`; sequential → `Process.sequential`. Can be manually edited.
- **Hook templates are real scripts**: Content is executable, not pseudocode — important for actual usability
- **Workflow import on file-tree click**: `.harness.yaml` files highlighted in amber "load" badge — single click replaces canvas

---

## 2026-05-16 — Phase 2: Visual Workflow Editor

### Files Modified
- `src/App.css` — Atelier CSS design tokens as CSS custom properties
- `src/types/agent.ts` — Added Hook, Aggregator roles; TOOL_RISK map; TokenBudget; new fields
- `src/types/workflow.ts` — edgeKind union; ValidationResult types
- `src/utils/nodeColors.ts` — Full rewrite: RoleMeta with glyphs, tints, icons; MINIMAP_COLORS; STATUS_COLORS
- `src/utils/autoLayout.ts` — New: Dagre LR auto-layout with feedback edge handling
- `src/utils/validateWorkflow.ts` — New: cycle detection, disconnected check, prompt/model/security checks
- `src/store/workflowStore.ts` — Updated makeDefaultAgentNode for 8 roles; proper token budgets; edgeKind type
- `src/schemas/agentSchema.ts` — Updated for new AgentNodeData fields
- `src/schemas/workflowSchema.ts` — Updated with edgeKind union
- `src/components/nodes/NodeIcon.tsx` — New: inline SVG icon set matching design system
- `src/components/nodes/BaseAgentNode.tsx` — Full rewrite: Atelier styling, left/right ports, prompt preview, token bar, hook chips
- `src/components/nodes/HookNode.tsx` — New node type
- `src/components/nodes/AggregatorNode.tsx` — New node type
- `src/components/canvas/WorkflowCanvas.tsx` — 8 nodeTypes, 4 edgeTypes, dark background, Atelier minimap
- `src/components/canvas/CanvasToolbar.tsx` — 8 role buttons with hover tints, auto-layout, validate
- `src/components/canvas/edges/DataFlowEdge.tsx` — 4 edge type styles + arrow markers for all types
- `src/components/layout/TopBar.tsx` — New: breadcrumb, phase badge, stats, save/run
- `src/components/layout/Sidebar.tsx` — Full rewrite: file tree, node list with glyphs + status dots
- `src/components/layout/StatusBar.tsx` — Dark theme, phase badge
- `src/components/layout/AuditStrip.tsx` — New: collapsible audit log with filtering
- `src/components/config-panel/ConfigPanel.tsx` — Dark Atelier styling
- `src/components/config-panel/shared.tsx` — New: shared Input/Select/Sec/Fld/SmallBtn
- `src/components/config-panel/tabs/RoleTab.tsx` — Model info grid, budget slider, limits
- `src/components/config-panel/tabs/PromptTab.tsx` — inline/file toggle, char count
- `src/components/config-panel/tabs/ToolsTab.tsx` — Risk-labeled tool list
- `src/components/config-panel/tabs/HooksTab.tsx` — pre/post rows, consent toggle
- `src/components/config-panel/tabs/MemoryTab.tsx` — Context breakdown, memory keys, strategy
- `src-tauri/src/commands/audit_commands.rs` — `.harness/` path (renamed from `.agent-audit/`)
- `.gitignore` — Added `.harness/audit.log.jsonl` and `.harness/trajectories/`

### Test Results
- 18 Vitest tests: all pass (was 17; +1 for token budget roundtrip)
- 5 Rust cargo tests: all pass
- `npx tsc --noEmit`: 0 errors

### Key Decisions
- Left/right ports (horizontal flow) instead of top/bottom — aligns with LR Dagre layout
- Inline SVG `NodeIcon` component — avoids lucide-react per-render dependency, exact match to design system
- CSS custom properties for tokens — allows dark theme without fighting Tailwind's color system
- `.harness/` audit path — aligns with design system filesystem convention
- `TOOL_RISK` map in agent.ts — single source of truth for risk classification

### Remaining Risks
- Live smoke test not run yet — `npm run tauri -- dev` needs to be executed
- Monaco editor Ctrl+S shortcut uses raw key codes — may vary by platform
- Auto-layout in CanvasToolbar uses `useReactFlow()` which requires the component be inside `<ReactFlowProvider>` — already satisfied by App.tsx wrapping

---

## 2026-05-09 — Tauri Scaffold (Phase 2 prerequisites)

### Files Created
- Full Tauri + React TypeScript scaffold at `D:\toy_project\AI_agent`
- `src/types/` — AgentRole, ToolPermission, AgentNodeData, WorkflowDef, FileTreeEntry, AuditEntry
- `src/schemas/` — Zod schemas for agent config and workflow
- `src/store/` — Zustand stores: workflow (with undo/redo), workspace, ui, audit
- `src/ipc/` — typed Tauri command wrappers + Vitest mocks
- `src/components/` — canvas nodes, config panel (5 tabs), file tree, Monaco editor, layout
- `src/utils/` — YAML serializer, node colors, ID generator, logger
- `src-tauri/src/commands/` — fs, workflow, audit, process (hook execution) Rust commands
- `src-tauri/capabilities/default.json` — scoped Tauri permissions
- All 12 documentation files in `docs/`
- `.gitignore`, `.env.example`

### Test Results
- 17 Vitest tests: all pass
- 5 Rust cargo tests: all pass
- `npx tsc --noEmit`: 0 errors

### Key Decisions Made Then
- Tauri 2.0 over Electron (bundle size, security model)
- React Flow v12 (`@xyflow/react`)
- Zustand 5 + zundo for undo/redo
- YAML for workflow files (human-readable, diffable)
- `std::fs` in Rust commands (not `tauri_plugin_fs`) for centralized path validation
