# `harness evolve` — Design

Date: 2026-10-11 · Branch: `ccr-ac944598-tom0ws` (from master `baf4b20`, with #15)

Phase P2 of `2026-10-01-airgapped-self-improvement-design.md`: a port of RRSI's loop
(`google-research/rrsi` at `be50316`) that improves a `.harness.yaml` workflow
against a task set, offline, with `harness eval` as its measurement.

## Goal

`harness evolve <tasks.yaml>` takes a workflow and, over T rounds:
- has a proposer draft m candidate edits of it;
- screens them with a critic;
- measures the survivors with `harness eval`;
- keeps the best one only when it beats the noise and pays for its tokens.

Everything runs against a local model server with no route out. The model is never
retrained; only the workflow changes.

## Decisions

### A change from the saved plan: no git worktrees

The P2 plan said "candidates in git worktrees". This design drops git, because **the
harness is one file**:
- The engine reads a file prompt (`promptSource: {type: file}`) from the run's
  workspace (`src/services/execution/promptSource.ts`).
- In an eval trial, that workspace is a fresh copy of the task's fixture, which
  belongs to the frozen task set. Hook scripts live there too.
- So the only part of the harness a loop can change is the `.harness.yaml` file
  itself: its inline prompts, agents, tools, memory keys, edges and limits.

A candidate is one file in the run's folder. The incumbent is a copy of the best
file, and its hash is kept in `frontier.json`. Git would add a repository
requirement, a `git` binary and a checkout per candidate, and give nothing for a
single file.

**The consequence:** a workflow whose prompts are files cannot have those prompts
evolved. The loop says so at the start and suggests inlining them.

### Other decisions

These are conventional choices, taken without asking the user:
1. **One command.** `harness evolve` does the baseline and the calibration when they
   are missing, then rounds up to T, then the held-out check. A re-run with the same
   `--out` resumes.
2. **The roles are workflows.**
   - The proposer and the critic are `.harness.yaml` workflows, run with
     `harness run`.
   - Every measurement is a `harness eval` run.
   - Both run as child processes of the same CLI, so `harness evolve` itself never
     calls a model or `harness-core`.
3. **One provider, separate models.** `--model` is the policy's model.
   `--proposer-model` and `--critic-model` default to it. (RRSI uses a stronger
   model for the search roles.)
4. **Cost.** `C` counts the policy's tokens only, as RRSI does. The proposer's and
   the critic's tokens are recorded per round, but never enter selection.
5. **Structured edits.**
   - The proposer does not edit files. It returns a list of edits, each made of
     operations on the workflow by agent name, and the loop applies them.
   - This way every change belongs to a declared edit, and each edit's component
     follows from its operations.
   - Weak models also handle it better: a few small JSON operations instead of
     rewriting a 300-line YAML file.
6. **The analyst is folded into the proposer.**
   - RRSI's analyst and digesters are separate model pipelines. Here, the loop
     writes the evidence to files and a short summary into the proposer's task.
   - The proposer workflow does its own analysis. The shipped one is a single agent,
     and a user can evolve it into more.
7. **Engineering defaults for local models.** These knobs are outside RRSI's method:
   - 2 repair rounds (RRSI: 5);
   - 4 failing and 2 passing traces (RRSI: 22 and 6);
   - 12 000 characters per trace.

## Non-goals

- RRSI's `readjudicate` and `reevaluate` commands; evaluating candidates in parallel.
- RRSI's separate analyst and digester models (see decision 6).
- Git branches, commits or merges of the evolved workflow.
- An app UI for evolve.
- Evolving prompt files, hook scripts, the model, or anything outside the workflow
  file.
- Run reports in the exact shape RRSI's own loader reads.

## 1. The method, as ported

`src/evolve/` holds the method as pure functions, each with its RRSI source file.
Symbols and defaults are RRSI's (`rrsi/config.py`):

| Symbol | Meaning | Default |
|---|---|---|
| `T` | rounds, t = 0..T−1 | 20 |
| `k` | trials per task in each evaluation | the task set's `trials`, else 2 |
| `m` | candidates per round | 2 |
| `b_min`, `b_max` | bounds of the edit budget | 1, 4 |
| `w` | stall window | 3 |
| `m_draft` | candidate slots reserved for exploration when stalled | 1 |
| `delta` | noise band | measured (§1.3) |
| `delta_z` | `delta = delta_z · sd(null ΔS)` | 2.0 |
| `beta0`, `beta1` | cost rule for a gaining candidate | 0.10, 40 |
| `w_s`, `w_c`, `w_n` | shaped rule within the band | 100, 15, 0.5 |
| `n_prune` | window of the yield summary | 4 |
| `repair_rounds` | proposer retries after a check or the critic says no | 2 |
| `invalid_missing_frac` | an evaluation with more missing trials is invalid | 0.15 |
| `n_fail_traces`, `n_success_traces` | traces shown to the proposer | 4, 2 |

**Units.**
- `S` is a fraction in [0, 1]. `C` is the mean policy tokens per trial.
- `ΔC` is relative: `(C' − C_t) / C_t`, and 0 when either side has no count.
- So `beta0 = 0.10` means "10% more tokens for free".

### 1.1 The edit budget (`schedule.py`)

`b_t = ceil(round(b_min + (b_max − b_min) · ½(1 + cos(πt/T)), 9))`.
- `t` is clamped to [0, T].
- `T ≤ 0` gives `b_max`.
- The rounding to 9 decimals guards against floating-point error at t = T.

### 1.2 Measurement (`evaluate.py`)

An evaluation is read from a `harness eval` report into RRSI's view: per task, the
trials' rewards, weights (the task's weight), token totals and missing count.

