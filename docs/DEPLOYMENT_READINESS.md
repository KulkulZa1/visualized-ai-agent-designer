# Deployment Readiness

Updated: 2026-09-30

This is the source of truth for what is verified, partial, mocked, or blocked.

## Verdict

Not ready for broad end-user release, but materially closer.

The app builds, launches as a Tauri desktop app, packages successfully, and has
a working CLI (read-only commands and headless runs with `harness run`) plus
read/test MCP surfaces. Every run is saved as a run record. Release blockers
remain around artifacts and full provider request traces, OS keychain storage,
installer smoke testing, signing, and clearer production-grade error recovery.

## Evidence From This Pass

Rows marked 2026-09-24 were re-run in the 2026-09-24 defect-fix pass. Rows
marked Linux come from a 2026-09-30 pass on Linux and do not replace the
Windows rows. Other rows come from earlier passes and were not re-run.

| Area | Command or action | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | Passed (2026-09-24) |
| Frontend tests | `npx vitest run` | Passed, 706 tests / 69 files (2026-09-26) |
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
| TypeScript (Linux) | `npx tsc --noEmit` | Passed (2026-09-30, Linux) |
| Frontend tests (Linux) | `npx vitest run` | Passed, 1514 tests / 75 files, and 1 skipped (2026-09-30, Linux); the skipped test needs a non-root user and runs on CI; the tests of the offline bundle and of the local-model changes are part of these (1413 / 73 before the local-model changes, 1151 / 72 before the offline bundle) |
| Rust tests (Linux) | `cargo test --manifest-path src-tauri/Cargo.toml` | Passed, 162 tests (2026-09-30, Linux; the 2 Windows-only tests are not compiled there; 143 before the local-model changes) |
| Rust tests without Tauri (Linux) | `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features core` | Passed, 162 + 2 (2026-09-30, Linux; 143 + 2 before the local-model changes) |
| Frontend build (Linux) | `npx vite build` | Passed (2026-09-30, Linux); no empty `vendor-react` chunk; the large `index`/`monacoLocal` warning remains |
| harness run, real core, no key (Linux) | The commands of CI's `harness run` step: `npm run build:cli`, then `harness run` on `examples/purchasing-decision.harness.yaml` with an empty `OPENAI_API_KEY`, against the real `harness-core` | Passed (2026-09-30, Linux): exit 3 and a `not_started` event |
| harness run, hook script check (Linux) | The real `harness run` bundle and a real debug `harness-core`, hook-only workflows, no model: 78 of 78 checks | Passed (2026-09-30, Linux; run by hand, not a test). An untouched hook ran. A script rewritten by an earlier hook was refused ("was changed during this run"), exit 1, and the refusal is in `.harness/audit.log.jsonl`; `--resume` refused it again, and a new run took the changed script as its baseline. A script that isn't valid UTF-8, changed by one byte, was refused. A link re-pointed to a name that isn't valid UTF-8, with another script at the name's U+FFFD form, was refused and the other script did not run. An `env`-only edit was refused on resume. `../outside.sh` was refused with "could not be checked (Path traversal detected: ../outside.sh)", and a missing script got "was not found". A record saved by the earlier text-hash bundle, resumed, was refused as changed. With Web Crypto disabled (`node --no-experimental-global-webcrypto`) the run finished. A `harness-core` without `hook_fingerprint` failed closed. `hookScripts` holds fingerprints, not text. Not run: the cmd.exe path refusal on Windows, `.bat`, `.ps1` and `.py` hooks, macOS, the Tauri window and its IPC, a live model |
| App run in the UI, the fixes for #10's review (Linux) | Chromium on the app's production build, every Tauri `invoke` answered by the real `harness-core` through an injected bridge, and a scripted OpenAI-compatible server as the model | Passed (2026-09-30, Linux; run by hand, not a test). **Changes (2)** stayed after another workflow was loaded. Revert with another folder open was refused, and both folders were untouched. A search matching 1,200 files showed "First 500 of 1,200 matches" with 500 rows. With a 4 s file listing, a second Run started 346 ms after the first finished, while the listing was still running. Not covered: the Tauri window and its IPC, a live model |
| Ollama fallback warning (Linux) | A fake local Ollama server that answers but lacks the model, as the billing-error fallback | Passed (2026-09-30, Linux): the warning says the model isn't pulled and shows the `ollama pull` command |
| Local models: Ollama's context window, the Custom endpoint's model name, timeouts, capability flags (Linux) | **Unit tests** in `npx vitest run` and `cargo test`, against scripted fake servers: a mock Ollama and a mock OpenAI-compatible server in the Rust tests (the request bodies with and without `num_ctx`, the 120 s and 10 s probe limits, the timeout message, the blank-model probe), a fake `harness-core` in the `harness run` tests (`--num-ctx`, `--request-timeout`, the `HARNESS_*` variables, the stderr warning and the `--json` event), and component tests of Settings and the Run dialog. **End to end**, by hand (not a test, not CI): the real `harness run` bundle and a real debug `harness-core`, both built from commit 76e60c7 in a separate checkout, against fake Ollama and OpenAI-compatible servers written in Node that recorded every request, all inside a network namespace with only loopback (`unshare -rn`) | Passed (2026-09-30, Linux). **Project checks in that checkout:** `npx tsc --noEmit` clean; `npx vitest run` 1507 tests / 75 files and 1 skipped; `cargo test` 162, and 162 + 2 without Tauri; `npm run build:cli`; `vite build`; CI's `harness run` step, exit 3 and `not_started`. **The context window:** `num_ctx` was 16384 by default on both Ollama paths, the native tool-calling turn (`chat_turn`) and the text call (`call_ollama_api`). `--num-ctx 4096` gave 4096 and `HARNESS_OLLAMA_NUM_CTX=8192` gave 8192. With both, the flag won. `0` left the key out, and a blank variable gave 16384. `ollama.com` and `api.ollama.com`, mapped to loopback by a private hosts file inside the namespace, got no `num_ctx`; look-alike hosts (`notollama.com`, `ollama.com.example.net`) did. **Bad values:** 16 invalid flag and variable values each gave exit 2, naming the flag or variable. No request was sent, and `harness-core` never started. **The run record** held `ollamaNumCtx` 16384, 4096 and 0 as given, and no keys or timeout. A `--resume` with another `--num-ctx` reused the finished agent and sent the new value. **The warning**, on 76e60c7: `--num-ctx 64` gave one stderr warning per node and `--json` audit events with `warning: true`, and the runs completed. None at the default, at 0 or with the Custom endpoint. An 84 KB task at the default window warned once. **The warning's new rule and text**, rechecked the same way on 2171368 (`npx tsc --noEmit` clean, `npx vitest run` 1514 tests / 75 files and 1 skipped; the Rust code is unchanged since 76e60c7): the results above held, in the new text and with one marker on stderr. `examples/spec-to-pr.harness.yaml` at the default window gave no context warning; the old rule warned on its Implementer, whose Max tokens is 16384. The rule's boundaries held through the real CLI (with Max tokens 16384 at the default window, a prompt of 8,192 tokens gave none and 8,193 warned; with Max tokens 2048, 14,336 gave none and 14,337 warned; half of an odd window rounds down), and 9 of those 12 checks failed against the old rule. **The Custom endpoint:** a run from the environment alone (`LLM_PROVIDER=openai-compatible`, `HARNESS_CUSTOM_BASE_URL`, `HARNESS_CUSTOM_MODEL`, `HARNESS_CUSTOM_API_KEY`) exited 0. The probe and all 3 calls sent that model and the Bearer key, and no Ollama options. Flags beat the variables. With only a URL, the probe and each call sent each agent's own model. `--provider openai-compatible` with no URL gave exit 2. **`gpt-4o-mini`** appeared in none of the 578 recorded files. The same scenarios on master (56e295c) sent it in the probe. **The blank-model probe:** `check_provider_health` with a blank model, sent straight to `harness-core`, returned the new message and sent nothing. **Timeouts:** `--request-timeout 30`, against a server that took the request and never answered, failed the agent at 30.4 to 30.5 s with the new message, on all four paths (Ollama and Custom, native turn and text call). `HARNESS_REQUEST_TIMEOUT_SECS=35` gave 35.5 s. A probe that never answered gave exit 3 after 120.3 s. Connecting to a listener with a full accept queue failed at 10.3 s. `harness-core` raised a timeout of 0 or 1 to 30 s. **Probe patience:** a probe that answered after 15 s let the run complete for Ollama, Ollama Cloud and Custom. On master the same run failed at 10.3 s. **Capability flags:** `harness provider list --json` and MCP `list_providers` reported the new flags. **Before, on master (56e295c):** no `num_ctx`; the probe sent `gpt-4o-mini` when no model was set; the 15 s probe failed at 10.3 s. **Not run:** a real model server (Ollama, llama.cpp, vLLM, LM Studio); the streaming turn end to end (`harness run` never streams; the Rust unit tests cover the streaming turn's `num_ctx`); the Tauri window and its `invoke` arguments; Windows; macOS; the hosted probes (OpenAI, Anthropic); real HTTPS to ollama.com; release builds. See `docs/AIRGAPPED.md` §5 |
| Offline build and test (Linux) | `npm run offline:bundle` on a connected machine. Then, in a fresh clone in a network namespace with no route out (`unshare -rn`) and with empty cargo and npm caches, so that the bundle was the only source: `npm run offline:setup`, then `npm run offline:verify` | Passed (2026-09-30, Linux x64, on the final script, commit 0e95a27; node 22.22.2, npm 10.9.7, cargo and rustc 1.94.1; not part of the test suite or CI). The bundle was about 1.1 GB (`npm-cache` about 307 MB, `cargo-vendor` about 836 MB, binaries about 6 MB) and took about 2 minutes to make. **Setup** installed 271 packages offline and placed both prebuilt binaries. **The shipped binary:** `harness-core` ran `harness run examples/purchasing-decision.harness.yaml --provider openai` with no key, before anything was built: exit 3 and `not_started`, which is CI's own check. **Verify** passed all 7 steps: vitest 1413 tests / 73 files, and 1 skipped (it needs a non-root user; it runs on CI); `cargo test` 143 (app) and 143 + 2 (core); both release builds and the vite build (the compile took about 6 minutes). **No downloads:** every crate compiled from the vendored folder, none from the machine's own cache. **Negative controls:** without the bundle the same steps fail at once (`cargo fetch` cannot resolve crates.io; `npm ci --offline` gives ENOTCACHED). **Refusals:** a changed dependency version was refused, naming the file, and a `.cargo/config.toml` that setup did not write was refused and the file was left unchanged. **Accepted:** a bump of the project's own version, a reformatted `package-lock.json` and CRLF line endings. **A damaged cache:** a missing, a truncated and a same-size-corrupted package for another OS were each refused, with the package named, and nothing was written. **`create --force`** repaired a damaged bundle (on the connected machine: npm fetched again only what was missing or damaged) and refused a folder it did not make. Not verified: Windows, macOS, a physically air-gapped machine, the installer build (the Tauri bundler downloads WiX and NSIS utilities and WebView2, so it needs the network and the bundle does not cover it), the prebuilt binary on another Linux distro, a machine with no Rust toolchain. See `docs/AIRGAPPED.md` |
| CI | `.github/workflows/ci.yml` | Defined, not run in this pass. On ubuntu-latest (Node 22) for every pull request and push to master, with `permissions: contents: read`: `npx tsc --noEmit`, `npx vitest run`, `npx vite build`, `cargo test` for the app and with `--no-default-features --features core` (each built, then run, as steps with time limits), and `harness run` against the real `harness-core` with no key, which must stop at the preflight (exit 3, a `not_started` event) |
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
| Offline bundle | Working on Linux x64: `npm run offline:bundle`, `offline:setup` and `offline:verify` built and tested the source with no network route (see the Evidence table and `docs/AIRGAPPED.md`). Not run on Windows or macOS. The Windows installer build is not covered: the Tauri bundler downloads its tools |
| Local models | Implemented, and checked with fake servers only: unit tests, and the real `harness run` and `harness-core` end to end on Linux (see the Evidence table and Partial or Mocked). Every Ollama request sends a context window (`num_ctx`, 16384 by default, 0 sends none, never to ollama.com; it overrides the server's `OLLAMA_CONTEXT_LENGTH` and a model's own `num_ctx`; Settings, `--num-ctx`, `HARNESS_OLLAMA_NUM_CTX`), and a node whose prompt may not leave room for its reply gets a `context_window` audit warning. The Custom endpoint's model has no default, and the preflight probes the model the run will send. Probes allow 120 s for Ollama, Ollama Cloud and Custom, 10 s for OpenAI and Anthropic; a model call's timeout is 600 s by default and configurable (Settings, `--request-timeout`, `HARNESS_REQUEST_TIMEOUT_SECS`). `harness provider list`, MCP `list_providers` and the provider catalog report native tool calling for Ollama and Ollama Cloud, and tool calling and streaming for OpenAI-compatible endpoints. See `docs/AIRGAPPED.md` §5 |
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
| Local model servers | Ollama's context window, the Custom endpoint's model name, the probe and model call timeouts and the capability flags are implemented. They were checked by unit tests and, on Linux, end to end with the real `harness run` bundle and a real debug `harness-core` against fake Ollama and OpenAI-compatible servers. No real model server (Ollama, llama.cpp, vLLM, LM Studio) was run. Not run either: the streaming turn end to end, the Tauri window and its `invoke` arguments, Windows, macOS, the hosted probes (OpenAI, Anthropic), real HTTPS to ollama.com. What the docs say of Ollama's own behavior (its small default window, `OLLAMA_CONTEXT_LENGTH`, a model's own `num_ctx`, memory use, reloads) was not tested | Run a real local server end to end (app and `harness run`), on Windows and on Linux |
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
| MCP path safety | `validate_workflow` rejects `..` and paths outside the project; `list_artifacts`/`get_recent_logs` workspace paths must stay inside the project, and so must the real path of `.harness/artifacts` and of the audit log: a link that leads outside the workspace or the project is refused. `get_recent_logs` reads a regular file only (a FIFO is refused). `list_workflows` and `project_status` do not follow links. Covered by unit tests; the FIFO and file-symlink tests run on Linux and are skipped on Windows |
| CLI file reads | `harness project status` reads `package.json`, the audit log and the snapshot index only if each is a regular file whose real path is inside the workspace (else it counts as missing), and does not follow links when it looks for workflow files |
| MCP test filter | Unsafe shell characters and filters starting with `-` rejected before spawning test command; `npx` runs with `--no-install` |
| Agent shell execution | Per-command approval: the dialog shows the agent, the exact command and the folder; Deny has the focus and Esc denies. The Rust `execute_command` refuses without `consentGranted` (set by the caller after approval, not a user-verified token) and runs the line in the workspace folder (cmd.exe on Windows, sh elsewhere) without provider API keys or input, until the node's remaining time runs out. "Allow for this run" grants that exact command text until the run ends, with a warning that it runs again even if the agent changes what it runs. Stop kills a running command (`cancel_command`: `taskkill /T /F`, a process group on Unix). Sub-agents never get `bash`; Stop denies pending approvals. Approvals (once / for this run / under a grant), denials and results go to `.harness/audit.log.jsonl`. In `harness run` there is no dialog: only commands the user passed exactly with `--allow-command` run, and the audit says "allowed by --allow-command" or "denied (not in --allow-command)"; `harness-core` ignores Ctrl+C so Stop can finish and save the run. Not sandboxed. `execute_inline_command` stays removed |
| Agent file writes | `fs.write`/`fs.append`/`edit_file` calls from model output do write files, confined to the open workspace by `resolve_safe_path()` (which resolves the deepest existing ancestor, so a symlink/junction cannot redirect writes outside). They refuse git internals (any `.git` path segment), `.harness/hooks/`, `.harness/runs/` (a resumed run trusts its saved record, which holds the hook-script fingerprints) and `.harness/audit.log.jsonl`. The check is on the path as written: links and Windows aliases (8.3 names, NTFS streams) are not covered, and an approved `bash` command can write there anyway. Each run's changes can be reverted from the Changes dialog; a file the run created is deleted with `delete_workspace_file` (workspace-confined, files only), and a file changed since the agent's last write is only overwritten after confirmation |
| Hook execution | Rust command requires an explicit `consentGranted` flag (set by the caller). During runs only Hook-role nodes run their pre-hook. A Hook node fails, and the run stops, instead of running when it is marked `requireConsent`; or, if it has no `requireConsent`, when its script or env changed during the run. Two checks: an agent's file tools changed the script (the change log, in any attempt of the run), or the fingerprint of the script and of the node's `env`, taken for every Hook node when the run first starts, differs from one taken just before the hook runs. The Rust command `hook_fingerprint` (in the app and in `harness-core`) takes the fingerprint: a SHA-256 of the script's bytes, in any encoding, and of the `env`, read at the path the interpreter is given (this catches other spellings of the path, links, approved shell commands and a changed `env`). `execute_hook` then reads the script again and re-checks it as its last step before it starts the interpreter. The fingerprints are saved in the run record (`hookScripts`); a resume never takes new ones (except for a record saved before the field), so a hook without a baseline is refused until a new run, and a new run takes the scripts as they are. A hook whose script cannot be checked (a path outside the workspace, a folder or a FIFO, a `harness-core` older than the CLI bundle) is not run unasked, and neither is one whose script is missing. On Windows, a hook that runs without asking and starts through cmd.exe is refused if its full resolved path (the workspace folder and the folders above it included) contains one of `& \| < > ^ % ! ( ) @ , ; =` (reasoned, not run on Windows). Refusals are audited. A record saved before this check holds hashes of the script's text, which never match: resuming it refuses its unasked hooks as changed. Not covered: files a script sources or imports, the moment between `execute_hook`'s last read and the interpreter's own opening of the file (narrowed, not closed), and an approved `bash` command that writes anywhere in the workspace, run records included; see `docs/SECURITY.md`. Agent-node hooks run only from the Hooks tab, which asks before running `requireConsent` hooks. Hook processes do not inherit provider API keys; workflow hook runs are appended to `.harness/audit.log.jsonl` |
| DevTools | Not enabled in release builds (tauri `devtools` feature removed); debug builds still open them |
| Tauri shell permissions | `shell:allow-execute` and `shell:allow-kill` removed from default capabilities |
| Cloud calls | No hidden cloud calls added; run preflight contacts only the hosted providers the run will use, and probes local Ollama only when the run uses it or as the billing fallback of OpenAI and Anthropic; the billing-error fallback only goes to a local Ollama server |

