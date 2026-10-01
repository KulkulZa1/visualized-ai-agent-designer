# `harness eval`, part 1: the eval (plan)

Spec: `docs/superpowers/specs/2026-10-01-harness-eval-design.md`. Read it first; this
plan does not repeat it. Read `AGENT.md` for the project rules.

## Scope of part 1

**In scope.** Everything in the spec except §5 (token usage) and the docs:
- the task-set file and its checks (§1);
- trials with fresh copies and restored or injected grader files (§2);
- the command and its options (§3);
- `--allow-scorer` (§4, CLI side only);
- the report written after every trial (§6);
- the exit codes (§7);
- `.gitignore` gets `.harness/evals/`;
- the `eval` usage text in `cli/harness.mjs` and in the new command's own usage.

**Out of scope:**
- **Rust.** No Rust changes in this part.
- **Token usage.** Every trial's `tokens` is `null` and `C` is `null`.
  `tokenEstimate` is the sum of the nodes' `tokenEstimate`.
- **Docs.** No docs beyond the usage text: part 3 writes them.

## Where things go

- **`src/cli/evalArgs.ts`:**
  - the parser and `EVAL_USAGE`;
  - it accepts `-k N` as well as `--trials N`.
  - Share the provider options with `runArgs.ts` (`--provider`, `--base-url`,
    `--model`, `--num-ctx`, `--request-timeout`, their environment variables,
    `usesCustomEndpoint`, `providerSettings`). Move them to a shared function
    rather than copying them.
  - `parseRunArgs`'s behavior and tests stay as they are.
- **`src/cli/taskSet.ts`:**
  - the strict zod schema (`z.strictObject` at every level);
  - loading the YAML with the same parser `runCli.ts` uses;
  - every check of §1, before any trial:
    - ids, splits, `taskFile` or `task`;
    - paths inside the task set's folder;
    - no symlinks in a fixture or an injected file;
    - `restore` and `inject.to` inside the trial;
    - `node:` names exactly one agent of the workflow under test.
- **`src/cli/trial.ts`:**
  - creating the trial folder and copying the fixture;
  - one run through `runWorkflow`, with a host like `runHarness`'s:
    - the shared core's `invoke`;
    - the `--allow-command` policy;
    - the eval's interrupt as `isCancelled`;
    - `saveRun` into the trial folder;
    - a reporter (`createReporter`) whose lines go to the trial's `run.log`;
  - the scorers, including the restore and inject replacement (delete, then
    copy);
  - saving `trials/<task>/t<i>/`: the outcome JSON, the scorer results, `run.log`
    and a copy of the run record;
  - deleting the folder unless `--keep-workspaces`.
- **`src/cli/evalReport.ts`:**
  - the aggregation (`S`, `C`, `n_expected`, `missing`, `per_task`);
  - writing `report.json` atomically: a temporary file in the same folder, then a
    rename.
- **`src/cli/evalCli.ts`, `runEval(argv)`:**
  - validation, then the trials in order (`--max-parallel-trials`, default 1);
  - the summary and the exit codes;
  - Ctrl+C.
- **`src/cli/runCli.ts`.** Factor out what `runEval` shares, and keep `runHarness`'s
  behavior and its tests unchanged:
  - loading and validating the workflow;
  - the core path and start;
  - the interrupt.

  The bundle entry stays `src/cli/runCli.ts`; it also exports `runEval` (for
  example by re-exporting it), so `cli/dist/harness-run.mjs` stays one file.
- **`src/cli/report.ts`.** Move the final-agent logic (`finalNodes`, now private)
  to a shared helper. Both the reporter and the `output` scorer use it.
- **`cli/harness.mjs`:**
  - `eval` goes to `runEval`, as `run` goes to `runHarness`, on the raw
    `args[0]`;
  - the header and usage text name `eval`.
- **`tests/node-shims.d.ts`.** Add only the Node APIs you use, for example
  `cpSync`, `lstatSync`, `realpathSync`, `renameSync`, `process.cwd`.
- **The containment helper.** It gets a `[KEEP-IN-SYNC]` marker, like
  `isInsideDir` in `cli/harness.mjs:255-260`, `scripts/offline-bundle-lib.mjs:573`
  and `mcp/server.mjs`.

## Facts to rely on (from a survey; re-check before relying)

- **Running several runs in one process.**
  - `runWorkflow` is re-entrant: its run state is local.
  - One `harness-core` serves concurrent requests.
  - `runHarness` is not reusable as is: it starts a core and installs a SIGINT
    handler per call.