`S` and `C` are recomputed from the trials, with RRSI's `aggregate`:
- **`S`** pools every trial: Σ reward·weight / Σ weight. A missing trial counts as
  0 with its full weight.
- **`C`** is the mean of the token totals above 0.

A test checks that these agree with the report's own `S` and `C`.

**An invalid evaluation.** An evaluation whose report is not `done`, or whose
missing trials exceed `invalid_missing_frac · n_expected`, is invalid.
- A candidate's evaluation is run again once, as RRSI's `_evaluate` does.
- An invalid baseline stops the run.

### 1.3 The noise band (`calibrate.py`)

`delta` comes from one of three places:
- **`--delta`**, if given.
- **One baseline evaluation** (the default): a bootstrap.
  - Trials are resampled within each task, 2000 times, with a seeded PRNG.
  - Then `sd_null = √2 · se · √(pooled k / k)`.
- **`--calibrate R`**, with R ≥ 2: the R evaluations of the unchanged workflow give
  `sd_null = stdev(S) · √2`. The bootstrap is used when that is 0.

Then `delta = delta_z · sd_null`. It is saved in `calibration.json`, with RRSI's
fields.

### 1.4 Selection (`selection.py`)

For each candidate with a valid evaluation, compute `ΔS`, `ΔC` and the novelty `ν`
(§1.6). The candidate is **admissible** when all three hold:
- **The floor:** `S' ≥ S* − delta`.
- **The cost rule:**
  - if `ΔS > delta`, then `ΔC ≤ beta0 + beta1·ΔS`;
  - otherwise, `w_s·ΔS − w_c·ΔC + w_n·ν > 0`.
- **No guard is violated.**
  - A guard is a non-compensatory check passed in by the caller.
  - The loop passes none. The parameter is ported for the tests.

The winner is the admissible candidate with the highest `S'`. Then
`S* = max(S*, S_winner)`. If none is admissible, the incumbent stays.

Each `Decision` keeps RRSI's reason text:
- the floor;
- the cost rule and its numbers;
- "domain guard violated";
- the gate failure.

### 1.5 The history (`history.py`)

