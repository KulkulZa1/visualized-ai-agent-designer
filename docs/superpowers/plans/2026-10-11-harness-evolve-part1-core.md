# `harness evolve`, part 1: the method core — Plan

Spec: `docs/superpowers/specs/2026-10-11-harness-evolve-design.md`, §1 and §2.
Source to port: `google-research/rrsi` at `be50316`, checked out at
`/home/user/google-research/rrsi`. Its tests are in `tests/test_core.py`.

**What this part is.** RRSI's method as pure TypeScript functions in a new folder
`src/evolve/`, with RRSI's test cases.
- There is no CLI and no model call yet.
- The only I/O is the JSONL files of the history and the attribution.

**Conventions.**
- **Data names** follow RRSI's snake_case (`delta_S`, `per_task`, `b_min`), as the
  eval report does. They appear in JSON files and in a user's `--config` file.
  Function names are camelCase.
- **The `@/` alias** maps to `src/`.
- **Tests** go in `tests/unit/evolve/<module>.test.ts` (vitest).

## Files

### `src/evolve/config.ts`

`EvolveConfig`, with the spec's §1 table:

| Key | Default |
|---|---|
| `T` | 20 |
| `k` | 2 |
| `m` | 2 |
| `b_min`, `b_max` | 1, 4 |
| `w` | 3 |
| `m_draft` | 1 |
| `delta` | `null` |
| `delta_z` | 2.0 |
| `calibrate` | 1 (evaluations of the base for the band; 1 means bootstrap) |
| `beta0`, `beta1` | 0.10, 40 |
| `w_s`, `w_c`, `w_n` | 100, 15, 0.5 |
| `n_prune` | 4 |
| `repair_rounds` | 2 |
| `invalid_missing_frac` | 0.15 |
| `n_fail_traces`, `n_success_traces` | 4, 2 |

