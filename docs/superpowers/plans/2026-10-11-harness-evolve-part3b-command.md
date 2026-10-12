# `harness evolve`, part 3b: the command — Plan

Spec: `docs/superpowers/specs/2026-10-11-harness-evolve-design.md`, §6 to §8.
Parts 1, 2 and 3a are done. `src/evolve/loop.ts` has `drive(ctx)`, with an injected
`Children`.

Part 3b covers:
- the command and its up-front checks;
- the real children (`harness eval` and `harness run` as child processes);
- the shipped proposer and critic workflows;
- the end-to-end test with the built CLI and the fake core.

## `src/cli/evolveArgs.ts`

**`parseEvolveArgs(argv, env)`** returns `{ args } | { error }`, written in the
style of `parseEvalArgs` (`src/cli/evalArgs.ts`). It reuses `PROVIDER_FLAGS`,
`parseProviderFlag` and `finishProviderArgs` from `src/cli/runArgs.ts`.

**The options** are the spec's §7:
- `<tasks.yaml>`;
- `--workflow`, `--out`, `--rounds`;
- `-k` and `--trials`;
- `--candidates`, `--delta`, `--calibrate`, `--config`;
- `--proposer`, `--critic`, `--proposer-model`, `--critic-model`;
- `--allow-scorer` and `--allow-command`, both repeatable;
- the provider flags and `--core`.

**Rules:**
- **Numbers** are checked as integers or finite numbers. Their bounds are left to
  `configFromJson`, so the messages come from one place.
- **`--proposer-model` and `--critic-model`** follow `--model`'s rule: only for
  Ollama and OpenAI-compatible endpoints, where `--model` applies.
- **`EVOLVE_USAGE`** follows `EVAL_USAGE`'s layout and appends
  `PROVIDER_OPTIONS_USAGE` and `PROVIDER_ENV_USAGE`.

## `src/cli/evolveCli.ts`

**`runEvolve(argv)`** returns an exit code, as `runEval` does. It is wrapped so that
an unexpected error prints `harness evolve: unexpected error: …` and gives 3.

### The checks

These run before anything else. Each failure is exit 2.
1. **The arguments** (`--help` prints the usage and exits 0).
2. **The task set** (`loadTaskSet`).
   - It needs at least one evolve task.
   - **Scorer commands:** every split's must be approved
     (`unapprovedScorerCommands` over all tasks, with the same message as eval).