`history.jsonl` has one record per **edit**, with RRSI's fields:
- `t`, `variant`, `edit_id`, `component`, `hypothesis`, `targets_mode`,
  `predicted_affected`;
- `diff` (the path of the candidate's change file);
- `delta_S`, `delta_C`, `accepted`, `outcome`, `S`, `C`, `bundle`, `detail`, `ts`.

`outcome` is one of:
- `ACCEPTED`, `REJECTED` or `LOST`, for a measured candidate;
- `BASELINE`;
- a gate failure: `no_proposal`, `invalid_proposal`, `critic_reject`, `smoke_fail`
  or `eval_invalid`.

**Summaries:**
- **`measured`:** records with a `delta_S` and a component in K.
- **`tried` (`T_t`):** the components that have a measured edit.
- **`yield_g(t, n_prune)`:** per tried component, the best `delta_S` within the
  window `t − t_i ≤ n_prune`; `−∞` when nothing is recent.
- **`prune_set`:** the components with `g ≤ 0`, each with the accepted edits to
  remove.
- **`incumbent_component_counts`:** accepted edits per component.
- **`render(40)`:** the last 40 records for the proposer. At most 4 unmeasured ones
  are kept.
- **`has(t, variant)`:** lets a resumed round skip records already written.

**Stalls:**
- **`stall_flag(trajectory, t, w, delta)`:** `1[S_t − S_{t−w} ≤ delta]`, and 0
  while fewer than w rounds exist.
- **`exploration(t, σ, tried, m_draft)`:** the untried components and RRSI's
  three texts (stalled, not stalled, all exercised), adapted to K below.

### 1.6 Novelty (`components.py`)

`ν` counts the structural components (§2) that the candidate's edits touch and that
have no accepted edit in the incumbent yet. It only ever breaks a tie inside the
band.

### 1.7 Attribution (`loop.py: attribute`)

`attribution.jsonl` has one row per edit of a measured candidate:
- **`predicted_hit`:** the predicted tasks whose mean rose.
- **`hit_rate`:** the share of predicted tasks that rose.
- **`unpredicted_regressions`:** tasks whose mean fell by at least `1/k` and that
  were not predicted (at most 12).

The last 20 rows are shown to the proposer as its scoreboard.

## 2. The components of a workflow (K)

RRSI's K names the kinds of change to a code harness. For a workflow, K is the set
of things an operation (§3) can change:

| Component | Operations | Structural |
|---|---|---|
| `prompt` | `replace_text`, `set_text` (an agent's prompt or description) | |
| `config` | `set` `maxTokens`, `maxSteps`, `timeoutSeconds`, `thinkDepth` | |
| `control_flow` | `connect`, `disconnect`, `set_role` | |
| `context_mgmt` | `add_memory_read`, `remove_memory_read` | |
| `memory` | `add_memory_write`, `remove_memory_write` | yes |
| `client_tool` | `add_tool`, `remove_tool` | yes |
| `subagent` | `add_agent`, `remove_agent` | yes |

**Why not RRSI's own K.** RRSI's `skill` and `output_plumbing` have no workflow
counterpart. A component no operation can reach would keep the exploration
directive pointing at something impossible.

**An edit's component** is the most structural one among its operations, in this
order:

`subagent > memory > client_tool > control_flow > context_mgmt > config > prompt`

- **Examples.** An edit that adds an agent and connects it is `subagent`. One that
  adds a tool and tells the prompt to use it is `client_tool`. This is RRSI's
  `classify_diff` rule (structural signals first, `prompt` last), made exact.
- **The declared tag.** The proposer still declares a component per edit. If it
  differs, the edit is re-tagged and the change is logged, as in RRSI.
- **The budget** counts declared edits: `b_t` at most.
- **Bundling.** One edit that bundles independent mechanisms is for the critic to
  judge, as RRSI's critic rule 4 does. A change outside every declared edit cannot
  happen: every operation belongs to an edit.

## 3. Machine edits

### 3.1 The proposal

The proposer workflow's final output must contain one JSON object, fenced or not:

```json
{ "summary": "one line",
  "edits": [
    { "id": "C1", "component": "prompt",
      "hypothesis": "the mechanism and why it should move the score",
      "targets_mode": "the failure it targets",
      "predicted_affected": ["task-id"],
      "retroactive_check": "which failing tasks would have moved, which passing ones it could break, why it transfers",
      "ops": [ { "op": "replace_text", "agent": "Critic", "field": "prompt", "old": "…", "new": "…" } ] } ] }
```

The final output is the output of the agents nothing follows, as for an `output`
scorer.

**Parsing.**
- The last JSON object that has an `edits` array is the proposal.
- **Required fields:** `id`, `component`, `hypothesis` and `ops`.
- **Optional fields:** RRSI's other fields (`targets_mode`, `predicted_affected`,
  `retroactive_check`, `why_not_lower_lever`, `trigger_condition`,
  `regression_risk`) are kept when present. RRSI requires most of them; a local
  model gets a repair round less often this way.
- **Unknown keys** are an error, in a proposal, an edit or an operation. A
  misspelled `agnet` must not be ignored.

### 3.2 The operations

Agents are named by `name`, and the loop requires names to be unique. Operations
apply in order, edit by edit, to the incumbent.

| Operation | Fields | Rule |
|---|---|---|
| `replace_text` | `agent`, `field` (`prompt` or `description`), `old`, `new` | `old` occurs exactly once |
| `set_text` | `agent`, `field`, `value` | replaces the whole text |
| `set` | `agent`, `field` (`maxTokens`, `maxSteps`, `timeoutSeconds`, `thinkDepth`), `value` | the app schema's bounds |
| `set_role` | `agent`, `value` | not `hook` |
| `add_tool` | `agent`, `tool` | only `read_file`, `fs.read`, `list_files`, `grep`, `fs.write`, `fs.append`, `subagent_dispatch` |
| `remove_tool` | `agent`, `tool` | any tool the agent has |
| `add_memory_read`, `remove_memory_read` | `agent`, `key` | |
| `add_memory_write`, `remove_memory_write` | `agent`, `key` | |
| `add_agent` | `name`, `role`, `prompt`, and optionally `description`, `tools`, `memoryRead`, `memoryWrite`, `maxTokens`, `maxSteps`, `timeoutSeconds`, `thinkDepth` | a new unique name |
| `remove_agent` | `agent` | not the only agent, and not one an `output` scorer names with `node:` |
| `connect` | `from`, `to`, and optionally `kind` (default `dataflow`) and `label` | no self-edge, no duplicate |
| `disconnect` | `from`, `to` | removes every edge from → to; there must be one |

**`add_agent` defaults.**
- The model is the one most agents use, so hosted providers work too.
- The temperature is the first agent's. The engine ignores it, but the schema
  requires it.
- `maxTokens` 2048, `maxSteps` 5, `timeoutSeconds` 300.
- No tools, no memory keys, no hooks; `tokens` `{used: 0, budget: 0}`;
  `status: idle`.

**An operation that changes nothing is an error.** For example: setting a value it
already has, adding a tool the agent has, or `old` equal to `new`. RRSI's critic
rejects such edits as degenerate; here the loop catches them first.

### 3.3 What cannot be edited, and why

| Field | Why |
|---|---|
| `model`, `fallback` | The policy model is frozen; that is RRSI's premise. |
| `temperature`, `condition`, `executionSettings` timeouts and retries | The engine ignores them, so an edit would be a no-op. |
| `preHook`, `postHook`, the `hook` role | They run scripts. |
| `bash` (adding it) | An agent's commands run only under the user's `--allow-command`. Adding `bash` to another agent would widen that approval. |
| Tools that never run (`web_search`, `web_fetch`, `git`, `test`, …) | `runnableTools` drops them, so adding one is a no-op. |
| `meta`, `nodePositions`, `tokens`, `status`, `comment` | Not behaviour. `nodePositions` is kept in step by the loop. |

### 3.4 Applying

The incumbent is parsed as a YAML document, so its comments and layout survive.
- **The changes.** Operations change the document's nodes. A new multi-line text is
  written as a block scalar.
- **Positional ids.**
  - Connections refer to agents positionally (`agent-N`). The loop rewrites those
    ids, and `nodePositions` keys, after `add_agent` (appended at the end) and
    `remove_agent` (later agents shift down).
  - A new agent's position is placed to the right of the rightmost one.
- **The result** is checked as `harness eval` would load it:
  - the app's schema;
  - every connection naming an existing agent;
  - `validateWorkflow`;
  - the task set's `node:` references.

### 3.5 The rendered change

**For the critic and the history,** the change is shown per edit:
- the edit's header (id, component, hypothesis);
- one line per operation;
- for text, the removed and added lines.

The whole-file line diff of incumbent → candidate is saved as `diff.txt`, for
people.

## 4. The critic

### 4.1 The precheck (deterministic, first)

The precheck looks only at text the proposal adds: new values, `new` text, a new
agent's name, prompt, description and label, and memory keys. It flags a pattern
only when the pattern is absent from the incumbent's file. It rejects:
- **a credential:** RRSI's generic pattern (`AIza…`, `sk-…`,
  `api_key = "…"`);
