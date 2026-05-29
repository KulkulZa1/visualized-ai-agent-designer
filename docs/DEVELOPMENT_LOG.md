# Development Log

## 2026-05-18 - Execution Verification, MCP Hardening, Templates, Packaging

- Ran real verification: `npx tsc --noEmit`, `npx vitest run` (229 tests / 26 files), `cargo test` (25 tests), `npm run build`, `npm run tauri -- dev`, and `npm run tauri -- build`.
- Confirmed Tauri dev launch reached `target\\debug\\agent-workflow-builder.exe` and spawned WebView2.
- Confirmed packaging produced MSI and NSIS installers under `src-tauri/target/release/bundle/`.
- Hardened MCP `validate_workflow` with project-root path safety and traversal rejection.
- Hardened MCP `run_tests.filter` with safe-pattern validation before subprocess spawn.
- Added MCP subprocess tests for initialize, tools/list, valid validation, path rejection, unsafe filter rejection, and unknown tool errors.
- Added Rust hook consent guard and fixed workflow hook-node error handling so failed hooks are not marked done.
- Removed unused broad Tauri shell execute/kill permissions from default capabilities.
- Added package scripts: `check:ts`, `test`, `test:rust`, and `check`.
- Added logistics routing, finance expense analysis, and MATLAB parameter sweep templates to the rule-based workflow recommender.
- Rewrote stale docs to distinguish implemented, verified, mocked, planned, blocked, and risky features.


---

## 2026-05-17 - Ollama Cloud / Remote Ollama Runtime Support

### Result
- Promoted the prior `ollama-remote` placeholder into an enabled `ollama-cloud` provider entry using `https://ollama.com/api` and credential reference `env:OLLAMA_API_KEY`.
- Extended provider selection with `LLM_PROVIDER=ollama-cloud`, `DEFAULT_OLLAMA_CLOUD_BASE_URL`, and cloud URL detection.
- Set the cloud default model to `gemma4:31b-cloud` and normalize `gemma4-31b:cloud` to the Ollama model ID.
- Routed `ollama` and `ollama-cloud` through the same provider adapter without UI/provider API coupling.
- Updated the Rust `call_ollama_api` command to use native Ollama `/api/chat` with optional Bearer auth for Ollama Cloud or authenticated remote gateways.
- Normalized Ollama endpoint construction so both `https://ollama.com` and `https://ollama.com/api` resolve to the same `/api/chat` and `/api/tags` calls.
- Updated Ollama health/model listing to support `ollama-cloud`, `OLLAMA_API_KEY`, and `OLLAMA_REMOTE_API_KEY` without logging key values.
- Scoped Ollama env credential lookup by endpoint so cloud keys are not sent to arbitrary remote gateways, remote keys are not sent to local Ollama, and Settings-saved tokens are passed into workflow health checks.
- Added Rust mock-server coverage proving authenticated remote Ollama calls use `/api/chat`, health/model listing use `/api/tags`, Bearer auth is sent only when a token is provided, `gemma4-31b:cloud` is normalized, native responses are parsed, and submitted tokens are redacted from error bodies.
- Updated Settings/Run UI labels so local Ollama and Ollama Cloud are distinct and cloud data is not implied to be local-only.

### Security Boundary
- No raw Ollama keys were added to source, docs, CLI output, or tests.
- Ollama Cloud keys are read only from Settings/local runtime state or environment variables and are sent only as Authorization headers to the configured endpoint.
- Remote Ollama is documented as cloud/hosted data, not local-only execution.

### Verification
- Focused provider tests passed: `npx vitest run tests\unit\utils\providerConfig.test.ts tests\unit\services\providerAdapter.test.ts tests\unit\services\providerCatalog.test.ts` -> 34/34.
- `npx tsc --noEmit` passed.
- Full frontend suite passed: `npx vitest run` -> 198/198.
- `npm run build` passed after approved esbuild spawn rerun; Vite still reports the pre-existing large chunk warning.
- Focused Rust Ollama tests passed: `cargo test ollama` -> 14/14.
- Full Rust suite passed with an isolated Cargo target dir: `cargo test` -> 24/24.
- `npm run harness -- provider list --json` prints only credential references for Ollama Cloud.

---

## 2026-05-17 - UX P1 Audit Filters + CLI v0 Hardening

