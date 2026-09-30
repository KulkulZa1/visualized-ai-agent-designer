# AGENT.md - Harness Studio

**Repository:** https://github.com/KulkulZa1/visualized-ai-agent-designer
**Working directory:** clone of the above — use this, not any older local copy.

Read this before touching files. Keep it aligned with
`docs/DEPLOYMENT_READINESS.md`.

## Project

Harness Studio is a local-first Tauri 2 desktop app for building, validating,
running, and inspecting multi-agent AI workflows.

Product goal: beginners can load or generate a workflow, configure a provider,
and run it; experts can inspect per-agent context, tools, logs, artifacts,
provider/model choices, CLI/MCP access, and safety boundaries.

## Current Verified Baseline

Last Windows execution pass: 2026-09-26 (the `npm run tauri -- dev` and
`npm run tauri -- build` rows come from an earlier pass and were not re-run;
`tauri build --debug --no-bundle` was re-run on 2026-09-25).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | Passed, 706 tests / 69 files |
| `cargo test` | Passed, 95 tests (the app build) |
| `cargo test --no-default-features --features core` | Passed, 95 + 1 tests; no Tauri, WebView or GTK in the dependency tree |
| `npm run build` | Passed; Vite empty `vendor-react` and large `index`/`monacoLocal` chunk warnings remain |
| `npm run build:core`, `npm run build:cli` | Passed: `harness-core` (5.6 MB release binary) and `cli/dist/harness-run.mjs` |
| `npm run tauri -- dev` | Launched `target\\debug\\agent-workflow-builder.exe` and WebView2 |
| `npm run tauri -- build` | Produced MSI and NSIS installers |
| CLI | Read-only commands tested; `harness run` end to end against a fake `harness-core` |
| `harness run` (live) | 2026-09-26: the real `harness-core` and a free keyless endpoint; an agent fixed a bug and ran an allowed `node --test`, and `--resume` reused it (see `docs/DEVELOPMENT_LOG.md`) |
| App run in the UI (Windows) | 2026-09-26: the UI in a browser against the real `harness-core` and a free endpoint: run, command approval, Changes, run record and Stop. The UI issues it found are fixed and were re-checked the same way (see `docs/DEVELOPMENT_LOG.md`) |
| MCP | stdio server and read/test tools tested |

