# Headless + CI, Part 5: CI, Template, Docs and Live Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give this repository its first CI, give users a GitHub Actions template for `harness run`, document headless runs, and prove the whole path live: the real `harness run`, the real `harness-core` and a real model, including a resume.

**Architecture:**
- **CI** (`.github/workflows/ci.yml`, `ubuntu-latest`, on push to master and on pull requests) runs:
  - types and the TypeScript tests, including the fake-core end-to-end test;
  - the Rust tests with Tauri, and again without Tauri (the core build);
  - the CLI bundle build and a real-core `harness run` preflight check.
- The Rust process tests have been Windows-only until now. They become platform-aware, so Linux CI runs them and covers the `sh` path and the process-group kill for the first time.
- **The template** (`examples/ci/harness-run.yml`) checks out the user's repository and Harness Studio side by side, builds the bundle and the core (no Tauri packages), runs a workflow with keys from secrets, and uploads the run record.

**Tech Stack:** GitHub Actions, Rust, Node 22, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-25-headless-ci-design.md` §4 (Repo CI, Template, Guide), Testing, Verification.

---

## Design decisions

1. **The repo CI uses the debug `harness-core`** that `cargo test --no-default-features --features core` already builds, so it skips a second, release build. The template builds release (`npm run build:core`), as users will.
2. **CI's real-core check** runs `harness run` with `--provider openai` and no key: the run must stop at the preflight with exit 3 and a `not_started` event. This proves the Linux core and the bundle work together without calling a model.
3. **Platform-aware Rust tests.**
   - A test helper `shell(windows, unix)` picks `cmd.exe /C …` or `sh -c …`.
   - Tests that run `execute_command` pick the command line by `cfg!`.
   - The hook tests use `hook.bat` on Windows and `hook.sh` elsewhere (`.sh` runs with bash).
   - Only the network-share test stays Windows-only.
   - A Unix symlink twin of the junction test covers the same safe-path rule.
4. **Live smoke:** a scratch workspace with synthetic data only, and the free keyless endpoint (`--provider openai-compatible --base-url https://text.pollinations.ai/openai --model openai`).
   - **First run.** A Coder fixes a one-line bug and runs `node --test`, allowed with `--allow-command`. A Reviewer has a 1-second timeout, so it fails: exit 1.
   - **Second run.** Raise the Reviewer's timeout (its definition changes; the Coder's does not) and `--resume` the run. The Coder must be reused with no model call, and the run exits 0.
   - The evidence goes into DEVELOPMENT_LOG and DEPLOYMENT_READINESS.

---

### Task 1: Rust tests on every platform

**Files:** `src-tauri/src/commands/process_commands.rs` (tests), `src-tauri/src/commands/fs_commands.rs` (tests)

- [ ] **Step 1: The shell helper and the direct `run_command_with_timeout` tests**

In `process_commands.rs`'s test module, add after `use tempfile::tempdir;`:

```rust
    /// The platform's shell running a line: cmd.exe /C on Windows, sh -c elsewhere.
    fn shell(windows: &str, unix: &str) -> (&'static str, Vec<String>) {
        if cfg!(target_os = "windows") {
            ("cmd.exe", vec!["/C".to_string(), windows.to_string()])
        } else {
            ("sh", vec!["-c".to_string(), unix.to_string()])
        }
    }
```

In these five tests, replace the hard-coded `"cmd.exe", &[…]` with `let (program, args) = shell(…)` and `run_command_with_timeout(program, &args, …)`:
- `run_hook_passes_custom_environment`: `shell("echo %PHASE4_MODE%", "echo $PHASE4_MODE")`;
- `child_processes_do_not_inherit_provider_api_keys`: `shell("echo key=%OLLAMA_REMOTE_API_KEY%", "echo key=$OLLAMA_REMOTE_API_KEY")`;
- `run_command_collects_more_than_a_pipe_buffer_of_output`: `shell("for /L %i in (1,1,3000) do @echo 0123456789012345678901234567890123456789", "i=0; while [ $i -lt 3000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done")`;
- `run_command_returns_when_a_background_grandchild_keeps_the_pipes_open`: `shell("start /b ping -n 8 127.0.0.1 >nul & echo done", "sleep 8 & echo done")`;
- `run_hook_enforces_timeout`: `shell("ping -n 4 127.0.0.1 > nul", "sleep 4")`.

- [ ] **Step 2: Windows-only tests become platform-aware**

Remove `#[cfg(target_os = "windows")]` from these tests and pick the platform's version:

- `execute_hook_runs_a_batch_hook_with_consent` → rename it `execute_hook_runs_a_hook_with_consent`:
  ```rust
          let (file, script) = if cfg!(target_os = "windows") { ("hook.bat", "@echo hook-ran") } else { ("hook.sh", "echo hook-ran") };
          fs::write(dir.path().join(file), script).unwrap();
  ```
  Pass `file.to_string()` as the hook path.
