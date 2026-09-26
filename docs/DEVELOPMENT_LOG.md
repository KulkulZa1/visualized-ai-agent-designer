# Development Log

## 2026-09-26 - Fixes for the Windows QA's UI findings

- **Scope:** the nine UI issues the Windows QA below found, all also on master. Branch `claude/ui-fixes`, stacked on `claude/headless-ci`, one commit per fix, each test-first where it can be tested.
- **Design choices** (agreed before the work):
  - A compact top bar in a narrow window, rather than an overflow menu or a larger minimum window.
  - Honest audit types, with working filter chips.
  - A working file search and a Refresh button.
  - Dark editors.
- **Top bar:**
  - The labels of Create from Goal, Examples, Generate and Permissions hide below 1,440 px (App.css).
  - The buttons, the stats and "harness-studio" no longer shrink or wrap; the workspace and file names shorten with "…".
  - The static phase badge left the top bar, and the Ctrl+K palette gained "Run workflow".
  - Measured in a browser:
    - With the labels, the bar needs 1,168 px before the names, so the breakpoint moved from the planned 1,280 px to 1,440 px.
    - At 1,024 px, with a long workspace name, a long file name and "unsaved", Save ends at 940 px and Run at 1,010 px.
    - At 1,280 px, both names show in full.
- **The unsaved flag:**
  - React Flow's measuring and selecting no longer mark a workflow unsaved.
  - A run's node status and token counts are written with `setNodeRunState`, which does not either. The browser check found this second case once opening a file stopped showing "unsaved".
- **Stale results:** loading a workflow, or starting a new one, clears a finished run (`clearRun`); a run still going is kept.
- **Audit:**
  - New action types: `provider_check`, `provider_fallback`, `agent_started`, `agent_finished`, `agent_failed`, `agent_skipped`, `agent_reused`, `tool_call`, `subagent`, `revision`, `compaction`, `gateway_route`, `memory_write` and `run_record`.
  - A `warning` flag marks the problems a run goes on after. The chips match on types and that flag.
  - `harness run` classifies events by action and adds `warning: true` to its JSON events.
  - Commands and hooks, the only entries saved to `audit.log.jsonl`, keep their names.
- **Ollama probe:** only when the run uses Ollama, or uses OpenAI or Anthropic (billing fallback). A fallback that is down is a warning worded as such.
- **Also:**
  - `modShortcut()` for Ctrl/⌘ hints;
  - `vs-dark` for both Monaco editors;
  - `filterFileTree()`, `refreshWorkspaceFiles()`, and a refresh after each run;
  - the page title.
- **Re-checked live** in the browser against the real `harness-core` and the free endpoint:
  - one health check (the Custom endpoint), with no Ollama probe;
  - the audit read provider check, file read, agent started, tool call ×4, command executed, agent finished;
  - the tool chip showed the 4 tool calls and the command, and the consent chip showed the command;
  - the Changes diff was dark;
  - the file search showed only the matches;
  - the workflow stayed "Saved" through the run (55.9 s).
- **Verification:** `npx tsc --noEmit`; `npx vitest run`: 706 tests / 69 files.

## 2026-09-26 - Visual QA on Windows (the app, with a free model)

- **Setup:**
  - No local Ollama and no keys, so the model was the free keyless endpoint (`https://text.pollinations.ai/openai`, model `openai`) as a Custom endpoint.
  - The Tauri window was not driven. The app's own UI ran in a browser, 1,062 to 1,240 px wide, through a scratch Vite plugin that sent every `invoke` to the real `harness-core`.
  - `harness-core` has no folder dialog, workflow load and save, or model list, so those were stood in for. It does not stream, so live streaming was not covered.
  - A synthetic scratch workspace: `sum.mjs` returns `a - b`.