Linux pass, 2026-09-30 (not a Windows re-run: the rows above stand):
`npx tsc --noEmit` passed; `npx vitest run` passed, 1514 tests / 75 files, and 1
skipped because it needs a non-root user (CI runs it; the suite was 1413 / 73 before
the local-model changes, and 1151 / 72 before the offline bundle's tests);
`cargo test` passed, 162 tests (the 2 Windows-only tests are not compiled on
Linux; it was 143 before the local-model changes);
`cargo test --no-default-features --features core` passed, 162 + 2 tests;
`npx vite build` passed with no empty `vendor-react` chunk (the large
`index`/`monacoLocal` warning remains). The commands of CI's `harness run` step,
against the real `harness-core` with no key, stopped with exit 3 and `not_started`.
Also run by hand, not as tests: the hook script check end to end, with the real
`harness run` bundle and a debug `harness-core`, hook-only workflows and no model
(78 of 78 checks passed); and the fixes for #10's review, in a browser (Chromium
on the app's production build, every Tauri `invoke` answered by the real
`harness-core`, a scripted OpenAI-compatible server as the model). Details are in
`docs/DEVELOPMENT_LOG.md`.
Offline bundle pass, the same day, on the final script (commit 0e95a27), not part of
the test suite or CI: `npm run offline:bundle`, then `offline:setup` and
`offline:verify` in a fresh clone in a network namespace with no route out and empty
npm and cargo caches. Setup installed 271 packages and placed both prebuilt binaries,
all 7 verify steps passed (vitest 1413 tests / 73 files and 1 skipped; `cargo test`
143, and 143 + 2 with the core build), and nothing was downloaded. Setup refused a
damaged npm cache (naming the package, writing nothing) and a changed dependency, and
accepted a bump of the project's own version, a reformatted lock and CRLF line
endings; `create --force` repaired a damaged bundle. Details are in
`docs/AIRGAPPED.md` and `docs/DEVELOPMENT_LOG.md`.
Not run in this pass: Windows (the cmd.exe path refusal, and `.bat`, `.ps1` and
`.py` hooks), macOS, the Tauri window and its IPC, and a live model. Also not run:
the offline bundle on Windows, on macOS and on a physically air-gapped machine. It
does not cover the installer build.
The local-model changes (Ollama's context window, the Custom endpoint's model name,
the timeouts, the capability flags) were checked by unit tests, and end to end, by
hand, with the real `harness run` bundle and a real debug `harness-core` (both built
from commit 76e60c7 in a separate checkout) against fake Ollama and OpenAI-compatible
servers that recorded every request, in a network namespace with only loopback:
`num_ctx` (the default, the flag, the variable, 0, ollama.com and look-alike hosts,
invalid values), the run record, a Custom endpoint run from the environment alone
(`gpt-4o-mini` in no request), and the timeouts (a 30 s call timeout, a probe that
never answered at 120 s, one that answered after 15 s, a 10 s connect). The warning's
current rule and text were checked the same way on commit 2171368: the shipped
`examples/spec-to-pr.harness.yaml` at the default window gave no context warning
(the old rule warned on its Implementer, whose Max tokens is 16384), a prompt that
did not fit still warned, and the rule's boundaries held. Not run: a real model
server (Ollama, llama.cpp, vLLM, LM Studio), the streaming turn end to end, the hosted
probes (OpenAI, Anthropic), real HTTPS to ollama.com, release builds, and nothing on
Windows, macOS or in the Tauri window and its `invoke` arguments. Details are in
`docs/DEVELOPMENT_LOG.md`.
`.github/workflows/ci.yml` runs these checks and `harness run` against the real
`harness-core` on every pull request and push to master.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | Tauri 2, Rust backend, WebView2 on Windows |
| Frontend | React 19, TypeScript, Vite |
| Canvas | `@xyflow/react` |
| State | Zustand + zundo |
| Validation | Zod |
| CLI | `cli/harness.mjs`: read-only commands, and `run` for headless workflow runs |
| MCP | `mcp/server.mjs`, stdio read/test v0 |

## What Works

- Canvas editor with node/edge editing, validation, undo/redo, auto-layout, examples, and YAML load/save.
- Rule-based Workflow Wizard / Create from Goal, including blog automation and Harness Studio self-improvement templates.
- Rule-based Guide Assistant. It makes no live AI calls.
- Provider settings and adapters for OpenAI, Anthropic, Ollama local, Ollama Cloud, and OpenAI-compatible endpoints.
- Agent file tools (`read_file`/`fs.read`, `list_files`, `grep`, `fs.write`, `fs.append`, and `edit_file` for nodes with `fs.write`), confined to the open workspace, called through native tool calling (Rust `chat_turn`; loop in `src/services/execution/agentLoop.ts`) with the `<tool_call>` text protocol as fallback. Writes to git internals, `.harness/hooks/`, `.harness/runs/` and `.harness/audit.log.jsonl` are refused. The check is on the path as written: links and Windows aliases (8.3 names, NTFS streams) are not covered.
- Coding core:
  - Every file a run's agents write is in the run's change log (`changeLog.ts`). The Changes dialog shows a diff and reverts per file or all (`revertChanges.ts`, Rust `delete_workspace_file`).
  - Native tool-calling turns stream live (`chat_stream.rs`).
  - Past 75% of a node's Token budget, older steps become a progress note (`compaction.ts`).
  - The workspace's `AGENTS.md` is given to agents with workspace tools (`projectInstructions.ts`).
