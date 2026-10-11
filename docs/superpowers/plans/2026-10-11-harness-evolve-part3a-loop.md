# `harness evolve`, part 3a: the loop — Plan

Spec: `docs/superpowers/specs/2026-10-11-harness-evolve-design.md`, §4.2 to §6.
Parts 1 and 2 are done: `src/evolve/{config, schedule, measure, calibrate,
components, jsonl, history, selection, attribution, jsonText, edits, precheck}.ts`.

**Part 3a** is the loop. It drives the baseline, the band, the rounds and the
held-out check through an injected `Children` interface, so every step is tested
without processes.

**Part 3b** comes later and is separate. It brings the command, the real child
processes, the shipped proposer and critic workflows, and the end-to-end test.

## The children (`src/evolve/loop.ts`)

```ts
export interface EvalRequest { workflow: string; split: "evolve" | "smoke" | "heldout"; k: number; out: string; log: string }
export interface EvalReply { code: number; report?: unknown }   // report: <out>/report.json parsed, when it exists
export interface RunRequest { role: "proposer" | "critic"; workflow: string; taskFile: string; workspace: string; log: string }
export interface RunReply { code: number; finalOutput?: string; tokens: { input: number; output: number } | null; error?: string }
export interface Children { eval(r: EvalRequest): Promise<EvalReply>; run(r: RunRequest): Promise<RunReply> }
```

**The exit codes.** These are `harness eval`'s and `harness run`'s: `0`, `1` (a
run whose agent failed), `2`, `3` and `130`.

**What the loop does with each code:**
- **`130`:** stop. The loop returns `{code: 130}` and leaves the step unrecorded, so
  a re-run redoes it.
- **`2`:** fatal, with exit 2. It means a usage problem the up-front checks should
  have caught.
- **`3` from an eval with no report:** fatal, with exit 3. For example,
  `harness-core` is missing.
- **`3` from an eval that has a report:** that evaluation is invalid (§3 of this
  plan).
- **`3` from a run:** fatal, with exit 3: "the proposer run did not start: …".
- **`1` from a run:** a normal attempt, whose output may still parse.

## The context (`EvolveContext`)

The command builds the context, and the loop reads it:
- **The run's folder:** `outDir`.
- **The task set:**
  - `taskSet`, the loaded `TaskSet`;
  - `hasSmoke`;
  - `hasHeldout`;
  - `patterns`, the result of `leakagePatterns`;
  - `protectedAgents`, which maps an agent named by an output scorer's `node:` to
    why it is protected.
- **The workflow:** `workflowText` and its `workflowHash`, the starting workflow.
- **The method:** `cfg`.
- **The pins:** `pins` (below).
- **The search roles:** `proposerFile` and `criticFile`.
- **The I/O:**
  - `children`;
  - `out(line)`, for progress;
  - `interrupted()`.

## State (`src/evolve/state.ts`)

**`Frontier`:**
- **The header:** `version: 1` and `pins`.
- **`base`:** `{hash, S, C}`.
- **`incumbent`:** `{t, file, hash, eval_dir, S, C, variant?}`. `file` and
  `eval_dir` are relative to `outDir`.
- **`S_star`.**
- **`trajectory`:** a list of `{t, S, C, hash, eval_dir}`.
- **`infra_streak`:** a number.
- **`heldout?`:** `{base: {S, C}, final: {S, C, hash}}`.

**`Pins`:**
- `taskSet: {path, hash}`;
- `workflow: {path, hash}`;
- `provider: {llmProvider, baseUrl, model, numCtx}`;
- `k`;
- `config`, the whole `EvolveConfig`.

**The functions:**
- **`pinDiff(a, b)`** lists what differs, readably: `task set (hash)`, `model`,
  and `config: beta1 (40 → 12.5)` (via `configDiff`).
- **`readFrontier(outDir)`** returns `undefined` when there is none.
- **`writeFrontier(outDir, fr)`** writes atomically: to a temp file, then rename.
- **`acquireLock(outDir)`** and **`releaseLock(outDir)`:**
  - `evolve.lock`, created with the `wx` flag and holding the process id;
  - an existing lock whose process is alive (`process.kill(pid, 0)` succeeds)
    returns `{error: "… is in use by process <pid>"}`;
  - a dead one is taken over.

