# Improving a workflow: `harness evolve`

`harness evolve` improves a workflow against a task set, round after round, with no
network. It ports the loop of Google's RRSI (<https://github.com/google-research/rrsi>,
Apache License 2.0) to `.harness.yaml` workflows. The model is never retrained; only
the workflow changes.

**What a run does:**
- **First,** it measures your workflow with `harness eval` (`docs/EVAL.md`).
- **Then, in each round:**
  - a **proposer** workflow drafts changes to it;
  - a **critic** workflow reviews them;
  - every candidate that passes is measured;
  - the best one becomes the workflow of the next round, but only when it beats the
    noise and pays for its tokens.

```bash
npm run build:cli && npm run build:core       # once, as for harness run
node cli/harness.mjs evolve examples/evals/research-synthesis.tasks.yaml \
  --provider ollama --model qwen2.5-coder:7b --num-ctx 32768 --rounds 5
```

It uses the same engine, provider options, keys and approvals as `harness eval`.
`node cli/harness.mjs evolve --help` lists every option.

**Your workflow file is never written.** The best workflow is
`incumbent.harness.yaml` in the run's folder; copy it over yours when you choose.

**Its layout is the loop's.** The run writes the workflow back through a YAML parser, so
the first copy over your file may reformat it: flow lists (`[a, b]` becomes `[ a, b ]`)
and folded text. Its values are the same, and its comments are kept.

The design is in `docs/superpowers/specs/2026-10-11-harness-evolve-design.md`.

## What it can change

**Only the workflow file itself:**
- agents' inline prompts and descriptions;
- their `maxTokens`, `maxSteps`, `timeoutSeconds` and `thinkDepth`;
- their roles;
- their tools;
- the memory keys they read and write;
- the agents themselves;
- the edges between them.

**What it cannot change, and why:**

| What | Why |
|---|---|
| The model, `fallback` | The model is frozen: that is the method. |
| `temperature`, `condition`, the workflow's timeouts and retries | The engine ignores them. |
| Hook agents and their edges, `preHook` and `postHook`; and an agent with a hook keeps its place and role | They run scripts. |
| Adding `bash` | It would widen your `--allow-command` approval to another agent. |
| Tools that never run (`web_search`, `git`, …) | Adding one would change nothing. |
| A prompt read from a file | It lives in the task's folder, which belongs to the frozen task set. |

**A file prompt.** The command says at the start which agents have one. Inline those
prompts first if you want them improved.

## How a round works

1. **The evidence.**
   - The loop takes the current workflow's last evaluation.
   - It renders the worst trial of the lowest-scoring tasks and the best trial of
     the highest ones, as traces.
   - It writes a brief:
     - the workflow;
     - the results;
     - the edit history and how past predictions fared;
     - the round's edit budget;
     - the components never tried, and those to prune;
     - the operations it may use, and the shape of the answer.
2. **The proposer** reads the brief and the traces, and answers with a JSON proposal:
   - **edits**, each with a component, a hypothesis and the tasks it should move;
   - **operations** in each edit, by agent name: replace text in a prompt, set a
     limit, add a tool, add an agent, connect two agents, and so on.

   The proposer edits nothing itself; the loop applies the proposal.
3. **The checks.** The loop runs these in order:
   1. **The budget.** At most `b_t` edits. The budget starts at 4 and anneals to 1, so
      late rounds make single, attributable changes.
   2. **Applying.** Every operation must apply.
   3. **Loading.** The result must load as `harness eval` loads it: the app's schema,
      no edge to a missing agent, no unconnected agent, no loop that is not a
      feedback edge.
   4. **The reserved slot.** When the run has stalled, one candidate must try a
      component never exercised.
   5. **The precheck.** It rejects a change that adds:
      - a task id;
      - a scorer's literal (`contains`, `notContains`, a file scorer's path);
      - the name of a grader file;
      - a credential;

      unless the workflow already had it.
   6. **The critic,** a model with RRSI's six rules: leakage, degenerate edits,
      grader gaming, undeclared bundling, runtime memory leakage, unbounded work.

   **Repair.** A proposal that fails a check goes back to the proposer with the
   reasons, up to 2 times (`repair_rounds`).
4. **The smoke check.** When the task set has smoke tasks, the candidate runs them
   once. A missing trial or a run that ended in error drops it. It is a liveness
   check, not a score.
5. **The measurement:** `harness eval` on the evolve split, k trials per task.
6. **The selection.** RRSI's rule (below) keeps the best admissible candidate, or the
   current workflow when none is admissible.

## The selection

Each candidate has a score `S'` and a cost `C'` (the mean tokens of a trial). These
are compared with the current workflow's `S` and `C`, and with the best score so far,
`S*`. The candidate is **admissible** when:

- **The floor:** `S' ≥ S* − δ`. `δ` is the noise band: how far the same workflow's
  score moves between two evaluations.
- **The cost rule:**
  - with a gain beyond the noise (`ΔS > δ`), the relative cost change must stay
    within `ΔC ≤ beta0 + beta1·ΔS`;
  - within the noise, `w_s·ΔS − w_c·ΔC + w_n·ν > 0`, where `ν` counts structural
    components (memory keys, tools, agents) new to the workflow.

The admissible candidate with the highest `S'` wins.

**The band `δ`** is measured from the baseline:
- **By default,** by a bootstrap over its trials.
- **With `--calibrate R`,** from R evaluations of the unchanged workflow.
- **With `--delta`,** set directly.

**With few tasks and trials, `δ` is wide** and only large gains pass. The summary warns
when nothing was accepted and `δ` was above 0.2. More tasks, or more trials per task
(`-k`), shrink it.

## Before you start

- **Prompts.** Inline the prompts you want improved.
- **Agent names.** They must be unique: the operations name agents.
- **The task set** (`docs/EVAL.md`):
  - It needs evolve tasks: the more there are, the smaller `δ`.
  - **Held-out tasks** are measured at the end, for the base workflow and the final
    one. They never enter selection, so they show whether a gain carries over.
  - **Smoke tasks** give each candidate a cheap liveness check. The base workflow
    must pass them itself, or the run does not start.
- **Approvals:**
  - `--allow-scorer` must name every scorer command of every split, as for
    `harness eval`;
  - `--allow-command` is for the improved workflow's agents only.

  The proposer and the critic never run commands.
- **The context window.**
  - **Why it matters:** the proposer reads a brief of about 3 000 tokens plus traces
    of up to 12 000 characters each, so Ollama's default window here (16 384 tokens)
    can be too small.
  - **What to pass:** `--num-ctx 32768` or more.
  - **What it reaches:** every child, including the measured workflow, so pick a
    window you would also run the workflow with.
- **The models.** RRSI's results came from a strong proposer. `--proposer-model` and
  `--critic-model` let the proposer and the critic use a bigger local model than the
  workflow.

## The run's folder

The run's folder is `--out`, by default `.harness/evolve/<the task-set file's name>/`.
This repository's `.gitignore` has `.harness/evolve/`.

```
frontier.json            the current workflow, S*, the trajectory, the pins, the held-out results
history.jsonl            one record per edit: component, hypothesis, ΔS, ΔC, outcome
attribution.jsonl        each edit's predicted tasks against what happened
calibration.json         δ and how it was measured
base.harness.yaml        your workflow as the run started
incumbent.harness.yaml   the best workflow so far
base/, base-smoke/, calib-<i>/, heldout/{base,final}/   harness eval folders (each with a .log)
r<t>/directives.json     the round's budget, stall flag, untried components and prune set
r<t>/decisions.json      the winner, and why each candidate was or was not admissible
r<t>/evidence/           the traces and the results the proposer read
r<t>/<V>/a<n>/           attempt n of variant V: the proposer's workspace (brief.md), its log,
                         proposal.json, and the critic's runs (review.md, logs)