- Sub-agents: `subagent_dispatch` (`src/services/execution/subAgents.ts`) starts helpers with a fresh context and a subset of the parent's tools; one level deep, max 5 per node run, 3 at a time. Helpers are recorded on the node's run (`AgentRun.subAgents`) and listed in `AgentActivityPanel`.
- Ollama Cloud model `gemma4:31b-cloud`; alias `gemma4-31b:cloud` normalizes to the canonical model.
- Air-gapped operation against a local OpenAI-compatible server: the "Custom" provider POSTs to `<base-url>/chat/completions` from the Rust backend (not the WebView, so CSP does not block it), key optional. Ship via the offline installer (`build-installer.ps1 -Offline`). See `docs/AIRGAPPED.md`.
- Local models, on this machine or the network (Ollama, or any OpenAI-compatible server; `docs/AIRGAPPED.md` §5). Checked against fake servers only, not a real model server (see Current Verified Baseline and Honest Limitations):
  - Ollama's context window: every Ollama `/api/chat` request (text protocol, native turn, streaming turn) sends `options.num_ctx` (`ollama_options` in `api_commands.rs`): 16384 by default, 0 sends none, never to ollama.com. Set in Settings ("Ollama context window (tokens)"), or with `harness run --num-ctx` / `HARNESS_OLLAMA_NUM_CTX`. It overrides the server's `OLLAMA_CONTEXT_LENGTH` and a model's own `num_ctx` (Modelfile): a model built with 32768 is lowered to the app's window (16384 by default) unless the window is 0 or 32768. `provider.ollamaNumCtx` in the run record is the setting, not what went over the wire: it is written for every run (another provider's, an ollama.com run), a resumed run records the value it was resumed with, and a resume never compares it. With P the estimated prompt (chars / 4), M the agent's `maxTokens` (2048 if 0) and W the window, a node gets one `context_window` audit warning when P + min(M, W / 2) > W (`harness run`: `warning: …` on stderr, without the ⚠, or an `audit` event with `--json`). A `harness-core` built before this change ignores the window and the call timeout without saying so: rebuild it (`npm run build:core`).
  - The Custom endpoint's model has no default (it was `gpt-4o-mini`; blank sends each agent's own model). The run's preflight probes the model the run will send (the Model name, else the first agent node's). Test connection with no model sends nothing and asks for one.
  - `harness run` reads `HARNESS_CUSTOM_BASE_URL` and `HARNESS_CUSTOM_MODEL` for the Custom endpoint (flags win), so `LLM_PROVIDER=openai-compatible` needs no `--provider`. These two, `HARNESS_OLLAMA_NUM_CTX` and `HARNESS_REQUEST_TIMEOUT_SECS` are read by `harness run` only, never by the app. The Run dialog's Provider Override offers Custom.
  - Timeouts: a health probe allows 120 s for Ollama, Ollama Cloud and Custom, and 10 s for OpenAI and Anthropic; connecting fails after 10 s. A model call's total timeout is 600 s by default, 30 to 86400 (Settings "Model call timeout (seconds)", `--request-timeout`, `HARNESS_REQUEST_TIMEOUT_SECS`); a call to Ollama or an OpenAI-compatible endpoint that has not started answering in time says so (a stalled non-streamed reply gives "Failed to parse Ollama response: …" instead, a non-streamed Anthropic call keeps its old message, and a probe that runs out of its limit still reads like a server that is down). An agent's own `timeoutSeconds` (300 for a new agent) bounds the node's whole run and is enforced, so a call cannot outlast its node: the call is not cancelled, a local server keeps working on it, and later calls may queue behind it. Raise both on slow hardware.
  - `harness provider list`, MCP `list_providers` and the provider catalog report native tool calling for Ollama and Ollama Cloud, and tool calling and streaming for OpenAI-compatible endpoints.
- Offline build and test (`docs/AIRGAPPED.md`): `scripts/offline-bundle.mjs` collects every npm package and Rust crate that `package-lock.json` and `src-tauri/Cargo.lock` name, and prebuilt `harness-run.mjs` and `harness-core` for its own platform, so the source builds and tests with no internet. Only cargo stays offline afterwards (`.cargo/config.toml`); a plain `npm ci` goes to the registry. Verified on Linux x64 with no network route; not run on Windows or macOS.
  - `npm run offline:bundle -- [<dir>] [--no-binaries] [--force]`: on a connected machine, after `npm ci`, from the repo root. Writes `npm-cache/`, `cargo-vendor/`, `bin/<platform>-<arch>/` and `MANIFEST.json`.
  - `npm run offline:setup -- [<dir>]`: on the air-gapped machine, from the repo root. Refuses a bundle made for other dependencies or with a missing or damaged npm package (every refusal comes before the first change), runs `npm ci --offline`, writes a gitignored `.cargo/config.toml` (delete it to go back online), and installs the prebuilt binaries where they are missing.
  - `npm run offline:verify [-- --skip a,b]`: runs `tsc`, `vitest`, `cargo-core`, `cargo-app`, `build-cli`, `build-core` and `vite-build`, prints a pass/fail table, and exits 1 if any step fails.
