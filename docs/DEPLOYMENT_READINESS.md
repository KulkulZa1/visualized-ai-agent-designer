# Deployment Readiness

Updated: 2026-09-26

This is the source of truth for what is verified, partial, mocked, or blocked.

## Verdict

Not ready for broad end-user release, but materially closer.

The app builds, launches as a Tauri desktop app, packages successfully, and has
a working CLI (read-only commands and headless runs with `harness run`) plus
read/test MCP surfaces. Every run is saved as a run record. Release blockers
remain around artifacts and full provider request traces, OS keychain storage,
installer smoke testing, signing, and clearer production-grade error recovery.

## Evidence From This Pass

Rows marked 2026-09-24 were re-run in the 2026-09-24 defect-fix pass. Other
rows come from earlier passes and were not re-run.

| Area | Command or action | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | Passed (2026-09-24) |
| Frontend tests | `npx vitest run` | Passed, 669 tests / 65 files (2026-09-26) |
| Rust tests | `npm run test:rust` | Passed, 95 Rust tests (2026-09-26) |
| Rust tests without Tauri | `cargo test --no-default-features --features core` | Passed, 95 + 1 (2026-09-26); `cargo tree` shows no Tauri, WebView or GTK |
| harness-core and the CLI bundle | `npm run build:core`, `npm run build:cli` | Passed (2026-09-26); 5.6 MB `harness-core.exe`, a 498 KB bundle with no React, stores or Tauri |
| Desktop build after the Cargo change | `npx tauri build --debug --no-bundle` | Passed (2026-09-25); the Tauri CLI still builds only the app |
| harness run, fake core | `tests/unit/cli/harnessRun.test.ts` (in `npx vitest run`) | Passed (2026-09-26): run, `--json`, denied and allowed commands, a failing agent (exit 1), bad usage (2), no core or a failed preflight (3), save and `--resume`, resume errors (2) |
| harness run, real core | `OPENAI_API_KEY= node cli/harness.mjs run examples/purchasing-decision.harness.yaml --task … --provider openai --json` | Passed (2026-09-25): a `not_started` event and exit 3 without a key |
| harness run, live | The real `harness-core` and the free endpoint on a synthetic scratch project | Passed (2026-09-26). An agent fixed a bug and ran `node --test`, allowed by `--allow-command` (exit 0). The 1 s Reviewer timed out, so exit 1. `--resume` reused the Coder with no model call; the Reviewer ran (21.1 s), so exit 0 with `attempts: 2`. See `docs/DEVELOPMENT_LOG.md` |
| harness run, Ctrl+C on Windows | A real console `CTRL_C_EVENT`, sent by a helper to a run in its own console | Passed (2026-09-26): "Stopping the run…", the agent was stopped, the run finished `cancelled` with exit 130, and the record was saved through `harness-core`, which survived |
| App run in the UI, Windows | The app's UI in a browser, its `invoke` calls sent to the real `harness-core`; the free endpoint and a synthetic scratch project | Passed (2026-09-26): workspace, Custom endpoint, run, command approval (`node --test`, exit 0), Changes and the run record. Stop killed a running `ping` and its `cmd.exe`, and saved the run as `cancelled`. Not covered: the Tauri window, the folder dialog and streaming. See `docs/DEVELOPMENT_LOG.md` |
| Resume an app-saved run | `harness run --resume` on a record the app saved | Passed (2026-09-26): both agents reused, exit 0 |
| harness run output on Windows | Redirected from cmd.exe; captured by Windows PowerShell 5.1 | cmd.exe: UTF-8. Windows PowerShell 5.1 in a default console decodes it with the console code page (`??`), and its `>` writes UTF-16: see `docs/HEADLESS.md` (Troubleshooting) |
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
| Parallel execution | Working; `runParallel()` (`src/services/execution/parallelScheduler.ts`) runs independent branches concurrently up to `executionSettings.maxParallel`; feedback edges excluded from deps but drive revision loops (≤2 rounds), gateway routing prunes skipped branches |
| YAML examples | Working; 7 workflow files detected by CLI/MCP |
| AuditStrip filters | Working with All chip, kind filters, agent chips, empty states |
| Workflow Wizard | Rule-based, working; blog and self-improvement flows verified in UI |
| Guide Assistant | Rule-based, working; no live AI calls |
| Provider settings | Working UI for local/cloud provider setup |
| Ollama Cloud | Implemented via native Ollama `/api/chat`, `https://ollama.com/api`, `gemma4:31b-cloud`, endpoint-scoped keys |
| CLI | Read-only commands working; `run` executes workflows headless |
| Headless runs (`harness run`) | Working: the shared engine plus `harness-core` (the app's Rust commands without Tauri); keys from the environment, `--allow-command`, `--json` events, exit codes 0/1/2/3/130. See `docs/HEADLESS.md` |
| Run records and resume | Working: `.harness/runs/<runId>/run.json` from the app (with a workspace open) and from `harness run`; `--resume` reuses finished, unchanged agents |
| CI | `.github/workflows/ci.yml` (Linux) and the `examples/ci/harness-run.yml` template |
| MCP v0 | Read/test stdio server with 8 tools, working |
| Tauri packaging | Working on this Windows environment |

## Partial or Mocked

| Feature | Current state | Required action |
|---|---|---|
| Agent independence | Logical per-node state only, not process isolation; run records (`.harness/runs/`) persist each node's status and output | Clearer UI labeling |
| Streaming | Real for native tool-calling turns (`chat_turn` streams Anthropic SSE, OpenAI-compatible SSE and Ollama NDJSON); the text-protocol fallback and helper agents still show each reply after it arrives, typed out in chunks | Stream the text-protocol path too |
| Context snapshots | Partial and not a complete request/response trace | Capture actual system/user messages, tool results, provider metadata |
| Artifacts | Mock placeholders in inspector; service exists but run loop is not wired (MCP `list_artifacts` is empty for app runs) | Persist generated artifacts per run/source node |
| API key storage | localStorage/env development path | Add OS keychain/Stronghold |
| Gemini | Catalog/planned only | Implement or keep disabled |
| MCP write tools | Not implemented by design | Add only after permission/audit system |
| Unapplied settings | Temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}`, and workflow `timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved and labeled in the UI but not applied at runtime | Implement each setting or remove it from the UI |
| Agent shell tool | `bash`/`run_command` run after the user approves the exact command, once or for the rest of the run; in `harness run`, only commands passed exactly with `--allow-command`. Not sandboxed. Stop kills a running command's process tree. The process tests now run on every platform, so the Linux CI covers the `sh` path and its process-group kill; macOS is not tested | Sandbox; test on macOS |
| Agent-node hooks | Pre/post hooks on agent nodes run only manually from the Hooks tab; hooks get no per-call input | Design a hook protocol before running them in workflows |
| VS Code extension | Experimental scaffold; most commands do not work (command-name mismatches with the webview). The host confines file access to the open workspace folder and sends the stored OpenAI key only to api.openai.com | Fix command wiring, then smoke-test in VS Code |

