# Deployment Readiness

Updated: 2026-09-24

This is the source of truth for what is verified, partial, mocked, or blocked.

## Verdict

Not ready for broad end-user release, but materially closer.

The app builds, launches as a Tauri desktop app, packages successfully, and has
working read-only CLI plus read/test MCP surfaces. Release blockers remain around durable run
traces/artifacts, OS keychain storage, installer smoke testing, signing, and
clearer production-grade error recovery.

## Evidence From This Pass

Rows marked 2026-09-24 were re-run in the 2026-09-24 defect-fix pass. Other
rows come from earlier passes and were not re-run.

| Area | Command or action | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | Passed (2026-09-24) |
| Frontend tests | `npx vitest run` | Passed, 492 tests / 44 files (2026-09-24) |
| Rust tests | `npm run test:rust` | Passed, 63 Rust tests (2026-09-24) |
| Frontend build | `npm run build` | Passed (2026-09-24); Vite warned about empty `vendor-react` chunk and large `index`/`monacoLocal` chunks |
| Tauri dev launch | `npm run tauri -- dev` | Passed; built dev profile, launched `target\\debug\\agent-workflow-builder.exe`, spawned WebView2 |
| Tauri package | `npm run tauri -- build` | Passed; produced MSI and NSIS installers; packaging downloaded Microsoft/Wix tooling |
| CLI status | `npm run harness -- project status` | Passed (2026-09-24); printed read-only v0 note, 7 workflows, docs present |
| CLI provider list | `npm run harness -- provider list` and `npm run harness -- provider list --json` | Passed (2026-09-24); credential references only |
| CLI valid workflow | `npm run harness -- workflow validate examples\\purchasing-decision.harness.yaml` | Passed (2026-09-24) |
| CLI missing workflow | `npm run harness -- workflow validate missing-file-does-not-exist.harness.yaml` | Failed correctly with JSON error (2026-09-24) |
| CLI invalid workflow | temporary invalid YAML passed to `workflow validate` | Failed correctly with schema errors |
| CLI option order | `node cli/harness.mjs --workspace . project status` | Passed (2026-09-24); `--workspace` accepted before the command |
| MCP initialize/list | JSON-RPC stdio | Passed (2026-09-24); 8 tools listed, `serverInfo.version` 0.1.0 |
| MCP project_status | JSON-RPC stdio | Passed (2026-09-24); type check true, workflows detected, test files detected |
| MCP validate_workflow | JSON-RPC stdio | Passed for purchasing demo (2026-09-24) |
| MCP run_tests | JSON-RPC stdio, filtered wizard test file | Passed (2026-09-24), 29 tests |
| MCP list_artifacts / get_recent_logs | JSON-RPC stdio on this repo | Passed (2026-09-24); both empty because the repo has no persisted artifacts or audit log |
| MCP safety tests | `npx vitest run` subprocess coverage | Passed (2026-09-24): path traversal, unsafe and `-`-prefixed filters, unknown tool, notifications, JSON-RPC error codes, `isError` results, `npx --no-install`, log redaction |
| Browser UI inspection | Tauri dev app and Vite app at `http://localhost:1420/` | Rendered nonblank shell and onboarding; wizard opened in browser inspection |
| Browser screenshot | Chrome headless | Captured `docs/assets/empty-state.png` |

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
| MCP v0 | Read/test stdio server with 8 tools, working |
| Tauri packaging | Working on this Windows environment |

## Partial or Mocked