## Evidence and briefs (`src/evolve/brief.ts`)

### `renderTrace(task, trialDir, cap = 12000)`

It reads `outcome.json`, `scorers.json` and `run.log` from
`<evalDir>/trials/<task>/t<i>/`, and renders Markdown:
- the task and trial, the reward and the run status;
- the task's text;
- the scorers: name, kind, passed, exit code and the end of the command output;
- the final outputs (from `outcome.json`'s `outputs`);
- the run log.

When it is over the cap, it cuts the run log first, keeping its end, and then the
outputs.

### `pickTraces(ev, n_fail, n_success)`

This is RRSI's `build_traces` choice:
- **The order:** rank the tasks by `taskMean`, ascending.
- **`fails`:** the first `n_fail`.
- **`wins`:** the last `n_success`, leaving out those in `fails`.
- **Which trial:** the first worst trial of each fail, and the first best trial of
  each win.

It returns `[{task, trial, kind}]`.

### `resultsTable(report, ev)`

A Markdown table: task, mean, rewards, the scorers that failed in any trial (names),
and the first error.

### `proposerBrief(input)`

Markdown. Each section has a `##` title, and nothing is left out silently:
1. **The variant's brief:** "You are variant A of round t. m variants are drafted
   independently from the same workflow this round; each is measured on the whole
   evolve split; the best admissible one becomes the new workflow."
2. **The workflow:**
   - its full text in a `yaml` fence;
   - a table of its agents: name, role, tools, memory read, memory write,
     maxTokens, maxSteps, timeoutSeconds, the agents it gets input from, and the
     agents it sends output to (by name).
   - Agents whose prompt is a file are marked "prompt file: cannot be edited".
3. **The results:**
   - `S`, `C` and k;
   - `resultsTable`;
   - the list of trace files in `evidence/traces/`, each with its task, reward and
     kind.
4. **The edit history:** RRSI's heading text, and `history.render()` as JSON.
5. **The attribution scoreboard:** RRSI's heading text, and the last 20 rows.
6. **Exploration:** the exploration text, and RRSI's reserved-slot paragraph when
   this variant holds the slot.
7. **The components to prune:** the prune set as JSON, or `(none)`.
8. **The edit budget:** "at most b_t edits", with RRSI's sentence.
9. **How to answer:**
   - `OPERATIONS_HELP`: a constant in this file listing every operation, its
     fields and its rule, as the spec's §3.2 table does;
   - the component list (K) and what each covers;
   - the output contract with a full example;
   - RRSI's rules (one independent change per edit, at most b_t, …).
10. **The task:**
    - first attempt: "Address the highest-impact failures within your budget…";
    - repair: "REPAIR ROUND: your previous proposal is below; the objections
      follow. Send the whole corrected proposal; it is applied to the current
      workflow from scratch." Then the previous proposal (JSON, or the first 2000
      characters of the raw output) and the objections.

### `criticReview(input)`

Markdown:
- the task set's name;
- the candidate's summary and the targets;
- the declared edits (JSON);
- the rendered change (`renderChange`);
- the workflow's agents table;
- the answer contract: one JSON object
  `{"verdict": "accept" | "reject", "reasons": [...], "risk_notes": [...]}`.

**A guard test** checks that every `op` of the schema appears in
`OPERATIONS_HELP`.

## The loop (`src/evolve/loop.ts`)

**`drive(ctx)`** returns `{ code: 0 | 2 | 3 | 130; error?: string }`.

### 1. Resume or start

- **Read the frontier.**
  - When there is one and `pinDiff(fr.pins, ctx.pins)` is not empty, return exit 2:
    "this folder holds a run with different settings: …; use a new --out".
  - When there is none, write `base.harness.yaml` if it is missing, then do the
    baseline (§2). `base.harness.yaml` is the starting workflow's text, written
    once through the YAML document: `parseDocument(text).toString({ lineWidth: 0 })`.
    The values stay the same. The layout becomes what `applyProposal` writes, so a
    candidate's `diff.txt` shows only its edit and not reformatting.