### Result
- Added `src/utils/auditFilters.ts` as a pure helper for agent chip derivation, independent kind/agent filtering, stable ordering, and beginner-friendly empty states.
- Updated `AuditStrip` to always expose an **All** agent chip, show dynamic per-agent chips from `AuditEntry.agentId`, keep errors visible under kind filters, and preserve newest-first ordering from `auditStore`.
- Hardened `cli/harness.mjs` output for read-only CLI v0: project status now reports app/docs/AGENT.md/example workflow metadata, and provider list includes type, local/cloud/gateway classification, capability flags, and credential refs only.
- Added subprocess CLI tests plus audit helper/component tests.

### Security Boundary
- CLI v0 remains read-only. It does not mutate files, run workflows, call providers, read or print secrets, add MCP write tools, execute commands, or run MATLAB.

### Verification
- Focused TDD red run failed for the expected reasons: missing audit helper, missing CLI metadata, and an AuditStrip `scrollTo` test-environment gap.
- Focused green run passed: `npx vitest run tests\unit\utils\auditFilters.test.ts tests\unit\components\AuditStrip.test.tsx tests\unit\cli\harnessCli.test.ts` -> 10/10 tests.
- `npx tsc --noEmit` passed.
- Full suite passed: `npx vitest run` -> 190/190 tests. The sandboxed run hit `spawn EPERM`; the approved rerun succeeded.
- Build passed: `npm run build`. The build still reports Vite warnings for an empty `vendor-react` chunk and a large `index` chunk.
- CLI smoke checks passed: `project status`, `provider list`, and `workflow validate examples\purchasing-decision.harness.yaml` exit 0; missing workflow validation exits nonzero with a clear JSON error.
- Secret scan found no real provider secrets in source/docs/CLI output; only an existing dummy test fixture matches a key-like pattern.
- Visible Tauri verification completed against an already running project window: the **Agent Workflow Builder** desktop app was foregrounded, the built-in **Harness Studio -- Active Project** example loaded, and the UI was nonblank with the canvas, node list, right inspector, minimap, and AuditStrip visible.
- Manual Run was not used for visual audit-chip verification because it can enter provider health checks and hook/provider execution paths. Audit chip behavior is covered by helper and React component tests.

---

## 2026-05-17 ??ProviderAdapter extraction + purchasing demo registered

### Result

**ProviderAdapter service (`src/services/model-providers/providerAdapter.ts`) ??new:**
- Extracts API call logic from `useWorkflowExecution` into a framework-agnostic module.
- Exports: `callProvider()`, `buildSystemMessage()`, `resolveModel()`, `estimateTokens()`,
  `MODEL_ALIASES`, `REASONING_EFFORT`, `InvokeFn`, `ProviderCallParams`, `ProviderCallResult`.
- No React, no Zustand, no Tauri imports ??injects `invoke` as a parameter.
- `useWorkflowExecution.ts` now imports from the adapter (behaviour unchanged).
- `tests/unit/services/providerAdapter.test.ts` ??19 new tests covering success paths
  (openai, anthropic, ollama), billing fallback, missing-key guard, message builder,
  token estimator, model alias resolution.

**Purchasing Decision Assistant registered in `useExamples`:**
- `PURCHASING_DECISION_YAML` added to `useExamples.ts` as `EXAMPLES[5]`.
- ExamplePicker now shows 6 examples; existing test suite picks it up automatically.
- Pattern: "Deterministic pipeline" ??beginner-friendly, no high-risk tools, Ollama-safe.

**AuditStrip per-agent filter chips (UX P1):**
- Dynamic chips appear only when agents have logged entries.
- Stacks orthogonally with the existing kind filter (all/tool/consent/warn/error).
- Event count shows `N/total` when filtered.

**ContextInspectorTab Output Stream expand toggle (UX P1):**
- `TextBlock` gains optional `expanded` prop; `Sec` action prop wires the toggle button.

### Verification
- `npx tsc --noEmit` ??0 errors
- `npx vitest run` ??**180/180 passing** (21 test files; +19 new in providerAdapter)
- `npm run build` ??passed in 4.87 s
- `node cli/harness.mjs workflow validate examples/purchasing-decision.harness.yaml` ??`??VALID`

