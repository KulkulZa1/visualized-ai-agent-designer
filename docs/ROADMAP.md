# Roadmap - Harness Studio

Updated: 2026-06-11

Current truth:

- Phase 5 execution uses dependency-aware bounded parallel scheduling via `runParallel()`.
- `executionSettings.maxParallel` is active for forward-edge branches; feedback edges are excluded from dependency scheduling.
- CLI v0 and MCP v0 are implemented and verified.
- Workflow Wizard and Guide Assistant are implemented as rule-based, non-live helpers.
- Ollama Cloud is implemented for `https://ollama.com/api` and `gemma4:31b-cloud`.
- Tauri packaging succeeds on Windows, but clean-machine installer smoke testing is still required.

Near-term roadmap:

1. Real provider streaming.
2. Durable run traces and artifact persistence.
3. OS keychain storage.
4. E2E UI automation and installer smoke tests.
5. Stronger cancellation/failure recovery coverage for parallel runs.

---

## Phase 0: Research & Planning ✅ Complete

- Research existing agent tools (LangGraph, CrewAI, Flowise, Dify, n8n, Langflow, AutoGen)
- Identify user pain points and opportunity map
- Evaluate Tauri vs Electron vs VS Code extension
- Define architecture (Tauri 2.0 + React + React Flow)
- Design system defined: Atelier (builder) + Observatory (monitor) dual-mode UI
- Role vocabulary: Orchestrator, Gateway, Worker, Critic, Memory, Hook, Aggregator, Tool
- Edge types: data, memory, control, feedback
- Inspector tabs: Role, Prompt, Tools, Hooks, Memory

---

## Phase 1: HTML Concept Prototype 🟡 In Review

**Goal:** Make the product concept visible and reviewable before committing to full implementation.

- [x] `prototype/index.html` — Atelier design, self-contained, no build step
- [x] Three switchable workflow patterns
- [x] Draggable agent nodes with role glyphs and edge types
- [x] Five-tab config inspector
- [x] Audit/trace strip with real log data
- [x] Phase progress modal + review checklist modal
- [x] `AGENT.md` for Codex delegation
- [ ] Human review sign-off

**Exit criteria:** Human confirms all 16 checklist items pass.

---

## Phase 2: Visual Workflow Editor ✅ Complete

**Goal:** Working Tauri desktop app with interactive canvas.

- Align Tauri scaffold with Atelier design tokens
- Add `hook` and `aggregator` node types
- `npm run tauri -- dev` opens without errors
- Drag-drop nodes, draw edges, minimap working
- Canvas toolbar adds new nodes
- Auto-layout (Dagre algorithm)
- Workflow validation (cycles, disconnected nodes, missing prompts)
- Node status badges (configured / needs attention / error)
- Undo/redo (already wired via `zundo`)
- YAML save/load to `.harness/*.harness.yaml`

---

## Phase 3: Agent Configuration System ✅ Complete

**Goal:** Full config management — prompts, files, export.

- CLAUDE.md / AGENTS.md generator from workflow
- Hook file creator with template library
- Prompt version history via git log
- Token estimator per node
- Export workflow to LangGraph Python
- Export workflow to CrewAI Python
- Import from existing `.harness.yaml`

---

## Phase 4: Hook & Permission Management ✅ Complete

**Goal:** Security-aware tool control with visual audit.

- Visual permission matrix (node × tool grid)
- Hook execution log viewer in UI
- Tool capability inheritance (Orchestrator → Workers)
- Pre-built hook templates

---

## Phase 5: Execution Tracing & Debugging ✅ Complete

**Goal:** Observatory mode — live monitoring and trajectory replay.

- [x] Provider abstraction layer: official OpenAI, OpenAI-compatible, Ollama, cloud placeholders, Kilo/Kilo Gateway placeholder
- [x] Provider capability flags: streaming, tool calling, model listing, context window, cost estimate, local/cloud routing
- [x] Per-workflow default provider and per-node model/provider override
- [x] Node context inspector: prompt layers, final context, inputs, tools, files, stream, artifacts, debug info
- [x] Artifact viewer: typed generated outputs linked to source node and workflow run
- [x] File-backed snapshot persistence (`.harness/snapshots/`) with in-memory fallback
- [x] File-backed artifact persistence (`.harness/artifacts/`) with module-level path tracking
- [x] Snapshot history panel per node (up to 5, expandable inline, soft-delete, reload button)
- [x] ArtifactSidebar panel in Sidebar (collapsible, path list, inline preview)
- [x] Session restore: auto-load last harness on startup from localStorage
- [x] AuditStrip severity border (error=red, warn=amber, hook=orange) + improved filter logic
- [x] Bundle code splitting via Vite `manualChunks` (vendor-react, vendor-flow, vendor-zustand, vendor-editor, vendor-yaml)
- [ ] Per-node trace panel: duration, tokens, tool calls (deferred)
- [ ] Live sparklines on running nodes (deferred)
- [ ] Swimlane timeline + scrubber (deferred)
- [ ] Replay any past trajectory from `.harness/trajectories/*.jsonl` (deferred)
- [ ] Token usage + cost summary (deferred)

---

## Phase 6: Execution Tracing — Deep Instrumentation

**Goal:** Full live execution tracing with trajectory replay and streaming provider events.

- Capture streaming provider events instead of mock stream placeholders
- Persist scheduler events for queued/running/skipped/blocked nodes
- Per-node trace panel: duration, tokens, tool calls
- Live sparklines on running nodes
- Swimlane timeline + scrubber
- Replay any past trajectory from `.harness/trajectories/*.jsonl`
- Token usage + cost summary per run
- Persist real execution context snapshots during workflow runs (not just mock/on-open)
- Add regression fixtures for gateway routing, skipped branches, cancellation, and failed parallel branches

---

## Phase 7: Git & Version Control Workflow

**Goal:** Workflow versioning as first-class citizen.

- Git init for new workspaces
- Workflow diff viewer (visual before/after YAML)
- Commit workflow changes with auto-generated messages
- Compare two workflow versions side-by-side

---

## Phase 7: Security Hardening

**Goal:** Commercial-ready security posture.

- OS keychain for API keys (Tauri `plugin-stronghold`)
- Replace development localStorage API key storage with credential references backed by secure storage
- Prompt injection scanner (static analysis of system prompts)
- Dependency audit UI (`npm audit` + `cargo audit`)
- Audit log viewer with filtering
- Pre-commit hook to detect secret patterns

---

## Future: VS Code Extension Readiness

**Goal:** Reuse Harness Studio workflow, provider, context, and artifact logic from a VS Code webview without coupling core behavior to Tauri.

- Keep provider adapters outside UI components
- Keep workflow state independent from the Tauri shell
- Wrap file system, command execution, provider credentials, and artifact persistence behind service interfaces
- Future commands: Create Agent, Open Workflow, Run Node, Inspect Context, Open Artifact, Edit Agent Instruction, Sync AGENT.md

---

## Phase 8: Commercialization-Ready Packaging

**Goal:** Shippable product for commercial distribution.

- Auto-update (Tauri updater plugin)
- Windows/Mac/Linux installers
- Onboarding wizard
- Template library (30+ workflow patterns)
- Plugin architecture for custom node types
- Eval harness (regression dashboard — from `.design/Components/expansions.jsx`)
- Prediction ledger (hypothesis → outcome tracking)
- Telemetry with explicit opt-in only
