# Headless Runs + CI — Design

Date: 2026-09-25 · Branch: `claude/headless-ci` (from master `34a2ee5`)

## Goal

Run a workflow without the desktop app, the way `codex exec` runs Codex: a
`harness run` command for CI servers (Linux, no desktop, API keys from secrets).
Runs are saved, so they can be inspected and resumed.

**Decisions (from the user):**
- **Where:** CI servers first (Linux, no display).
- **Shell commands:** denied unless allowed up front with an exact-match
  `--allow-command` flag.
- **Resume:** node-level; finished nodes keep their saved output.
- **Approach 1:** one shared TypeScript engine, plus the app's Rust code as a
  Tauri-free `harness-core` helper binary for model calls, files and commands.
- **Repo CI:** this repo also gets its own CI workflow.

## Non-goals

These are out of scope:
- A Resume button or a run browser in the app
- Live token streaming in CLI output
- Resuming inside a node's conversation
- A Codex node
- Git worktrees and PRs
- MCP client tools
- Windows or macOS CI runners
- Publishing prebuilt `harness-core` binaries

## 1. One engine for the app and the CLI

- **New module:** `src/engine/runWorkflow.ts`, plain TypeScript with no React,
  no UI stores and no Tauri imports. It exposes `runWorkflow(input, host):
  Promise<RunOutcome>`.
  - `input`:
    - the graph (nodes, edges, meta, executionSettings)
    - the run config (task, context files, overrides)
    - the provider settings (provider, URLs, models, keys the app holds)
    - `workspacePath` and `continueOnError`
    - the saved run to resume from, if any
  - `host`:
    - `invoke(cmd, args)`: the Rust commands.
    - `events`: `onRunStarted`, `onAgentUpdate(nodeId, partial)`,
      `onNodeStatus(nodeId, status)` for the canvas, `onAudit(entry)`,
      `onFileChange(...)`, `onRunFinished`.
    - `askCommand(request) → Promise<CommandApproval>`: the approval policy.
    - `isCancelled()`.
    - `saveRun(record)`.
    - `snapshot?` (optional): the app's context snapshots.
- **The React hook becomes an adapter.** It builds `input` from the stores and a
  `host` that updates the stores, uses the approval dialog and writes snapshots.
  App behavior does not change: the existing hook tests pass unmodified.
- **`defToGraph(def)`:** the conversion from a saved workflow to a graph, today
  inside `workflowStore.loadWorkflow`, becomes a pure function in
  `src/engine/workflowGraph.ts` that the store and the CLI share.
- **Refactor, not rewrite:** the engine body is the existing code moved, with
  store reads and writes replaced by `input` and `host`. The scheduler, agent
  loop, tools, compaction and routing modules are unchanged.

## 2. `harness-core` (Rust, no Tauri)

- **Cargo:**
  - `tauri` and every `tauri-plugin-*` become optional dependencies of a default
    `app` feature; `tauri-build` becomes an optional build dependency.
  - `build.rs` runs `tauri_build::build()` only when `CARGO_FEATURE_APP` is set.
  - A `core` feature builds the helper.
  - The desktop binary has `required-features = ["app"]`. The `harness-core`
    binary (`src/bin/harness-core.rs`) has `required-features = ["core"]`, so
    `tauri build` doesn't build it.
- **Gating:**
  - Every command function gets `#[cfg_attr(feature = "app", tauri::command)]`
    (`(async)` where it has it today).
  - `open_workspace_dialog`, the Tauri `chat_turn` wrapper and `lib.rs run()`
    are `#[cfg(feature = "app")]`.
- **Server:** `commands/core_server.rs` reads JSON lines from stdin and writes
  responses to stdout.
  - Request: `{"id":N,"cmd":"…","args":{…}}`, with the same camelCase arguments
    the app sends through `invoke`.
  - Response: `{"id":N,"ok":…}` or `{"id":N,"err":"…"}`.
  - Each request runs as its own task, and blocking commands run on
    `spawn_blocking`. Responses are matched by id and may come in any order.
  - Logs go to stderr. At end of input the server finishes in-flight requests
    and exits.
- **Commands served:**
  - Model calls: `chat_turn` (via `run_turn`, not streaming), `call_openai_api`,
    `call_anthropic_api`, `call_claude_api` (the alias `callProvider` uses for
    Anthropic), `call_ollama_api`.
  - Provider info: `check_provider_health`, `get_provider_defaults`.
  - Workspace files: `read_workspace_file`, `write_workspace_file`,
    `delete_workspace_file`, `list_workspace_files`.
  - Other: `write_audit_entry`, `execute_hook`, `execute_command`,
    `cancel_command`.
  - Anything else gets `err: "Unknown command: X"`.