### Files
New: `src/services/model-providers/providerAdapter.ts`,
     `tests/unit/services/providerAdapter.test.ts`
Edited: `src/hooks/useWorkflowExecution.ts`,
        `src/hooks/useExamples.ts` (+PURCHASING_DECISION_YAML + EXAMPLES[5]),
        `src/components/layout/AuditStrip.tsx` (per-agent chips),
        `src/components/config-panel/tabs/ContextInspectorTab.tsx` (expand toggle),
        `docs/TODO.md`, `docs/DEVELOPMENT_LOG.md`

---

## 2026-05-17 ??UX P0/P1 fixes + CLI v0

### Result

**UX fixes (3):**
- `src/components/canvas/EmptyCanvasHero.tsx` (new) ??frosted-glass overlay on blank canvas.
  Three action chips (Open Workspace, Load Example Ctrl+E, Keyboard Help Ctrl+/) dispatch
  keyboard events; `Ctrl+Shift+E` tip line. Pointer-events let ReactFlow pane stay active.
- `src/components/layout/TopBar.tsx` ??amber 8 px dot on Run button when selected provider
  has no API key; tooltip explains what to set.
- `src/components/layout/StatusBar.tsx` ??amber animated pill "??Running: Agent Name" while
  execution is in progress; disappears on run finish.
- `src/components/layout/AuditStrip.tsx` ??per-agent filter chips appear dynamically as
  agents log entries; stacks with existing kind filter; event count shows `N/total` when
  filtered; `useMemo` for id?뭤ame map.
- `src/components/config-panel/tabs/ContextInspectorTab.tsx` ??Output Stream expand toggle
  via `Sec` action prop; `TextBlock` gains optional `expanded` prop (removes maxHeight).

**CLI v0 (zero new deps):**
- `cli/harness.mjs` ??Node.js `.mjs` CLI with 3 commands:
  `project status`, `workflow validate`, `provider list`.
  Human-readable tables or `--json` output. Structured JSON errors to stderr, non-zero exit.
  Inline Zod schemas (labelled [KEEP-IN-SYNC] with `src/schemas/`).
- `package.json` ??`"harness": "node cli/harness.mjs"` script.
- `tests/unit/cli/cliValidate.test.ts` ??7 Vitest tests covering valid/invalid YAML,
  unknown roles, missing fields, semver check, parallel-min check, demo sync check.

### Verification
- `npx tsc --noEmit` ??0 errors
- `npx vitest run` ??**160/160 passing** (153 prior + 7 new)
- `npm run build` ??passed in 5.06 s
- `node cli/harness.mjs workflow validate examples/purchasing-decision.harness.yaml` ??`??VALID`
- `node cli/harness.mjs provider list` ??8 providers in formatted table
- `node cli/harness.mjs project status` ??detects 6 workflows, .harness/ dir present

### Files
New: `cli/harness.mjs`, `src/components/canvas/EmptyCanvasHero.tsx`,
     `tests/unit/cli/cliValidate.test.ts`
Edited: `src/components/canvas/WorkflowCanvas.tsx`, `src/components/layout/TopBar.tsx`,
        `src/components/layout/StatusBar.tsx`, `src/components/layout/AuditStrip.tsx`,
        `src/components/config-panel/tabs/ContextInspectorTab.tsx`, `package.json`,
        `docs/TODO.md`, `docs/DEVELOPMENT_LOG.md`

---

## 2026-05-17 ??Strategic Assessment + Documentation Slice

### Goal

Produce a comprehensive assessment of the project's readiness for beginners,
experts, other AI agents (CLI/MCP), a future VS Code extension, MATLAB
integration, and coding-heavy projects. Implement only the safest valuable
next slice ??documentation and a demo workflow scaffold. No execution paths,
provider behaviour, or secret-handling code was modified.

### Result

- Created `docs/UX_REVIEW.md` ??P0?밣3 pain points, beginner-vs-expert
  capability matrix, recommended UX priorities.
- Created `docs/CLI_MCP_PLAN.md` ??read-only CLI v0 surface (3 commands),
  full read-only MCP tool surface, write-tool deferral, safety constraints.
- Created `docs/VS_CODE_EXTENSION_PLAN.md` ??reusable layers, 5 blockers,
  target monorepo architecture, capability matrix, security constraints.