- CLI:
  - `npm run harness -- project status`
  - `npm run harness -- provider list`
  - `npm run harness -- workflow validate <file>`
  - `npm run harness -- run <workflow> --task "…"` (see below)
- Headless runs (`docs/HEADLESS.md`): `harness run` runs a workflow without the app.
  - It uses the same engine (`src/engine/runWorkflow.ts`) and `harness-core`: the app's Rust commands built without Tauri, over JSON lines on stdin/stdout.
  - Keys come from the environment. Agent commands run only if passed exactly with `--allow-command`.
  - Output is readable lines or `--json` events, with exit codes for CI.
- Run records: every run, in the app with a workspace open and in `harness run`, is saved to `.harness/runs/<runId>/run.json`. `harness run --resume <runId>` reuses the agents that finished and did not change. The record also keeps a fingerprint of each Hook node's script bytes and env (`hookScripts`), never the text.
- CI: `.github/workflows/ci.yml` runs on Linux, with read-only permissions: types, the TypeScript tests, the production frontend build, the Rust tests (with and without Tauri), and `harness run` against the real `harness-core`. `examples/ci/harness-run.yml` is a template for other repositories.
- MCP v0 tools:
  - `project_status`
  - `list_workflows`
  - `validate_workflow`
  - `run_tests`
  - `run_cargo_tests`
  - `list_providers` (metadata and credential references only)
  - `list_artifacts` (file metadata only; empty until runs persist artifacts)
  - `get_recent_logs` (`.harness/audit.log.jsonl` entries with best-effort secret redaction, not a guarantee)
- Tauri package build for Windows MSI and NSIS installer.

## Honest Limitations