- **Check the incumbent's file.** `sha256(read(outDir/fr.incumbent.file))` must
  equal `fr.incumbent.hash`, else exit 2: "<file> changed since round t; restore it
  or use a new --out".
- **Rewrite the convenience copy.** Then rewrite `incumbent.harness.yaml` from it.

### 2. The baseline

- **The smoke check first.** When `ctx.hasSmoke`, run `eval smoke, k 1 → base-smoke/`,
  reusing a `done` report. `smokeProblem(report)` (§4) not being undefined is exit
  3: "the workflow fails its own smoke tasks: …".
- **The evaluation.** Run `eval evolve, k → base/`, reusing a valid `done` report.
  An invalid one is exit 3: "the baseline is invalid: …".
- **The frontier.** Write it with `t: 0`, the file `base.harness.yaml`, `eval_dir:
  base`, and `S_star = S`.
- **The history.** Append RRSI's `BASELINE` record.
- **Print:**
  - `baseline: S 0.500 C 4200 (6 runs, 9 min)`;
  - the cost estimate: "measuring a candidate takes about N min; a round about
    m × that, plus the proposer's and critic's runs".

### 3. Evaluations: `evaluateInto(dir, workflow, split, k)`

It returns `{ ev } | { invalid } | { stop } | { fatal }`.
- **Reuse.** When `dir/report.json` is `done`, it is used as it is.
- **A report that is not `done`:** delete `dir`, then run the evaluation again.
- **Folders.** `harness eval` refuses an `--out` that is not empty, so a fresh run
  always gets a missing or emptied folder.
- **Logs.** The child's log goes to `dir + ".log"`.

**For a candidate:**
- **A crash** (exit 3 with a report whose status is `error`) makes it
  `eval_invalid`, with the report's `error` as the detail.
- **Too many missing trials** (`tooManyMissing`): rename `eval/` to `eval-failed/`
  and run it once more. Still too many is `eval_invalid`.
- **On resume,** `eval-failed/` existing means the retry was spent.

### 4. `smokeProblem(report)`

- **Not `done`:** `"the smoke evaluation ended <status>: <error>"`.
- **Otherwise,** the first smoke trial that is missing or has `runStatus: "error"`
  gives `"task <id>: <error>"`.
- **Else** undefined.

### 5. The band

- **`cfg.delta` is set:** use it.
- **Otherwise, `calibration.json` exists:** use its `delta`.
- **Otherwise, calibrate:**
  - the evaluations are `base/` plus `calib-1 … calib-(calibrate−1)`, each
    reusable;
  - `calibrate(evals, cfg.delta_z)`;
  - add `jobs`;
  - write the file;
  - print
    `noise band δ 0.212 (bootstrap over the baseline's runs, z 2) — a candidate must reach S* − δ`.
- **An invalid evaluation** is exit 3.

### 6. A round t

The round runs for t from `trajectory.length − 1` up to `T − 1`. This is RRSI's
`round`, reading the spec's §5.
1. **The incumbent's evaluation.**
   - `incEv` is `fromReport(job, raw)`, with `raw` the parsed
     `outDir/fr.incumbent.eval_dir/report.json`.
   - `incReport` is the raw report.
2. **The traces.** `pickTraces`, then `renderTrace` into
   `r<t>/evidence/traces/<task>-t<i>.md`. The results go to
   `r<t>/evidence/results.md`.
3. **The directives.**
   - `b = editBudget(t, T, …)`;
   - `σ = stallFlag(trajectory S list, t, w, δ)`;
   - `explore = exploration(…)`;
   - `prune = history.pruneSet(t, n_prune)`;
   - `rows = history.render()`;
   - the scoreboard is the last 20 rows of `attribution.jsonl`.

   They are written to `r<t>/directives.json`, and a line is printed:
   `round 3/20: budget 2, stalled no, untried [memory, subagent], prune [config]`.
4. **Draft each variant** in turn (§7). A reserved slot goes to the variants with
   `σ && untried.length > 0 && v ≥ m − m_draft`.
