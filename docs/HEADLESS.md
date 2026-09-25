# Headless runs: `harness run`

`harness run` runs a workflow without the desktop app, the way `codex exec` runs
Codex: in a terminal or on a CI server. Keys come from the environment, agent
shell commands run only if you allow them up front, and every run is saved so
you can look at it later or resume it.

It uses the app's own run engine (`src/engine/runWorkflow.ts`), so a workflow
behaves the same in both. The model calls, workspace files and commands go
through `harness-core`: the app's Rust commands, built without Tauri, which
`harness run` starts and talks to over its stdin and stdout
(`src-tauri/src/commands/core_server.rs`).

## Build

```bash
npm ci
npm run build:cli    # cli/dist/harness-run.mjs
npm run build:core   # src-tauri/target/release/harness-core (.exe on Windows)
```

`harness-core` is built without Tauri, so it needs a Rust toolchain but none of
Tauri's system packages (WebKit, GTK).

## Run

```bash
node cli/harness.mjs run <workflow.harness.yaml> --task "What to do" [options]
npm run harness -- run <workflow.harness.yaml> --task "What to do" [options]
```

| Option | What it does |
|---|---|
| `--task "<text>"` | What the run should do. It goes to the entry agents, as in the app. |
| `--task-file <path>` | The task from a file (instead of `--task`) |
| `--resume <runId>` | Resume a saved run: finished, unchanged agents are reused (see below) |
| `--workspace <dir>` | The folder the agents work in. Default: the current folder. File tools, commands and hooks stay inside it. |
| `--provider <name>` | `auto`, `openai`, `anthropic`, `ollama`, `ollama-cloud` or `openai-compatible`. Default: `auto`, which picks each agent's provider from its model, as the app does. |
| `--base-url <url>` | The Ollama endpoint, or the OpenAI-compatible endpoint (required for `openai-compatible`) |
| `--model <name>` | The Ollama or OpenAI-compatible model. OpenAI and Anthropic keep each agent's own model. |
| `--max-parallel <n>` | Agents running at once. Default: the workflow's setting. |
| `--continue-on-error` | Keep running the other agents after one fails. By default the run stops at the first failure. |
| `--allow-command "<cmd>"` | Let agents run this exact command. Repeat it for more commands. |
| `--json` | One JSON event per line on stdout, and nothing else |
| `--core <path>` | The `harness-core` binary. Default: `HARNESS_CORE`, then `src-tauri/target/release/harness-core`. |

Examples:

```bash
# A local Ollama model for every agent
node cli/harness.mjs run review.harness.yaml --task "Review src/" --provider ollama --model qwen2.5-coder:7b

# OpenAI, with each agent's own model; the key comes from the environment
OPENAI_API_KEY=sk-… node cli/harness.mjs run review.harness.yaml --task-file task.md --provider openai

# Any OpenAI-compatible server
HARNESS_CUSTOM_API_KEY=… node cli/harness.mjs run review.harness.yaml --task "Review src/" \
  --provider openai-compatible --base-url https://llm.example.com/v1 --model my-model
```

The workflow is checked with the same schema and validation as the app before
anything starts.

## Keys

Keys come only from environment variables; there is no key flag, and the run
record never contains a key.

| Variable | For |
|---|---|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `OLLAMA_API_KEY` | Ollama Cloud (ollama.com) |
| `OLLAMA_REMOTE_API_KEY` | An authenticated remote Ollama server |
| `HARNESS_CUSTOM_API_KEY` | An OpenAI-compatible endpoint (`--provider openai-compatible`) |

`harness-core` reads the first four itself. A custom endpoint never gets your
OpenAI key: it gets `HARNESS_CUSTOM_API_KEY` or nothing. `harness-core` also
reads `LLM_PROVIDER`, `OLLAMA_BASE_URL` and `OLLAMA_MODEL`, as the app does.

Agent commands and hooks run without these keys in their environment.

## Agent commands

An agent with the `bash` tool can ask to run a command line. In the app, you
approve each one. In `harness run`, you approve them up front:

```bash
node cli/harness.mjs run fix.harness.yaml --task "Make the tests pass" \
  --allow-command "npm test" --allow-command "npm run lint"
```

- A command runs only if it matches one of the `--allow-command` lines exactly,
  after trimming spaces at both ends. `npm test -- --watch` is not `npm test`.
- Every other command is denied. The agent is told that the run does not allow
  it, and the audit reads `denied (not in --allow-command)`. An allowed command's
  audit reads `allowed by --allow-command`.
- The app's checks still apply: one line, no control or invisible characters,
  at most 2000 characters, and a workspace to run in.
- Commands run in the workspace folder (cmd.exe on Windows, `sh` elsewhere),
  without your provider keys. They are **not sandboxed**: allow only commands
  you would run yourself.

## Hooks

Hook nodes run their script, as in the app: `.sh` with bash, `.bat` with cmd,
`.ps1` with PowerShell and `.py` with Python, in the workspace, with the node's
timeout. A hook marked `requireConsent` is not run: it fails the run.

## Output

Without `--json`, `harness run` prints a line for each agent that starts and
ends, each command, revision, compaction and reused agent, then a summary:

```
Run run-1790348292064: Fix the sum bug (2 agents)
▶ Coder started (openai via openai-compatible)
$ Coder ran: node --test (allowed by --allow-command; exit 0, 422 ms)
✓ Coder done (112.9 s)
▶ Reviewer started (openai via openai-compatible)
✗ Reviewer failed: Error: Reviewer timed out after 1s

Failed in 116.3 s · run run-1790348292064
  ✓ Coder: done
  ✗ Reviewer: error
Changed files:
  sum.mjs  +1 −1
Saved: .harness/runs/run-1790348292064/run.json
Resume: harness run fix.harness.yaml --resume run-1790348292064
```

When every agent finishes, the summary ends with the final output of the last
agents. Warnings and errors go to stderr.

With `--json`, stdout has one JSON object per line and nothing else:

| `type` | Fields |
|---|---|
| `run_started` | `runId`, `workflow` |
| `node_started` | `nodeId`, `agent`, `model`, `provider`, `revision` |
| `node_finished` | `nodeId`, `agent`, `status` (`done`, `error`, `stopped`, `skipped`), `output` (the full text), `error`, `durationMs`, `revision`, `reused` |
| `command`, `revision`, `compaction`, `reused`, `audit` | `nodeId`, `details`, `success` |
| `run_finished` | `runId`, `status` (`done`, `error`, `cancelled`), `durationMs`, `agents`, `changes` (`path`, `created`, `added`, `removed`), `outputs` (the final agents' text), `trace` (the saved record) |

`nodeId`s are the agents' places in the workflow file: `agent-0`, `agent-1`, …
The provider check's `audit` events can come before `run_started`. A run that
never started ends with `{"type":"run_finished","status":"not_started","error":…}`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The run finished and every agent is done |
| `1` | An agent failed |
| `2` | Bad usage, a missing file, an invalid workflow, or a resume that cannot be done |
| `3` | The run could not start: `harness-core` is missing or stopped, or the provider check failed (for example, no key) |
| `130` | Stopped with Ctrl+C |

## Stopping

Press Ctrl+C once to stop the run, like the app's Stop button: running agents
stop, running commands are killed, and the run is saved as `cancelled`, so you
can resume it. `harness-core` ignores Ctrl+C so it can finish the run and save
it. Press Ctrl+C again to exit at once.

## Saved runs and resume

Every run is saved to `<workspace>/.harness/runs/<runId>/run.json` as it goes:
when it starts, after each agent and at the end. The app saves its runs there
too when a workspace is open. Add `.harness/runs/` to your `.gitignore`.

The record holds:
- the workflow's name, file path and SHA-256;
- the task, the provider settings (never a key), the status, the times and the
  number of attempts;
- each agent's status, output, error, times, model, token estimate, revision,
  helpers and definition hash;
- the text each agent passed on, the memory, the gateway routes, the files the
  run changed, and the audit.

To resume a run that failed or was stopped:

```bash
node cli/harness.mjs run fix.harness.yaml --resume run-1790348292064
```

```
Run run-1790348292064: Fix the sum bug (2 agents)
↩ Coder: reused from the saved run (unchanged)
▶ Reviewer started (openai via openai-compatible)
✓ Reviewer done (21.1 s)

Done in 23.5 s · run run-1790348292064
…
```

- The run keeps its id and its task. `--task` is not needed, and a different
  task is an error (exit 2).
- An agent is reused, not run again, if all of these hold:
  - it finished (`done`) in the saved run;
  - nothing that shapes its work has changed: role, model, tools, limits, prompt
    text (a prompt file's content), memory keys, hook;
  - every agent before it is reused too.
- Reused agents keep their saved output; the agents after them get it as if they
  had just run. Everything else runs again, so fixing one agent re-runs it and
  everything after it.
- A run id that is not saved in the workspace, or a record of another workflow,
  is an error (exit 2).
- The provider settings are recorded, not compared. A finished agent is reused
  even if you resume with another `--provider`, `--base-url` or `--model`.

A run saved by the app can be resumed with `harness run` on the same workflow
file: the record names agents by their place in the file.

## CI

`examples/ci/harness-run.yml` is a GitHub Actions workflow to copy into your
repository. It:
- checks out your repository and Harness Studio side by side;
- builds the bundle and `harness-core` (no Tauri packages needed);
- runs a workflow with keys from `secrets.*` and the commands you allow;
- uploads `.harness/runs/` and the JSON events as an artifact.

This repository's own CI (`.github/workflows/ci.yml`) runs on every push to
master and every pull request, on Linux:
- types and the TypeScript tests, including `harness run` end to end against a
  fake `harness-core`;
- the Rust tests with Tauri and without it;
- `harness run` against the real `harness-core`.

## Limits

- Replies do not stream in the terminal: each agent's output arrives when it is
  done.
- Commands are not sandboxed. Only the exact commands you allow run.
- There are no prebuilt binaries: build the bundle and `harness-core` from the
  repository.
- The app has no Resume button; resume with `harness run`.
- Ctrl+C handling in `harness-core` is tested on Linux in CI. On Windows it was
  checked once with a real console Ctrl+C (the run stopped, was saved as
  `cancelled` and exited 130); no automated test covers it there.

## Troubleshooting

- **`harness-core not found`**: run `npm run build:core`, or pass
  `--core <path>` or set `HARNESS_CORE`.
- **`build it first with npm run build:cli`**: the bundle is missing.
- **`No API key for the selected provider. Add one in Settings…`**: this
  message comes from the app's engine. For `harness run`, set the key's
  environment variable (see Keys).
- **An agent times out on a slow endpoint**: free and shared endpoints can take
  30 seconds or more per call and may answer 429 when busy. Raise the agents'
  timeouts in the workflow, or use `--max-parallel 1`.