- **a task id** of any split, 4 characters or longer, as a whole word, ignoring
  case;
- **an `output` or `file` scorer's literal:**
  - `contains` and `notContains` strings, 4 characters or longer;
  - a `file` scorer's path;
- **a grader file's name:** the base name of an `inject` source or target, 4
  characters or longer.

These are RRSI's "domain patterns", derived from the task set instead of written by
hand. Scorer names, scorer commands and `matches` patterns are left out on purpose:
they are often common words, generic commands or broad patterns.

### 4.2 The critic workflow

**Its input.** The critic's task text holds:
- the candidate's summary and targets;
- the declared edits (JSON);
- the rendered change;
- the workflow's agents;
- the task set's name.

**Its rules** are in the critic workflow's own prompt: RRSI's six, adapted to
workflows.
1. leakage or task specialization;
2. degenerate edits;
3. grader gaming;
4. undeclared bundling;
5. runtime memory leakage;
6. unbounded work.

**Its output** is the last JSON object with a `verdict` field:
`{"verdict": "accept" | "reject", "reasons": [...], "risk_notes": [...]}`.

**An unparseable output** is retried, up to 3 critic runs, as RRSI does. After
that the verdict is reject, "critic output unparseable".

### 4.3 Repair

A variant gets at most `1 + repair_rounds` proposer runs. Each of these sends the
proposer back with the reasons:
- a proposal that cannot be parsed or applied, or fails a check;
- one that is over the budget;
- a precheck or critic rejection;
- an unhonoured reserved slot, after re-tagging.