5. **Evaluate each ready candidate** in turn: `evaluateInto(r<t>/<V>/eval, …)`.
6. **Select.**
   - `selectRound(cands, incEv, S_star, δ, cfg, history.incumbentComponentCounts())`;
   - write `decisions.json`.
   - **History records.** For every candidate that `history.has(t, v)` does not
     already have, append the records. The outcomes are `ACCEPTED`, `LOST`,
     `REJECTED` or the gate failure; the diff path and the reason or detail are
     RRSI's.
   - **Attribution.** For a measured candidate, append its rows.
   - **Print** one line per candidate, as RRSI's log does:
     `A: S 0.667 dS +0.167 dC +0.143 ν 0 → ACCEPTED: admissible: …`.
7. **Settle.**
   - **A winner** becomes the incumbent:
     `{t: t+1, file: r<t>/<V>/candidate.harness.yaml, hash, eval_dir: r<t>/<V>/eval, S, C, variant}`,
     and `S_star = max`.
   - **The trajectory:** keep the entries with `t ≤ t`, then append
     `{t+1, S, C, hash, eval_dir}`.
   - **`infra_streak`** is `+1` when every candidate is `eval_invalid` (and there
     is at least one), else 0.
   - Write the frontier, then rewrite `incumbent.harness.yaml`.
   - **A streak of 3 or more** is exit 3: "three rounds in a row ended with every
     candidate's evaluation invalid; check the model server".

### 7. Drafting variant V (`r<t>/<V>/`)

**Resuming.** When `prep.json` exists, return the candidate it records: either a
gate failure, or ready with `{file, hash, edits, diff, summary}`. Otherwise empty
the folder and draft.

**For attempt a = 0 … `repair_rounds`:**
1. **The proposer's workspace,** `a<a>/proposer/`:
   - `brief.md`, from `proposerBrief`, with the repair section from attempt 1 on;
   - `workflow.harness.yaml`, the incumbent's text;
   - `evidence/`: copies of `r<t>/evidence/*`, plus `history.json` (the full
     render) and `scoreboard.json`.
2. **The run.** Call `children.run({role: "proposer", …, log: a<a>/proposer.log})`.
   - **130** means stop.
   - **2 or 3** are fatal.
3. **Parse.** Parse the final output.
   - **No output, or no proposal object:** the objection says why, and the failure
     kind is `no_proposal`.
   - **A schema error:** the failure kind is `invalid_proposal`.
4. **Check.** `checkBudget`, then `applyProposal`. Any problem gives
   `invalid_proposal`, with the problems as the objections.
5. **Precheck.** A `precheck` hit gives `critic_reject`, with the hits as the
   objections.
6. **The critic,** up to 3 runs, in `a<a>/critic-<i>/` with `review.md`.
   - **The verdict** is the last object from `jsonObjectsIn` whose `verdict` is
     `accept` or `reject`. `reasons` and `risk_notes` become string arrays.
   - **No verdict after 3 runs:** reject, with
     `critic output unparseable after 3 attempts: <first 200 chars>`.
   - **A reject** gives `critic_reject`. The objections are the reasons, plus the
     risk notes as `risk: …`.
7. **The reserved slot.** When this variant holds the slot, `checkReservedSlot` on
   the classified edits. A failure gives `critic_reject`, as in RRSI.
8. **Attempt records.**
   - `a<a>/proposal.json` holds the parsed proposal or the error, the objections,
     the failure kind, and the proposer's and critic's tokens.
   - Each step prints one indented line, for example
     `A: proposal 2 edits [prompt, client_tool] → critic reject (repair 1/2): …`.

**When an attempt passes:**
- **Write** `candidate.harness.yaml` (the applied text), `diff.txt` (`diffFile`)
  and `change.txt` (`renderChange`, which needs the incumbent the edits applied to:
  call it only after `applyProposal` succeeded).
- **Smoke**, when `ctx.hasSmoke`: `evaluateInto(smoke/, candidate, smoke, 1)`.
  - A `smokeProblem` gives `smoke_fail`.
  - An invalid smoke evaluation gives `smoke_fail` too, with its reason.
