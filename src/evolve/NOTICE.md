# Notice: code ported from RRSI

The selection method in this folder is ported from RRSI, <https://github.com/google-research/rrsi> at
commit `be50316`:
- Copyright 2026 The rrsi Authors;
- Copyright 2026 Google LLC.

It is used under the Apache License, Version 2.0. A copy is in [`LICENSE-rrsi`](LICENSE-rrsi).

**These files are modified versions.** They were translated from Python to TypeScript and changed for
Harness Studio:

| File | Ported from |
|---|---|
| `config.ts` | `rrsi/config.py` |
| `schedule.ts` | `rrsi/schedule.py` |
| `measure.ts` | `rrsi/evaluate.py` |
| `calibrate.ts` | `rrsi/calibrate.py` |
| `components.ts` | `rrsi/components.py` |
| `history.ts` | `rrsi/history.py` |
| `selection.ts` | `rrsi/selection.py` |
| `attribution.ts` | `rrsi/loop.py` (`attribute`) |
| `edits.ts` | `rrsi/propose.py` (the checks of `done`: the budget and the reserved slot) and `rrsi/loop.py` (the reserved-slot rejection) |
| `precheck.ts` | `rrsi/critic.py` (`precheck` and its credential pattern) |
| `examples/evolve/proposer.harness.yaml` | `rrsi/propose.py` (the proposer's `SYSTEM_TMPL`) |
| `examples/evolve/critic.harness.yaml` | `rrsi/critic.py` (the critic's `SYSTEM_TMPL`) |
| `brief.ts` | `rrsi/propose.py` (the proposer's context and the rules of its `done`), `rrsi/critic.py` (the reviewer's payload and verdict) and `rrsi/loop.py` (`build_traces`) |
| `loop.ts` | `rrsi/loop.py` (`baseline`, `calibrate`, `heldout`, `round`, `_draft`, `_evaluate`) and `rrsi/driver.py` (a round is settled once the trajectory has its entry; stop after consecutive infrastructure failures) |
| `tests/unit/evolve/*.test.ts` | `tests/test_core.py` (its cases, ported or adapted) |

**The main changes:**
- **The components.** K names the parts of a workflow file, not of a code harness. A change is classified
  by its operations, not by regular expressions over a diff.
- **The precheck's patterns** come from the task set, not from hand-written lists per domain.
- **The config file** is strict: an unknown key is an error.
- **The bootstrap** uses a seeded mulberry32 generator, not Python's `random`.
- **Timestamps** are ISO 8601.
- **The proposer and the critic** are workflows run through an injected `Children`, not model calls in the loop's own process, and the
  proposer sends operations that the loop applies, not edits to a git worktree. The loop starts no process itself.
- **A resumed run** reuses a finished evaluation only when its report is of the same workflow, task set, split and k, and keeps
  each step's result in a file that is written whole (RRSI resumes from `prep.json` and `eval.json` with a branch and a commit).