- **App run** ("Fix the sum bug", Coder → Reviewer):
  - Open the workspace, Settings → Custom endpoint, Test connection (0.7 s), load the file, then Run with "Make the tests pass.".
  - The Coder read both files, fixed the line with `edit_file`, and asked to run `node --test`. The dialog showed the exact command and "cmd.exe on Windows". Approved once: exit 0 in 398 ms.
  - The Reviewer answered in 17.7 s, and the run was done in 53.7 s.
  - The canvas statuses, the run panel (time, tokens, timeline), the output panel, the audit strip and the Changes dialog's diff all showed the run. Revert was not tried.
  - `.harness/runs/<id>/run.json` was saved: `done`, the change, and the provider settings without a key.
- **Stop:** a one-agent workflow ran an approved `ping -n 30 127.0.0.1`.
  - Cancel run stopped it at once. `cancel_command` killed `cmd.exe` and `ping.exe`, and `execute_command` returned.
  - The node showed "stopped", and the record was saved as `cancelled`.
- **Resume an app-saved run:** `harness run --resume` on the app's record reused both agents (the app and the CLI hash the definitions alike) and exited 0 with `attempts: 2`.
- **`harness run` output on Windows:**
  - Redirected from cmd.exe, it is UTF-8: ▶ ✓ · — and an emoji came through intact.
  - Windows PowerShell 5.1 in a default console (code page 949) turns them into `??` when it captures the output, and `--json > events.jsonl` writes UTF-16. This is now in `docs/HEADLESS.md` (Troubleshooting).
  - Consolas lacks ▶ ✓ ✗ ↺ ↻ ↩, and Cascadia Mono lacks ↺ ↻ ↩ ✗. Windows Terminal, the default here, falls back to other fonts. Output shown directly in a console (Windows Terminal or the legacy console) was not checked.
- **Fixed:**
  - `harness run` printed "(1 agents)".
  - `tests/unit/cli/harnessRun.test.ts` failed once in a full run; its message was not captured.
    - The likely cause: vitest 4 fails a synchronous test that runs past the 5 s default, and the test that runs the CLI four times took 3.9 s under load.
    - The file now has a 60 s timeout.
    - Separately, running the file several times at once fails with "build it first": each copy's build empties `cli/dist`.
- **Found, not fixed** (all also on master):
  - With a workflow open, the top bar needs about 1,230 px, but the window may be 1,024 px wide (`minWidth`). Below that, Save and Run are cut off, and nothing else runs a workflow. For example, a 1,366 px screen at 125 % scaling gives a 1,093 px window.
  - A workflow shows "● unsaved" as soon as it is opened. `onNodesChange` marks the graph dirty for every React Flow change, including measuring the nodes.
  - After another workflow is opened, the node inspector shows the previous run's output, status and run id for the node with the same id (`agent-0`).
  - Audit labels are wrong for some entries:
    - tool calls (`bash`, `edit_file`) show as "file read";
    - an agent's start and end show as "hook executed";
    - provider checks show as "workflow loaded".
  - A run on the Custom endpoint still probes local Ollama as the billing fallback, which applies only to OpenAI and Anthropic calls. That adds about 2 s and a warning that reads "Ollama is selected".
  - Shortcut hints use the Mac ⌘ on Windows (`⌘K`, `⌘S`, …).
  - The Changes diff uses Monaco's light theme in the dark app.
  - The file tree's search box and the cog next to the workspace name do nothing. New files show only after the workspace is opened again.
  - The page title is still "Tauri + React + Typescript".
- **Verification:** `npx tsc --noEmit`, and `npx vitest run`: 669 tests / 65 files under Git Bash. From PowerShell, the 32 bash hook tests are skipped.

## 2026-09-26 - Headless runs and CI (`harness run`)

- **Goal:** run a workflow without the app, the way `codex exec` runs Codex, for CI servers.
  - Spec: `docs/superpowers/specs/2026-09-25-headless-ci-design.md`.
  - Five parts, each with a plan in `docs/superpowers/plans/`, built test-first.