3. **The workflow** (`--workflow`, or the task set's `workflow:`).
   - `loadWorkflow` and `checkWorkflowGraph`.
   - Its agent names must be unique.
   - `nodeProblems` over all tasks.
   - **A note, not an error:** "agents A, B read their prompts from files; the loop
     cannot change those prompts".
4. **The proposer and the critic** (`--proposer` and `--critic`, defaulting to
   `examples/evolve/*.harness.yaml` relative to the CLI bundle:
   `new URL("../../examples/evolve/…", import.meta.url)`). Each needs `loadWorkflow`
   and `checkWorkflowGraph`.
5. **The config.**
   - **Its sources,** lowest first:
     - the defaults;
     - the `--config` file (strict JSON);
     - the task set's `trials` for `k`, when neither `--config` nor `-k` sets it;
     - the flags `--rounds` (T), `-k` (k), `--candidates` (m), `--delta`,
       `--calibrate`.
   - They are combined by `configFromJson`.
6. **`--out`.**
   - **The default** is `.harness/evolve/<task-set base name without .yaml/.yml
     and a trailing .tasks>`.
   - **Placement:** it must not be inside a task's workspace or an inject source.
     Export `evalCli.ts`'s `outDirProblem` and call it with `explicit = true`, so
     that the empty-folder rule does not apply: evolve's folder is reused on
     purpose.
7. **The pins:**
   - the task set's path and hash;
   - the workflow's absolute path and its SHA-256;
   - the provider settings from `providerSettings` (`llmProvider`, the Ollama or
     custom base URL, the model, `ollamaNumCtx`; no keys);
   - `k`;
   - the config.

Then it does three things:
- takes the lock (exit 2 when it is in use);
- installs Ctrl+C with `createInterrupt(err, exit, "evolve")`;
- runs `drive(ctx)`, releases the lock in `finally`, and returns the code. When
  `drive` returns an error, it prints `harness evolve: <error>`.

### The real children

**The CLI script** is `fileURLToPath(new URL("../harness.mjs", import.meta.url))`.
Each child is `spawn(process.execPath, [script, "eval" | "run", …], { env:
process.env })`.

**The provider flags** given to `evolve` are passed on unchanged: `--provider`,
`--base-url`, `--model`, `--num-ctx`, `--request-timeout`, `--core`.

**An eval** runs `eval <tasks> --workflow <w> --split <s> -k <k> --out <dir>`, with
every `--allow-scorer` and every `--allow-command`.
- **Its output:** each stdout and stderr line is printed indented by 4 spaces, and
  appended to the request's log.
- **After it exits,** `report.json` is parsed when it exists.

**A run** runs `run <w> --task-file <f> --workspace <dir>`, with `--model` set to
the role's model: `--proposer-model` or `--critic-model`, falling back to `--model`.
It gets no `--allow-command`.
- **Its output** goes to the log only.
- **After it exits,** it reads the one run record under
  `<workspace>/.harness/runs/*/run.json`.
  - **`finalOutput`** joins the outputs of the final nodes, with `finalNodes` from
    `src/cli/report.ts` (export it if needed), on the role's workflow graph.
  - **`tokens`** sums the nodes' `usage`; it is null when there is none.
  - **`error`** is the record's or the log's last error line.

**The exit code** comes from the child. A signal death (`code === null`) maps to
130 when the evolve process itself was interrupted, else to 3.

### Wiring

- **`src/cli/runCli.ts`:** add `export { runEvolve } from "@/cli/evolveCli";`.
- **`cli/harness.mjs`:**
  - dispatch `evolve` as `eval` is dispatched;
  - add it to the header comment and the top-level usage;
  - give it the same "build the CLI bundle first" message.
- **`.gitignore`:** add `.harness/evolve/`.

## `examples/evolve/proposer.harness.yaml` and `critic.harness.yaml`

Valid workflows: `meta`, `agents`, `connections: []`, `executionSettings`,
`nodePositions`. Copy the field layout from
`examples/research-synthesis.harness.yaml`.

**`proposer`:**
- **The agent:** one, "Harness Engineer", role `worker`, with tools `read_file`,
  `list_files` and `grep`.
- **Limits:** `maxTokens` 4096, `maxSteps` 12, `timeoutSeconds` 1800.
- **The model:** `qwen2.5-coder:7b`, as the other examples use.
- **Its prompt** adapts RRSI's proposer `SYSTEM_TMPL` (`rrsi/propose.py`) to a
  workflow, keeping its substance:
  - a different, frozen model runs the workflow;
  - improve the workflow from that model's side, with the traces as evidence;
  - the only thing you can change is the workflow file, through the operations in
    the brief;
  - there is no abort;
  - one independent change per edit, within the budget;
  - honour a reserved slot;
  - pruning is legitimate;
  - `predicted_affected` names real task ids;
  - no task-specific names, values or answers;
  - the workflow runs unattended on every task;
  - answer with the JSON object only, at the end.
- **What it must not hold:** the operation table. The brief carries it.

**`critic`:**
- **The agent:** one, "Harness Critic", role `critic`, with no tools.
- **Limits:** `maxTokens` 2048, `maxSteps` 1, `timeoutSeconds` 900.
- **Its prompt** adapts RRSI's critic `SYSTEM_TMPL` (`rrsi/critic.py`): the six
  REJECT rules, rewritten for workflow changes (prompts, agents, tools, memory
  keys, edges, limits). It keeps the litmus test and "Runtime correctness is NOT
  your job". It answers with the JSON verdict only.

## The fake core

`tests/fixtures/fake-core.mjs` gets one scenario key, `when`:

```json
{ "<agent>": [ { "contains": "<text>", "text": "<reply>" } ] }
```

- **Matching.** For a model call by that agent, the first rule whose `contains`
  occurs in the system prompt answers with its `text`. Otherwise `replies` applies
  as now.
- **Docs and a test.** Document it in the file's header comment, and test it in the
  existing fake-core test, if there is one.

## The end-to-end test (`tests/unit/cli/harnessEvolve.test.ts`)

Build the bundle into a private folder, as `harnessEval.test.ts` does, and run
`node <private>/cli/harness.mjs evolve …` with `HARNESS_CORE=fake-core.mjs` and
`FAKE_CORE_SCENARIO`.

**The setup:**
- **The task set:** two evolve tasks (one with `smoke: true`) and one held-out
  task. Each has an `output` scorer with `matches: ["\\bexcellent\\b"]`. `matches`
  is not in the precheck.
- **The policy workflow:** one agent, "Writer", with the inline prompt
  `Write an answer.`
- **The scenario:**
  - **Writer:** `when` the prompt contains `be excellent`, it replies
    `an excellent answer`; otherwise `a plain answer`.
  - **Harness Engineer:** a proposal with one `replace_text` on Writer's prompt,
    `Write an answer.` → `Write an answer. Always be excellent.`
  - **Harness Critic:** `{"verdict": "accept", "reasons": [], "risk_notes": []}`.
- **The options:** `--provider ollama --model fake`, `--rounds 1`,
  `--candidates 1`, `-k 1`, `--delta 0.1`, `--proposer` and `--critic` pointing at
  the repo's `examples/evolve/` files, and `--out` in a temp folder.

**The cases:**
1. **Exit 0.**
   - The output has `ACCEPTED`.
   - `frontier.json` has the trajectory `[0, 1]` in S.
   - `incumbent.harness.yaml` contains `be excellent`.
   - `history.jsonl` has a `BASELINE` and an `ACCEPTED` record.
   - The held-out final S is 1 and the base is 0.
2. **A re-run** with the same options exits 0, prints the summary, and runs no
   child. Check that no new eval folders appear.
3. **The critic rejects:** a scenario where Harness Critic answers `reject`, with
   `--config` setting `repair_rounds: 0`.
   - Exit 0.
   - `critic_reject` is in the history.
   - The incumbent is unchanged.
4. **A changed `--model` on resume** is exit 2, naming the model.
5. **An unapproved scorer command** in the held-out split is exit 2, before
   anything runs: no `base/` folder.

## Checks

- `npx tsc --noEmit`: clean.
- `npx vitest run`: the whole suite, which builds the CLI bundle in the e2e tests.
- **The real command, once:**
  - `npm run build:cli`;
  - then `node cli/harness.mjs evolve --help`.