## Security Status

| Area | Status |
|---|---|
| Secrets in repo | No real secrets found by regex scan; one dummy test key remains in test fixture |
| CLI secrets | The read-only commands do not read or print raw keys. `harness run` leaves keys in the environment, where `harness-core` reads them; only `HARNESS_CUSTOM_API_KEY` is passed to it, over a local pipe. There is no key flag, and run records never contain keys |
| MCP secrets | Does not read or print raw keys; `get_recent_logs` returns audit-log entries with best-effort (not guaranteed) secret redaction |
| MCP path safety | `validate_workflow` rejects `..` and paths outside the project; `list_artifacts`/`get_recent_logs` workspace paths must stay inside the project |
| MCP test filter | Unsafe shell characters and filters starting with `-` rejected before spawning test command; `npx` runs with `--no-install` |
| Agent shell execution | Per-command approval: the dialog shows the agent, the exact command and the folder; Deny has the focus and Esc denies. The Rust `execute_command` refuses without `consentGranted` (set by the caller after approval, not a user-verified token) and runs the line in the workspace folder (cmd.exe on Windows, sh elsewhere) without provider API keys or input, until the node's remaining time runs out. "Allow for this run" grants that exact command text until the run ends, with a warning that it runs again even if the agent changes what it runs. Stop kills a running command (`cancel_command`: `taskkill /T /F`, a process group on Unix). Sub-agents never get `bash`; Stop denies pending approvals. Approvals (once / for this run / under a grant), denials and results go to `.harness/audit.log.jsonl`. In `harness run` there is no dialog: only commands the user passed exactly with `--allow-command` run, and the audit says "allowed by --allow-command" or "denied (not in --allow-command)"; `harness-core` ignores Ctrl+C so Stop can finish and save the run. Not sandboxed. `execute_inline_command` stays removed |
| Agent file writes | `fs.write`/`fs.append`/`edit_file` calls from model output do write files, confined to the open workspace by `resolve_safe_path()` (which resolves the deepest existing ancestor, so a symlink/junction cannot redirect writes outside). Each run's changes can be reverted from the Changes dialog; a file the run created is deleted with `delete_workspace_file` (workspace-confined, files only), and a file changed since the agent's last write is only overwritten after confirmation |
| Hook execution | Rust command requires an explicit `consentGranted` flag (set by the caller). During runs only Hook-role nodes run their pre-hook; hooks with `requireConsent` are not run automatically (the node fails and the run stops); agent-node hooks run only from the Hooks tab, which asks before running `requireConsent` hooks. Hook processes do not inherit provider API keys; workflow hook runs are appended to `.harness/audit.log.jsonl` |
| DevTools | Not enabled in release builds (tauri `devtools` feature removed); debug builds still open them |
| Tauri shell permissions | `shell:allow-execute` and `shell:allow-kill` removed from default capabilities |
| Cloud calls | No hidden cloud calls added; run preflight contacts only the hosted providers the run will use, and always probes local Ollama as the billing fallback; the billing-error fallback only goes to a local Ollama server |

