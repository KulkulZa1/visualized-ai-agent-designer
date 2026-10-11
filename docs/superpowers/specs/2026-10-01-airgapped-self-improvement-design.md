# Air-Gapped Recursive Self-Improvement — Design

Date: 2026-10-01 · Branch: `ccr-ac944598-tom0ws` (from master `5d3413f`)

## Goal

Let Harness Studio improve the workflows it runs in a loop, on a machine with no
internet, the way Google's RRSI improves an agent harness around a frozen model. The
model is never retrained; only the harness changes: the prompts, the control flow,
the tools and the settings of a `.harness.yaml` workflow.

**Decisions (from the user):**
- **The aim:** "This project should be recursively improve-able in air-gapped
  circumstance", with RRSI as the model.
- **Order:**
  - first, the offline build bundle (done, #13);
  - then the local-model fixes (done, #14);
  - then measurement (`harness eval`);
  - then the loop.
- **One PR per phase,** merged after review, verification and the user's OK.

## Non-goals

- Retraining or fine-tuning a model.
- Running the paper's benchmarks (Terminal-Bench, Harvey LAB, EngDesign).
- Any step that needs a hosted service or a network: every phase must run against a
  local model server with no route out.

## 1. What RRSI is

Source: `google-research/rrsi` at `be50316` (its README, `rrsi/` and `tests/`).

- **The loop.** It edits a harness around a frozen model: prompts, control flow,
  configuration, context management, tools, skills, memory and sub-agents.
  - Each round drafts two candidates.
  - Each candidate lives in its own git worktree, on a branch off
    `evolve/<domain>`.
  - The loop screens both candidates and evaluates them on the evolve set.
  - It then fast-forwards the branch to the winner, so the incumbent is always a
    commit.
- **Regularizing the proposals.**
  - **An annealed edit budget** caps how many independent edits one candidate may
    bundle: `b_t = ceil(b_min + (b_max − b_min) · ½(1 + cos(πt/T)))`
    (`rrsi/schedule.py`).
  - **The edit history.** The proposer sees the full history, one JSONL record per
    edit: the component, the hypothesis, the measured score and cost change, and
    the verdict. A falsified hypothesis is not redrawn.
  - **Stalls.** A stalled run is pointed at components it has never changed.
- **Regularizing the selection.**
  - **A critic** screens each candidate for suite-specific logic before it is
    evaluated, with a regex denylist and an LLM review.
  - **Evaluation.** Each task gets k trials. The score is the weighted mean of
    the per-trial rewards, and a missing trial counts as 0.
  - **A noise floor.** A candidate below `S* − δ` is out, so a gain within the
    evaluation's noise never wins.
  - **The cost rule.**
    - If the score gain `dS > δ`, the cost change must stay within
      `dC ≤ β0 + β1·dS`.
    - Within the band, the candidate needs `w_s·dS − w_c·dC + w_n·ν > 0`, where
      `ν` rewards structural novelty.
    - The best eligible candidate wins.
  - **Pruning.** Components that stop helping are offered to the proposer for
    removal.
- **Results.** These are reported on the evolve split, an in-distribution held-out
  split and out-of-distribution benchmarks.
  - The held-out and out-of-distribution sets never enter selection.
  - They show whether a gain transfers or was overfitted.

## 2. Where Harness Studio stands (master `5d3413f`)

**What it has:**
- **Workflows.** A `.harness.yaml` workflow is a harness in RRSI's sense: agents'
  prompts, tools, limits and routing.
- **Headless runs.** `harness run` runs headless, with run records and `--resume`.
  It works with local providers: Ollama, or any OpenAI-compatible server.
- **A local runtime.**
  - The runtime makes no network calls of its own.
  - Agents' file tools are confined to the workspace.
  - Shell commands run only when approved or allowed by `--allow-command`.
- **Offline build and test (#13):** `npm run offline:bundle`, `offline:setup` and
  `offline:verify`.
- **Local models (#14):**
  - Ollama's context window;
  - no hosted model names sent to a local server;
  - timeouts for slow hardware.
- **Tests and CI.** It has its own suites (vitest 1514 tests, `cargo test` 162) and
  CI.

**Missing for the loop** (from the 2026-09-30 survey):
1. **Measurement:**
   - task sets;
   - scorers;
   - k-trial evaluation in isolated workspaces;
   - real token counts. Today tokens are a chars/4 estimate; the providers' usage
     is not read.
2. **Candidates:** git worktrees and branches for candidate workflows.
3. **The loop:**
   - a proposer;
   - a critic;
   - selection;
   - the edit history;
   - the edit budget;
   - pruning.
4. **Strict validation of machine edits.**
   - Unknown keys are dropped without a word.
   - Node ids are positional.
   - `harness run` does not catch an edge that points nowhere.
5. **Grader integrity.** Agents can change the tests and files that grade them.
6. **Parts of the harness live in code, not in the workflow file:**
   - the revision cap;
   - compaction;
   - tool descriptions;
   - message templates.

   **Some fields are saved but not applied:**
   - temperature;
   - the fallback model;
   - a gateway's condition;
   - the workflow-level timeouts and retries.
7. **The self-development examples** cannot run as shipped:
   - Windows paths;
   - a dead `fix` edge;
   - hooks on agent nodes;
   - no `AGENTS.md`.

**Still open for air-gapped use:**
- **No real model server yet.** No end-to-end run against a real local model server
  has been done; #14 used fake servers.
- **Platform limits.**
  - The prebuilt binaries in an offline bundle are for the platform it was made on.
  - The installer build needs the network (the Tauri bundler downloads its tools).
- **Ollama mode** sends one model to every node.

## 3. Phases

Each phase is one PR.

- **P0. Offline build.** Done (#13).
- **P1a. Local-model fixes.** Done (#14).
- **P1b. Measurement: `harness eval`.** This gets its own design spec.
  - A task-set format with evolve, held-out and smoke splits.
  - **Scorers:**
    - a command's exit code, for example the project's own tests;
    - checks on the output;
    - later, a judge workflow.
  - **`harness eval -k N`:**
    - each trial runs in a fresh copy of the task's workspace;
    - the scorer's files are put back before scoring, so an agent cannot change
      its own grader.
  - **Real token usage** from the providers.
  - **A JSON report:** per task and trial, the reward, the tokens and the time.
- **P2. `harness evolve`: a port of RRSI's loop.**
  - **The pure logic in TypeScript:**
    - selection;
    - the edit budget;
    - the history;
    - novelty;
    - pruning.

    It is tested against the cases of rrsi's own tests.
  - **Candidates** in git worktrees.
  - **The proposer and the critic** as `.harness.yaml` workflows, so the loop can
    evolve its own roles.
  - **Strict validation** and component classification by YAML path for machine
    edits.
- **P3. Self-hosting.**
  - **A self-development workflow** for this repo that runs as shipped.
  - **A task set from the repo's own fix history.** A task reverts a fix, and its
    test must pass again.
  - **Evolve that workflow** offline, against a local model.

## 4. Risks and open questions

- **Model strength.** RRSI's results use a frontier model as the policy and the
  proposer. A local model may be too weak to propose useful edits. P3 must measure
  this, not assume it.
- **Noise.**
  - The problem: a small task set and few trials make `δ` large, so the floor
    would block most real gains.
  - The way out: more tasks and trials.
  - The catch: on slow hardware those cost hours.
- **Grader integrity.** Agents run approved commands and edit files. P1b must keep
  the scorer's files and the run records out of their reach from the start.
- **Cost.**
  - A round costs `tasks × k × candidates` workflow runs, all of it local inference.
  - The report must show time and tokens per trial, so the cost of a round is known
    before a loop is started.
