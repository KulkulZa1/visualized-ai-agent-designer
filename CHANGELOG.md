# Changelog

All notable changes to Harness Studio are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (headless runs and CI)
- **`harness run`**: runs a workflow without the app, for CI (`docs/HEADLESS.md`).
  - It uses the app's run engine, now `src/engine/runWorkflow.ts` with the hook as its host.
  - The Rust commands come from `harness-core`: the app's commands built without Tauri (`npm run build:core`), as JSON lines over stdin/stdout.
  - Keys come from the environment only. Agent commands run only if passed exactly with `--allow-command`.
  - Output is readable lines or `--json` events. Exit codes are 0/1/2/3/130. Ctrl+C stops the run and saves it.
- **Run records and resume**: every run, in the app with a workspace open and in `harness run`, is saved to `.harness/runs/<runId>/run.json`.
  - `harness run --resume <runId>` reuses the agents that finished and did not change, keyed by their place in the workflow file.
- **CI**: `.github/workflows/ci.yml` runs types, the TypeScript tests (with `harness run` end to end) and the Rust tests with and without Tauri on Linux. `examples/ci/harness-run.yml` is a template for other repositories.
  - The Rust process tests now run on every platform, so Linux covers the `sh` path.

### Added
- **Native tool calling** — agents with runnable tools call them through the provider's native tool calling (new Rust `chat_turn` command for Anthropic, OpenAI and compatible endpoints, and Ollama): JSON-schema tool definitions, a real message history, and every tool call of a turn answered. Models or servers that refuse tool definitions fall back to the `<tool_call>` text protocol for the rest of the run; so does the VS Code extension, whose invoke shim lacks the command.
- **Sub-agents** — `subagent_dispatch` now starts helper agents while a node runs: each gets a fresh context, a subset of its parent's tools and the parent's provider, model, deadline and Stop, and its final report comes back as the tool result; several dispatches in one turn run in parallel. One level deep, at most 5 per node run and 3 at a time. The activity panel lists each helper (status, task, tools, time, report or error; a helper still working when the run is stopped shows as stopped); starts, reports and tool calls are also in the audit log.

### Added (coding core)
- **`edit_file`**: agents with `fs.write` also get `edit_file`, which replaces an exact snippet.
  - The snippet must occur once, unless `replace_all` is set.
  - It tolerates CRLF files.
  - A mismatch returns an explanation the model can act on.
- **Changes and undo**: every `fs.write`, `fs.append` and `edit_file` of a run, by nodes and their helpers, is recorded.
  - **Changes (N)** in the run panel opens a side-by-side Monaco diff, using the offline bundle.
  - It reverts one file or all of them. A file the run created is deleted with the new, workspace-confined `delete_workspace_file`.
  - A file changed since the agent's last write is only overwritten after confirmation.
  - Changes made by shell commands are not tracked.
- **"Allow for this run"**: the approval dialog now offers Deny (focused), "Allow for this run" and "Allow once".
  - A run grant covers that exact command text, for any agent, until the run ends. The dialog warns that it runs again even if the agent changes what it runs.
  - The audit log says how each command was approved.
- **Stop kills running commands**: Stop now kills a running command's process tree at once (new `cancel_command`: `taskkill /T /F` on Windows, a process group on Unix). Before, the command ran on until the node's time limit.
- **Live streaming**: agents that call tools natively show their reply live as it arrives (Anthropic, OpenAI-compatible and Ollama streaming).
  - A server that cannot stream, or ignores `stream: true`, still works.
  - The text-protocol fallback and helpers still show replies after they arrive.
- **Compaction**: past 75% of a node's Token budget, older steps are summarized into a progress note by one extra model call. The newest tool exchange is kept verbatim. Each compaction is audited.
- **AGENTS.md**: the workspace's `AGENTS.md` (max 32 KB) is added as project instructions for agents and helpers that have a workspace tool.