- **Write `prep.json`** as ready, with the classified edits (`component`,
  `declared`, `retagged`, and the edit's metadata, but not its `ops`) and the
  `summary`.

**When the attempts run out:** write `prep.json` with the last failure kind, the
detail (the last objections joined, at most 600 characters), and the last
proposal's edits, classified when it parsed.

### 8. The held-out check

It runs only when `ctx.hasHeldout`.
- **Skip it** when `fr.heldout` exists and `fr.heldout.final.hash` equals
  `fr.incumbent.hash`.
- **Evaluate:**
  - `heldout/base` from `base.harness.yaml`;
  - `heldout/final` from the incumbent, unless its hash is the base's (then the
    final is the base);
  - with k each.
- **An invalid evaluation** is exit 3, with the reason.
- **Store** `fr.heldout` and print it.

### 9. The summary

Printed at the end and on a re-run of a finished run:
- **The scores:** base `S`/`C`, final `S`/`C` and the round it was reached, and
  `S*`;
- **Acceptances:** how many rounds accepted a candidate;
- **Held-out:** base and final;
- **The result:** the path of `incumbent.harness.yaml`, and "to use it, copy it over
  <the workflow file>".
- **A warning** when no candidate was ever accepted and `δ` exceeded 0.2: the band
  was wide, and more tasks or trials shrink it.

### Ctrl+C

- **Before each child,** check `interrupted()`. When set, return `{code: 130}`.
- **A child that returns 130** stops the loop the same way.
- **Nothing half-done is recorded.** `prep.json`, `decisions.json` and the frontier
  are written only when their step is complete.

## Tests (`tests/unit/evolve/loop.test.ts`, `brief.test.ts`, `state.test.ts`)

**The fake children.** Use a fake `Children` that:
- **for an eval,** writes a `report.json` built with `buildReport` from
  `src/cli/evalReport.ts`. The rewards and tokens are scripted by the workflow's
  text: for example, reward 1 when the text contains `be excellent`, else 0.
- **for a run,** returns a scripted final output per role and per call count.

**The cases:**
- **A full run,** T = 2 and m = 2: the baseline, the bootstrap band, round 0 with
  candidate A accepted and B rejected, round 1 with none admissible, the held-out
  check, and the summary.
- **The files:** the frontier, history, attribution, decisions and the convenience
  copy each hold what they should.
- **Each gate:**
  - `no_proposal` (no output, then garbage);
  - `invalid_proposal` (over budget; an unknown agent);
  - `critic_reject` by the precheck, by the critic, by unparseable output after 3
    runs, and by the reserved slot;
  - `smoke_fail`;
  - `eval_invalid` by a crash, and by too many missing trials after the retry.
- **Repair:** the second attempt's brief holds the objections and the previous
  proposal; a repaired proposal is accepted.
- **Resume:** a fake child throws, or returns 130, at each step: the baseline, a
  proposer run, a critic run, the smoke check, a candidate's eval, the held-out
  check. Then:
  - the next `drive` finishes;
  - no history record is duplicated;
  - the evaluations already `done` are not run again (count the calls).
- **The pins:** a mismatch is exit 2 with the readable differences. A changed
  incumbent file is exit 2.
- **The lock:** taken by a live process, or by a dead one.
- **Exit 3 for:**
  - an invalid baseline;
  - a base that fails its smoke check;
  - a proposer run that did not start (exit 3);
  - three `eval_invalid` rounds in a row.
- **Fatal codes:** a child's exit 2 is exit 2; an eval's exit 3 with no report is
  exit 3.
- **`brief.test.ts`:**
  - the sections are present;
  - the reserved-slot paragraph appears only for a slot holder;
  - the repair section appears;
  - every schema op is in `OPERATIONS_HELP`;
  - file-prompt agents are marked;
  - `renderTrace` respects the cap;
  - `pickTraces` matches RRSI's choice on a hand-made evaluation.

## Checks

- `npx tsc --noEmit`: clean.
- `npx vitest run tests/unit/evolve`.
- `npx vitest run`: the whole suite.