- `execute_hook_honours_the_node_timeout`:
  ```rust
          let (file, script) = if cfg!(target_os = "windows") { ("slow.bat", "@ping -n 8 127.0.0.1 >nul") } else { ("slow.sh", "sleep 8") };
  ```
- `execute_command_stops_at_the_time_limit`: the line is `if cfg!(target_os = "windows") { "ping -n 8 127.0.0.1 >nul" } else { "sleep 8" }`.
- `agent_commands_do_not_inherit_provider_api_keys`: the line is `if cfg!(target_os = "windows") { "echo key=%OLLAMA_REMOTE_API_KEY%" } else { "echo key=$OLLAMA_REMOTE_API_KEY" }`.
- `cancel_command_kills_a_running_command`: `if cfg!(target_os = "windows") { "ping -n 30 127.0.0.1 >nul" } else { "sleep 30" }`.

`commands_do_not_run_in_a_network_folder` stays Windows-only.

- [ ] **Step 3: The symlink twin** — in `fs_commands.rs`, after the junction test:

```rust
    #[cfg(unix)]
    #[test]
    fn resolve_safe_path_rejects_new_files_under_a_symlink_leading_outside() {
        let ws = temp_workspace();
        let outside = temp_workspace();
        std::os::unix::fs::symlink(outside.path(), ws.path().join("link")).unwrap();

        let root = ws.path().to_str().unwrap();
        assert!(matches!(resolve_safe_path(root, "link/new.txt"), Err(AppError::PathTraversal(_))));
        assert!(matches!(
            resolve_safe_path(root, "link/deep/nested/new.txt"),
            Err(AppError::PathTraversal(_))
        ));
    }
```

- [ ] **Step 4:** Run `cd src-tauri && cargo test && cargo test --no-default-features --features core && cargo check 2>&1 | grep -c "^warning"`. Expected: on Windows, all pass (95 in the library), with 0 warnings. The Unix branches compile and run on Linux in CI (Task 2).

- [ ] **Step 5: Commit:** `git add src-tauri/src/commands && git commit -m "Rust tests run on every platform: cmd.exe on Windows, sh elsewhere"`

---

### Task 2: This repository's CI

**File:** create `.github/workflows/ci.yml`

```yaml
# Every push to master and every pull request, on Linux: types, the TypeScript
# tests (with harness run end to end against a fake harness-core), the Rust tests
# with Tauri and without it, and harness run against the real harness-core.
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Tauri's Linux build packages
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
            libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run

      - name: Rust tests (the app)
        run: cargo test --manifest-path src-tauri/Cargo.toml

      - name: Rust tests (harness-core, without Tauri)
        run: cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features core

      - name: harness run with the real harness-core
        # No key for the chosen provider: the run must stop at the preflight (exit 3).
        run: |
          npm run build:cli
          set +e
          OPENAI_API_KEY= HARNESS_CORE=src-tauri/target/debug/harness-core \
            node cli/harness.mjs run examples/purchasing-decision.harness.yaml \
            --task "Pick a laptop" --provider openai --json > events.jsonl
          code=$?
          set -e
          cat events.jsonl
          test "$code" -eq 3
          grep -q '"not_started"' events.jsonl
```

- [ ] **Step 1:** Write the file. Check that it parses: `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"`.
- [ ] **Step 2:** Check the real-core step locally (Git Bash, debug core):

```bash
cd src-tauri && cargo build --no-default-features --features core --bin harness-core && cd ..
OPENAI_API_KEY= HARNESS_CORE=src-tauri/target/debug/harness-core.exe node cli/harness.mjs run examples/purchasing-decision.harness.yaml --task "Pick a laptop" --provider openai --json; echo "exit $?"
```

Expected: a `not_started` event and `exit 3`.
- [ ] **Step 3: Commit:** `git add .github/workflows/ci.yml && git commit -m "Add CI: types, TypeScript and Rust tests (with and without Tauri), harness run"`

---

### Task 3: The `harness run` template for other repositories

**File:** create `examples/ci/harness-run.yml`

