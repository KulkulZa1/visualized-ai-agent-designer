// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The annealed edit budget of `harness evolve` (rrsi/schedule.py, Eq. anneal):
 *
 *     b_t = ceil( b_min + (b_max - b_min) · ½ (1 + cos(π t / T)) ),  t = 0..T-1
 *
 * Early rounds may bundle several coordinated edits in one candidate; late rounds become sparse and attributable. The budget
 * bounds the number of independent edits in one proposal, and nothing else.
 */

/** b_t for round t (0-indexed) of a T-round run. `t` is clamped to [0, T]; T ≤ 0 gives b_max. */
export function editBudget(t: number, T: number, b_min: number, b_max: number): number {
  if (T <= 0) return Math.trunc(b_max);
  const clamped = Math.max(0, Math.min(Math.trunc(t), Math.trunc(T)));
  const v = b_min + (b_max - b_min) * 0.5 * (1.0 + Math.cos((Math.PI * clamped) / T));
  // Rounding to 9 decimals first: floating error must not turn 2.0000000000000004 into 3.
  return Math.ceil(Math.round(v * 1e9) / 1e9);
}

/** The budgets of rounds t = 0..T-1. */
export function budgetTable(T: number, b_min: number, b_max: number): number[] {
  return Array.from({ length: Math.max(0, T) }, (_, t) => editBudget(t, T, b_min, b_max));
}