- **Shared engine:**
  - The run moved out of the React hook into `src/engine/runWorkflow.ts`: `runWorkflow(input, host)`.
  - Store reads became `input`. Store writes, command approval, Stop and snapshots became `host` calls. The engine keeps its own run record.
  - The hook's 40 tests passed unchanged. `defToGraph` is shared by the store and the CLI.
- **harness-core:**
  - Tauri and its plugins are optional (the default `app` feature). `--features core` builds the crate with no Tauri, WebView or GTK in the dependency tree.
  - `core_server.rs` parses each command's camelCase arguments into typed structs, runs the app's own command functions, and answers concurrent requests by id.
  - It serves only the commands a run uses, including `call_claude_api`, which the spec had missed.
  - `tauri build` still builds only the app.
- **harness run:**
  - `src/cli/` is bundled by Vite in SSR mode, with a Node shim for Tauri's `Channel`, so replies do not stream.
  - Keys come from the environment only. `--allow-command` lets exact command lines run; the audit reads "allowed by --allow-command" or "denied (not in --allow-command)".
  - Output is readable lines or `--json` events, with exit codes 0/1/2/3/130. The first Ctrl+C is Stop.
- **Run records and resume:**
  - Every run is saved to `.harness/runs/<runId>/run.json` as it goes, including in the app when a workspace is open.
  - Nodes are keyed by their place in the workflow file.
  - `--resume` reuses a node that is done, has the same definition hash (role, model, tools, limits, prompt text, memory keys, hook) and has only reused forward predecessors. It restores the reused nodes' outputs, memory and routes, and the change log.
- **Found and fixed along the way:**
  - Ctrl+C reached `harness-core` too (the same console or process group) and killed it. A stopped run then exited 3 and could not be saved. The core now ignores Ctrl+C.
  - A memory node's downstream text differs from its shown output, so the record keeps `outputs`.
  - The CLI summary took the final output from a trailing memory node; it now takes it from the last agents.
  - The app's bash warning talked about the approval dialog; `harness run` words it for `--allow-command`.
- **CI:**
  - `.github/workflows/ci.yml` runs on Linux: types, `vitest`, `cargo test` with and without Tauri, and `harness run` against the real core, expecting exit 3 without a key.
  - The Rust process tests used `cmd.exe` and `.bat` hooks. They now pick `sh` on Unix, so Linux covers the `sh` path, the process-group kill and key-free environments.
  - `examples/ci/harness-run.yml` is a template for other repositories.
- **Live smoke (2026-09-26):**
  - **Setup:**
    - the real `harness run` and the real release `harness-core`;
    - the free keyless endpoint (`--provider openai-compatible --base-url https://text.pollinations.ai/openai --model openai`);
    - a synthetic scratch project: `sum.mjs` returns `a - b`, and `sum.test.mjs` expects 5.
  - **Run 1** (`--allow-command "node --test"`):
    - The Coder read both files through native tool calls and fixed the line with `edit_file` (`a - b` → `a + b`).
    - It ran `node --test`: "allowed by --allow-command; exit 0, 422 ms". It was done in 112.9 s with 4 tool calls.
    - The Reviewer, given a 1 s timeout on purpose, failed ("timed out after 1s"): exit 1 after 123 s.
    - The record was saved with the change `sum.mjs +1 −1`.
  - **Run 2**, after raising the Reviewer's timeout (its definition changed; the Coder's didn't), with `--resume run-1790348292064`:
    - A `reused` event for the Coder; no `node_started` and no model call for it.
    - The Reviewer ran in 21.1 s on the Coder's saved report ("The bug was that `sum.mjs` performed `return a - b;` …").
    - Exit 0 after 24 s. The record shows `attempts: 2`, `status: done`, the same run id and the change log carried over.
    - `node --test` passes in the scratch project.
  - The free endpoint answered 429 a few times; `harness-core` retried and logged it on stderr, and stdout stayed pure JSON.
  - **Ctrl+C on Windows:** a run was started in its own console, and a helper process attached to that console and sent a real `CTRL_C_EVENT` about 12 s in.
    - `harness run` printed "Stopping the run…". The Coder was stopped mid-call, and the run finished `cancelled` with exit code 130.
    - The record was saved as `cancelled` through `harness-core`, so the core survived the Ctrl+C.