### Added (command approval)
- **Agents can run shell commands, with your approval**: the `bash`/`run_command` tool works again, and each command needs its own approval.
  - The approval dialog shows the agent, the exact command and the workspace folder. Only **Allow** runs the command; Deny has the focus and Esc denies.
  - An approved command runs in the workspace folder through the new Rust `execute_command` command, not sandboxed: `cmd.exe` on Windows (UTF-8 output), `sh` elsewhere. It gets no input and no provider API keys.
  - It stops at the agent's time limit, and time spent waiting for the answer does not count toward that limit. The agent gets the exit code and the end of the output.
  - Stop, or the end of the run, denies pending approvals. Sub-agents never get the tool.
  - Approvals, denials and results are audited (`command_executed`), including in `.harness/audit.log.jsonl`.

### Added (revision loops)
- **Feedback edges loop** — when a node with outgoing feedback edges answers REVISE (or names a feedback edge's label, e.g. `rust-fix`), the agents from each fired edge's target back to that node re-run with its review, what it read that they don't see themselves (so a gateway's bare `{"route":"revise"}` still carries the critique behind it) and their previous output, and the node reviews again: at most 2 rounds per node per run, then the run continues with the latest version. Downstream nodes and gateway routing use the final round; rounds appear in the audit log and on each re-run agent's record (`revision`). Labels must match exactly, so ordinary prose cannot start a loop.

### Changed
- **The Token budget now applies**: the Role-tab Token budget used to be display-only. Once a conversation passes 75% of it, older steps are summarized (see Compaction above), which adds a model call.
  - Nodes on the default budget (16k) now compact at about 12k tokens.
  - Raise the budget for agents that read large files; 0 turns compaction off.
- **The run dialog, guide and example notes no longer say streaming is simulated.** Native tool-calling turns stream live.
- **Examples that list `bash`** — in Spec to PR and both Harness Studio projects (Self-Development, Active Project), agents can now run commands: a dialog asks you to approve each one. Before, these calls were refused.
- **Examples with feedback edges now loop** — Self-Critic, Spec-to-PR, Parallel Research, Purchasing Decision and the Harness Studio project re-run agents when their reviewer asks for changes, which adds model calls. Self-Critic's Loop Gate ("REVISE+iter<3") is now honored with a bound of 2 rounds; its `iter_counter` hook does not count rounds.
- **Only offered tools run** — an agent can no longer run a tool it was not given (read tools were never checked), and the system prompt's "Allowed tools" names only tools that actually run.
- **Examples that list `subagent_dispatch`** (Parallel Research's Coordinator, the Harness Studio project's orchestrator) now really start helpers when the model chooses to, which adds model calls.
- **Hooks during workflow runs** — only Hook-role nodes run their `preHook`; pre/post hooks on agent nodes run only manually from the Hooks tab and `postHook` never runs during runs. A `requireConsent` hook fails its node instead of running, a failed hook stops the run even with `continueOnError`, and hooks receive only `AGENT_ID`, `WORKSPACE` and their declared env (no per-call `HOOK_INPUT`). A Hook node times out after its own `timeoutSeconds` (default 30 s, max 1 h); a manual run from the Hooks tab uses 30 s.
- **Permission matrix and validator** — pre/post hooks on agent nodes are no longer presented as a "gate" ("Add guard" removed); the validator notes that each `bash` command waits for your approval.
- **Unapplied settings are labeled** — temperature, per-node fallback model, gateway `condition`, prompt `{{variables}}` and workflow `timeoutSeconds`/`retryOnFailure`/`maxRetries` are still not applied at runtime, and the UI now says so.
- **MCP server has 8 tools** — added `list_providers` (credential references only), `list_artifacts` (file metadata; empty until runs persist artifacts) and `get_recent_logs` (audit entries with best-effort secret redaction). Still read/test only.
- **Generate** — generated CLAUDE.md names `<slug>.harness.yaml` (same as Save) and no longer claims every hook is consented and logged; the Generate panel asks before overwriting an existing file with different content.
- **Repository** — root `CLAUDE.md` is a short pointer to `AGENT.md` (the generated 12-agent harness moved to `examples/harness-studio-project.CLAUDE.md`); `src-tauri/target-codex-verify*` and `.claude/settings.local.json` untracked; `outputs/` ignored; the empty-state screenshot moved to `docs/assets/empty-state.png`; `.gitattributes` added (LF).