## Runtime UI Findings

Verified through browser DOM inspection and Chrome headless screenshot of the frontend:

- Empty canvas onboarding is visible and actionable.
- `Create from Goal` opens the rule-based recommender.
- Blog template details show recommendation rationale, setup requirements, artifacts, verification method, next steps, and privacy notes.
- The wizard no longer labels local Ollama as ready without a provider health check.
- Empty-canvas run guidance now says independent forward branches can run concurrently up to `maxParallel`.
- Empty-canvas minimap is hidden until the workflow has nodes.
- AuditStrip empty state says no events yet and includes the All chip.

Found by the Windows QA on 2026-09-26 and not fixed yet (details in
`docs/DEVELOPMENT_LOG.md`):

- The top bar needs about 1,230 px with a workflow open, but the window may be
  1,024 px wide: below that, Save and Run are cut off.
- A workflow shows "● unsaved" as soon as it is opened.
- After another workflow is opened, the node inspector shows the previous run's
  output for the node with the same id.
- Audit labels: tool calls show as "file read", an agent's start and end as
  "hook executed", provider checks as "workflow loaded".
- A Custom-endpoint run still probes local Ollama and warns "Ollama is selected".
- Shortcut hints use the Mac ⌘ on Windows.
- The Changes diff uses a light theme.
- The file search box and the workspace cog do nothing.
- The page title is still "Tauri + React + Typescript".

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
7. Agent shell commands run unsandboxed once approved: decide on a sandbox or an allowlist.

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


