# Scoring a workflow: `harness eval`

`harness eval` runs a workflow on each task of a task set, several times per task,
each time in a fresh copy of the task's folder. It scores every run with checks you
write and saves a report.

The report gives:
- a score `S` from 0 to 1;
- the average tokens a run used, `C`;
- each task's rewards and each run's time.

Use it to tell whether a change to a workflow made it better. It works with no
network, against a local model, and it is the measurement step of the plan in
`docs/superpowers/specs/2026-10-01-airgapped-self-improvement-design.md`.

```bash
npm run build:cli && npm run build:core       # once, as for harness run
node cli/harness.mjs eval examples/evals/research-synthesis.tasks.yaml \
  --provider ollama --model qwen2.5-coder:7b -k 3
```

It uses the same engine, `harness-core`, provider options, keys and agent command
policy as `harness run` (`docs/HEADLESS.md`). `node cli/harness.mjs eval --help`
lists every option.

## The task set

A task set is a YAML file, usually `<name>.tasks.yaml`.
- **Paths** in it are relative to the file.
- **Its schema is strict:** an unknown key is an error, unlike in a workflow file,
  where unknown keys are dropped.

```yaml
version: 1
name: purchasing
workflow: ../purchasing-decision.harness.yaml   # --workflow overrides it
trials: 3                                       # runs per task; --trials or -k overrides it
tasks:
  - id: laptop                     # letters, digits, - and _
    split: evolve                  # evolve (the default) or heldout
    smoke: true                    # also part of --split smoke
    weight: 2                      # the task's weight in S (default 1)
    task: "Rank the three offers for 40 laptops."   # or taskFile: tasks/laptop.md
    workspace: fixtures/laptop     # copied fresh for every run; none means an empty folder
    scorers:
      - name: tests
        command: "npm test --silent"
        restore: [test, package.json]    # put back from the fixture first
        inject:                          # copied in first; the agents never see them
          - { from: grader/hidden.test.js, to: test/hidden.test.js }
        timeoutSecs: 300                 # 1 to 3600 (default 300)
      - name: names-the-winner
        output: { contains: ["SUP-A"], notContains: ["SUP-C"], node: "Decision Maker" }
      - name: wrote-the-report
        file: { path: report.md, contains: ["## Ranking"], matches: ["\\| SUP-A \\|"] }
```

**Splits.** Pick the tasks with `--split`:
- `evolve`, the default: the tasks you tune against;
- `heldout`: tasks you keep out of tuning, to see whether a gain carries over;
- `smoke`: the tasks marked `smoke: true`;
- `all`.

`--only <id>` narrows a split further.

**Task ids** may not be `__proto__`, `constructor` or `prototype`, or a Windows
device name such as `con` or `nul`. `trials` and `-k` go up to 1000.

**Fixtures must be self-contained.** A scorer that runs `npm test` needs the
fixture's own `node_modules`.

## Scorers

Each scorer gives 0 or 1. A run's reward is the weighted mean of its scorers; a
scorer's `weight` defaults to 1.

### `command`
A command passes on exit code 0.
- **Before it runs,** its `restore` paths are deleted in the run's folder and copied
  back from the pristine fixture. Its `inject` files are copied in from outside the
  fixture.
- **Both replace, not overlay.** An agent's edit to a restored file is undone, and a
  file it added inside a restored folder is gone.
- **How it runs:** through `harness-core`, in the run's folder, like an agent's
  approved command.
- **A timeout** fails the scorer.
- **A command that cannot start** makes the run missing.
- **Approval.** It runs only when approved exactly with `--allow-scorer` (see
  Approving scorer commands).

### `output`
It checks the run's final output: the output of the agents nothing follows,
joined, or of the one agent `node:` names.
- `contains`, `notContains` and `matches` (regular expressions) must all hold.
- A run with no final output fails it, so a crashed run cannot pass a
  `notContains` check.
- `node:` must name exactly one agent of the workflow; otherwise the eval does not
  start.

### `file`
It checks one file in the run's folder: it must exist, and its `contains` and
`matches` checks must hold. These fail it:
- a link that leads out of the folder;
- something that is not a regular file;
- a file over 4 MiB.