| Feature | Current state | Required action |
|---|---|---|
| Agent independence | Logical per-node state only, not process isolation | Add run-level persisted records and clearer UI labeling |
| Streaming | Simulated chunks after full response | Implement provider streaming/SSE |
| Context snapshots | Partial and not a complete request/response trace | Capture actual system/user messages, tool results, provider metadata |
| Artifacts | Mock placeholders in inspector; service exists but run loop is not wired (MCP `list_artifacts` is empty for app runs) | Persist generated artifacts per run/source node |
| API key storage | localStorage/env development path | Add OS keychain/Stronghold |
| Gemini | Catalog/planned only | Implement or keep disabled |
| MCP write tools | Not implemented by design | Add only after permission/audit system |
| Unapplied settings | Temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}`, and workflow `timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved and labeled in the UI but not applied at runtime | Implement each setting or remove it from the UI |
| Agent shell tool | `bash`/`run_command` disabled: refused and not advertised to the model | Per-command consent system before re-enabling |
| Agent-node hooks | Pre/post hooks on agent nodes run only manually from the Hooks tab; hooks get no per-call input | Design a hook protocol before running them in workflows |
| VS Code extension | Experimental scaffold; most commands do not work (command-name mismatches with the webview). The host confines file access to the open workspace folder and sends the stored OpenAI key only to api.openai.com | Fix command wiring, then smoke-test in VS Code |

## Security Status

| Area | Status |
|---|---|
| Secrets in repo | No real secrets found by regex scan; one dummy test key remains in test fixture |
| CLI secrets | Does not read or print raw keys |
| MCP secrets | Does not read or print raw keys; `get_recent_logs` returns audit-log entries with best-effort (not guaranteed) secret redaction |
| MCP path safety | `validate_workflow` rejects `..` and paths outside the project; `list_artifacts`/`get_recent_logs` workspace paths must stay inside the project |
| MCP test filter | Unsafe shell characters and filters starting with `-` rejected before spawning test command; `npx` runs with `--no-install` |
| Agent shell execution | Disabled: `bash`/`run_command` calls are refused and not advertised to the model; `execute_inline_command` IPC removed |
| Agent file writes | `fs.write`/`fs.append` calls from model output do write files, confined to the open workspace by `resolve_safe_path()` (which resolves the deepest existing ancestor, so a symlink/junction cannot redirect writes outside) |
| Hook execution | Rust command requires an explicit `consentGranted` flag (set by the caller). During runs only Hook-role nodes run their pre-hook; hooks with `requireConsent` are not run automatically (the node fails and the run stops); agent-node hooks run only from the Hooks tab, which asks before running `requireConsent` hooks. Hook processes do not inherit provider API keys; workflow hook runs are appended to `.harness/audit.log.jsonl` |
| DevTools | Not enabled in release builds (tauri `devtools` feature removed); debug builds still open them |
| Tauri shell permissions | `shell:allow-execute` and `shell:allow-kill` removed from default capabilities |
| Cloud calls | No hidden cloud calls added; run preflight contacts only providers the run will use; the billing-error fallback only goes to a local Ollama server |

## Runtime UI Findings

Verified through browser DOM inspection and Chrome headless screenshot of the frontend:

- Empty canvas onboarding is visible and actionable.
- `Create from Goal` opens the rule-based recommender.
- Blog template details show recommendation rationale, setup requirements, artifacts, verification method, next steps, and privacy notes.
- The wizard no longer labels local Ollama as ready without a provider health check.
- Empty-canvas run guidance now says independent forward branches can run concurrently up to `maxParallel`.
- Empty-canvas minimap is hidden until the workflow has nodes.
- AuditStrip empty state says no events yet and includes the All chip.

Screenshot evidence: `docs/assets/empty-state.png` shows the empty
onboarding state after hiding the blank minimap when no nodes exist. Playwright's
bundled browser was not installed, so Chrome headless was used for screenshot
capture.

## Release Blockers

1. Installer smoke test on a clean Windows machine or clean user profile.
2. Code signing decision for Windows installers.
3. OS keychain integration for API keys.
4. Durable run logs, snapshots, and artifact persistence.
5. E2E browser/Tauri smoke tests for first-run, workflow creation, settings, run failure, logs, inspector, and bounded parallel fan-out.
6. Durable scheduler trace events for queued/running/skipped/blocked nodes.
7. Per-command consent system before re-enabling agent shell execution.

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