## Runtime UI Findings

Verified through browser DOM inspection and Chrome headless screenshot of the frontend:

- Empty canvas onboarding is visible and actionable.
- `Create from Goal` opens the rule-based recommender.
- Blog template details show recommendation rationale, setup requirements, artifacts, verification method, next steps, and privacy notes.
- The wizard no longer labels local Ollama as ready without a provider health check.
- Empty-canvas run guidance now says independent forward branches can run concurrently up to `maxParallel`.
- Empty-canvas minimap is hidden until the workflow has nodes.
- AuditStrip empty state says no events yet and includes the All chip.

The Windows QA on 2026-09-26 found nine UI issues, now fixed and re-checked in
a browser with a real run (details in `docs/DEVELOPMENT_LOG.md`):

- The top bar fits a 1,024 px window: Save and Run stay visible.
- A workflow is "unsaved" only after an edit: opening it, selecting and
  running no longer count.
- Opening another workflow clears the last run's per-agent results from the
  panels ("Agent results were cleared when another workflow was opened."). The
  run stays: its status, its time and **Changes (N)** with the diff and Revert.
  Revert works only with the folder the run worked in open. With another folder
  open it is refused, nothing is read, written or deleted, and the diff stays
  viewable.
- Audit entries are named by what happened, and the tool, consent and warn
  chips match them.
- Local Ollama is probed only when the run uses it or can fall back to it.
- Shortcut hints say Ctrl on Windows.
- The code editors use a dark theme.
- The file search box works (it waits 150 ms after typing stops, and a big
  workspace lists the first 500 matching files, with "First 500 of N matches"),
  and a Refresh button replaced the dead gear.
- The page title is "Harness Studio".

The 2026-09-30 review fixes to the workflow-switch and file-search items above
(Changes staying, the Revert folder check and the 500-match cap) were checked in a
browser against the real `harness-core`, with a scripted OpenAI-compatible server
as the model, not a live one (see the Evidence table).

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

Also on Windows: run a workflow whose Hook nodes run `.bat`, `.ps1` and `.py`
scripts (the hook script check was only run on Linux), and check the cmd.exe path
refusal. A `.bat` hook that runs without asking, in a workspace whose full path has
one of `& | < > ^ % ! ( ) @ , ; =` (for example a folder named `proj(1)`), must be
refused, and one under a folder with only a space in its name must run.


