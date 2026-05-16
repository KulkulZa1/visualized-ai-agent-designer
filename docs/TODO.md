# TODO

---

## UX Issue Tracker

### Immediate Fixes Completed (this PR)

- [x] **3a AuditStrip**: max-height increased 180→320; order toggle (newest/oldest first) added; `workflow_loaded` action color added
- [x] **3b RunPanel output**: max-height increased 80→200; slice(-3)→slice(-10) for last 10 lines; Copy button added
- [x] **3c AgentOutputPanel**: max-height increased 160→280; Copy button added for output text
- [x] **3d ContextInspectorTab TextBlock**: max-height increased 170→240 for pre blocks
- [x] **3e SettingsPanel**: collapsible Provider Registry section added at the bottom

### Near-Term Deferred

- [ ] Resizable panels (drag handle between config panel and canvas)
- [ ] Expanded artifact viewer (full-screen / dockable artifact preview)
- [ ] Log level filter for AuditStrip (debug / info / warn / error severity)
- [ ] Copy-to-search: clicking a path/node-id in audit log pre-fills a search filter
- [ ] Session restore: auto-load last harness on startup (requires careful error handling to avoid startup regressions)
- [ ] Snapshot deletion UI (remove individual persisted snapshots from the history panel)
- [ ] Artifact list panel in sidebar (browse all .harness/artifacts/ files)
- [ ] Full-text search across snapshots
- [ ] Snapshot export to ZIP

### Long-Term

- [ ] Dockable panels (float any panel as a separate window via Tauri)
- [ ] Workflow replay: scrub audit log timeline and restore canvas state at a point in time
- [ ] Split view: show two nodes side-by-side in the config panel

---

## Immediate Tasks

- [x] In the running app, press `Ctrl+E`, choose **Harness Studio — Active Project**, then click **Load**
- [ ] Open `prototype/index.html` in a browser — verify it loads without errors
- [ ] Click **✅ Review** button — verify all 16 checklist items show ✅ pass
- [ ] Click **📊 Phases** button — verify phase roadmap is readable
- [ ] Switch workflow patterns (fan-out / pipeline / critic) — verify canvas updates
- [ ] Drag a node — verify position updates correctly
- [ ] Select a node — verify config panel shows correct node data
- [ ] Switch tabs (Role / Prompt / Tools / Hooks / Memory) — verify each tab renders
- [ ] Human review sign-off → confirm Phase 1 complete

---

## Phase 1 Review Tasks

- [ ] Layout understandable without explanation?
- [ ] Agent connections visually clear (edge types distinguishable)?
- [ ] Hook consent concept understood at a glance?
- [ ] Token budget concept understood?
- [ ] File tree maps to real filesystem structure?
- [ ] Audit log readable and informative?
- [ ] Observatory mode needed in prototype before Phase 2?
- [ ] Any naming changes needed (e.g. "Harness Studio" vs "Agent Workflow Builder")?

---

## Phase 2 Preparation Tasks

These unlock after Phase 1 human review is confirmed:

- [ ] Align Tauri scaffold naming with design system:
  - Rename `.agent-audit/` → `.harness/` (or keep separate — decide)
  - Update `CLAUDE.md`/`AGENTS.md` references to `.harness/` convention
  - Update color tokens in `src/` to match Atelier design tokens
- [ ] Add `hook` and `aggregator` node types to `AgentRole` enum
- [x] Run `npm run tauri -- dev` and verify the real desktop app opens visibly
- [x] Record first-launch issue: sandboxed launch hit `spawn EPERM`; escalated visible launch succeeded
- [ ] Replace scaffold canvas node styles with Atelier design tokens
- [ ] Wire canvas toolbar to actual node creation (currently has placeholder buttons)
- [ ] Add auto-layout (Dagre) button to canvas

---

## Codex Delegation Candidates

These can be delegated to Codex independently (see `AGENT.md` for full context):

- [ ] Add Observatory mode to `prototype/index.html`
- [ ] Add Command Palette (⌘K) to `prototype/index.html`
- [ ] Add Run Preflight modal to `prototype/index.html`
- [ ] Write Vitest tests for `yamlSerializer.ts`
- [ ] Write Vitest tests for `workspaceStore.ts`
- [ ] Update `docs/AGENT_WORKFLOW_SPEC.md` with node type reference + edge type table

---

## Blocked Tasks

- **Phase 2 implementation** — blocked on Phase 1 human review sign-off
- **Git initialization** — blocked until first review of folder structure

---

## Long-Term Tasks

### Phase 3 — Agent Configuration System
- [ ] CLAUDE.md / AGENTS.md generator from workflow nodes
- [ ] Hook file creator with templates
- [ ] Prompt version history (git log of prompt files)
- [ ] Export workflow to LangGraph Python
- [ ] Export workflow to CrewAI Python

### Phase 4 — Hook & Permission Management
- [x] Visual permission matrix (node × tool grid)
- [x] Permission risk summary and one-click guard insertion
- [x] Hook execution controls with consent, env vars, output, and audit writes
- [x] Rust hook timeout enforcement
- [ ] Dedicated hook execution log viewer in UI
- [ ] Pre-built hook template library
- [ ] Tool capability inheritance rules

### Phase 5 — Execution Tracing
- [x] Normalize OpenAI quota/billing errors into a user-friendly message
- [x] Normalize Anthropic insufficient-credit errors into a user-friendly message
- [x] Add Ollama fallback provider config (`LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`)
- [x] Add selected-provider health checks and Ollama missing-model guidance
- [x] Verify local Ollama fallback model `qwen2.5-coder:7b` is installed and reachable
- [x] Relaunch visible Tauri app after provider changes and load **Harness Studio - Active Project**
- [x] Add provider catalog scaffolding for OpenAI, OpenAI-compatible, Ollama, cloud placeholder, Kilo placeholder, and Anthropic
- [x] Add mock node context inspector tab with separated prompt/context/input/tool/file/output/artifact/debug sections
- [x] Add mock artifact data model and artifact viewer preview
- [x] Document VS Code extension readiness boundaries
- [ ] Per-node trace panel (duration, tokens, tool calls)
- [ ] Trajectory replay (scrub by time, see active nodes)
- [ ] Token usage + cost summary across workflow

### Phase 6 — Git Integration
- [ ] Git init for new workspaces
- [ ] Workflow diff viewer (before/after YAML)
- [ ] Commit workflow changes with auto-generated messages

### Phase 7 — Security Hardening
- [ ] OS keychain for API keys (Tauri `plugin-stronghold`)
- [ ] Replace development localStorage API key storage with secure credential references
- [ ] Prompt injection scanner
- [ ] Dependency audit UI (`npm audit` + `cargo audit`)

### Phase 8 — Commercialization
- [ ] Auto-update (Tauri updater)
- [ ] Windows/Mac/Linux installers
- [ ] Plugin architecture for custom node types
- [ ] Template library (30+ workflow patterns)
- [ ] Telemetry with explicit opt-in only