### The order
`output` and `file` scorers run first, on what the agents left. Then the `command`
scorers run in their order, each seeing the earlier ones' effects. So a `file`
scorer checks the agents' work, never what a scorer command built. The report keeps
the order you wrote.

## Approving scorer commands

A scorer command runs only if you passed that exact command with
`--allow-scorer "<command>"`. That is the same up-front approval `--allow-command`
gives agents' commands, but a separate list:
- `--allow-scorer "npm test"` does not let an agent run `npm test`;
- `--allow-command "npm test"` does not approve a scorer.

If a selected task has a scorer command you did not approve, the eval does not
start (exit 2), and the message lists the commands to approve.

**Where scorer commands are recorded.** Each command, its exit code and the end of
its output are in `trials/<task>/t<i>/scorers.json`, not in
`.harness/audit.log.jsonl`.

## What a run's agents can't reach

**Fresh copies.**
- Every run starts in a new folder with a fresh copy of its task's `workspace`.
- The task set, the fixtures and the grader files are never inside it; only copies
  are. So an agent cannot change the originals.

**Paths are checked before anything starts.**
- A fixture, a `taskFile` or an `inject` source must be inside the task set's
  folder.
- `restore` and `inject.to` must stay inside the run's folder.

**Containment.** At run time, every delete and copy is checked against the run
folder's real path, resolved as the operating system resolves it. So a link an
agent makes cannot lead a restore or an inject outside the folder.

**Links in fixtures.**
- **Allowed:** a link whose target is relative and stays inside the fixture at
  every step. An npm `node_modules/.bin` is such a link. It is copied as it is, so
  in a run it points inside the run's folder.
- **Refused:**
  - absolute links;
  - dangling links;
  - links that leave the fixture, even ones that come back in by the fixture's
    name;
  - any link in an `inject` source or a `taskFile`.
- **Checked again after a restore.** A restored folder's links are checked against
  the run's folder after the copy.

**`--out` placement.** `--out`, and the default, may not be inside a selected
task's `workspace` or `inject` source. Every run starts as a copy of those, so it
would see the earlier runs' results.

**The limits.** There is no sandbox.
- **Unlisted files.** An agent can change anything in its run's folder that a
  scorer does not restore or inject, for example an unlisted `package.json` test
  script.
- **Lingering processes.** An agent command you approved with `--allow-command`
  can start a process that keeps running, for example with `nohup … &`.
  - Such a process can rewrite files after they are restored, or swap a folder for
    a link while a restore is under way. A check found that the swap can make a
    restore delete files outside the run's folder.
  - The process already runs as you, so this gives it nothing it could not do
    anyway, but scores from such a run cannot be trusted.
  - Without `--allow-command`, agents cannot start processes at all.

## The report

The eval writes to `--out`, `.harness/evals/<evalId>/` by default. Add
`.harness/evals/` to your `.gitignore`; this repository's has it.

- **`report.json`** is written before the first run and after every run, with
  status `running`. The last write gives `done`, `cancelled` or `error`.
  - A crash loses at most the run in progress.
  - A second Ctrl+C, or a killed process, can leave it at `running`.
- **`trials/<task>/t<i>/`** holds, for each run:
  - `outcome.json`;
  - `scorers.json`;
  - `run.log`, the lines `harness run` would print;
  - `run.json`, a copy of the run record.

```json
{ "version": 1, "evalId": "eval-…", "status": "done",
  "taskSet": { "name": "…", "path": "…", "hash": "…" },
  "workflow": { "name": "…", "path": "…", "hash": "…" },
  "split": "evolve", "k": 3, "provider": { "…": "as in a run record, no keys" },
  "S": 0.67, "C": 4500, "n_expected": 9, "n_done": 9, "missing": 0,
  "per_task": {
    "laptop": { "weight": 2, "mean": 0.67, "rewards": [1, 0, 1], "tokens": [4100, 3900, null], "missing": 0,
                "trials": [ { "trial": 0, "reward": 1, "missing": false, "runStatus": "done",
                              "runMs": 45210, "scoreMs": 3120,
                              "tokens": { "input": 3500, "output": 600 }, "tokenEstimate": 3800,
                              "scorers": [ { "name": "tests", "kind": "command", "passed": true,
                                             "weight": 1, "exitCode": 0, "timedOut": false, "ms": 3050 } ] } ] } } }
```