### Fixed
- **Stopped nodes** — a node still working when you press Stop now shows as stopped (grey ■, also on the canvas node, in the run panel and in the timeline; saved to the workflow file as idle) instead of "Skipped by gateway" with a red "Stopped by user" error.
- **Tool names with leaked template tokens** — gpt-oss behind some servers returns names like `read_file<|channel|>commentary`; they are now cleaned instead of refused as unknown tools.
- **Native tool calls from OpenAI-compatible endpoints** — servers that parse the model's tool intent themselves (e.g. gpt-oss behind vLLM) reply with `tool_calls` and no `content`; every agent then failed with "Failed to parse OpenAI response" at its first tool call, and a tool call next to text was dropped. The first native call is now passed to the run loop as a `<tool_call>`, and an empty reply reports its `finish_reason`. Found by a live run against a free endpoint.
- **Purchasing demo docs** — `docs/E2E_DEMO_PLAN.md`'s expected ranking now follows its own rubric (SUP-A 92.0 > SUP-B 89.5 > SUP-C 43.5, not SUP-B first), and the example no longer claims to append to `.harness/decision-log.jsonl`.
- **Monaco editor now bundled locally** — it previously loaded from `cdn.jsdelivr.net` at runtime, which is unreachable air-gapped and blocked by the CSP (`script-src 'self'`) in every packaged build. Opening `.md`/`.yaml` files now works fully offline. `monaco-editor` is an explicit dependency; CSP `worker-src` gained `'self'`.
- **Generation calls are time-bounded** — `call_openai_api` / `call_anthropic_api` / `call_ollama_api` had no HTTP timeout; a server that accepted the connection but never responded hung the workflow forever. Now: 10 s connect timeout, 600 s response timeout.
- **Custom endpoint preflight** — runs with provider mode "Custom" now health-check the endpoint up front and abort with one clear error (including a missing-URL guard) instead of failing once per node mid-run.
- **404 health-check hint** — a custom base URL missing the `/v1` prefix now produces "check that the base URL includes the API prefix" instead of a bare HTTP 404.
- **Test suite hygiene** — vitest no longer sweeps up stale test copies under `.claude/worktrees/`, which reported 3 phantom file failures on every run.
- **Provider requests** — dotted Claude IDs (`claude-sonnet-4.6`) are sent as API IDs (`claude-sonnet-4-6`); official OpenAI requests use `max_completion_tokens` + `reasoning_effort` (custom OpenAI-compatible endpoints keep `max_tokens`), and reasoning effort is sent only to reasoning models (`gpt-5.5*`, o1/o3/o4).
- **Provider preflight and retries** — keys set only as environment variables now work; health checks contact only providers the run will use (local Ollama is always probed as the billing fallback); 5xx/529 responses are retried; Ollama model availability requires the exact tag.
- **Execution** — file-based prompts are read from the workspace (node fails if unreadable); per-node `timeoutSeconds` is enforced (the late provider result is discarded); `maxTokens` is no longer silently capped at 4096; runs with failed agents end with status `error`; a second run is refused while one is active; Stop also prevents a pending tool call from executing.
- **Routing** — the user's task reaches entry agents even when a hook/memory node sits in front; a gateway join with another live input still runs; a route that matches no edge label follows all branches.
- **Windows hooks** — `.bat`/`.ps1`/`.sh` hooks now run (previously only `.py` worked); large output no longer deadlocks (up to 1 MiB captured per stream).
- **Editor** — unsaved text is kept per tab and closing a dirty tab asks first; binary / non-UTF-8 files show an error instead of an empty editor that Ctrl+S could truncate.
- **Save and undo** — Ctrl+S validates like the Save button and saves never-saved workflows as `<slug>.harness.yaml`; saving a canvas-built workflow no longer drops or rewires edges on reload; loading a workflow starts a fresh undo history and run status no longer fills it.
- **Shortcuts and UI** — Ctrl+Shift+O (also the first-run "Open Workspace" button), Ctrl+L, Ctrl+. and Ctrl+Shift+Z work; undo/redo/duplicate don't fire while typing; the top bar shows the real valid/invalid state; session restore reopens the last workspace and workflow; command-palette Save/Validate/Auto-layout/Open CLAUDE.md/Open AGENTS.md/View audit log work; the Context tab no longer writes mock snapshots; the status bar no longer overlaps the audit strip.
- **Generators** — CrewAI and LangGraph exports parse as valid Python for all 7 examples (not run against real crewai/langgraph).
- **MCP protocol** — notifications get no reply; parse / invalid-request / unknown-tool errors return -32700 / -32600 / -32602; tool failures return `isError` results; `run_tests` rejects filters starting with `-`; npx runs with `--no-install`; `serverInfo.version` is 0.1.0.
- **CLI** — `--workspace <dir>` can appear before the command.
- **Bundled hook scripts** — `url_allowlist.py` checks the parsed hostname and requires http/https; `destructive_guard.sh` no longer fails open on large input and catches more destructive forms; `rate_limit_sentinel.py` no longer crashes on non-UTF-8 consoles; `test_gate` defaults `WORKSPACE` to the repo root.