- **Verification:**
  - `npx tsc --noEmit`, and `npx vitest run`: 668 tests / 65 files.
  - `cargo test`: 95 tests, and 95 + 1 in the core build, with no warnings in either build.
  - `npm run build`, `npm run build:core`, `npm run build:cli`, and `npx tauri build --debug --no-bundle`.
- **Not verified:** macOS. Windows Ctrl+C was checked once by hand, as above, with no automated test; the Unix SIGINT test runs in CI.

## 2026-09-25 - Coding Core (toward Codex-level coding)

- **Goal:** the six-item checklist the user chose. Spec: `docs/superpowers/specs/2026-09-25-coding-core-design.md`. There was one plan per part in `docs/superpowers/plans/`, built test-first with one commit per part.
- **Edits and undo:**
  - `edit_file` comes with `fs.write` and replaces an exact snippet that must occur once, unless `replace_all` is set. It tolerates CRLF.
  - A per-run change log (`WorkflowRun.changes`) records every file write, by nodes and their helpers.
  - The Changes dialog shows a Monaco diff and reverts per file or all. Created files are deleted with the new `delete_workspace_file`, and a file changed since the agent's last write is only overwritten after confirmation.
- **Commands:**
  - "Allow for this run" grants the exact command text until the run ends; a waiting duplicate runs too.
  - `cancel_command` kills a running command's process tree on Stop.
  - The spec's kill at run end was dropped: `runParallel` only settles after in-flight nodes finish, so a run cannot end while its command runs.
- **Streaming:**
  - With a channel, `chat_turn` streams: OpenAI-compatible SSE, Anthropic SSE, Ollama NDJSON. `chat_stream.rs` rebuilds the non-streaming JSON, so the existing parsers read it.
  - Lines are buffered whole, so text split mid-character decodes correctly.
  - A server that ignores `stream: true` and sends one JSON body is still read. That gap was found while testing, before the live run, with a test first.
  - The node's own native turns show live text (throttled to 50 ms). A server that can't stream falls back for the rest of the run.
- **Long runs:**
  - Compaction starts past 75% of the node's Token budget, which is now applied. One extra call writes a progress note; the newest tool exchange stays verbatim.
  - `AGENTS.md` (max 32 KB) goes to agents and helpers that have a workspace tool.
- **Live checks** against the free keyless endpoint `https://text.pollinations.ai/openai` (gpt-oss-20b, synthetic data):
  - *Streaming:* a temporary `#[ignore]` test called the real `run_turn`. It received 13 separate text pieces (`"1"`, `"\n"`, `"2"`, …) and rebuilt the full reply correctly.
  - *Coding loop:* headless, through the real run loop, `run_turn` and `execute_command` over a temporary localhost bridge, in a synthetic repo with an off-by-one `sum()` and a `node:test` file plus `AGENTS.md`. A stand-in user allowed `node --test` for the run. The run was `done` in 125 s:
    1. `AGENTS.md` was in the agent's system message (audited).
    2. `bash node --test` raised one prompt, answered "allow for this run". It exited 1 (0 of 2 passing).
    3. The model read `math.js`.
    4. It called `edit_file` with exact `old_string`/`new_string` (`i = 1` → `i = 0`).
    5. `node --test` ran again with no prompt, audited as "allowed for this run". It exited 0 (2 of 2 passing).
    6. The model reported the cause correctly.
    7. The change log held `math.js` (before/after, agent Coder), and revert restored the original byte for byte.
  - The bridge did not carry streaming back to the UI, so live text in the UI is covered by unit tests only.
- **Not verified:** a click-through in the desktop window; the macOS/Linux `sh` path and its process-group kill.
- **Known gaps:**
  - Helpers don't compact.
  - `loadProjectInstructions` treats every read error as "no AGENTS.md".
  - Esc in the approval dialog also closes an open Changes dialog. Deny is the safe default.
  - After compaction the token estimate counts only the compacted history.
