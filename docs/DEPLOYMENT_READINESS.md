# Deployment Readiness

Updated: 2026-06-11

This is the source of truth for what is verified, partial, mocked, or blocked.

## Verdict

Not ready for broad end-user release, but materially closer.

The app builds, launches as a Tauri desktop app, packages successfully, and has
working read-only CLI/MCP surfaces. Release blockers remain around durable run
traces/artifacts, OS keychain storage, installer smoke testing, signing, and
clearer production-grade error recovery.

## Evidence From This Pass

| Area | Command or action | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | Passed |
| Frontend tests | `npx vitest run` | Passed, 281 tests / 30 files |
| Rust tests | `cargo test` | Passed, 30 tests |
| Frontend build | `npm run build` | Passed; Vite warned about empty `vendor-react` chunk and large `index`/`monacoLocal` chunks |
| Tauri dev launch | `npm run tauri -- dev` | Passed; built dev profile, launched `target\\debug\\agent-workflow-builder.exe`, spawned WebView2 |
| Tauri package | `npm run tauri -- build` | Passed; produced MSI and NSIS installers |
| CLI status | `npm run harness -- project status` | Passed; printed read-only v0 note, 7 workflows, docs present |
| CLI provider list | `npm run harness -- provider list --json` | Passed; credential references only |
| CLI valid workflow | `npm run harness -- workflow validate examples\\purchasing-decision.harness.yaml` | Passed |
| CLI missing workflow | `npm run harness -- workflow validate missing-file-does-not-exist.harness.yaml` | Failed correctly with JSON error |
| MCP initialize/list | JSON-RPC stdio | Passed |
| MCP project_status | JSON-RPC stdio | Passed; type check true, workflows detected, test files detected |
| MCP validate_workflow | JSON-RPC stdio | Passed for purchasing demo |
| MCP path rejection | JSON-RPC stdio with `../package.json` | Rejected path traversal |
| MCP run_tests | JSON-RPC stdio, filtered wizard test file | Passed, 23 tests |
| Browser UI inspection | Vite app at `http://127.0.0.1:1420/` | Rendered nonblank shell, onboarding, wizard, settings, run dialog |
| Browser screenshots | Browser CDP screenshot call | Blocked by screenshot timeout; DOM inspection succeeded |

Installer outputs:

- `src-tauri/target/release/bundle/msi/Harness Studio_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/Harness Studio_0.1.0_x64-setup.exe`

## Implemented

| Feature | Current state |
|---|---|
| Canvas/editor | Working |
| Parallel execution | Working; `runParallel()` (`src/services/execution/parallelScheduler.ts`) runs independent branches concurrently up to `executionSettings.maxParallel`; feedback edges excluded from deps, gateway routing prunes skipped branches |
| YAML examples | Working; 7 workflow files detected by CLI/MCP |
| AuditStrip filters | Working with All chip, kind filters, agent chips, empty states |
| Workflow Wizard | Rule-based, working; blog and self-improvement flows verified in UI |
| Guide Assistant | Rule-based, working; no live AI calls |
| Provider settings | Working UI for local/cloud provider setup |
| Ollama Cloud | Implemented via native Ollama `/api/chat`, `https://ollama.com/api`, `gemma4:31b-cloud`, endpoint-scoped keys |
| CLI v0 | Read-only, working |
| MCP v0 | Read/test stdio server, working |
| Tauri packaging | Working on this Windows environment |

## Partial or Mocked

| Feature | Current state | Required action |
|---|---|---|
| Agent independence | Logical per-node state only, not process isolation | Add run-level persisted records and clearer UI labeling |
| Streaming | Simulated chunks after full response | Implement provider streaming/SSE |
| Context snapshots | Partial and not a complete request/response trace | Capture actual system/user messages, tool results, provider metadata |
| Artifacts | Mock placeholders in inspector; service exists but run loop is not wired | Persist generated artifacts per run/source node |
| API key storage | localStorage/env development path | Add OS keychain/Stronghold |
| Gemini | Catalog/planned only | Implement or keep disabled |
| MCP write tools | Not implemented by design | Add only after permission/audit system |

## Security Status

| Area | Status |
|---|---|
| Secrets in repo | No real secrets found by regex scan; one dummy test key remains in test fixture |
| CLI secrets | Does not read or print raw keys |
| MCP secrets | Does not read or print raw keys |
| MCP path safety | `validate_workflow` rejects `..` and paths outside the project |
| MCP test filter | Unsafe shell characters rejected before spawning test command |
| Hook execution | Rust command now requires explicit `consentGranted`; workflow hook nodes with `requireConsent` are blocked from automatic execution |
| Tauri shell permissions | `shell:allow-execute` and `shell:allow-kill` removed from default capabilities |
| Cloud calls | No hidden cloud calls added |

## Runtime UI Findings

Verified through browser DOM inspection of the frontend:

- Empty canvas onboarding is visible and actionable.
- `Create from Goal` opens the rule-based recommender.
- Blog automation goal recommends `Blog Writing Pipeline`.
- Template details show agents, setup requirements, artifacts, verification method, and privacy notes.
- Loading the template creates a 7-node / 8-edge workflow.
- Settings expose Ollama Cloud setup, `OLLAMA_API_KEY`, auth token field, and `gemma4:31b-cloud`.
- Run dialog footer now reports bounded parallel scheduling when `maxParallel > 1`, or sequential mode when `maxParallel = 1`; `streaming simulated` remains accurate.
- AuditStrip empty state says no events yet and includes the All chip.

Screenshot limitation: the Browser tool rendered and interacted with the app,
but `Page.captureScreenshot` timed out twice. This pass uses DOM and process
evidence instead of screenshots.

## Release Blockers

1. Installer smoke test on a clean Windows machine or clean user profile.
2. Code signing decision for Windows installers.
3. OS keychain integration for API keys.
4. Durable run logs, snapshots, and artifact persistence.
5. E2E browser/Tauri smoke tests for first-run, workflow creation, settings, run failure, logs, inspector, and bounded parallel fan-out.
6. Durable scheduler trace events for queued/running/skipped/blocked nodes.

## Next Verification Before Release

```powershell
npm install
npm run check:ts
npm test
npm run test:rust
npm run build
npm run tauri -- dev
npm run tauri -- build
npm run harness -- project status
npm run harness -- provider list --json
npm run harness -- workflow validate examples\purchasing-decision.harness.yaml
```

Then install the generated NSIS installer on a clean Windows profile and verify
the app launches without repo, Node, Rust, or Tauri developer tooling.