- **Safety:** these are the same functions the app uses, so the same
  protections apply: `resolve_safe_path`, no provider keys in child processes,
  the consent flag enforced in Rust, killing the whole command process tree.
- **Build:** `npm run build:core` runs
  `cargo build --release --manifest-path src-tauri/Cargo.toml --no-default-features --features core --bin harness-core`.
- **Implementation note (Part 1 review):** each command's arguments get a
  camelCase `Deserialize` struct, tested against the exact JSON the
  TypeScript side builds. That includes `chat_turn`'s `onDelta: null`, which is
  what a CLI run sends.

## 3. `harness run`

- **Usage:** `node cli/harness.mjs run <workflow.harness.yaml>` (also
  `npm run harness -- run …`).
  - The task: `--task "…"` or `--task-file <path>`. Required unless `--resume`
    is given.
  - `--workspace <dir>`: default is the current folder. Agents' file tools and
    commands are confined to it.
  - `--provider auto|openai|anthropic|ollama|ollama-cloud|openai-compatible`:
    default `auto`, as in the app.
    - `--base-url`: the custom or Ollama endpoint.
    - `--model`: the model for `openai-compatible` and Ollama. Hosted providers
      keep each node's model.
  - `--max-parallel N` and `--continue-on-error`: override the workflow's
    settings.
  - `--json`, `--resume <runId>`, and `--core <path>` or `HARNESS_CORE`.
- **Keys:** environment variables only: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `OLLAMA_API_KEY`, `OLLAMA_REMOTE_API_KEY`, and `HARNESS_CUSTOM_API_KEY` for
  `openai-compatible`. There is no key flag.
- **Command policy:** repeatable `--allow-command "<exact command line>"`.
  - A command that matches exactly after trimming resolves `"granted"`: it runs
    without a prompt, and the audit reads "allowed by --allow-command".
  - Anything else resolves `"deny"`, and the audit reads "denied (not in
    --allow-command)".
  - The engine's existing checks still apply: control and invisible
    characters, the 2000-character cap, the workspace requirement.
- **Output:**
  - Default: one line per event:
    - `▶ <agent> started (<model> via <provider>)`
    - `$ <command> → exit N (allowed)` or `… denied`
    - `↺ revision`, `↻ compacted`
    - `✓ <agent> done (12.3 s)` or `✗ <agent> failed: …`
  - At the end, a summary: status, elapsed time, each node's status,
    changed files, the final output of the nodes with no successors, and the
    run id and trace path.
  - `--json`: one JSON object per line (`run_started`, `node_started`,
    `node_finished` with the full output, `command`, `revision`, `compaction`,
    `audit`, `run_finished` with the summary), and nothing else on stdout.
- **Exit codes:**
  - `0`: done.
  - `1`: finished with a failed node.
  - `2`: bad usage, an invalid workflow, or a resume that can't be done.
  - `3`: couldn't start (`harness-core` missing or dead, provider preflight
    failed).
  - `130`: interrupted.
- **Ctrl+C:** the first one works like Stop: `host.isCancelled()` becomes true,
  pending approvals are denied, running commands are killed, and the run is
  saved as `cancelled`, so it can be resumed. A second one exits immediately.
- **Bundle:** `npm run build:cli` runs `vite build --ssr src/cli/runCli.ts`
  (no new dependency) to produce `cli/dist/harness-run.mjs`. The `run`
  subcommand of `cli/harness.mjs` loads it; the existing read-only commands
  are unchanged.
- **Core client:** `src/cli/coreClient.ts` starts `harness-core` and turns
  `invoke` into request/response over its pipes. If the process dies, pending
  calls reject with "harness-core stopped".
- **Implementation notes (Part 1 review):**
  - The engine still reaches Tauri through `providerAdapter.ts`, which imports
    `Channel`. The CLI's Vite build aliases `@tauri-apps/api/core` to a small
    Node shim whose `Channel` throws. `deltaChannel` then sends
    `onDelta: null`, so there is no streaming.
  - The end-to-end test runs the built `cli/dist/harness-run.mjs` with `node`.
    That is the only check that the bundle loads in Node.
  - The engine's simulated typing (the app's progressive reveal) costs about
    0.5–1 s per node. A host option lets the CLI skip it.

## 4. Saved runs, resume, CI