**The repair brief** holds:
- the previous proposal;
- the reasons, and the critic's risk notes;
- "send the whole corrected proposal".

A proposal is always applied to the incumbent from scratch.

**When the runs are used up:**
- `no_proposal`: nothing parseable;
- `invalid_proposal`: parseable, but a check failed;
- `critic_reject`: the precheck or the critic.

## 5. A round

Round t, after `loop.py: round`:
1. **Check the pins.**
   - The pins (§6.2) must match.
   - The incumbent's file hash must match the frontier.
   - Read `delta`.
2. **Build the evidence** from the incumbent's evaluation folder.
   - **Which trials:** the worst trial of the `n_fail_traces` lowest tasks, and the
     best trial of the `n_success_traces` highest ones.
   - **Each rendered trace holds** the task text, the run's log, its final output,
     its scorers, and the end of their command output. Each is capped.
3. **Directives.**
   - Compute `b_t`, `σ_t`, `tried`, the exploration text, the prune set, the
     history view and the scoreboard.
   - Write `r<t>/directives.json`.
4. **Draft each variant** v = A, B, … in turn.
   - **A reserved slot:** the last `m_draft` variants hold one when `σ_t` = 1 and
     untried components exist.
   - **The cycle** (§4.3): proposer → parse → apply → the checks (the budget, the
     result, the reserved slot judged by the operations) → precheck → critic, with
     repair. The slot is known before any model reads the change, so a slot that is
     not honoured costs no critic run, and it counts as `invalid_proposal`.
   - **Smoke.** Then the candidate file is written, and when the task set has
     smoke tasks, `harness eval --split smoke -k 1` runs. **Smoke fails** if any
     smoke trial is missing or its run ended in error (`runStatus: error`). It is
     a liveness check, not a score, and is not repaired.
   - `r<t>/<V>/prep.json` records the outcome, so a resumed round reuses it.
