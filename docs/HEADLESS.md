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

Use Node 20 or later (`package.json` declares it).

On a machine with no internet, `npm ci` and `cargo` cannot fetch anything: see
`docs/AIRGAPPED.md` for the offline bundle, which holds the packages and crates, and
prebuilt `harness-run.mjs` and `harness-core` for the platform it was made on.

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
| `--base-url <url>` | The Ollama endpoint, or the OpenAI-compatible endpoint (required for `openai-compatible`, unless `HARNESS_CUSTOM_BASE_URL` gives it) |
| `--model <name>` | The Ollama or OpenAI-compatible model. OpenAI and Anthropic keep each agent's own model. For an OpenAI-compatible endpoint it can come from `HARNESS_CUSTOM_MODEL`; with none, each agent's own model is sent. |
| `--num-ctx <n>` | Ollama's context window in tokens, sent as `num_ctx`: a whole number from 0 to 4294967295. Default: 16384. It overrides the server's default (`OLLAMA_CONTEXT_LENGTH`) and a model's own `num_ctx` (Modelfile); `0` sends none, so those stand. Never sent to ollama.com. Can come from `HARNESS_OLLAMA_NUM_CTX`. |
| `--request-timeout <secs>` | How long one model call may take in total: a whole number of seconds from 30 to 86400. Default: 600. An agent's own `timeoutSeconds` still bounds its whole run. Can come from `HARNESS_REQUEST_TIMEOUT_SECS`. |
| `--max-parallel <n>` | Agents running at once. Default: the workflow's setting. |
| `--continue-on-error` | Keep running the other agents after one fails. By default the run stops at the first failure. |
| `--allow-command "<cmd>"` | Let agents run this exact command. Repeat it for more commands. |
| `--json` | One JSON event per line on stdout, and nothing else |
| `--core <path>` | The `harness-core` binary. Default: `HARNESS_CORE`, then `src-tauri/target/release/harness-core`. |

What this page says of Ollama's own behavior, and of how a real server answers, was
not tested against a real server: see `docs/AIRGAPPED.md` §5.

Examples:

```bash
# A local Ollama model for every agent
node cli/harness.mjs run review.harness.yaml --task "Review src/" --provider ollama --model qwen2.5-coder:7b

# OpenAI, with each agent's own model; the key comes from the environment
OPENAI_API_KEY=sk-… node cli/harness.mjs run review.harness.yaml --task-file task.md --provider openai

# Any OpenAI-compatible server
HARNESS_CUSTOM_API_KEY=… node cli/harness.mjs run review.harness.yaml --task "Review src/" \
  --provider openai-compatible --base-url https://llm.example.com/v1 --model my-model

# The same, from the environment alone: no flags
LLM_PROVIDER=openai-compatible HARNESS_CUSTOM_BASE_URL=https://llm.example.com/v1 \
  HARNESS_CUSTOM_MODEL=my-model HARNESS_CUSTOM_API_KEY=… \
  node cli/harness.mjs run review.harness.yaml --task "Review src/"

# Ollama on another machine, with a larger context window and a longer call timeout.
# Also raise each agent's own timeoutSeconds in the workflow: it still bounds its whole run.
node cli/harness.mjs run review.harness.yaml --task "Review src/" --provider ollama \
  --base-url http://192.168.1.20:11434 --model qwen2.5-coder:7b --num-ctx 32768 --request-timeout 1800
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
| `HARNESS_CUSTOM_API_KEY` | An OpenAI-compatible endpoint (`--provider openai-compatible`, or `LLM_PROVIDER=openai-compatible`) |

`harness-core` reads the first four itself. A custom endpoint never gets your
OpenAI key: it gets `HARNESS_CUSTOM_API_KEY` or nothing. `harness-core` also
reads `LLM_PROVIDER`, `OLLAMA_BASE_URL` and `OLLAMA_MODEL`, as the app does.

Agent commands and hooks run without these keys in their environment.

## Options from the environment

Four options can also come from an environment variable, so a CI job or a shell
profile can set them once. A flag wins over its variable, and a blank variable counts
as unset.

| Variable | Same as | |
|---|---|---|
| `HARNESS_OLLAMA_NUM_CTX` | `--num-ctx` | Ollama's context window |
| `HARNESS_REQUEST_TIMEOUT_SECS` | `--request-timeout` | How long one model call may take |
| `HARNESS_CUSTOM_BASE_URL` | `--base-url` | An OpenAI-compatible endpoint only |
| `HARNESS_CUSTOM_MODEL` | `--model` | An OpenAI-compatible endpoint only |

- The two `HARNESS_CUSTOM_…` variables are read only when the run uses the
  OpenAI-compatible endpoint: `--provider openai-compatible`, or `--provider auto`
  (the default) with `LLM_PROVIDER=openai-compatible`. In the second case `--provider`
  is not needed.
- A value that is not valid is exit 2 and names the variable, for example
  `harness run: HARNESS_REQUEST_TIMEOUT_SECS must be a whole number of seconds from 30 to 86400`
  (`HARNESS_OLLAMA_NUM_CTX must be a whole number of tokens, 0 or more`). The value is
  checked whichever provider the run uses, before `harness-core` starts. The flags
  give the same errors, naming the flag.
- With no URL from a flag or a variable, `--provider openai-compatible` is exit 2:
  `--provider openai-compatible needs --base-url (or HARNESS_CUSTOM_BASE_URL)`.
  `LLM_PROVIDER=openai-compatible` alone gets past that check, and the engine then
  refuses to start the run, before any agent runs: exit 3, `Custom endpoint URL is not
  configured. Add it in Settings → Custom Endpoint.` That message is the app's
  wording: set `--base-url` or `HARNESS_CUSTOM_BASE_URL`.
- The app does not read these four variables: its values are in Settings.
  `LLM_PROVIDER` is read by both.

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
timeout. A Hook node that fails or is refused stops the run, even with
`--continue-on-error`.

A hook marked `requireConsent` is not run. A hook without it runs with nobody
asking, so it is also refused when its script or its `env` is not what the run
started with:
- an agent's file tools changed the script, in any attempt of the run; or
- its fingerprint differs from the one taken when the run first started.
  `harness-core` takes the fingerprint (the command `hook_fingerprint`): a SHA-256
  of the script's bytes, in any encoding, and of the node's `env` (the hook runs
  with it as it is, and an agent can edit the workflow file to add a `BASH_ENV` or
  `PATH`). It reads the script at the path the interpreter is given. The run
  fingerprints every Hook node at its start (`requireConsent` ones too) and again
  just before an unasked hook runs. Then `execute_hook` reads the script once more
  and re-checks it as its last step before it starts the interpreter. This also
  catches other spellings of the path, links and shell commands you allowed. A
  script that was there and is gone, or the other way round, counts as changed.

A refusal fails the hook's node, stops the run and goes to
`.harness/audit.log.jsonl`. It is the hook's error in the output, and `harness run`
exits 1. For example:

```
✗ Gate failed: Hook script .harness/hooks/gate.sh or its environment was changed during this run; review it, then run it from the Hooks tab or start a new run.
```

The Hooks tab is in the app. Here, review the script and start a new run.

The refusals:
- "… or its environment was changed during this run; …": the script or the `env`
  changed, or the script appeared or disappeared. `execute_hook`'s own check
  words it "… changed after it was checked; it was not run."
- "… could not be checked (`<reason>`), so it is not run unasked; …": `harness-core`
  could not fingerprint the script. The reason is its own, for example
  `Path traversal detected: ../outside.sh` (a path outside the workspace),
  `IO error: not a regular file` (a folder or a FIFO), or
  `Unknown command: hook_fingerprint` (a `harness-core` older than the CLI bundle:
  rebuild it with `npm run build:core`). A resumed run whose saved baseline could
  not be checked says "the script could not be read, or harness-core is older than
  the app" instead.
- "… was not found in the workspace, so it was not run.": the script was missing
  when the run started and still is.

On Windows, an unasked hook that `execute_hook` starts through cmd.exe is also
refused if its full resolved path contains one of `& | < > ^ % ! ( ) @ , ; =`,
because cmd.exe reads the path as a command line and could run another file. The
whole path counts: the hook's own path, the workspace folder and the folders above
it. cmd.exe runs `.bat`, `.cmd`, `.exe` and any extension other than `.sh`/`.bash`,
`.ps1` and `.py`. The message is "… is at `<path>`, a path cmd.exe would not run as
written (it contains one of …), so it was not run; move it to a path without
them." The set is broad on purpose (fail closed): it also refuses some paths
cmd.exe would run correctly, for example a workspace under a folder named
`OneDrive - Acme, Inc` or `proj(1)`, where even `.harness/hooks/gate.bat` is
refused. Moving the hook inside the workspace does not help: move or rename the
workspace or the hook so that the full path has none of these characters. The
Hooks tab does not check this: run a hook from there only if you know cmd.exe runs
its path as written. How cmd.exe parses the path was reasoned from its documented
rules, not tested on Windows.

The fingerprints are the run's baselines. They are saved in the run record
(`hookScripts`, see below) and a resume keeps them; it takes no new ones. So:
- a script changed during an earlier attempt, or an `env` changed in the workflow
  file since, is refused on every resume;
- a script that could not be checked when the run started is refused on every
  resume;
- a Hook node added to the workflow file, or given a script, since the first
  attempt has no baseline ("… has no baseline from this run's first attempt …")
  and is refused;
- after a refusal a resume refuses again, even though the summary prints a
  `Resume:` line: start a new run. A new run takes the scripts as they are as its
  baselines, so review the script first.

The one exception is a record saved before `hookScripts` existed: it has no
baselines, and resuming it takes them from the scripts as they are then. A record
saved by a build that hashed the script's text, before the check moved into
`harness-core`, holds hashes that never match the fingerprints: resuming it
refuses its unasked hooks as changed, so start a new run.

The check does not cover files a script sources or imports, or the moment between
`execute_hook`'s last read and the interpreter's own opening of the file (narrowed,
not closed). See `docs/SECURITY.md`.

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

One warning comes from the run itself: an agent's prompt may leave no room for its
reply in Ollama's context window. It is printed on stderr when the agent starts,
without the ⚠ that the app's audit strip shows:

```
warning: Coder: its prompt is about 9,000 tokens and it may reply with up to 16,384 tokens, but Ollama's context window is 16,384 tokens, so Ollama may cut off the start of the prompt. Raise the context window (Settings → Ollama context window; harness run: --num-ctx).
```

It fires when the agent's estimated prompt P (about 4 characters per token, over the
system and user messages) plus its `maxTokens` M (2048 if it is 0), counted as at
most half the window W, is more than the window: P + min(M, W / 2) > W. A generous
`maxTokens` alone does not warn: at the default window an agent with `maxTokens`
16384 counts its reply as 8192, so it warns when its prompt is more than 8192 tokens.
The message gives P, M and W. It is said once per agent, and it does not change the
run or its exit code. The estimate is a minimum: it covers the first prompt only, and
leaves out the tool definitions and the steps after it. There is no warning with
`--num-ctx 0`, for ollama.com, or for another provider.

With `--json`, stdout has one JSON object per line and nothing else:

| `type` | Fields |
|---|---|
| `run_started` | `runId`, `workflow` |
| `node_started` | `nodeId`, `agent`, `model`, `provider`, `revision` |
| `node_finished` | `nodeId`, `agent`, `status` (`done`, `error`, `stopped`, `skipped`), `output` (the full text), `error`, `durationMs`, `revision`, `reused` |
| `command`, `revision`, `compaction`, `reused`, `audit` | `nodeId`, `details`, `success`, and `warning: true` for a problem the run went on after (a fallback, a revision limit, a branch a gateway chose after a revision that could not run, a prompt that may not fit Ollama's context window) |
| `run_finished` | `runId`, `status` (`done`, `error`, `cancelled`), `durationMs`, `agents`, `changes` (`path`, `created`, `added`, `removed`), `outputs` (the final agents' text), `trace` (the saved record), `error` (only when the run failed as a whole rather than through an agent, for example a cycle: `Run failed: …`; an agent's own error is on its `node_finished` event) |

`nodeId`s are the agents' places in the workflow file: `agent-0`, `agent-1`, …
The provider check's `audit` events can come before `run_started`. A run that
never started ends with `{"type":"run_finished","status":"not_started","error":…}`.

The context window warning above is an `audit` event with `warning: true`,
`success: true`, the agent's `nodeId` and the warning's text in `details` (it starts
with the ⚠). Nothing goes to stderr for it.

`node_finished` can repeat for a node. It runs again in each revision round
(`revision` says which), and a node that finished as `done` gets a later
`skipped` when a revision makes a gateway route around it: its output is dropped
from the record and from what later agents receive. The last event for a node,
and `run_finished.agents`, hold its final status.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The run finished and every agent is done |
| `1` | An agent failed, or the run failed as a whole rather than through an agent: the reason is in the summary and in the JSON `error` field of `run_finished` |
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
- the task, the provider settings (never a key, and not the model call timeout), the
  status, the times and the number of attempts. The settings include Ollama's
  context window as `provider.ollamaNumCtx`. It is the setting, not what went over
  the wire: it is written for every run, also a run on another provider (an
  OpenAI-compatible run given `--num-ctx 64` records 64) and a run on ollama.com
  (which gets none), and 0 means none was asked for. A resumed run records the value
  it was resumed with. A record saved before this field has none;
- each agent's status, output, error, times, model, token estimate, revision,
  helpers and definition hash;
- the text each agent passed on, the memory, the gateway routes, the files the
  run changed, and the audit;
- `hookScripts`: for each Hook node with a script, a fingerprint (64 hex digits),
  `null` if there was no such script, or `"unverifiable"` if `harness-core` could
  not check it. The fingerprint is not the file's plain SHA-256: it is a SHA-256
  over a versioned encoding of the script's bytes, as the run first found them,
  and of the node's `env`. Never the script's text or the `env` (see Hooks).

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
  even if you resume with another `--provider`, `--base-url`, `--model` or
  `--num-ctx`.
- The hook baselines carry over and a resume takes no new ones (see Hooks). A
  hook refused for its script or `env` is refused again on resume.

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
- the production frontend build;
- the Rust tests with Tauri and without it;
- `harness run` against the real `harness-core`, with no key: it must stop at the
  preflight (exit 3).

The job has read-only permissions (`contents: read`) and uses Node 22.

## Limits

- Replies do not stream in the terminal: each agent's output arrives when it is
  done. `harness run` never streams: its requests to Ollama carry `stream: false`,
  and OpenAI-compatible endpoints are not asked to stream. The app's streaming turn
  (`stream: true`) carries `num_ctx` too, but only the Rust unit tests cover that.
- Commands are not sandboxed. Only the exact commands you allow run.
- The hook script check has gaps: files a script sources or imports, and a change
  in the moment between `execute_hook`'s last read and the interpreter's own
  opening of the file (see Hooks).
- No binaries are published: build the bundle and `harness-core` from the
  repository. An offline bundle (`npm run offline:bundle`) carries prebuilt ones,
  for the platform it was made on only (`docs/AIRGAPPED.md`).
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
- **An agent fails with `<name> timed out after <N>s`**: the agent's own
  `timeoutSeconds` (`<N>`; 300 for an agent made in the app) ran out. It bounds the
  agent's whole run, all its model calls and tools. Free and shared endpoints can
  take 30 seconds or more per call and may answer 429 when busy. Raise the agents'
  `timeoutSeconds` in the workflow (the workflow-level `timeoutSeconds` is not
  applied), or use `--max-parallel 1`.
- **`The model did not answer within the request timeout. On slow hardware, raise
  the model call timeout (Settings in the app, --request-timeout in harness
  run).`**: one model call to Ollama or an OpenAI-compatible endpoint got no answer
  within `--request-timeout` (default 600 s). Raise it with `--request-timeout <secs>`
  (30 to 86400) or `HARNESS_REQUEST_TIMEOUT_SECS`. Raise the agents' `timeoutSeconds`
  too: an agent gives up at its own timeout even if a call is still going, and an
  agent's 300 s is shorter than the default call timeout (600 s). An agent that gives
  up does not cancel its call: a local server keeps working on it until it answers or
  `--request-timeout` ends it, so later calls to the same server may queue behind it.
  A reply that had begun when the timeout ended gives `Failed to parse Ollama
  response: error decoding response body` (or `Failed to parse OpenAI response: …`)
  instead; real servers normally send nothing until the reply is complete. An
  Anthropic call that got no answer keeps `Anthropic network error: …`. A refused
  connection keeps its own message (Ollama: `… is not reachable at <url>`; an
  OpenAI-compatible endpoint: `Network error: …`), and connecting fails after 10 s.
- **`warning: <agent>: its prompt is about N tokens and it may reply with up to M
  tokens, but Ollama's context window is W tokens …`**: the agent's estimated prompt
  plus its `maxTokens`, counted as at most half the window, is more than the window
  (`--num-ctx`, default 16384), so Ollama may cut off the start of the prompt. The run
  goes on. Raise `--num-ctx` (a larger window needs more memory on the Ollama server),
  shorten what the agent is given, or lower its `maxTokens`. With `--num-ctx 0` the
  server's own window applies, and there is no warning. A window you set here
  overrides the server's `OLLAMA_CONTEXT_LENGTH` and a model's own `num_ctx` (its
  Modelfile): if either sets one, pass `--num-ctx 0` or the same value. Otherwise a
  model built with a larger window, say 32768, is lowered to the window you pass
  (16384 by default).
- **The context window or the call timeout seems to have no effect**: a
  `harness-core` built before this change ignores both without saying so, while the
  run record still shows the window. After updating, rebuild it with
  `npm run build:core` (the same advice as for `hook_fingerprint`), or pass a new one
  with `--core`.
- **`harness run: … must be a whole number …` (exit 2)**: `--num-ctx`,
  `--request-timeout` or one of their variables has a value that is not valid (see
  Options from the environment).
- **`Custom endpoint URL is not configured. Add it in Settings…`** (exit 3): the
  run uses the OpenAI-compatible endpoint (`LLM_PROVIDER=openai-compatible`) but has
  no URL. This message comes from the app's engine. Set `--base-url` or
  `HARNESS_CUSTOM_BASE_URL`.
- **Garbled text in Windows PowerShell** (`??` instead of `▶` and `✓`, broken
  non-English text): `harness run` writes UTF-8, but Windows PowerShell reads a
  program's output with the console's code page, and its `>` saves files as
  UTF-16. To save it, redirect from cmd.exe:
  `cmd /c "node cli\harness.mjs run … --json > events.jsonl"`. To read it into
  PowerShell, first run `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.