- **`DEFAULT_CONFIG`** holds those values.
- **`configFromJson(raw: unknown, overrides: Partial<EvolveConfig>)`** returns
  `{ config } | { error }`.
  - **The schema** is strict (`z.strictObject`), so an unknown key is an error.
    RRSI keeps unknown keys in `notes`; we refuse them, as the task set does.
  - **Bounds:**

    | Key | Bound |
    |---|---|
    | `T` | integer 1..1000 |
    | `k` | integer 1..1000 |
    | `m` | integer 1..8 (variants are labelled A..H, as RRSI's `VARIANT_LABELS`) |
    | `b_min` | integer ≥ 1 |
    | `b_max` | integer ≥ `b_min`, ≤ 20 |
    | `w` | integer ≥ 1 |
    | `m_draft` | integer 0..`m` |
    | `delta` | number ≥ 0 or null |
    | `delta_z` | > 0 |
    | `calibrate` | integer 1..100 |
    | `beta0`, `beta1`, `w_s`, `w_c`, `w_n` | finite |
    | `n_prune` | integer ≥ 0 |
    | `repair_rounds` | integer 0..10 |
    | `invalid_missing_frac` | 0..1 |
    | traces | integers 0..50 |

  - **The cross-key checks** (`b_min ≤ b_max`, `m_draft ≤ m`) are checked after
    the overrides are applied. Their errors name the keys.
  - **Overrides** whose value is `undefined` are ignored, as RRSI's `load` ignores
    `None`.
- **`configDiff(a, b)`** lists the keys whose values differ. The loop uses it to
  report a pin mismatch.

### `src/evolve/schedule.ts` (`rrsi/schedule.py`)

- **`editBudget(t, T, b_min, b_max)`:**
  - `T ≤ 0` gives `b_max`.
  - Clamp `t` to [0, T].
  - `v = b_min + (b_max − b_min)·0.5·(1 + cos(πt/T))`.
  - Return `Math.ceil(Math.round(v·1e9)/1e9)`.
- **`budgetTable(T, b_min, b_max)`** returns the budgets for t = 0..T−1.

### `src/evolve/measure.ts` (`rrsi/evaluate.py`)

**The types:**
- `TaskResult { rewards: number[]; weights: number[]; tokens: (number|null)[]; missing: number }`
- `EvalResult { job; k; per_task: Record<string, TaskResult>; S: number; C: number|null; n_expected; missing }`

**The functions:**
- **`taskMean(tr)`:** the weighted mean, or 0 when the weights sum to 0.
- **`aggregate(job, k, perTask)`:**
  - `S = Σ r·w / Σ w`, or 0 when there is no weight.
  - `C` is the mean of the tokens that are numbers above 0, or null when there are
    none.
  - `n_expected = |tasks|·k`.
  - `missing` is the sum over the tasks.
- **`relativeCostChange(cCand, cInc)`:** 0 when either is null or 0; otherwise
  `(cCand − cInc)/cInc`.
- **`pooled(evals)`:**
  - per task, it concatenates rewards, weights and tokens and sums `missing`;
  - then `aggregate("pooled", Σ k, per)`.
- **`fromReport(job, raw: unknown)`** reads a `harness eval` `report.json` (see
  `src/cli/evalReport.ts`). It returns `{ ev } | { invalid: string }`.
  - **Check the shape** with a small zod schema. Only the fields used are needed
    (`status`, `k`, `per_task[id].{weight, rewards, tokens, missing}`); other
    fields are allowed, since this reads a report, not user input.
  - **A report whose `status` is not `done` is invalid,** and the reason names the
    status.
  - **Otherwise,** per task:
    - `rewards` as is;
    - `weights` is the task's `weight` repeated, one per reward;
    - `tokens` as is;
    - `missing` as is.

    Then call `aggregate(job, report.k, per)`.
- **`tooManyMissing(ev, frac)`:** `ev.missing > frac·ev.n_expected`.

### `src/evolve/calibrate.ts` (`rrsi/calibrate.py`)

- **The PRNG.** A small seeded one (mulberry32 is fine), with
  `randrange(n) = floor(rng()·n)`.
  - The numbers will differ from Python's `random.Random(7)`. Determinism for a
    given seed is what matters.
- **`bootstrapSe(ev, reps = 2000, seed = 7)`:** RRSI's loop.
  - It takes the tasks with rewards.
  - Per repetition, for each task of n trials, it draws n indices with replacement
    and sums `r·w` and `w`. The repetition's value is `num/den`, or 0.
  - It returns the population standard deviation of the values when there is more
    than one, else 0.
- **`calibrate(evals, z = 2.0, reps = 2000)`:** port line for line.
  - **No evaluations:** it throws `"no base evaluations"`.
  - **Two or more:** `scores` are their `S`; `diffs` are the pairwise absolute
    differences; `sd_null = sampleStdev(scores)·√2`; the method is
    `"repeated base evaluations"`; and `observed = {S_per_eval, max_abs_diff}`.
  - **One:** `sd_null = 0`; the method is
    `"bootstrap over trials of one base evaluation"`.
  - **The bootstrap figures:**
    - `pooledEv = pooled(evals)`;
    - `se = bootstrapSe(pooledEv, reps)`;
    - `sd_boot = √2·se·√(pooledEv.k / evals[0].k)`.
  - **Which one is used:** `sd_use` is `sd_null` when there are two or more
    evaluations and `sd_null > 0`; otherwise `sd_boot`.
  - **It returns:**
    - `delta = round6(z·sd_use)`, `z`, `sd_null = round6(sd_use)`;
    - `sd_null_bootstrap = round6(sd_boot)`, `se_bootstrap = round6(se)`;
    - `method`, `n_evals`, `k: evals[0].k`, `n_tasks`;
    - `S_base = round6(evals[0].S)`, `C_base = evals[0].C`;
    - and the `observed` fields.

### `src/evolve/components.ts` (`rrsi/components.py`, adapted)

- **`K`**, in this order: `["prompt", "config", "control_flow", "context_mgmt",
  "memory", "client_tool", "subagent"]`. Also the `Component` type.
- **`K_STR`** is `["memory", "client_tool", "subagent"]`.
- **`PRECEDENCE`** is `["subagent", "memory", "client_tool", "control_flow",
  "context_mgmt", "config", "prompt"]`.
- **`mostStructural(components)`** returns the first entry of `PRECEDENCE` that
  is in the list, or null for an empty list.
- **`isComponent(x)`** is a type guard.
- **`novelty(editComponents, incumbentCounts)`** counts the distinct components
  that are in `K_STR` and have a count of 0 or none.
- RRSI's regex classification (`classify_diff`, `has_evidence`, `normalize`) is not
  ported. Part 2 classifies by operation.

### `src/evolve/jsonl.ts`

- **`readJsonl(file)`** returns `[]` for a missing file. It parses each non-empty
  line, and throws `"<file> line <n> is not JSON: …"`.
- **`appendJsonl(file, records)`** makes the parent folder and appends one line per
  record.

### `src/evolve/history.ts` (`rrsi/history.py`)

`class History(path)`, with RRSI's methods and semantics:
- **`records()`** reads through `readJsonl`.
- **`append(rec)`** adds `ts`, as an ISO 8601 string, when it is missing.
- **`appendCandidate(t, variant, edits, outcome, delta_S, delta_C, accepted, S, C, diff, detail = "")`:**
  - It writes one record per edit. With no edits, it writes one record for
    `{id: "C1", component: null, hypothesis: null}`, as RRSI does.
  - **The fields:**
    - `t`, `variant`, `edit_id`, `component`;
    - `hypothesis` (or the edit's `mechanism`);
    - `targets_mode`, `predicted_affected` (null when absent), `diff`;
    - `delta_S`, `delta_C`, `S` rounded to 6 places, and `C` to 1 (null stays
      null);
    - `accepted`, `outcome`;
    - `bundle` (the number of edits);
    - `detail`, cut to 600 characters.
- **`has(t, variant)`.**
- **`measured()`:** records with a non-null `delta_S` and a component in K.
- **`tried()`:** a `Set`.
- **`attempted()`:** counts for every component in K; only records with an
  `edit_id` count.
- **`acceptedEdits()`:** for every component in K, the list of
  `{t, edit_id, hypothesis, delta_S}`.
- **`incumbentComponentCounts()`.**
- **`yieldG(t, n_prune)`:**
  - start with `-Infinity` for each tried component;
  - for each measured record with `t − r.t ≤ n_prune`, take the max of `delta_S`.
- **`pruneSet(t, n_prune)`:**
  - the components with `g ≤ 0`, in alphabetical order (RRSI's `sorted`);
  - each as `{component, recent_best_gain: null for −∞, else rounded to 5 places,
    accepted_edits_in_incumbent}`.
- **`render(n = 40)`:**
  - walk from the newest record;
  - drop unmeasured ones after the 4th;
  - stop at n;
  - return them oldest first, with RRSI's keys, leaving out null or undefined
    values.

Two functions sit beside the class:
- **`stallFlag(trajectory, t, w, delta)`:** 0 when
  `t < w || t >= trajectory.length`; otherwise
  `trajectory[t] − trajectory[t−w] ≤ delta ? 1 : 0`.
- **`exploration(t, stall, tried, m_draft)`:** `{sigma, untried, m_draft, text}`.
  - `untried` is K minus `tried`, in K's order.
  - The three texts are RRSI's (stalled with untried components, not stalled with
    untried, all exercised), with the list printed as JSON.

### `src/evolve/selection.ts` (`rrsi/selection.py`)

**The types:**
- **`EditRecord`:** the declared edit fields `id`, `component`, `hypothesis`,
  `targets_mode`, `predicted_affected`, `mechanism`, …, all optional.
- **`Candidate`:**
  - `variant`, `edits`;
  - `ev?: EvalResult`;
  - `gate_failure?`, `detail?`;
  - `file?` (the candidate's workflow file), `hash?`.
- **`Decision`:**
  - `variant`, `admissible`, `reason`;
  - `S?`, `C?`, `delta_S?`, `delta_C?`;
  - `novelty`, `guards`.

**The functions:**
- **`candidateComponents(c)`:** the edits' components, leaving out empty ones.
- **`costRule(dS, dC, nov, delta, cfg)`** returns `[ok, why]`.
- **`judge(cand, incumbent, S_star, delta, cfg, incumbentCounts, guards = [])`.**
- **`selectRound(cands, incumbent, S_star, delta, cfg, incumbentCounts, guardFn?)`**
  returns `{ winner, decisions }`.
  - **The guard function** is called only for candidates with an evaluation.
  - **The winner** is the first admissible candidate with the highest `S`. This is
    Python's `max`, which keeps the first one on a tie.

**The reason texts** are RRSI's, with Python's format specs done by hand: a helper
`signed(x, digits)` gives `+0.0500` and `-0.0100`.

### `src/evolve/attribution.ts` (`rrsi/loop.py: attribute`)

**`attribute(t, variant, edits, inc, cand, k)`** returns one row per edit:
- `{t, variant, edit_id, component, hypothesis}`, with `hypothesis` cut to 160
  characters;
- `n_predicted`;
- `predicted_hit`;
- `hit_rate`: null when nothing is predicted, else rounded to 2 places;
- `unpredicted_regressions`.

**How each row is worked out:**
- **The threshold** is `1 / max(1, k)`.
- **`pred`:** the edit's `predicted_affected`, as strings, kept only when the task
  is in both evaluations.
- **`hits`:** the tasks in `pred` where `taskMean(cand) > taskMean(inc)`.
- **`drops`:** the tasks of `inc` that are in `cand` and whose mean fell by at
  least the threshold.
- **`unpredicted_regressions`:** the drops that are not in `pred`, the first 12.

## Tests (vitest; port `tests/test_core.py` and add these)

**`schedule.test.ts`.**
- RRSI's `test_schedule_matches_eq_anneal`: T = 20, 1..4, every t against the
  formula. The table starts at `b_max` and does not increase, and
  `editBudget(T, T) = b_min`.
- Also: T ≤ 0, and t below 0 or above T.

**`measure.test.ts`.**
- RRSI's `test_estimator_and_weights`:
  - S = 0.75 and `n_expected` = 4;
  - weights 10 and 90 give 15/200.
- **`fromReport`:**
  - on a report built with `buildReport` from `src/cli/evalReport.ts`, its S and C
    equal the report's;
  - not `done` is invalid;
  - a bad shape is invalid.
- `relativeCostChange`, `pooled` and `tooManyMissing`.

**`calibrate.test.ts`.**
- RRSI's `test_calibration_bootstrap_and_repeats`.
- **By hand:** two evaluations with S 0.5 and 0.7 give `sd_null` 0.2, so
  `delta` = 0.4 when z = 2, and `max_abs_diff` is 0.2.
- The same seed gives the same result.
- No evaluations throws.

**`selection.test.ts`.**
- RRSI's `test_cost_rule_both_branches`, unchanged.
- RRSI's `test_selection_floor_argmax_and_sstar`, with the `skill` component
  replaced by `client_tool`.
- A tie keeps the first.

**`history.test.ts`.**
- RRSI's `test_history_summaries_prune_and_explore`.
  - **Adapted:** `skill` becomes `client_tool`. `novelty(["subagent", "prompt"], counts)`
    is 1, and `novelty(["client_tool"], {client_tool: 2})` is 0.
  - **Ported one for one:**
    - the four `stall_flag` cases;
    - the exploration case.
- **The no-edit record** has `edit_id` C1.
- **`render`** keeps at most 4 unmeasured records and the last n.
- **A bad line** throws with its line number.

**`components.test.ts`.**
- `PRECEDENCE` holds the same components as `K`.
- `mostStructural`.
- `novelty`.

**`attribution.test.ts`.**
- hits and `hit_rate`;
- the 1/k threshold, including a drop of exactly the threshold;
- the cap of 12;
- a predicted task missing from one evaluation is ignored.

**`config.test.ts`.**
- RRSI's `test_config_roundtrip`, adapted: an unknown key is an error, not a note.
- Overrides, with `undefined` ignored.
- The bounds.
- The cross-key checks after the overrides.
- `configDiff`.

## Checks

- `npx tsc --noEmit`: clean.
- `npx vitest run tests/unit/evolve`: all pass.
- `npx vitest run`: the whole suite still passes (1931 passed, 2 skipped before this
  part).