5. **Evaluate** each surviving candidate in turn.
   - `harness eval --split evolve -k k`.
   - It is reused when `r<t>/<V>/eval/report.json` is `done`.
6. **Select** (§1.4).
   - Write `r<t>/decisions.json`.
   - Write the history records, skipping any `has(t, v)` already has.
   - Write the attribution rows.
7. **Settle.**
   - **With a winner:** copy its file to `incumbent.harness.yaml`, and record its
     hash, evaluation folder, `S` and `C`.
   - **In every case:** append `{t+1, S, C, hash, job}` to the trajectory and save
     `frontier.json`. A round is settled once the trajectory has entry t+1.

## 6. The run

### 6.1 Order

1. **Check everything before anything runs:**
   - the arguments;
   - the task set;
   - the workflow, its unique agent names, and a note about any file prompts;
   - the proposer and critic workflows;
   - every split's scorer commands against `--allow-scorer`;
   - `--out` placement, as `harness eval` checks it.
2. **The baseline:** `harness eval --split evolve -k k` into `base/`, when there is
   no frontier.
   - When the task set has smoke tasks, the base must pass its own smoke check.
     Otherwise the run stops (exit 3), since every candidate would fail it too.
   - Then print the cost of a round, estimated from the baseline's run times.
3. **Calibration,** when `delta` is unknown (§1.3): into `calib-<i>/` and
   `calibration.json`.
4. **The rounds:** from the first unsettled one up to T−1.
5. **The held-out check,** when the task set has held-out tasks.
   - `harness eval --split heldout` of the base and the final incumbent, into
     `heldout/base/` and `heldout/final/`. The final one is skipped when nothing
     was accepted.
   - It never enters selection.
6. **The summary:**
   - base, final and best `S` and `C`, and the held-out `S` of both;
   - the path of the best workflow, and how to use it.

The user's workflow file is never written: they copy the incumbent over it when
they choose to.

### 6.2 The folder and its pins

`--out` defaults to `.harness/evolve/<task-set file name without .yaml/.yml and
.tasks>/`:

```
frontier.json         incumbent {t, hash, job, S, C}, S_star, trajectory, pins, heldout
calibration.json      delta and how it was measured
history.jsonl         one record per edit
attribution.jsonl     predictions against results
incumbent.harness.yaml
base/  calib-<i>/  heldout/{base,final}/        harness eval folders
r<t>/directives.json  r<t>/decisions.json
r<t>/<V>/a<n>/proposer/   the proposer's workspace: brief.md, evidence/, its run record
r<t>/<V>/a<n>/proposal.json   r<t>/<V>/a<n>/critic-<i>/
r<t>/<V>/candidate.harness.yaml  diff.txt  prep.json  smoke/  eval/
evolve.lock
```

**The pins.** `frontier.json` pins what makes rounds comparable:
- the task set's path and hash;
- the starting workflow's hash;
- the provider, base URL, model and context window (no keys);
- `k`;
- the method's parameters (§1), `T` included.