### Security
- **Agent shell execution disabled** — model-issued `bash`/`run_command` calls are refused and no longer advertised to the model; the `execute_inline_command` IPC command was removed. Re-enabling needs a per-command consent system.
- **Hook environment and audit** — hook processes no longer inherit `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_API_KEY` / `OLLAMA_REMOTE_API_KEY`; hooks need an open workspace (no `meta.projectRoot` fallback); hook runs inside workflows are recorded in the audit strip and appended to `.harness/audit.log.jsonl`.
- **Release builds** — DevTools are no longer enabled (tauri `devtools` feature removed; debug builds still open them).
- **Workspace paths** — `resolve_safe_path` resolves the deepest existing ancestor for new files, so a symlink/junction inside the workspace cannot redirect writes outside it; atomic writes use unique temp names and refuse directory targets.
- **Provider traffic** — the billing-error fallback only goes to a local Ollama server; network errors no longer echo URL query strings.
- **VS Code extension host** (experimental scaffold) — file access is confined to the open workspace folder, and the stored OpenAI key is sent only to api.openai.com.

### Planned
- Live streaming execution traces
- Artifact viewer in sidebar
- Git diff viewer for workflow changes
- Secure credential storage via Tauri Stronghold
- VS Code extension reuse of core boundaries

## [0.1.0] - 2026-05-29

### Added
- **Phase 5 — Execution Engine**: Run button executes workflow agents in topological order via OpenAI, Anthropic, or Ollama APIs. Supports per-node model configuration with GPT-5.5 tier aliases, `reasoning_effort` for o-series, and Visual Inspector locked to Claude.
- **Multi-provider support**: OpenAI (with retry backoff), Anthropic, Ollama local, and Ollama fallback on billing errors. Provider health checks before each run. Settings panel with API key management.
- **Snapshot persistence**: In-memory and file-backed (`FileSnapshotRepository`) execution context snapshots stored at `.harness/snapshots/`. Snapshot history panel in Context Inspector tab with expand, delete, reload, and JSON export.
- **Provider catalog**: 8 providers catalogued (OpenAI, Anthropic, OpenAI-compatible, Ollama local, Ollama remote, Google Gemini, Cloud placeholder, Kilo). Gemini and Ollama remote added as disabled scaffolding.
- **Token tracking**: Per-agent token estimation after each run; updates node `tokens.used` field; shown in RunPanel.
- **UX improvements**: AuditStrip newest/oldest-first toggle with auto-scroll; animated execution progress bar; RunPanel output 80→200px; resizable config panel (CSS resize); keyboard help overlay (Ctrl+/).
- **Bundle optimisation**: Vite `manualChunks` splits vendor-flow (188 KB), vendor-yaml (97 KB), vendor-editor (14 KB) into separate chunks; main bundle 809 KB → 513 KB.
- **Session restore**: Last opened harness auto-loaded on startup from localStorage.
- **Artifact service**: `artifactService.ts` writes node artifacts to `.harness/artifacts/`. ArtifactSidebar component in Sidebar.
- **Tests**: 124 Vitest tests (was 57 at Phase 3 entry).

### Phase 0-4 (prior)
- Research & Planning, HTML prototype, Visual Workflow Editor (8 node types, 4 edge types, Dagre auto-layout)
- Example YAML files, AGENT_WORKFLOW_SPEC, ExamplePicker
- Agent configuration generators (CLAUDE.md, AGENTS.md, LangGraph, CrewAI, hook templates)
- Hook & Permission Management (permission matrix, hook execution with consent, audit log)
- API error handling with provider fallback