- **Verification:**
  - `npx tsc --noEmit` passed.
  - `npx vitest run`: 593 tests / 57 files.
  - `cargo test --manifest-path src-tauri/Cargo.toml`: 86 tests.
  - `cargo check` has no warnings, and `npm run build` passed.

## 2026-09-25 - Agent Shell Commands With Per-Command Approval

- `bash`/`run_command` works again. Each command needs the user's approval: `commandConsentStore` holds the queue, `CommandConsentDialog` asks, and `src/services/execution/commandTool.ts` runs the tool.
  - The dialog shows the agent, the exact command and the workspace folder. Deny has the focus, Esc denies, and a click outside does nothing.
  - Time spent waiting for the answer does not count against the node's time: the loop's deadline became a getter, and `beforeDeadline` re-arms when it moves.
  - Stop, or the end of the run, denies pending approvals. Sub-agents never get the tool.
  - Commands with control or invisible characters (bidi overrides, zero-width spaces), or longer than 2000 characters, are refused before asking. The dialog shows the whole command above its buttons, so what the user approves is what runs.
- Rust `execute_command` (`process_commands.rs`):
  - It requires `consentGranted` and an existing workspace folder, and refuses a network share on Windows.
  - It runs the line with no input, without provider keys, and stops at the node's remaining time (1 s–1 h).
  - On Windows the line goes through `cmd.exe /d /s /c` in a cmd started after `chcp 65001`, with the line passed in a delayed-expansion variable.
  - Probe results on this Korean-locale machine: `chcp` in the same cmd still printed cp949 (a cmd keeps the code page it started with). The nested cmd printed UTF-8, and quotes, `&`, `|`, `^`, `%` and `!` came through as typed.
  - I chose cmd over Windows PowerShell 5.1 because 5.1 rejects `&&`.
- Live check against the free keyless endpoint `https://text.pollinations.ai/openai` (gpt-oss-20b, synthetic data). It was a headless run through the real run loop, the Rust `chat_turn` and the Rust `execute_command`, over a temporary localhost bridge.
  - Setup: a "Test Runner" node with `bash` and `read_file`, and a temp workspace holding one `node:test` file (2 passing tests, 1 failing). A stand-in user approved only `node --test`.
  - Command: the model called `bash` natively with `node --test`, the prompt showed the agent, the command and the folder, and after approval the command exited 1 in 319 ms with 236 s allowed. The UTF-8 output was intact (`ℹ pass 2`, `✖ fail 1`).
  - Result: the model read the test file and reported 2 passed and 1 failed, naming `adds numeric strings` (`'23' !== 5`). Run `done` in 70 s; the `command_executed` entry reached the audit file.
- Not verified: a click-through in the desktop window, and the macOS/Linux `sh` path.
- Verification:
  - `npx tsc --noEmit` passed.
  - `npx vitest run`: 538 tests / 49 files.
  - `cargo test --manifest-path src-tauri/Cargo.toml`: 74 tests.
  - `npm run build` passed.

## 2026-09-25 - Revision Loops