- **Run ids** are `run-${Date.now()}`. Never key anything on a run id alone.
- **`execute_command`** (`process_commands.rs:315-349`):
  - **Arguments:** `workspacePath`, `command`, `consentGranted`, `timeoutSecs`
    (1 to 3600), `commandId`.
  - **A result** is `{ exitCode, stdout, stderr, durationMs }`. A non-zero exit
    code is a result, not an error.
  - **A timeout** is an error, `"Command timed out after N s"`.
  - **A spawn failure** is an error, `"Could not start the command: …"`.
  - **How the eval maps them.** The prefix "Command timed out after" means
    `timedOut: true`, and the scorer fails. Any other error makes the trial
    missing. Put the prefix in one constant with a `[KEEP-IN-SYNC]` comment
    naming `process_commands.rs`. If there is no Rust test pinning both texts,
    say so in your report; part 2 will add one.
- **The reporter.** `src/cli/report.ts:41-49` has the final-agent logic: agents
  that are not Memory or Hook nodes, minus the sources of non-feedback edges.
  - In `run_finished`, a final agent appears only when its output is non-empty.
- **`tests/fixtures/fake-core.mjs`** fakes the core for end-to-end tests.
  - `execute_command` always answers exit 0 today.
  - **Extend it, compatibly.** A scenario key, for example
    `commands: { "<command>": { exitCode, stdout, stderr, timeout: true, fail: "…" } }`,
    should script a command's exit code, a timeout (answer the Rust timeout error
    text) or a start failure. `commandOutput` keeps working.
  - Its per-agent reply counters live for the life of the core, which is the
    whole eval. Script a repeating last reply.

## Tests

**Unit tests:**
- **The task-set schema and checks:**
  - unknown keys at each level;
  - a bad id and duplicate ids;
  - `task` and `taskFile` both or neither;
  - a path leaving the task set's folder;
  - a symlink in a fixture;
  - `restore` and `inject.to` leaving the trial;
  - `node:` naming no agent or two.
- **Scorers:**
  - **output:** `contains`, `notContains` and `matches`, and the `node:` choice;
  - **file:** missing, `contains`, `matches`;
  - **command:** pass, fail, timeout (scores 0, `timedOut`), could not start (the
    trial is missing);
  - **restore and inject are replacements:** an agent's added file under a
    restored folder is gone, and an agent's edit to a restored file is undone.
- **Aggregation**, with rrsi's cases:
  - `{a: [1, 0], b: [1, 1]}` gives `S = 0.75`;
  - the weighted case gives `15/200` (see `rrsi/tests/test_core.py:66-72` at
    `/home/user/google-research/rrsi`);
  - missing trials count 0 with the full denominator;
  - `C` is `null` with no token counts.
- **The approval check:** an unapproved scorer gives exit 2 and lists the
  commands.
- **`evalArgs`:** `-k`, `--trials`, `--only`, `--split`, bad values, the shared
  provider options.

**End to end** (`tests/unit/cli/harnessEval.test.ts`, like `harnessRun.test.ts`):
- the built CLI against the extended `fake-core`, with a small task set:
  - two tasks;
  - k = 2;
  - one command scorer, one output scorer and one file scorer.
- **Assert:**
  - the report's shape and values;
  - that `report.json` exists after the first trial;
  - a missing trial (a provider check that fails, or a scorer that cannot start);
  - a scorer timeout;
  - a grader file the agent overwrote, and a test file it added, both undone
    before the scorer ran;
  - exit 2 for an unapproved scorer and for an invalid task set;
  - exit 1 for `--min-score` above `S`;
  - exit 3 when the first trial cannot start;
  - `--json`;
  - that `--keep-workspaces` keeps the folders and its absence deletes them.

## Checks before you report

Run each and report the result:
- `npx tsc --noEmit`;
- `npx vitest run`, with the counts. Before this part: 1514 passed + 1 skipped,
  75 files;
- `npm run build:cli`;
- `git diff --check`.

**Mutation checks.** Break the main rules on purpose and show the tests fail:
- the pooled `S`;
- missing trials counting 0;
- replacement instead of overlay;
- the approval check;
- containment.

**A live run.** Run the built `node cli/harness.mjs eval …` against `fake-core`
on a small task set, and quote its output and `report.json`.

## Constraints

- **No new dependencies.**
- **No Rust changes.**
- **No docs** beyond the usage text.
- **Don't change existing behavior:**
  - `harness run`'s behavior and tests;
  - the workflow schema;
  - the engine. If the engine needs a change, explain why in your report.
- **No git commands that change anything.** The director commits.
- **AGENT.md's rules apply.** In particular: no command runs without its exact
  approval, and no hidden network calls.