```yaml
# Run a Harness Studio workflow in GitHub Actions (docs/HEADLESS.md in Harness Studio).
#
# Copy this file to .github/workflows/ in the repository the agents should work
# on, then set the workflow file, the task and the commands the agents may run.
# Keys come from repository secrets: harness run reads them from the environment
# and never takes them as flags.
name: Harness run

on:
  workflow_dispatch:
  pull_request:

jobs:
  harness:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: This repository (the agents' workspace)
        uses: actions/checkout@v4
        with:
          path: project

      - name: Harness Studio (to build harness run)
        uses: actions/checkout@v4
        with:
          repository: KulkulZa1/visualized-ai-agent-designer
          path: harness-studio

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: harness-studio/src-tauri

      - name: Build harness run and harness-core
        # harness-core is built without Tauri, so no WebKit or GTK packages are needed.
        working-directory: harness-studio
        run: |
          npm ci
          npm run build:cli
          npm run build:core

      # Install what the allowed commands need, for example:
      # - run: npm ci
      #   working-directory: project

      - name: Run the workflow
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: >
          node harness-studio/cli/harness.mjs run project/.harness/review.harness.yaml
          --workspace project
          --task "Review the changes in this pull request and list the problems you find."
          --allow-command "npm test"
          --json > harness-events.jsonl

      - name: Keep the run record and the events
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: harness-run
          path: |
            project/.harness/runs/
            harness-events.jsonl
```

- [ ] **Step 1:** Write the file and check that it parses (as in Task 2).
- [ ] **Step 2: Commit:** `git add examples/ci/harness-run.yml && git commit -m "Add a GitHub Actions template for harness run"`

---

### Task 4: `docs/HEADLESS.md` and the docs pass

- [ ] **Step 1: `docs/HEADLESS.md`**, with these sections and facts:
  1. **What it is:** `harness run` runs a workflow without the app, as `codex exec` runs Codex.
     - It uses the app's engine (`src/engine/runWorkflow.ts`).
     - The Rust commands come from `harness-core`, the app's commands built without Tauri, over JSON lines on stdin/stdout (`src-tauri/src/commands/core_server.rs`).
  2. **Build:** `npm ci`, `npm run build:cli` (→ `cli/dist/harness-run.mjs`) and `npm run build:core` (→ `src-tauri/target/release/harness-core[.exe]`). No Tauri packages are needed.
  3. **Run:** the usage line and an options table matching `RUN_USAGE`, with examples for Ollama, OpenAI and an OpenAI-compatible endpoint.
  4. **Keys:** only from environment variables.
     - harness-core reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY` and `OLLAMA_REMOTE_API_KEY` itself.
     - `HARNESS_CUSTOM_API_KEY` is for `openai-compatible`.
     - There is no key flag, and the run record never contains keys.
  5. **Providers:** `--provider` (default `auto`, plus `LLM_PROVIDER`, `OLLAMA_BASE_URL` and `OLLAMA_MODEL` from the environment).
     - `--base-url` and `--model` apply to Ollama and OpenAI-compatible endpoints only. Hosted providers keep each agent's model.
  6. **Agent commands:** denied unless passed exactly with `--allow-command`, which is repeatable and trimmed.
     - The audit reads "allowed by --allow-command" or "denied (not in --allow-command)".
     - The engine's checks still apply: one line, no control or invisible characters, at most 2000 characters, and a workspace.
     - Commands are not sandboxed, and they run without the provider keys.
  7. **Hooks:** Hook nodes run their scripts as in the app. `requireConsent` hooks fail the run.
  8. **Output:** the readable lines (an example), then the `--json` events and their fields:
     - `run_started`, `node_started`, `node_finished` (full output, `reused`), `command`, `revision`, `compaction`, `reused`, `audit`, and `run_finished` (agents, changes, outputs, `trace`);
     - the provider preflight's `audit` events can come before `run_started`;
     - a run that didn't start ends with `run_finished` and `status: "not_started"`.
  9. **Exit codes:**
     - `0` done;
     - `1` an agent failed;
     - `2` bad usage, a missing file, an invalid workflow, or a resume that can't be done;
     - `3` harness-core missing or dead, or a failed preflight;
     - `130` stopped with Ctrl+C.
  10. **Stop:** Ctrl+C once stops the run (the audit and the record say `cancelled`; `harness-core` ignores Ctrl+C so the run can finish and save). A second Ctrl+C exits at once.
  11. **Run records and resume:**
      - The record lives at `.harness/runs/<runId>/run.json`, and the app saves one too when a workspace is open. Ignore the folder in git.
      - It holds each node's status, output, times, model, `definitionHash`, and the outputs, memory, routes, changes and audit.
      - `--resume <runId>` keeps the run id and the task. A node is reused if it is done, unchanged, and fed only by reused nodes.
      - These are exit 2: a different `--task`, another workflow, or an unknown id.
  12. **CI:** the template `examples/ci/harness-run.yml` (what it does, the secrets, the artifact), and this repository's own `ci.yml`.
  13. **Limits:**
      - There is no live token streaming.
      - On Windows, Ctrl+C was checked by hand, not in CI.
      - There is no sandbox.
      - There are no prebuilt binaries.
      - There is no Resume button in the app.
  14. **Troubleshooting:**
      - "harness-core not found" means building it, or `--core` / `HARNESS_CORE`.
      - "No API key … Add one in Settings" means setting the environment variable.
      - Free endpoints are slow (about 30 s per call) and return 429s, so raise node timeouts.
- [ ] **Step 2: Docs pass**:
  - **`AGENT.md`**:
    - The Verified Baseline gets the new counts and rows: `cargo test` with and without Tauri, `npm run build:core`, `npm run build:cli`, `harness run` (live) and CI.
    - What Works gets headless runs and run records.
    - Honest Limitations says run records exist but hold outputs and the audit, not full provider requests, plus the `harness run` limits.
    - Key Files gets `src/cli/runCli.ts`, `src/engine/runRecord.ts` and `src-tauri/src/commands/core_server.rs`.
    - Next Best Work drops "Wire real GitHub Actions CI" and rewords the artifacts item.
  - **`README.md`** covers `harness run` in the status, features and Real vs Mock rows, plus how to build and run it.
  - **`docs/ARCHITECTURE.md`** gets the headless runner (engine + CLI + harness-core).
  - **`docs/DEPLOYMENT_READINESS.md`** gets rows for `harness run`, harness-core, run records and CI with their evidence. The "run-level persisted records" gap is updated.
  - **`docs/VS_CODE_EXTENSION_PLAN.md`** notes that the engine now lives outside the hook (`src/engine/runWorkflow.ts`).
  - **`CHANGELOG.md`** gets an entry.
- [ ] **Step 3: Commit:** `git add docs AGENT.md README.md CHANGELOG.md && git commit -m "Document headless runs: docs/HEADLESS.md and the docs pass"`

---

### Task 5: Live smoke

**Scratch only** (the session scratchpad; never the repo). Synthetic data only.

- [ ] **Step 1: Workspace** — `live-ws/` with:
  - `sum.mjs`: `export function sum(a, b) { return a - b; }`;
  - `sum.test.mjs`: a `node:test` check that `sum(2, 3) === 5`;
  - `AGENTS.md`: "Run the tests with `node --test`.";
  - `fix.harness.yaml`, with two agents, Coder → Reviewer:
    - **Coder:** a worker with `read_file`, `fs.write` and `bash`, `maxSteps: 8`, `timeoutSeconds: 600`. Prompt: fix the bug with `edit_file`, run `node --test` with bash, report.
    - **Reviewer:** a critic with no tools and `timeoutSeconds: 1`. Prompt: summarize what was wrong and whether the tests pass.
- [ ] **Step 2: First run** (expect exit 1, because the Reviewer times out):

```bash
node cli/harness.mjs run <ws>/fix.harness.yaml --workspace <ws> --task "Make the tests pass." \
  --provider openai-compatible --base-url https://text.pollinations.ai/openai --model openai \
  --allow-command "node --test" --json > <ws>/run1.jsonl