- Feedback edges now loop (`src/services/execution/routing.ts`, the `runNode` wrapper in `useWorkflowExecution.ts`). A node with outgoing feedback edges is a reviewer. When its verdict is REVISE, or it names a feedback edge's label, the path from each fired edge's target back to the reviewer re-runs, and then the reviewer runs again. This happens at most `MAX_REVISION_ROUNDS` (2) times, after which the run continues with the latest version. The scheduler awaits the loop, so downstream nodes and gateway routing see the final round.
- A re-run agent gets a REVISION REQUEST with the review, its previous output, and whatever the reviewer read that the agent does not see itself.
- Live check against the free keyless endpoint `https://text.pollinations.ai/openai` (gpt-oss-20b, synthetic data). It was a headless run through the real run loop and the Rust `call_openai_api`, over a temporary localhost bridge. The graph was Drafter → Critic → Loop Gate (gateway), with feedback from Loop Gate to Drafter ("revise") and Loop Gate → Publisher ("ship").
  - First run: `done` in 276 s. Drafter, Critic and Loop Gate each ran 3 times and the revision limit was hit. The Drafter's revision request carried only the gate's `{"route":"revise"}`, not the Critic's note to add "Harness Studio", so it never fixed the draft. After the limit, the gate's last route ("revise") matched no forward edge, so every branch ran and the Publisher got the unrevised draft.
  - Fixed test-first: the request now also carries the reviewer's other inputs, minus what the target already receives.
  - Second run: `done` in 91 s. The Drafter added "Harness Studio" after one round, the Critic answered PASS, and the gate routed "ship". The Publisher ran once, with the revised draft. Counts: Drafter 2, Critic 2, Loop Gate 2, Publisher 1.
- Verification:
  - `npx tsc --noEmit` passed.
  - `npx vitest run`: 513 tests / 46 files.
  - `cargo test --manifest-path src-tauri/Cargo.toml`: 63 tests.
  - `npm run build` passed.

## 2026-09-24 - Native Tool Calling and Sub-Agents

- Agents with runnable tools now use the provider's native tool calling: Rust `chat_turn` (Anthropic, OpenAI and compatible, Ollama) takes a provider-neutral history plus JSON-schema tool definitions; the model ⇄ tool loop moved to `src/services/execution/agentLoop.ts`. The `<tool_call>` text protocol remains the fallback (no runnable tools, tools refused by the model or server, first-call billing error, VS Code extension).
- Only tools offered to an agent run, and the system prompt names only runnable tools.
- `subagent_dispatch` starts real helper agents (`src/services/execution/subAgents.ts`): fresh context, a subset of the parent's tools, the parent's provider/model/deadline/Stop; one level deep, max 5 per node run, 3 at a time.
- The activity panel lists a node's helpers (status, task, tools, time, tool calls, report or error) from `AgentRun.subAgents`, updated as each helper starts and finishes; a helper still working when the run is stopped is shown as stopped, not failed, and so is its node, on the canvas too (saved to the workflow file as idle; before: "skipped" with a "Stopped by user" error).
- Live checks (free keyless endpoint `https://text.pollinations.ai/openai`, gpt-oss-20b, synthetic data; headless run through the real run loop and Rust `chat_turn` via a temporary localhost bridge):
  - Purchasing Decision with native tools: the multi-turn tool history was accepted and tools ran, but tool names came back as `read_file<|channel|>commentary`, which wasted steps; fixed (names are cleaned). The run still ended `error`: the Risk Reviewer spent four ~30 s steps guessing nonexistent file paths and passed its 90 s limit.
  - Sub-agents: an orchestrator dispatched three helpers (one per turn; the model did not batch them, so parallel dispatch was only exercised by unit tests); each read its note with only `read_file` and reported, and the orchestrator combined the reports correctly. Run `done` in 259 s; four 429 rate limits were absorbed by the retry.
- Verification: `npx tsc --noEmit` passed; `npx vitest run` 501 tests / 45 files; `cargo test --manifest-path src-tauri/Cargo.toml` 63 tests; `cargo check` clean; `npm run build` passed.

## 2026-09-24 - Live Check Against a Free Cloud Model

- Ran the Purchasing Decision example headlessly through the real run loop and the Rust `call_openai_api` (temporary localhost bridge in place of Tauri IPC) against the keyless endpoint `https://text.pollinations.ai/openai` (model `openai`, gpt-oss-20b), synthetic inputs only. A click-through run in the desktop window was not done.
- Found and fixed (test-first): native `tool_calls` replies with no `content` failed every agent; `openai_reply_text` renders them as the run loop's `<tool_call>`. After the fix, tools ran (file read, `ranking.md` written) and the evaluator's scores matched the rubric; the run still ended `error` because the Report Writer's third ~30 s call passed the example's 90 s node timeout.
- Doc truth fixes: the demo plan's expected ranking and artifact paths, the example's decision-log claim, and "fixed 30 s" hook timeout wording.
- Verification: `npx tsc --noEmit` passed; `npx vitest run` 456 tests / 42 files; `cargo test --manifest-path src-tauri/Cargo.toml` 50 tests; `cargo check` clean.

