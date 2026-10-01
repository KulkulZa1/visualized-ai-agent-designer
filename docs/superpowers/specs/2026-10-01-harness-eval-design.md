# `harness eval` — Design

Date: 2026-10-01 · Branch: `ccr-ac944598-tom0ws` (PR #15, from master `5d3413f`)

Part of the air-gapped self-improvement plan
(`2026-10-01-airgapped-self-improvement-design.md`, phase P1b).

## Goal

Measure how well a workflow does on a set of tasks.
- **Trials.** Each task runs k times, each time in a fresh copy of its workspace.
- **Scoring.** Each trial is scored with checks the user wrote: commands, the
  workflow's output, and files.
- **The report.** It holds the reward, tokens and time of every trial and the
  totals. It is shaped the way RRSI's selection reads an evaluation: a pooled
  score `S`, a cost `C`, and per task the rewards, tokens and missing trials.

All of it must run on a machine with no network, against a local model server.

**Decisions.** These are conventional choices, taken without asking the user and
listed here so they can be changed.
- **Scorer commands need their own approval.** It is given with
  `--allow-scorer "<exact command>"` (§4).
- **The model calls return their token usage.** The text-protocol `call_*`
  commands return `{ text, usage }` instead of a bare string. Callers accept
  either shape (§5).
- **One PR in three parts.** Part 1 is the eval and part 2 the token usage. The
  report's token fields have their final shape from part 1 on.

## Non-goals

- **The loop:** `harness evolve`, candidate worktrees, selection and the noise
  band `δ` (P2).
- **A judge-workflow scorer.** A later step.
- **A sandbox for commands.** Agents' approved commands and the scorer commands
  run as `harness run` runs commands today: in the workspace folder, not
  confined.
- **Sampling controls** (temperature, seed). Nothing sends them today, so trials
  vary as the provider varies, as in RRSI.
- **An app UI.** This is CLI only.
- **Cost in money.** Cost is tokens, as in RRSI.
- **Resuming an eval.** The report is written after every trial, so a crash
  loses at most one trial's work. A `--resume` is a follow-up.

## 1. The task-set file

`<name>.tasks.yaml`, with its own schema.
- **The schema is strict:** an unknown key is an error. Workflow files are
  different: there, unknown keys are dropped.
- **Paths are relative to the file.**

```yaml
version: 1
name: purchasing
workflow: ../purchasing-decision.harness.yaml    # --workflow overrides it
trials: 3                                        # k; --trials / -k overrides it
tasks:
  - id: laptop                                   # [A-Za-z0-9_-]+, unique
    split: evolve                                # evolve (default) | heldout
    smoke: true                                  # also in --split smoke
    weight: 1                                    # default 1
    task: "Rank the three offers for 40 laptops."   # or taskFile: tasks/laptop.md
    workspace: fixtures/laptop                   # copied fresh for each trial; none: empty
    scorers:
      - name: tests
        command: "npm test --silent"
        restore: [test, package.json]            # put back from the fixture
        inject:                                  # copied in; the agents never see them
          - { from: grader/hidden.test.js, to: test/hidden.test.js }
        timeoutSecs: 300                         # default 300; 1 to 3600
      - name: names-the-winner
        output: { contains: ["SUP-A"], notContains: ["SUP-C"], node: "Decision Maker" }
      - name: wrote-the-report
        file: { path: report.md, contains: ["## Ranking"] }
```

**Paths.**
- **Inside the task set's folder:** `workspace`, `taskFile` and an `inject.from`
  must resolve inside the task set's own folder. Symlinks are refused.
- **The `workflow`** may be anywhere; it is read, never copied.
- **Inside the trial's folder:** `restore` paths and `inject.to` must stay
  inside it: no absolute paths, and no `..` that leaves it.
- **One helper** checks containment. It carries a `[KEEP-IN-SYNC]` marker, like
  the other copies of `isInsideDir`.
- **When the checks run.** All of it is checked before any trial.

**Scorers.** Each scorer gives 0 or 1, and a scorer's `weight` defaults to 1.
- **`command`** passes on exit code 0.
  - **Its files are prepared first.**
    - Each `restore` path is deleted in the trial's folder, then copied back from
      the pristine fixture, if the fixture has it. This is a replacement, not an
      overlay, so a test file an agent added under a restored folder is gone.
    - Each `inject` is copied the same way, from the task set's folder to `to`.
  - **It runs** through `harness-core`'s `execute_command`, in the trial's folder.
  - **A timeout** (`harness-core`'s "Command timed out after N s") fails the
    scorer, with `timedOut: true`.
  - **A command that cannot start** (any other error) makes the trial missing.
  - **The two errors are told apart** by their text. A test pins both texts, and
    both ends carry `[KEEP-IN-SYNC]`.
- **`output`** checks the run's final output. That is the joined output of the
  agents nothing follows, or the output of the one agent `node:` names.
  - Its checks are `contains`, `notContains` and `matches` (a regex). All must
    hold.
  - `node:` must name exactly one agent of the workflow under test; otherwise
    the eval is exit 2 before any trial.
  - The final-agent logic, now private in `src/cli/report.ts`, is shared.
- **`file`** checks one file in the trial's folder after the run: it exists, and
  its `contains` and `matches` checks hold.

**A trial's reward** is the weighted mean of its scorers.

**A missing trial** gets reward 0 and still counts in the denominator, as in
RRSI. A trial is missing when:
- its run did not start (the provider preflight failed, or `harness-core` stopped);
- a scorer command could not start;
- a file could not be copied.

**A failed agent is not a missing trial.** If the run finished with a failed
agent, the trial is scored as usual, and the failure shows in the report.

**Fixtures must be self-contained.** A scorer that runs `npm test` needs the
fixture's `node_modules`.

## 2. Trials and grader integrity

Each trial goes through these steps:
1. **A fresh folder.** The trial gets a new folder,
   `<tmp>/harness-eval-<random>/<task>-t<i>`.
2. **The fixture.** The task's `workspace` is copied into it.
3. **The workflow.** The workflow runs with that folder as its workspace and the
   task as its input.
   - It is the same engine as `harness run`, in the same process.
   - One `harness-core` serves the whole eval.
   - The lines `harness run` would print go to the trial's `run.log`.
4. **The scorers** run, with the command scorers' files prepared first (§1).
   - `output` checks read the run's result in memory, not the run record in the
     folder, which an agent with `bash` could have changed.
5. **What is kept.** It is saved under `trials/<task>/t<i>/` in the eval's output
   folder:
   - the trial's outcome: statuses, the final outputs, tokens, the run time and
     the scoring time;
   - each scorer's result, with the tail of a command's output;
   - `run.log`;
   - a copy of the run record.

   The report is then rewritten (§6).
6. **Cleanup.** The trial's folder is deleted, unless `--keep-workspaces` is
   given.

**What agents can't reach.** The task-set file, the fixtures and the grader files
are never inside a trial's folder; only copies are. So agents cannot change the
originals.

**The limits.** An agent with `bash` can still change anything in its trial's
folder that a scorer does not restore or inject, for example a `package.json`
test script that is not listed. The docs say so.

## 3. The command

```
harness eval <tasks.yaml> [--workflow <file>] [--split evolve|heldout|smoke|all]
  [--only <task-id>]... [--trials N | -k N] [--max-parallel-trials N]
  [--out <dir>] [--keep-workspaces] [--min-score X] [--json]
  [--allow-scorer "<cmd>"]... [--allow-command "<cmd>"]...
  [the provider options of harness run] [--core <path>]
```

- **Defaults:**
  - `--split evolve`;
  - the task set's `trials` (else 1);
  - `--max-parallel-trials 1`. A local server usually answers one request at a
    time, and parallel trials would skew the timings;
  - `--out`: `.harness/evals/<evalId>/` in the current folder. An `--out` folder
    that exists and is not empty is exit 2.
- **Order.** Trials run in task order, then trial order.
- **Provider and agent options** are those of `harness run`, with the same
  environment variables:
  - `--provider`, `--base-url`, `--model`;
  - `--num-ctx`, `--request-timeout`;
  - `--allow-command`, for the agents' commands.
- **The provider check runs on every trial.** Every trial's run checks the
  provider first, as `harness run` does. That is how a trial whose server is
  down is told apart from a harness that failed.
  - For Ollama the check is a list of its models.
  - For the Custom endpoint it is a one-token completion, which takes up to
    120 s when the model is loading.
  - The docs say so.
- **The first Ctrl+C** stops starting trials and stops the running ones as Stop
  does. The report is then written as `cancelled`. A second Ctrl+C exits at once.
- **Output.**
  - A line per trial, and a summary.
  - With `--json`, the report alone on stdout, and progress on stderr.
- **`.gitignore`** gets `.harness/evals/`.

## 4. Approving scorer commands (AGENT.md rules 4 and 6)

A scorer command runs only if the user approved that exact command with
`--allow-scorer "<command>"`. That is the same up-front, exact-match approval
`--allow-command` gives agents' commands, but a separate list, so approving the
grader does not let the agents run it.

Before any trial, a selected task with an unapproved scorer command is exit 2,
and the message lists the commands to approve.

These need updating:
- **AGENT.md rule 4:** today `harness run` is the only command that executes
  anything;
- **AGENT.md rule 6:** the approval rule;
- **`docs/CLI_MCP_PLAN.md`:** its safety list is out of date.

**Keys in commands.** `HARNESS_CUSTOM_API_KEY` is added to the variables
`harness-core` strips from every command's environment. Before this change,
agents' commands, hooks and scorers all received it.

## 5. Real token usage

- **Rust reads the providers' usage from every model call's response:**
  - OpenAI and OpenAI-compatible: `usage.prompt_tokens` and `completion_tokens`;
  - Anthropic: `usage.input_tokens` and `output_tokens`;
  - Ollama: `prompt_eval_count` and `eval_count`.
- **How it comes back:**
  - **`chat_turn`'s reply** gains an optional `usage`.
  - **The text-protocol commands** (`call_openai_api`, `call_anthropic_api`,
    `call_claude_api`, `call_ollama_api`) return `{ text, usage? }` instead of a
    string. Their names and registrations don't change.
  - **`providerAdapter.callProvider`** is the only TypeScript caller (checked
    with grep). It accepts a string or `{ text, usage? }`. So an older
    `harness-core` keeps working, as do the VS Code extension's own string
    answers and the test mocks, with no usage.
- **The engine sums each node's calls:** turns, text calls, compaction summaries
  and helpers.
  - The node gets `usage { input, output, calls, callsWithoutUsage }` on its
    `AgentRun`.
  - The run record's node gets the same field. The field is additive, and the
    record stays version 1.
- **A trial's tokens** are the sum over its nodes, `{ input, output }`.
  - They are `null` when any call lacked usage. A local server may leave it out,
    and a partial sum would bias `C`.
  - The report also gives the chars/4 `tokenEstimate`, marked as an estimate.
- **The probe** (`check_provider_health`) is not counted.

## 6. The report

The output folder holds `report.json` and `trials/<task>/t<i>/`.

**When it is written.** `report.json` is written before the first trial and
after every trial, with status `running`. The last write gives `done`,
`cancelled` or `error`.

```json
{ "version": 1, "evalId": "eval-…", "status": "done",
  "taskSet": { "name": "…", "path": "…", "hash": "…" },
  "workflow": { "name": "…", "path": "…", "hash": "…" },
  "split": "evolve", "k": 3, "provider": { "…": "as in a run record, no keys" },
  "startedAt": "…", "finishedAt": "…",
  "S": 0.67, "C": 4500, "n_expected": 9, "missing": 0,
  "per_task": {
    "laptop": { "weight": 1, "mean": 0.67, "rewards": [1, 0, 1],
                "tokens": [4100, 3900, null], "missing": 0,
                "trials": [ { "trial": 0, "reward": 1, "missing": false,
                              "runStatus": "done", "runMs": 45210, "scoreMs": 3120,
                              "tokens": { "input": 3500, "output": 600 },
                              "tokenEstimate": 3800,
                              "scorers": [ { "name": "tests", "kind": "command",
                                             "passed": true, "weight": 1,
                                             "exitCode": 0, "timedOut": false,
                                             "ms": 3050 } ] } ] } } }
```

- **`S`** pools all trials, as RRSI does: `Σ w_task·r / Σ w_task`. Missing trials
  count as 0.
- **`C`** is the mean of the trials' token totals (input + output), over the
  trials that have one. It is `null` when none does.
- **`per_task.<id>.tokens`** lists each trial's total, or `null`.
- **In part 1** every trial's `tokens` is `null`, so `C` is `null`. Part 2 fills
  them.

## 7. Exit codes

- `0`: the eval finished, whatever the score.
- `1`: `--min-score` was given and `S` is below it.
- `2`: bad usage, an invalid task set or workflow, an unapproved scorer command,
  or a non-empty `--out`.
- `3`: the eval could not start: `harness-core` is missing, or the first trial's
  run did not start. A later trial that does not start counts as missing.
- `130`: interrupted.

## 8. Code

- **The CLI:**
  - `src/cli/evalCli.ts`, the command;
  - `evalArgs.ts`;
  - `taskSet.ts`, the strict schema and the checks;
  - `trial.ts`, the copies, the run and the scorers;
  - `evalReport.ts`, the aggregation and the report.
- **The bundle.** The CLI bundle (`cli/dist/harness-run.mjs`) also exports
  `runEval`, and `cli/harness.mjs` sends `eval` to it, as it does `run`. The
  shared pieces of `runCli.ts` are factored out, not copied:
  - loading and validating the workflow;
  - provider settings;
  - the interrupt;
  - starting the core.
- **Types.** `tests/node-shims.d.ts` gains what the copies need: for example
  `cpSync`, `lstatSync`, `realpathSync`, `process.cwd`.

## 9. Testing

- **Unit tests:**
  - **the task-set schema:** unknown keys, ids, paths that leave their folder,
    symlinks, a `node:` that names no agent or two;
  - **the scorers:**
    - output and file checks;
    - the command result mapping: passed, failed, timed out, could not start;
    - restore and inject as replacements;
  - **the aggregation:** the cases of rrsi's own `tests/test_core.py`.
    `{a:[1,0], b:[1,1]}` gives S = 0.75, the weighted case gives 15/200, and
    missing trials count as 0;
  - **the approval check**;
  - **the argument parser.**
- **Rust:**
  - usage parsed from each provider's response, and missing usage;
  - `call_*`'s new return shape;
  - the key stripping.
- **The engine:** usage summed across turns, text calls, compaction and helpers.
- **End to end:** the built CLI against `fake-core`, extended so that a scorer
  command's exit code (or a timeout) and the replies' usage can be scripted.
  - **What it covers:**
    - the report after each trial;
    - a missing trial;
    - a scorer timeout;
    - an agent overwriting a restored file and adding a test file, both undone;
    - an unapproved scorer, which is exit 2;
    - Ctrl+C.
  - **A caution.** `fake-core` counts each agent's replies for the life of the
    process, so a test must script a repeating last reply, or use a fresh eval
    per case.
- **Verification:** the real CLI and core against a fake Ollama in a network
  namespace, as in #14, plus the shipped example task set.

## 10. Delivery

One PR (#15), in parts. Each part has its own plan in `docs/superpowers/plans/`,
its review and verification, and green commits.
1. **The eval:** task sets, trials, scorers, the report, `harness eval` and
   `.gitignore`. Tokens are `null` until part 2.
2. **Token usage:** real usage, threaded into the run record and the eval's `C`,
   plus the key stripping.
3. **Docs and an example:**
   - **The docs:**
     - a `harness eval` guide in `docs/HEADLESS.md`;
     - `docs/AIRGAPPED.md`;
     - `AGENT.md` rules 4 and 6;
     - `docs/CLI_MCP_PLAN.md`;
     - `CHANGELOG.md`.
   - **The example:** an example task set for `examples/research-synthesis`. That
     workflow has local model ids and no shell. Its output checks are loose: it
     shows the format, it is not a benchmark.