```

Check:
- `sum.mjs` now adds;
- a `command` event with `allowed by --allow-command; exit 0`;
- the Coder's `node_finished` is `done`;
- the Reviewer's `node_finished` is `error` (timed out);
- `run_finished` has a `trace`.

- [ ] **Step 3: Second run.** Set the Reviewer's `timeoutSeconds` to 300 in the YAML, then run `… --resume <runId> --json > <ws>/run2.jsonl`. Expect:
  - exit 0;
  - a `reused` event for the Coder, and no `node_started` for the Coder;
  - the Reviewer done;
  - `run.json` with `attempts: 2` and `status: done`.
- [ ] **Step 4:** Record the evidence (commands, exit codes, key events and times) in `docs/DEVELOPMENT_LOG.md` and the DEPLOYMENT_READINESS evidence column. Commit: `git add docs && git commit -m "Record the harness run live smoke: a real model, a fix, a resume"`

---

### Task 6: Final verification and finishing

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run && npm run build`, and in `src-tauri`, `cargo test` and `cargo test --no-default-features --features core`. All must pass.
- [ ] **Step 2:** Advisor review of the whole branch.
- [ ] **Step 3:** superpowers:finishing-a-development-branch: push `claude/headless-ci` and open the PR. CI then runs on Linux for the first time; read its result, and fix any Linux-only failure before calling the branch done.

## Spec coverage (Part 5)

| Spec requirement | Where |
|---|---|
| Repo CI: npm ci, tsc, vitest, cargo test with Tauri's Linux packages, core build, build:cli, CLI e2e with the fake core | Task 2 (the e2e is inside `vitest run`); Task 1 makes the Rust tests platform-aware |
| Template: checkout, setup-node, Rust toolchain with caching, npm ci, build:cli, build:core, `harness run … --json --allow-command "npm test"` with secrets, upload `.harness/runs/` | Task 3 |
| `docs/HEADLESS.md`: usage, keys, command policy, exit codes, resume, CI | Task 4 |
| Live smoke: real `harness run` + real `harness-core` + free endpoint, including a resume | Task 5 |
| First GitHub Actions run checks the Linux build | Task 6, Step 3 |