## 2026-09-24 - Full Defect-Fix Pass and Documentation Truth Pass

- Whole-repo defect review and fix pass; the review record, including the items left unfixed, is `docs/REVIEW_FULL_AUDIT_2026-09.md`.
- Security: agent shell execution disabled (`bash`/`run_command` refused, `execute_inline_command` removed); hooks no longer inherit provider API keys and need an open workspace; release builds no longer enable DevTools; `resolve_safe_path` blocks symlink/junction escapes for new files; atomic writes use unique temp names.
- Hooks: only Hook-role nodes run during workflows; consent-required or failed hooks stop the run; Windows `.bat`/`.ps1`/`.sh` hooks run and large output no longer deadlocks; workflow hook runs are audited.
- Providers: Claude IDs normalized; OpenAI uses `max_completion_tokens`/`reasoning_effort`; env-only keys work; preflight only contacts providers the run uses; billing fallback only to local Ollama; 5xx/529 retried.
- Execution: file prompts read from the workspace; per-node timeouts enforced; no hidden 4096 max-token cap; failed runs end as `error`; single-run guard; gateway join and unmatched-route fixes; the task reaches entry agents behind hook/memory nodes.
- UI/editor: per-tab unsaved buffers, binary-file guard, validated Ctrl+S, working Ctrl+Shift+O / Ctrl+L / Ctrl+. / Ctrl+Shift+Z, fresh undo history on load, session restore, command-palette actions, edge-preserving save.
- MCP: 8 tools documented; notification and JSON-RPC error-code handling, `isError` results, `-`-prefixed filters rejected, `npx --no-install`. CLI accepts `--workspace` before the command. CrewAI/LangGraph exports parse as valid Python for all 7 examples.
- Docs and in-app help (GuidePanel, QuickStartGuide) updated to match the code; settings that are still not applied (temperature, per-node fallback, gateway condition, prompt variables, workflow timeout/retries) are labeled.
- Verification: `npx tsc --noEmit` passed; `npx vitest run` 456 tests / 42 files; `cargo test --manifest-path src-tauri/Cargo.toml` 45 tests; `npm run build` passed with Vite chunk warnings only.

## 2026-06-11 - Hard Review: Scheduler, Feedback Validation, Parallel Wording

- Ran baseline verification before edits: `npx tsc --noEmit`, `npx vitest run`, and `cargo test --manifest-path src-tauri/Cargo.toml` all passed.
- Found a validator bug: feedback loops were checked through `edge.type`, but the app stores semantic feedback status in `edge.data.edgeKind`. Added `tests/unit/utils/validateWorkflow.test.ts` and fixed `validateWorkflow()`.
- Found the same feedback-edge field bug in auto-layout. Added `tests/unit/utils/autoLayout.test.ts` and fixed feedback-edge reversal in `applyDagreLayout()`.
- Found a scheduler bug: gateway skip logic only skipped direct unmatched successors, so descendants that depended solely on a skipped branch could still run. Added a regression test and fixed `runParallel()` to propagate branch-only skips while allowing shared joins to run.
- Added scheduler protection for pure forward cycles so the runner rejects blocked graphs instead of silently finishing without executing anything.
- Fixed stale user-facing execution wording in the run dialog, guide assistant, example picker, generated CLAUDE.md output, and current status docs.
- Focused verification passed after the fixes: scheduler tests, workflow validation tests, auto-layout tests, generator tests, and `npx tsc --noEmit`.
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
  read/test MCP tool surface, write-tool deferral, safety constraints.
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