- Execution uses `runParallel()` from `src/services/execution/parallelScheduler.ts`, which runs independent branches concurrently up to `executionSettings.maxParallel`. Feedback edges are excluded from dependency calculations; instead, a verdict of REVISE (or one naming the edge's label) re-runs the path back to the reviewer, up to 2 rounds (the loop is `runWithRevisions` in `src/engine/runWorkflow.ts`; verdicts are read in `src/services/execution/routing.ts`). Gateway routing prunes skipped branches. A revision follows the gateways' current routes:
  - It skips the nodes the current routes prune.
  - When a gateway on the path switches route, a node it routed away from that had already run is dropped: marked skipped, and its output removed from later inputs, the run record and memory. So `harness run --json` can report a node `done` and later `skipped`; the last event, and `run_finished.agents`, count.
  - A node the new route makes live but that is off the revision path does not run; an audit warning (a `revision` entry with `warning`) says so.
  - A failed node is dropped only with `continueOnError`, and a failed Hook never is (it fails the run even then), so a failed run keeps its reason.
- Agents are independent in node ID, role, prompt, model, output, status, audit entries, and snapshots. They are not separate OS processes.
- Streaming is real for native tool-calling turns; the text-protocol fallback and helper agents still show each reply after it arrives (typed out in chunks).
- Context snapshots are partial and not a complete durable provider request trace. Run records (`.harness/runs/`) keep each agent's status, output and the audit, not the provider requests.
- `harness run` shows each agent's reply when it is done (no streaming). `harness-core`'s Ctrl+C handling is tested on Linux in CI; on Windows it was checked once with a scripted console Ctrl+C, not by an automated test. No `harness-core` binaries are published: build it, or use the prebuilt one an offline bundle carries, for the platform it was made on only (`docs/AIRGAPPED.md`). The app has no Resume button.
- Artifact viewer still uses mock placeholders during execution; real artifact persistence is not wired into the run loop (so MCP `list_artifacts` is empty for app runs).
- API keys are stored in localStorage/env during development. OS keychain storage is not implemented.
- Local model servers (Ollama, llama.cpp, vLLM, LM Studio) have not been run with the app or `harness run`. Ollama's context window, the Custom endpoint's model name, the timeouts and the capability flags were checked by unit tests and, with the real `harness run` and `harness-core`, against fake servers (Linux). Not run: the streaming turn end to end (`harness run` never streams), the Tauri window and its `invoke` arguments, Windows, macOS, the hosted probes (OpenAI, Anthropic), real HTTPS to ollama.com. What the docs say of Ollama's own behavior (its small default window, `OLLAMA_CONTEXT_LENGTH`, a model's own `num_ctx`, memory use, reloads) was not tested.
- Gemini is catalog/planned only; no live direct Gemini adapter.
- MCP has no write tools and no workflow execution.
- Agent shell commands (`bash`/`run_command`) run only after the user approves the exact command: once, or for the rest of the run ("Allow for this run" grants that exact text). This goes through `commandConsentStore` + `CommandConsentDialog` and the Rust `execute_command`. Keep it that way: no other auto-approval, and sub-agents never get `bash`. Approved commands are not sandboxed. Stop kills a running command's process tree (`cancel_command`).
- During workflow runs only Hook-role nodes run their `preHook`. Pre/post hooks on agent nodes run only manually from the Hooks tab; `postHook` never runs during runs. A Hook node fails, and the run stops, instead of running when:
  - it is marked `requireConsent`;
  - its script or env changed during the run (checked only for a hook without `requireConsent`). Either an agent's file tools changed the script (the change log, in any attempt of the run), or the fingerprint of the script and of the node's `env` taken when the run first starts differs from one taken just before the hook runs. The Rust command `hook_fingerprint` (in the app and in `harness-core`) takes the fingerprint: a SHA-256 of the script's bytes, in any encoding, and of the `env`, read at the path the interpreter is given. It also catches other spellings of the path, links, approved shell commands and an `env` (a `BASH_ENV` or `PATH`) added to the workflow file. The engine gives the fingerprint to `execute_hook` for every hook that runs without asking, and `execute_hook` reads the script again and re-checks it as its last step before it starts the interpreter (a run from the Hooks tab passes none, so nothing is checked there);
  - its script could not be checked: `hook_fingerprint` failed (a path outside the workspace, a folder or a FIFO, or a `harness-core` older than the CLI bundle, which lacks the command: rebuild it with `npm run build:core`). The message gives harness-core's reason, and the hook is not run unasked. A script that is missing at the start and still missing fails the node too ("was not found in the workspace");
  - on Windows, its full path is one cmd.exe would not run as written: a hook that runs without asking and starts through cmd.exe (any extension except `.sh`/`.bash`, `.ps1` and `.py`) is refused if its resolved path, the workspace folder and the folders above it included, contains one of `& | < > ^ % ! ( ) @ , ; =`, because cmd.exe reads the path as a command line. This is reasoned from cmd.exe's rules and was not run on Windows. The Hooks tab does not check this;
  - the run is a resume and the hook has no baseline (a Hook node added, or given a script, since the first attempt). The baselines are saved in the run record and a resume never takes new ones, so that hook is refused until a new run. After a refusal a resume refuses again: start a new run, which takes the scripts as they are as its baselines. (A record saved before `hookScripts` existed has none; resuming it takes them then.)
- Hook refusals are audited (`.harness/audit.log.jsonl`), and `harness run` exits 1. The check needs no Web Crypto, so `harness run` has no exit-3 preflight for it (`package.json` still declares Node 20 or later). A record saved by a build that hashed the script's text in JavaScript never matches: resuming it refuses its unasked hooks as changed, so start a new run.
- The hook script check does not cover files a script sources or imports, the moment between `execute_hook`'s last read and the interpreter's own opening of the file (narrowed, not closed), or an approved `bash` command that writes anywhere in the workspace, run records included. A new run takes the scripts as they are as its baselines (`docs/SECURITY.md`).
- Temperature, per-node fallback model, gateway `condition` text, prompt `{{variables}}`, and workflow-level `executionSettings.timeoutSeconds`/`retryOnFailure`/`maxRetries` are saved and labeled in the UI but not applied at runtime.
- The VS Code extension (`vscode-extension/`) is an experimental scaffold; most commands do not work yet (command names do not match the webview).