**The fields:**
- **`S`** pools every run: the sum of task weight × reward over the sum of task
  weights. A missing run counts as 0 and still counts in the sum.
  - If the eval stopped early, `S` covers the runs that finished (`n_done` of
    `n_expected`). It is `null` before the first run finishes.
- **A run is missing** when it could not run or be scored:
  - its provider check failed;
  - `harness-core` stopped;
  - a scorer command could not start;
  - a file could not be copied.

  A run whose agent failed is not missing: it is scored as usual, and the failure
  is in its `error`.
- **`C`** is the average of the runs' token totals (input + output), over the runs
  that have one. It is `null` when none does.
  - **Where the counts come from:** the providers' own counts in each response.
    OpenAI and OpenAI-compatible servers give `usage`; Anthropic gives `usage`;
    Ollama gives `prompt_eval_count` and `eval_count`.
  - **What a run's total covers:** every model call of every agent, its summaries,
    its helpers and its revision attempts. The provider check is not counted.
  - **When a run's `tokens` is `null`:** any of its calls came back without counts,
    for example from a local server that leaves them out. That way `C` is never an
    average of partial counts.
  - **`tokenEstimate`** is the old characters ÷ 4 estimate, kept for comparison.
- **An older `harness-core`** does not report counts: rebuild it
  (`npm run build:core`) after updating.
- **`--json`** prints the report alone on stdout; progress goes to stderr.

Each run's record (`run.json`) also holds every agent's `usage`:
`{ input, output, calls, callsWithoutUsage }`. `harness run` records it too.

## Exit codes

- `0`: the eval finished, whatever the score.
- `1`: `--min-score` was given and `S` is below it.
- `2`: any of these:
  - bad usage;
  - an invalid or unreadable task set, or an invalid workflow;
  - an unapproved scorer command;
  - an `--out` that is not empty, or is inside a workspace or grader files.
- `3`: the eval could not run to its end:
  - `harness-core` is missing or stopped;
  - the first run did not start;
  - a folder or the report could not be written;
  - an unexpected error.
- `130`: interrupted.

The first Ctrl+C stops starting runs, stops the running ones as Stop does, and
writes the report as `cancelled`. A second Ctrl+C exits at once.

## Cost and time

**What runs.** An eval runs `tasks × k` workflows.
- **The provider check.** Every run checks its provider first, as `harness run`
  does, so a run whose server is down counts as missing rather than as a failed
  workflow. For Ollama the check lists the models. For a Custom endpoint it is a
  one-token completion, which can take up to 120 s while the model loads.
- **One run at a time.** Runs go one at a time by default
  (`--max-parallel-trials 1`), because a local server usually answers one request
  at a time, and parallel runs would skew the timings.

## What was checked

These ran on 2026-10-01, on Linux:
- **The project's tests:**
  - vitest 1931 tests (84 files) and 2 skipped;
  - `cargo test` 191, and 191 + 2 for the core build.

  They cover the task set's checks, the scorers, the aggregation (with the cases of
  RRSI's own tests), grader integrity, and token usage from each provider's
  response.
- **The real `harness eval` and `harness-core` against fake model servers,** in a
  network namespace with only loopback, for the eval's first part: 52 scenarios
  and 534 checks, of which 533 passed.
  - **The agents' tampering was undone.** Agents overwrote, deleted and added test
    files and forged a grader; the restores and injects undid all of it.
  - **Approval held:**
    - only the exact approved command ran;
    - agents could not run it;
    - nothing started without approval.
  - **The numbers held.** Timeouts, missing runs, Ctrl+C, `--min-score`,
    parallel runs and every path check behaved as described.
  - **One check failed: the folder-swap race in "The limits".** It needs a process
    an approved command left running.
- **Token counts end to end.** The real `harness-core` against scripted local
  servers: the counts reached the run record and `C`, and a server that sends none
  gave `null`.

**Not run:**
- a real model server (Ollama, llama.cpp, vLLM, LM Studio);
- Windows or macOS.
  - Creating a link on Windows needs the symlink privilege; without it a fixture
    link fails the first run (exit 3).
  - npm's Windows junctions have absolute targets and are refused.
- The report is not in the exact shape RRSI's own loader reads (it adds per-task
  `weight`, `mean` and `trials`).
