# Coding Core — Design

Date: 2026-09-25 · Branch: `claude/coding-core`, stacked on `claude/command-approval` (PR #7)

## Goal

Make one Harness Studio agent node code the way Codex does: change files with
reviewable, revertible edits; run commands without an approval prompt for every
repeat; show its work live; keep working through long tasks; follow the
project's `AGENTS.md`. This is the first step toward "equal or better than
Codex". Harness Studio already leads on multi-agent workflows, provider choice
(including air-gapped) and per-agent permissions/audit.

**Approach:** build the features into Harness itself, so they work with every
provider and offline. A "Codex agent" node that runs `codex exec` is a later,
separate option.

**Done when** all six checklist items work and are covered by tests (the user
chose a feature checklist over a head-to-head benchmark):

1. **Diff edits and undo:** the `edit_file` tool, a change log per run, a diff
   view and revert.
2. **Safe auto-approval:** "Allow for this run" for an exact command.
3. **Kill on Stop:** running commands are killed on Stop and at the end of a run.
4. **Live streaming:** for native tool-calling turns.
5. **Compaction:** long conversations are summarized before they outgrow the
   node's token budget.
6. **`AGENTS.md`:** project instructions for agents with workspace tools.

After the checklist, a free-endpoint smoke test (no paid API) walks the coding
loop: edit, approved test run, diff, revert.

## Non-goals (this round)

These are out of scope:
- OS sandbox or command allowlist
- Codex node
- Git worktrees, commits or PRs
- Headless/CI runs (`harness run`)
- Saved runs and resume
- MCP client tools for agents
- A plan/todo tool
- Nested `AGENTS.md` files
- Streaming for the text-protocol fallback
- Tracking file changes made by shell commands

## 1. Editing, change log, diff view, revert

### `edit_file(path, old_string, new_string, replace_all = false)`

- Defined in `toolExecutor.ts` next to `fs.write`. Any node that lists `fs.write`
  is also offered `edit_file` (`runnableTools` adds it). It needs no new
  permission, and saved workflows don't change. The permission check treats
  `edit_file` like `fs.write`.
- Reads the file through `read_workspace_file`, replaces the text, and writes it
  back through `write_workspace_file`, so paths stay confined by
  `resolve_safe_path`. Errors come back as `[error] …` results the model can act on:
  - **Missing file:** `path` does not exist. Use `fs.write` to create it.
  - **Not found:** `old_string` does not occur.
  - **Several matches:** `old_string` occurs N times. Add surrounding lines to
    make it unique, or set `replace_all`.
  - **No change:** `old_string` equals `new_string`.
  - **Empty `old_string`:** use `fs.write` to create or overwrite a file.
- **CRLF files:** when the file uses `\r\n` and a verbatim match fails, the
  strings are retried with `\n` turned into `\r\n`.

### Change log (per run, in memory)

- `executeTool` takes an optional `onChange(path, before, after)`. `fs.write`,
  `fs.append` and `edit_file` call it after a successful write.
  - `before` is `null` when the file did not exist.
  - `fs.write` reads the file first to get `before`. A read that fails with
    "not found" counts as `null`; any other read failure skips the log entry but
    still writes, as today.
- The node and its helpers pass a callback that records into the run.
  - **Where:** `WorkflowRun.changes: FileChange[]` in `executionStore`, where
    `FileChange = { path, before, after, agents: string[], edits: number }`.
  - **Keying:** the path is normalized (`\` → `/`, leading `./` removed).
  - **Merging:** a repeat change to a path keeps the first `before`, takes the new
    `after`, adds the agent name and counts the edit. That logic is a pure
    function in `src/services/execution/changeLog.ts`.

### Changes dialog

- The run panel shows **Changes (N)** when the run has changes. It opens
  `ChangesDialog`:
  - Left: the file list, each marked new or modified, with +/− line counts and
    the agents that touched it.
  - Right: Monaco's `DiffEditor`, read-only and lazily loaded from the offline
    bundle (`monacoLocal.ts` also exports `DiffEditor`).
- A note says that changes made by shell commands are not tracked.

### Revert

`src/services/execution/revertChanges.ts` handles **Revert file** and **Revert all**:
- **Conflict check:** it reads the current content first. If that differs from the
  log's `after` (edited since, by you or by a command), it asks before
  overwriting.
- **Modified file:** writes `before` back.
- **New file:** deletes it with the new Rust `delete_workspace_file(workspace_path,
  relative_path)`. The command goes through `resolve_safe_path`, deletes files
  only (never folders), and is registered in `lib.rs` with a
  `deleteWorkspaceFile` wrapper.
- **After a revert:** the file leaves the change log, and the revert is written
  to the audit log as a `file_write` entry.

## 2. Commands: "Allow for this run" and kill on Stop

### Approval dialog

- The buttons become **Deny** (focused, Esc), **Allow once** and **Allow for this
  run**.
- "Allow for this run" grants that exact command text, for any agent, until the
  run ends. A different command, even a slightly changed one, asks again.
- Next to the button: "It will run again without asking, even if the agent
  changes what it runs (for example `package.json` scripts)."
- **State:** `commandConsentStore` keeps grants per run.
  - `request()` resolves with a granted command right away, without queueing.
  - `denyRun(runId)` also clears the run's grants.
- **Audit:** entries say whether a command was approved once, ran under a
  run-wide grant, or was denied.

### Kill on Stop

- **Rust registry:** `execute_command` takes an optional `command_id` and keeps a
  map from id to process id while the command runs; the entry is removed when it
  ends.
- **`cancel_command(command_id) -> bool`:** kills the whole process tree.
  - Windows: `taskkill /T /F`, as the timeout path does.
  - Elsewhere: the command starts with `process_group(0)` and the group is killed.
    This path is untested here.
- **TS side:** `commandTool` creates the id from the run id plus a counter.
  - **Stop:** when the wait fails because the run was stopped, it calls
    `cancel_command` (ignoring errors, e.g. in the VS Code shim), logs "stopped"
    and rethrows.
  - **Run end:** the hook tracks each run's active command ids and cancels any
    that are still running when the run ends, for example when another node
    failed.
    - *Implementation note:* not needed and not built. `runParallel` only
      settles after in-flight nodes finish, so a run cannot end while its
      command runs; Stop is the only case that kills.

## 3. Live streaming (native tool-calling turns)

### Rust

- `chat_turn` gets an optional `on_delta: Channel<ChatDelta>`, where
  `ChatDelta = { text }`. Without it, behavior is unchanged: the offline bridge,
  the VS Code extension and existing tests are unaffected.
- With it, the request uses the provider's streaming API. The body is read with
  `reqwest::Response::chunk()` (no new crates), each piece of text is sent to the
  channel, and the same `ChatReply` is built. Parsing is pure code over byte
  chunks in a new `chat_stream.rs`, which buffers until a full line (and full
  UTF-8 characters) is available:
  - **OpenAI-compatible:** SSE `data:` lines and `[DONE]`. Tool calls are
    assembled by index from their id, name and argument fragments. The finish
    reason comes from the last choice.
  - **Anthropic:** SSE events. Text comes from `text_delta`; `tool_use` blocks
    take their input from `input_json_delta` pieces; `stop_reason` comes from
    `message_delta`.
  - **Ollama:** one JSON object per line; tool calls arrive whole; `done_reason`
    marks the end.
- The existing refusal handling (tools unsupported → text protocol) applies to
  the streaming request too.

### Fallback

If a streaming request fails before any text arrives, and the error mentions
streaming, the turn is retried without streaming. That provider/model stops
streaming for the rest of the run (`noStreaming`, like `noNativeTools`).

### TS

- `callChatTurn(params, invoke, onDelta?)` creates a `Channel` when `onDelta` is
  given. The test mock (`mockTauri.ts`) gains a `Channel` class whose
  `onmessage` handlers can call.
- The hook shows the current turn's text as the node's output, throttled to about
  one update every 50 ms. When the node finishes, the final text is set once.
- The simulated typing is removed for nodes whose final turn streamed. The
  text-protocol path keeps it.
- Helpers started with `subagent_dispatch` don't stream: their reports appear when
  they finish, as now.

## 4. Long runs: compaction and AGENTS.md

### Compaction (`src/services/execution/compaction.ts`, pure functions with an injected `summarize`)

- **When:** before each model call in `agentLoop`, if system + conversation is
  estimated (characters ÷ 4) above 75% of the node's **Token budget**. That's the
  existing Role-tab setting, which has had no effect at run time until now. A
  missing or zero budget turns compaction off.
- **How:** one `summarize` call (same provider and model, no tools) turns the older
  steps into a specific progress note: task, findings, files changed, command
  results, what remains.
- **Native mode:** the conversation becomes the original user message plus the
  note, then the most recent assistant tool-call turn and its tool results
  verbatim. It starts with a user message and every tool call keeps its results,
  so the history stays valid for every provider.
- **Text mode:** the accumulated step log becomes the task, the note and the last
  step.
- **Still too large:** if the kept tool results alone are still over the budget,
  their middle is cut with a marker.
- **Cost:** the note call doesn't count as a step but runs under the node's
  deadline.
- **Audit:** "↻ {agent}: compacted N earlier steps (~X → ~Y tokens)".

### AGENTS.md

- At run start, with a workspace open, `AGENTS.md` at the workspace root is read
  once, capped at 32 KB with a truncation note. A missing file means no
  instructions, and loading is logged in the audit.
- It is appended to the system message as `PROJECT INSTRUCTIONS (AGENTS.md):` for
  agents with at least one workspace tool (`read_file`, `fs.read`, `list_files`,
  `grep`, `fs.write`, `fs.append`, `edit_file`, `bash`), and for their helpers
  that have one. `buildSystemMessage` gains an optional `projectInstructions`
  field.

## Error handling summary

- Tool-level problems become `[error]` tool results the model can react to:
  edit mismatches, a denied command, a failed start.
- Run-level problems keep today's behavior: timeouts, Stop, provider errors.
- New failure paths:
  - Streaming errors fall back once to non-streaming.
  - A failed compaction call is audited, and the run continues uncompacted until
    the next check.
  - Revert conflicts ask the user first.

## Testing

Each section is built test-first (red, then green).

| Area | Tests |
|---|---|
| `edit_file` | unique match, not found, several matches, `replace_all`, CRLF, missing file, no-op edit |
| Change log | first `before` / last `after`; agents merged; helper edits recorded; path normalization |
| Revert | restore, delete a created file, conflict prompt; Rust delete refuses traversal and folders |
| Changes dialog | renders files and counts, and opens the diff (Monaco mocked in jsdom) |
| Approvals | run grant skips the prompt for the same text only; the next run asks again; dialog buttons and warning; audit wording |
| Kill | Rust cancel ends a long `ping` within about 2 s; unknown id is a no-op; registry cleanup. TS: Stop and run end call `cancel_command` |
| Streaming | Rust parsers against recorded chunks per provider (text, fragmented tool calls, split lines and characters) equal the non-streaming parse; one mock-server end-to-end test; TS live output, final output set once, fallback remembered |
| Compaction | triggers above the threshold only; valid rebuilt history; summarize input; text mode; oversized results cut; loop completes |
| AGENTS.md | tool agents get it, tool-less agents don't; missing file; cap |

**Verification:** `npx tsc --noEmit`, `npx vitest run`, `cargo test`,
`npm run build`, then the free-endpoint smoke test.

## Delivery

- **Where:** one PR from `claude/coding-core`, based on `claude/command-approval`.
  Retarget it as #6 and #7 merge.
- **Commits:** one per section, each green:
  1. Edits and change log
  2. Commands
  3. Streaming
  4. Compaction and `AGENTS.md`
  5. Docs and smoke-test evidence
- **Docs:** README, USER_MANUAL, ARCHITECTURE, SECURITY, DEPLOYMENT_READINESS,
  CHANGELOG and DEVELOPMENT_LOG are updated with the final behavior and limits.