## Development Rules

1. Do not create `AGEND.md`; use `AGENT.md`.
2. Do not claim mock/partial features are production-ready.
3. Do not commit secrets or print raw API key values.
4. The CLI's `project`, `workflow` and `provider` commands stay read-only, and MCP stays limited to read/test tools. `harness run` executes workflows: agent commands run only if the user passed that exact command with `--allow-command`, and every command is audited.
5. Do not add hidden cloud calls or background provider checks.
6. Do not add command execution without the user's approval of that exact command: once, as a run grant the user chose (agent `bash` goes through `commandConsentStore`), or up front with `harness run --allow-command`. Never auto-approve anything else.
7. Use `resolve_safe_path()` for Rust file paths.
8. Hook execution must stay explicit and consent-gated.
9. Prefer small, reviewable fixes over rewrites.
10. Verify with real commands before declaring completion.

## Key Files

| File | Purpose |
|---|---|
| `src/engine/runWorkflow.ts` | Workflow run engine (uses `runParallel`); no React, stores or Tauri |
| `src/engine/runRecord.ts` | Saved run records (`.harness/runs/`), the resume rule and the saved hook baselines (`hookScripts`) |
| `src/cli/runCli.ts` | `harness run` (bundled by `npm run build:cli`) |
| `src-tauri/src/commands/core_server.rs` | `harness-core`: the run's Rust commands over stdin/stdout (`npm run build:core`) |
| `src/hooks/useWorkflowExecution.ts` | Runs the canvas workflow in the app through the engine |
| `src/services/model-providers/providerAdapter.ts` | Provider call adapter |
| `src/utils/providerConfig.ts` | Provider selection, Ollama URL/key helpers, the context window and model call timeout defaults and bounds |
| `src/services/wizard/goalTemplates.ts` | Rule-based goal templates |
| `src/components/guide/GuidePanel.tsx` | Rule-based guide assistant |
| `cli/harness.mjs` | CLI: read-only commands, and `run` (headless runs: `src/cli/`, needs `npm run build:cli` and `npm run build:core`) |
| `mcp/server.mjs` | MCP stdio server |
| `src-tauri/src/commands/api_commands.rs` | Provider calls, Ollama Cloud handling, the Ollama context window (`ollama_options`), timeouts and health probes |
| `src-tauri/src/commands/process_commands.rs` | Hook execution, the hook script fingerprint (`hook_fingerprint`) and approved agent commands (`execute_command`) |
| `docs/DEPLOYMENT_READINESS.md` | Current readiness source of truth |
| `docs/AIRGAPPED.md` | Offline / air-gapped deployment runbook |
| `scripts/build-installer.ps1` | Installer build; `-Offline` embeds WebView2 |
| `scripts/offline-bundle.mjs` | Offline bundle: `create`, `setup` and `verify` (`npm run offline:bundle`, `offline:setup`, `offline:verify`); see `docs/AIRGAPPED.md` |

## Next Best Work

1. Git-native runs: a worktree per run, a diff that includes command-made changes, commit/PR.
2. Persist real per-run artifacts and full provider request traces (run records keep outputs and the audit only).
3. Move API keys from localStorage to an OS keychain (Tauri Stronghold).
4. Add installer smoke tests on a clean Windows user profile.
5. Add a Windows CI job for the Windows-only Rust tests and the Tauri build (`.github/workflows/ci.yml` runs on Linux only).
6. Close the moment between `execute_hook`'s last read of a hook script and the interpreter's own opening of the file, for example by running a private copy of the checked bytes.
7. Build the Windows installer with no network: the Tauri bundler downloads WiX and NSIS utilities and WebView2 (the bootstrapper, or with `-Offline` the full offline installer), so the offline bundle does not cover it. The bundle also has not been run on Windows or macOS.