- Created `docs/MATLAB_INTEGRATION_PLAN.md` ??5 integration options ranked
  by safety, environment-check spec, file handoff layout, beginner demo.
- Created `docs/E2E_DEMO_PLAN.md` ??Purchasing Decision Assistant demo,
  deterministic scoring rubric, expected ranking, failure cases.
- Created `examples/purchasing-decision.harness.yaml` ??5 agents, 7 edges,
  4 edge kinds, no high-risk tools, schema-valid.
- Created `tests/unit/examples/purchasingDemo.test.ts` ??7 new tests
  (schema parse + structure + safety assertions).
- Updated `AGENT.md` ??added Strategic Assessment Slice section + next-agent
  guidance.
- Updated `docs/TODO.md` ??Strategic Assessment Backlog at the top.
- Updated `docs/PROJECT_STATUS.md` ??current state + test counts.

### What was NOT changed

- No source files under `src/`.
- No Rust files under `src-tauri/`.
- No live provider execution.
- No secret storage code.
- Historical note: at that time, no CLI binary or MCP server existed. As of 2026-05-18, CLI v0 and MCP v0 both exist and are verified.
- No MATLAB execution (no environment probe yet either).
- `useExamples.ts` was deliberately NOT modified ??the new demo loads via
  the file tree until a deterministic verification harness exists.

### Verification

- `npx tsc --noEmit` ??0 errors.
- `npx vitest run` ??**153/153 passing** (146 prior + 7 new in purchasingDemo).
- `npm run build` ??succeeded with the existing 533 kB main chunk warning.
- Tauri app was not relaunched this slice ??no runtime-affecting changes.

### Files Modified

New:
- `docs/UX_REVIEW.md`
- `docs/CLI_MCP_PLAN.md`
- `docs/VS_CODE_EXTENSION_PLAN.md`
- `docs/MATLAB_INTEGRATION_PLAN.md`
- `docs/E2E_DEMO_PLAN.md`
- `examples/purchasing-decision.harness.yaml`
- `tests/unit/examples/purchasingDemo.test.ts`

Edited:
- `AGENT.md` ??Strategic Assessment Slice handoff.
- `docs/TODO.md` ??Strategic Assessment Backlog header.
- `docs/PROJECT_STATUS.md` ??status line + test counts.
- `docs/DEVELOPMENT_LOG.md` ??this entry.

### Next Recommended Action

UX P0 fix: add a first-launch empty-state hero on the canvas with "Open
workspace" / "Load example" / "Keyboard help" buttons. The empty state is
a pure presentation change in `src/components/canvas/WorkflowCanvas.tsx`
(or a new `EmptyCanvasHero.tsx`) gated on `workflowStore.nodes.length === 0`.
Low risk, high value, no execution path touched.

---

## 2026-05-17 - Bundle Splitting, Session Restore, Artifact Sidebar, Audit Improvements, Snapshot UX