r<t>/<V>/change.txt      the change, edit by edit, as the critic read it
r<t>/<V>/diff.txt        the line diff of the workflow file
r<t>/<V>/candidate.harness.yaml, prep.json, smoke/, eval/
```

**Resume.**
- **Run the same command again** to resume. A step writes its result whole, as its
  last act, so a crash or Ctrl+C loses at most the step in progress.
- **What is kept:** finished evaluations of the same workflow, task set, split and k
  are reused, and history records are never written twice.
- **A run that has finished** prints its summary again.

**The pins.**
- **What `frontier.json` pins:**
  - the task-set file's hash;
  - your workflow's hash;
  - the provider, base URL, model and context window;
  - k;
  - every method parameter.
- **A resume that differs in any of them** stops with exit 2, naming what changed.
  Use a new `--out` to start over, for example from the final
  `incumbent.harness.yaml`.
- **The fixtures are not hashed:** don't change them during a run.

**The lock.** `evolve.lock` keeps two runs out of one folder. A lock left by a process
that is gone is taken over.

**Ctrl+C.**
- It stops the running evaluation or run as it stops on its own. Then evolve exits
  with 130.
- A second Ctrl+C exits at once.

## The proposer and the critic

Both are ordinary workflows: `examples/evolve/proposer.harness.yaml` and
`critic.harness.yaml`, adapted from RRSI's prompts.
- **Replacing them.** `--proposer` and `--critic` take others, so you can rework them,
  or improve them with `harness evolve` itself.
- **The brief carries the contract.** The operations, the output's shape and the
  round's data come from the loop, so a reworked prompt cannot fall out of step with
  it.
- **How their output is read:**
  - The proposer's final output must end with the proposal, a JSON object, fenced
    or not.
  - The critic's must hold `{"verdict": "accept" | "reject", "reasons": [...],
    "risk_notes": [...]}`.
  - A critic output with no verdict is retried, up to 3 runs, then counts as a
    reject.
- **Their tokens are not in `C`.** They are recorded in each attempt's
  `proposal.json`.

## The method's parameters

`--rounds`, `-k`, `--candidates`, `--delta` and `--calibrate` set the common ones.
`--config <file.json>` sets any of them; the flags win. In the file, an unknown key is
an error. The names are RRSI's:

| Key | Meaning | Default |
|---|---|---|
| `T` | rounds | 20 |
| `k` | trials per task in each evaluation | the task set's `trials`, else 2 |
| `m` | candidates per round, 1 to 8 | 2 |
| `b_min`, `b_max` | the edit budget anneals from `b_max` to `b_min` | 1, 4 |
| `w` | the stall window: σ = 1 when S has not moved by more than δ in w rounds | 3 |
| `m_draft` | candidates that must explore an untried component when stalled | 1 |
| `delta`, `delta_z`, `calibrate` | the band; `delta = delta_z · sd(null ΔS)`; evaluations it is measured from | measured, 2.0, 1 |
| `beta0`, `beta1` | the cost rule for a gain beyond the band | 0.10, 40 |
| `w_s`, `w_c`, `w_n` | the shaped rule within the band | 100, 15, 0.5 |
| `n_prune` | the window of the yield summary behind the prune set | 4 |
| `repair_rounds` | proposer retries after a check or the critic says no | 2 (RRSI: 5) |
| `invalid_missing_frac` | an evaluation with more missing trials is invalid (retried once for a candidate) | 0.15 |
| `n_fail_traces`, `n_success_traces` | traces shown to the proposer | 4, 2 (RRSI: 22, 6) |

## Exit codes

- `0`: the rounds are done, whatever the gain.
- `2`:
  - bad usage;
  - an invalid task set, workflow, proposer or critic;
  - an unapproved scorer command;
  - a bad `--out`;
  - a folder in use, or one that holds a run with other settings;
  - a changed `incumbent.harness.yaml` or `base.harness.yaml`.
- `3`: the run cannot go on:
  - `harness-core` is missing;
  - the baseline is invalid;
  - the base workflow fails its smoke tasks;
  - a proposer or critic run did not start;
  - three rounds in a row ended with every candidate's evaluation invalid (check the
    model server);
  - a file could not be written;
  - an unexpected error.
- `130`: interrupted. Run it again to resume.

## Cost and time

**A round costs, at most:**
- `m × (1 + repair_rounds)` proposer runs;
- up to 3 critic runs per attempt;
- `m` smoke checks;
- `m` evaluations of `|evolve tasks| × k` workflow runs.

**The estimate.** After the baseline, evolve prints how long measuring a candidate
takes.

**One at a time.** Evaluations run one after another, as a local server answers one
request at a time.

## Limits

- **Model strength.** A small local model may propose little that survives the floor.
  Whether a given model can improve a given workflow has to be measured, not assumed.
- **The critic is a model.** Leakage that the precheck's patterns do not catch is
  caught only as well as the critic model reads.
- **`harness eval`'s limits apply** (`docs/EVAL.md`), notably processes an approved
  agent command leaves running.
- **Not done:** RRSI's re-adjudication and re-evaluation commands, and parallel
  candidates.
- **The example task set** (`examples/evals/research-synthesis.tasks.yaml`) has four
  evolve tasks and one held-out task. That is enough to see the loop work, not to
  show a real gain.

## What was checked

These ran on 2026-10-11, on Linux.

**The project's tests.** They include:
- RRSI's own test cases, ported for the method;
- the operations;
- the precheck;
- the loop, with every gate, repair and resume after a crash at each step;
- end-to-end runs of the built CLI against a fake model core, covering:
  - accept and resume;
  - a critic reject;
  - a changed model on resume;
  - an unapproved scorer;
  - Ctrl+C;
  - which approvals each child gets.

**By hand.** The built CLI against the fake core, with a task set of two evolve tasks
and one held-out task:
- the baseline scored 0;
- round 0 accepted a prompt edit (S 1);
- round 1 rejected an edit that gained nothing;
- the held-out score went from 0 to 1.

**Not run:**
- **A real model server.** Ollama Cloud, the planned check, was not reachable from
  the environment used, so the proposer's and critic's prompts and the context
  window have not been tried with a real model.
- **Windows and macOS.**