A resume with any of them different stops with exit 2, saying what differs. To go
further, start a new `--out` from the final incumbent.

**The lock.** `evolve.lock` holds the process id, so two runs cannot share a
folder. A lock whose process is gone is taken over.

**What the pins don't cover.** The fixtures are not hashed. Changing them during a
run makes the rounds incomparable, and the docs say so.

### 6.3 Children, approvals and Ctrl+C

**How children run.** Each child is `node <this CLI> eval|run …` with the parent's
environment, so keys come from the same variables.

**Approvals.**
- `--allow-scorer` goes to every eval.
- `--allow-command` goes to the evals only. A proposer or critic run gets no
  approved commands, so its agents cannot run any.

**Output.**
- An eval's progress lines are shown, indented.
- A proposer or critic run's output goes to a log file in its folder, and one line
  says how it ended.

**Ctrl+C.**
- It reaches the running child too, which stops as it does on its own. Evolve then
  saves what is settled and exits 130.
- A re-run redoes the interrupted step.
- A second Ctrl+C exits at once.

### 6.4 Exit codes

- `0`: the rounds are done, whatever the gain.
- `2`:
  - bad usage;
  - an invalid task set, workflow, proposer or critic;
  - an unapproved scorer command;
  - a bad `--out`;
  - a pin mismatch;
  - a changed incumbent file;
  - a locked folder.
- `3`: the run cannot go on:
  - `harness-core` is missing;
  - the baseline is invalid;
  - the base fails its smoke check;
  - a proposer or critic run did not start;
  - three rounds in a row ended with every candidate `eval_invalid`;
  - a file could not be written;
  - an unexpected error.
- `130`: interrupted.

## 7. The command

```
harness evolve <tasks.yaml> [options]
  --workflow <file>         The workflow to evolve (default: the task set's workflow:)
  --out <dir>               The run's folder; run again with the same folder to resume
  --rounds <T>              Rounds (default 20)
  -k, --trials <n>          Trials per task in each evaluation (default: the task set's, else 2)
  --candidates <m>          Candidates per round (default 2)
  --delta <x>               The noise band (default: measured from the baseline)
  --calibrate <R>           Measure the band from R evaluations of the base workflow (R ≥ 2)
  --config <file.json>      The method's other parameters (§1), strict JSON
  --proposer <file>         Default: examples/evolve/proposer.harness.yaml next to the CLI
  --critic <file>           Default: examples/evolve/critic.harness.yaml next to the CLI
  --proposer-model <name>   Default: --model
  --critic-model <name>     Default: --model
  --allow-scorer "<cmd>"    As for harness eval
  --allow-command "<cmd>"   As for harness eval; the evaluated workflow's agents only
  --provider, --base-url, --model, --num-ctx, --request-timeout, --core   As for harness eval
```

## 8. The shipped search workflows

Both are in `examples/evolve/`.

**`proposer.harness.yaml`.** One agent.
- **Its tools** are `read_file`, `list_files` and `grep`, read-only.
- **Its prompt** adapts RRSI's proposer:
  - a different, frozen model runs the workflow;
  - fix the reported failures from that model's side;
  - there is no abort;
  - every edit targets a reported failure;
  - no task-specific names, values or answers;
  - stay within the budget;
  - pruning is a legitimate edit.
- **The loop's brief** carries everything that must match the code: the operation
  table, the output contract, the budget, the reserved slot, the components and
  the workflow's text. So an evolved proposer prompt cannot fall out of step with
  the loop.

**`critic.harness.yaml`.** One agent with no tools, and RRSI's six rules adapted
(§4.2).

## 9. Code