- **Record:** `<workspace>/.harness/runs/<runId>/run.json`. It is written
  through `host.saveRun`, atomically (`write_workspace_file` uses
  `atomic_write`), at run start, after every node settles, and at run end.
  - Run: `version`, `runId`, workflow `{ name, path, hash }` (SHA-256 of the
    YAML text), `task`, provider settings without keys, `status`, times,
    `attempts`.
  - Per node: `status`, `output`, `error`, times, `modelUsed`/`providerUsed`,
    `tokenEstimate`, `revision`, `subAgents` (name, status, task, report),
    `definitionHash` (prompt source and content, model, tools, role, max
    steps, timeout).
  - Resume state: `memory` (key → value), `gatewayRoutes`, `changes` (the change
    log), and `audit` (the run's audit entries).
- **Who saves:** the CLI saves with the workspace path. The app saves when a
  workspace is open, which closes the "no persisted run traces" gap. This
  repo's `.gitignore` gets `.harness/runs/`, and the docs tell users to ignore
  it too, like `.harness/snapshots/`.
  - Implementation notes (Part 4):
    - Nodes are keyed by their place in the workflow file (`agent-<i>`), so a
      run in the app and a run of the saved file name the same node alike.
    - The resume state also keeps `outputs`: the text each node passes
      downstream. For a memory node, that differs from its shown output.
    - `definitionHash` also covers max tokens, think depth, the memory keys and
      a hook node's hook. For a file prompt, the file's content is hashed.
    - `harness-core` ignores Ctrl+C, which reaches it along with `harness run`
      (same console or process group). The CLI turns Ctrl+C into Stop, and it
      needs the core to finish the run and save it.
- **Resume:** `harness run <workflow> --resume <runId>` loads the record and
  keeps the same run id (`attempts` + 1). It uses the saved task; passing
  `--task` with a different task is exit 2. A node is reused (not run) only if
  all of these hold:
  - its saved status is `done`,
  - its `definitionHash` matches the current definition,
  - every forward predecessor is reused.

  Reused nodes get their saved output, revision and helper records, and the
  scheduler treats them as finished. Memory, gateway routes and the change log
  are restored. All other nodes run normally, so a changed node re-runs
  together with everything downstream. A record whose workflow name differs,
  or a run id that isn't found, is exit 2.
- **Repo CI:** `.github/workflows/ci.yml`, on `ubuntu-latest`, for push and
  pull requests:
  - `npm ci`, `npx tsc --noEmit`, `npx vitest run`
  - `cargo test` after installing Tauri's Linux packages
  - `cargo build --no-default-features --features core --bin harness-core`
  - `npm run build:cli` and the CLI end-to-end test with the fake core
- **Template:** `examples/ci/harness-run.yml`, a workflow for users to copy:
  - checkout, `setup-node` and a Rust toolchain with caching
  - `npm ci`, `npm run build:cli`, `npm run build:core`
  - `harness run … --json --allow-command "npm test"`, with keys from
    `secrets.*`
  - upload `.harness/runs/` as an artifact
- **Guide:** `docs/HEADLESS.md` covers usage, keys, the command policy, exit
  codes, resume and CI.

## Error handling

- A missing or dead `harness-core`, or an invalid workflow, gives a clear
  message and exit 3 or 2 before any model call.
- A failed provider preflight is exit 3.
- Node failures follow `continueOnError` as in the app (exit 1).
- A failing `saveRun` is reported once, but the run continues: losing the
  trace must not lose the work.

## Testing

| Area | Tests |
|---|---|
| Engine extraction | the existing hook tests pass unchanged; engine unit tests with a fake host (events, `askCommand`, `saveRun` calls) |
| `defToGraph` | round trip with `toWorkflowDef` on the bundled examples |
| `core_server` | dispatch of a known command, unknown command, error mapping, concurrent requests answered by id; `cargo check --no-default-features --features core` |
| CLI | argument parsing, allowlist policy, exit-code mapping, JSON events; end-to-end run of the built CLI against a fake core (Node script, canned replies) including a denied command, a failing node (exit 1) and a resume |
| Saved runs | a record written after each node; resume reuse rule (unchanged, changed node, changed upstream, errored or stopped node); app run resumed by the CLI |

**Verification:**
- `npx tsc --noEmit`, `npx vitest run`, `cargo test` and `npm run build`.
- `cargo check --no-default-features --features core`, plus building the core
  binary on Windows.
- A live smoke test: the real `harness run` with the real `harness-core`
  against the free endpoint, including a resume.
- The first GitHub Actions run checks the Linux build.

## Delivery

- **Where:** one PR from `claude/headless-ci` to master.
- **Parts:** built in order, each with its own plan and green commit(s):
  1. Engine extraction and `defToGraph`
  2. `harness-core`
  3. `harness run`
  4. Saved runs and resume
  5. CI, the template, docs and the live smoke test
