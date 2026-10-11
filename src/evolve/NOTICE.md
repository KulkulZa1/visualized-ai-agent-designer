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
| `tests/unit/evolve/*.test.ts` | `tests/test_core.py` (its cases, ported or adapted) |

**The main changes:**
- **The components.** K names the parts of a workflow file, not of a code harness. A change is classified
  by its operations, not by regular expressions over a diff.
- **The precheck's patterns** come from the task set, not from hand-written lists per domain.
- **The config file** is strict: an unknown key is an error.
- **The bootstrap** uses a seeded mulberry32 generator, not Python's `random`.
- **Timestamps** are ISO 8601.