### Result
- Split 809 KB bundle into vendor chunks via Vite `manualChunks` (vendor-react, vendor-flow, vendor-zustand, vendor-editor, vendor-yaml).
- Added session restore: last loaded harness path persisted in localStorage; auto-loaded silently on app startup.
- Added `ArtifactSidebar` panel at the bottom of the Sidebar: collapsible, reads `getPersistedArtifactPaths()`, inline file preview.
- Added module-level path tracking to `artifactService.ts` (`_persistedPaths` Set + `getPersistedArtifactPaths()`).
- Improved `AuditStrip`: severity left-border (error=red, warn=amber, hook=orange, info=transparent); fixed "error" filter to catch `success=false` entries; "warn" filter no longer overlaps with error entries.
- Snapshot delete: "?? button on each `SnapshotHistoryRow` calls `updateSnapshot(..., { snapshotStatus: "cancelled" })` (soft delete); cancelled snapshots are filtered from the history list.
- Snapshot history reload button (?? next to "Snapshot History" section title; `loadHistory` extracted as named function.
- Marked Phase 5 complete in ROADMAP.md; added Phase 6 (Execution Tracing ??Deep Instrumentation).

### Changes Made
- Modified: `vite.config.ts` ??`build.rollupOptions.output.manualChunks`
- Modified: `src/store/workspaceStore.ts` ??`lastHarnessPath` state + `setLastHarnessPath` action
- Modified: `src/hooks/useWorkflow.ts` ??calls `setLastHarnessPath` after successful save
- Modified: `src/App.tsx` ??`useEffect` session-restore on mount (silent, no spinner)
- Modified: `src/services/artifact-manager/artifactService.ts` ??`_persistedPaths` Set + `getPersistedArtifactPaths()`
- New: `src/components/layout/ArtifactSidebar.tsx`
- Modified: `src/components/layout/Sidebar.tsx` ??added `<ArtifactSidebar>`
- Modified: `src/components/layout/AuditStrip.tsx` ??severity borders + corrected filter logic
- Modified: `src/components/config-panel/tabs/ContextInspectorTab.tsx` ??snapshot delete + reload
- Modified: `docs/ROADMAP.md` ??Phase 5 complete, Phase 6 added
- Modified: `tests/unit/services/artifactService.test.ts` ??`getPersistedArtifactPaths` tests
- Modified: `tests/unit/store/workspaceStore.test.ts` ??`lastHarnessPath` tests (new describe block)

### Verification
- `npx tsc --noEmit` passed.
- `npx vitest run` passed ??112 existing tests + new tests passing.
- No new npm packages; no live API calls; no secrets.

---

## 2026-05-17 - File-Backed Snapshot Persistence and Execution Wiring

### Result
- Added file-backed snapshot repository (`FileSnapshotRepository`) persisting to `.harness/snapshots/` via Tauri IPC.
- Introduced `snapshotService.ts` fa챌ade: routes to file or in-memory depending on workspace availability.
- Wired execution engine to save snapshots non-blocking after each agent completes or fails.
- Added `SnapshotHistory` section at the top of the Context Inspector tab showing up to 5 recent snapshots per node, expandable inline.
- Added `artifactService.ts` for file-backed artifact persistence via Tauri IPC.
- Updated TopBar run stats to show agent completion progress (`??N/M agents`) while a run is active.
- Updated `.gitignore` to exclude `.harness/snapshots/` and `.harness/artifacts/`.
- Added near-term deferred items to TODO.md and persisted-snapshot security note to SECURITY.md.

### Changes Made
- New: `src/services/context-builder/fileSnapshotRepository.ts`
- New: `src/services/context-builder/snapshotService.ts`
- New: `src/services/artifact-manager/artifactService.ts`
- Modified: `src/hooks/useWorkflowExecution.ts` ??snapshot wiring (non-blocking, per-agent)
- Modified: `src/components/config-panel/tabs/ContextInspectorTab.tsx` ??snapshot history section
- Modified: `src/components/layout/TopBar.tsx` ??run progress stat
- New tests: `fileSnapshotRepository.test.ts`, `snapshotService.test.ts`, `artifactService.test.ts`

### Verification
- `npx tsc --noEmit` passed.
- `npx vitest run` passed ??existing 92 tests green, new tests added.
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
- Loaded **Harness Studio ??Active Project** via `Ctrl+E` and **Load**.
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
- In the running app, press `Ctrl+E`, choose **Harness Studio ??Active Project**, then click **Load**. Use that harness for Phase 4 (Hook & Permission Management) work.

---

## 2026-05-16 ??Phase 1 HTML Prototype

### Files Created
- `prototype/index.html` ??self-contained Atelier-direction prototype (~700 lines)
- `AGENT.md` (project root) ??Codex delegation document

### Files Modified
- `docs/PROJECT_STATUS.md` ??updated to Phase 1, added review checklist
- `docs/TODO.md` ??restructured for phase-based task management
- `docs/ROADMAP.md` ??updated with Phase 0 completed, Phase 1 in review, Phase 2?? defined
- `docs/DEVELOPMENT_LOG.md` ??this entry

### Key Decisions
- **Prototype uses Atelier direction** (amber accent `#e5a142`, refined dark, Linear/Zed lineage). Observatory direction exists in `.design/` but is Phase 5+ scope.
- **Self-contained single HTML file** rather than multi-file JSX (mirrors `.design/index.html` approach but bundled inline). No CDN dependencies except React 18 + Babel standalone (integrity hashes included).
- **Three workflow patterns** (fanout, pipeline, critic loop) are switchable from the top bar dropdown ??same patterns as `.design/workflows.jsx`.
- **Phase progress and review checklist** surfaced as modal dialogs accessible from the header ??keeps them visible without cluttering the main UI.
- **Design tokens copied exactly** from `.design/Components/atelier.jsx` to ensure prototype matches the design document precisely.

### Design Alignment Notes
The prototype uses `.design/` as the authoritative source. Key values confirmed:
- All role tints match `ROLE_META` in `workflows.jsx`
- Edge colors: data `rgba(255,255,255,0.28)`, memory `#b88bd9` dashed, control `#9097a3` dashed, feedback `#e07575`
- Node structure: header (role chip + label + status dot) / prompt preview / footer (model + tools) / token bar / hook chips
- Inspector tabs: role ??prompt ??tools ??hooks ??memory (in that order)
- Audit kinds: `run`, `tokens`, `edge`, `tool`, `fanout`, `consent`, `done`, `warn`, `error`

### Remaining Risks
- Observable alignment issue: Tauri scaffold uses `.agent-audit/` and `CLAUDE.md`/`AGENTS.md` conventions; design uses `.harness/` and `prompts/` conventions. This needs to be resolved before Phase 2.
- Observatory mode not in prototype yet ??if human review requests it, add from `.design/Components/observatory.jsx`.
- `prototype/index.html` loads React and Babel from unpkg CDN ??requires internet to open. For offline use, these would need to be bundled locally.

### Next Recommended Action
1. Human: Open `prototype/index.html` in a browser
2. Human: Click **??Review** and verify 16 checklist items
3. Human: Sign off on Phase 1
4. Then: Start Phase 2 (align Tauri scaffold with design system, get `npm run tauri -- dev` running)

---

## 2026-05-16 ??Phase 3: Agent Configuration System

### Files Created
- `src/utils/generators/claudeMd.ts` ??CLAUDE.md generator
- `src/utils/generators/agentsMd.ts` ??AGENTS.md generator
- `src/utils/generators/langGraph.ts` ??LangGraph Python exporter
- `src/utils/generators/crewAi.ts` ??CrewAI Python exporter
- `src/utils/generators/hookTemplates.ts` ??5 hook script templates
- `src/utils/generators/index.ts` ??barrel export
- `src/hooks/useGenerator.ts` ??generator hook (writes via IPC + audit)
- `src/components/generate/GeneratePanel.tsx` ??modal with preview + write
- `src/components/palette/CommandPalette.tsx` ???쁊 palette with keyboard nav
- `tests/unit/generators/generators.test.ts` ??13 generator tests

### Files Modified
- `src/App.tsx` ??added modal state, ?쁊 / Ctrl+G keyboard handlers
- `src/components/layout/TopBar.tsx` ???쁊 + Generate buttons
- `src/components/layout/Sidebar.tsx` ??`.harness.yaml` click ??load workflow

### Test Results
- 31 Vitest tests: all pass (was 18; +13 generator tests)
- 5 Rust tests: all pass
- `npx tsc --noEmit`: 0 errors

### Key Decisions
- **LangGraph over generic export**: LangGraph is the most production-ready graph-based agent framework; CrewAI covers the role-based pattern. Together they cover 80% of use cases.
- **Preview before write**: GeneratePanel shows content before writing to disk ??user can inspect and copy without committing
- **Heuristic process type in CrewAI**: Fan-out/aggregator topology ??`Process.hierarchical`; sequential ??`Process.sequential`. Can be manually edited.
- **Hook templates are real scripts**: Content is executable, not pseudocode ??important for actual usability
- **Workflow import on file-tree click**: `.harness.yaml` files highlighted in amber "load" badge ??single click replaces canvas

---

## 2026-05-16 ??Phase 2: Visual Workflow Editor

### Files Modified
- `src/App.css` ??Atelier CSS design tokens as CSS custom properties
- `src/types/agent.ts` ??Added Hook, Aggregator roles; TOOL_RISK map; TokenBudget; new fields
- `src/types/workflow.ts` ??edgeKind union; ValidationResult types
- `src/utils/nodeColors.ts` ??Full rewrite: RoleMeta with glyphs, tints, icons; MINIMAP_COLORS; STATUS_COLORS
- `src/utils/autoLayout.ts` ??New: Dagre LR auto-layout with feedback edge handling
- `src/utils/validateWorkflow.ts` ??New: cycle detection, disconnected check, prompt/model/security checks
- `src/store/workflowStore.ts` ??Updated makeDefaultAgentNode for 8 roles; proper token budgets; edgeKind type
- `src/schemas/agentSchema.ts` ??Updated for new AgentNodeData fields
- `src/schemas/workflowSchema.ts` ??Updated with edgeKind union
- `src/components/nodes/NodeIcon.tsx` ??New: inline SVG icon set matching design system
- `src/components/nodes/BaseAgentNode.tsx` ??Full rewrite: Atelier styling, left/right ports, prompt preview, token bar, hook chips
- `src/components/nodes/HookNode.tsx` ??New node type
- `src/components/nodes/AggregatorNode.tsx` ??New node type
- `src/components/canvas/WorkflowCanvas.tsx` ??8 nodeTypes, 4 edgeTypes, dark background, Atelier minimap
- `src/components/canvas/CanvasToolbar.tsx` ??8 role buttons with hover tints, auto-layout, validate
- `src/components/canvas/edges/DataFlowEdge.tsx` ??4 edge type styles + arrow markers for all types
- `src/components/layout/TopBar.tsx` ??New: breadcrumb, phase badge, stats, save/run
- `src/components/layout/Sidebar.tsx` ??Full rewrite: file tree, node list with glyphs + status dots
- `src/components/layout/StatusBar.tsx` ??Dark theme, phase badge
- `src/components/layout/AuditStrip.tsx` ??New: collapsible audit log with filtering
- `src/components/config-panel/ConfigPanel.tsx` ??Dark Atelier styling
- `src/components/config-panel/shared.tsx` ??New: shared Input/Select/Sec/Fld/SmallBtn
- `src/components/config-panel/tabs/RoleTab.tsx` ??Model info grid, budget slider, limits
- `src/components/config-panel/tabs/PromptTab.tsx` ??inline/file toggle, char count
- `src/components/config-panel/tabs/ToolsTab.tsx` ??Risk-labeled tool list
- `src/components/config-panel/tabs/HooksTab.tsx` ??pre/post rows, consent toggle
- `src/components/config-panel/tabs/MemoryTab.tsx` ??Context breakdown, memory keys, strategy
- `src-tauri/src/commands/audit_commands.rs` ??`.harness/` path (renamed from `.agent-audit/`)
- `.gitignore` ??Added `.harness/audit.log.jsonl` and `.harness/trajectories/`

### Test Results
- 18 Vitest tests: all pass (was 17; +1 for token budget roundtrip)
- 5 Rust cargo tests: all pass
- `npx tsc --noEmit`: 0 errors

### Key Decisions
- Left/right ports (horizontal flow) instead of top/bottom ??aligns with LR Dagre layout
- Inline SVG `NodeIcon` component ??avoids lucide-react per-render dependency, exact match to design system
- CSS custom properties for tokens ??allows dark theme without fighting Tailwind's color system
- `.harness/` audit path ??aligns with design system filesystem convention
- `TOOL_RISK` map in agent.ts ??single source of truth for risk classification

### Remaining Risks
- Live smoke test not run yet ??`npm run tauri -- dev` needs to be executed
- Monaco editor Ctrl+S shortcut uses raw key codes ??may vary by platform
- Auto-layout in CanvasToolbar uses `useReactFlow()` which requires the component be inside `<ReactFlowProvider>` ??already satisfied by App.tsx wrapping

---

## 2026-05-09 ??Tauri Scaffold (Phase 2 prerequisites)

### Files Created
- Full Tauri + React TypeScript scaffold at `D:\toy_project\AI_agent`
- `src/types/` ??AgentRole, ToolPermission, AgentNodeData, WorkflowDef, FileTreeEntry, AuditEntry
- `src/schemas/` ??Zod schemas for agent config and workflow
- `src/store/` ??Zustand stores: workflow (with undo/redo), workspace, ui, audit
- `src/ipc/` ??typed Tauri command wrappers + Vitest mocks
- `src/components/` ??canvas nodes, config panel (5 tabs), file tree, Monaco editor, layout
- `src/utils/` ??YAML serializer, node colors, ID generator, logger
- `src-tauri/src/commands/` ??fs, workflow, audit, process (hook execution) Rust commands
- `src-tauri/capabilities/default.json` ??scoped Tauri permissions
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