| File | What |
|---|---|
| `src/evolve/config.ts` | parameters, defaults, the strict `--config` schema |
| `src/evolve/schedule.ts` | `editBudget`, `budgetTable` |
| `src/evolve/measure.ts` | the evaluation view of a report, `aggregate`, `relativeCostChange`, `pooled` |
| `src/evolve/calibrate.ts` | `bootstrapSe` (seeded), `calibrate` |
| `src/evolve/selection.ts` | `costRule`, `judge`, `selectRound` |
| `src/evolve/components.ts` | K, the structural set, precedence, `novelty` |
| `src/evolve/history.ts` | `History`, `stallFlag`, `exploration` |
| `src/evolve/attribution.ts` | the attribution rows |
| `src/evolve/edits.ts` | the proposal schema, parsing, applying, checks, rendering, the line diff |
| `src/evolve/precheck.ts` | the deterministic critic layer |
| `src/cli/evolveArgs.ts`, `src/cli/evolveCli.ts` | the command, its folder, the children, a round |
| `examples/evolve/*.harness.yaml` | the proposer and the critic |
| `cli/harness.mjs` | `evolve` dispatch, as for `eval` |

## 10. Testing

**RRSI's own test cases** (`tests/test_core.py`).
- **Ported one for one:**
  - `edit_budget` (Eq. anneal, monotone, `t = T`);
  - the estimator with weights;
  - calibration, by bootstrap and by repeats;
  - both branches of the cost rule;
  - selection: the floor, argmax, `S*`, the L1 block, a guard;
  - the history summaries: `tried`, `g` with its window, the prune set, counts,
    `has`;
  - `stall_flag`;
  - exploration;
  - the config round trip.
- **Adapted to the workflow K:** the component tests (`normalize`, `novelty`),
  because K and the classification differ.

**Edits.** For every operation:
- applying it, with comments kept;
- an id shift after `remove_agent`;
- its errors: an unknown agent, `old` missing or repeated, a no-op, a forbidden
  field or tool, a duplicate edge, an orphaned `node:`;
- precedence and re-tagging;
- the rendered change;
- the line diff;
- the result loading as `harness eval` loads it.

**Precheck:** each pattern kind; patterns already in the incumbent pass.

**The loop, with the children faked:**
- a round end to end;
- each gate failure;
- repair;
- the reserved slot;
- resume after a crash at each step;
- the pins;
- the lock;
- held-out;
- the exit codes.

**End to end:** the built CLI and the fake core, on a two-task set. The proposer's
scripted edit makes the fake policy pass, so the edit must be accepted, the
incumbent must change, and a re-run must resume as settled.

**Not run:** a real model server. Ollama Cloud is blocked in this environment (the
proxy answers 403 for ollama.com, and no `OLLAMA_API_KEY` is set).

## 11. Delivery

One PR for P2, built in four parts. Each part is implemented, then reviewed and
checked by running the project's checks directly (no model-based reviewer, per the
user's rule on tokens):
1. **The method core,** with RRSI's tests.
2. **Edits, checks and the precheck.**
3. **The loop:** the command and the shipped workflows.
4. **Docs and the example.**
   - `docs/EVOLVE.md`, plus the README, HEADLESS, AIRGAPPED, AGENT.md, CHANGELOG,
     DEPLOYMENT_READINESS and DEVELOPMENT_LOG.
   - More evolve tasks in the example task set. It has one now, and that can only
     show the mechanics.

## 12. Risks and limits

- **Model strength.** RRSI's gains came from a frontier proposer. A local model may
  propose little that survives the floor. P3 measures it.
- **Noise.**
  - With few tasks and trials, `delta` is large and the floor blocks most gains.
  - The summary prints `delta`, and says that more tasks or trials shrink it.
  - The example task set can only show the mechanics.
- **Time.** A round is about `m × |evolve| × k` workflow runs, plus up to
  `m × (1 + repair_rounds)` proposer runs and the critic's. The estimate is printed
  after the baseline.
- **Grader integrity** is `harness eval`'s, with its limits (`docs/EVAL.md`).
- **The critic is a model.** Leakage the precheck does not pattern-match is caught
  only as well as the critic model reads.
