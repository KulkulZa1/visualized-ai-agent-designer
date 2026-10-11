// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * Algorithm 2 of the paper, the selection side, as pure functions (rrsi/selection.py). For every screened candidate H' with the
 * measurement (S', C'):
 *
 *     ΔS = S' − S_t,   ΔC = (C' − C_t) / C_t
 *     c = [ΔC ≤ beta0 + beta1·ΔS]             if ΔS > delta      Eq. (tokenbudget)
 *         [w_s·ΔS − w_c·ΔC + w_n·ν > 0]       otherwise
 *     admissible  iff  S' ≥ S* − delta  and  c  (and every guard holds)      Eq. (floor)
 *
 *     H_{t+1} = argmax over the admissible H' of S',  or H_t when none is admissible
 *     S*      = max(S*, S_{t+1})
 *
 * The floor is checked before the cost rule, and the cost rule before the guards, so a decision's reason is the first that fails.
 */
import { novelty } from "@/evolve/components";
import type { EvolveConfig } from "@/evolve/config";
import { fixed, relativeCostChange, type EvalResult } from "@/evolve/measure";

/** An edit as the proposer declared it. RRSI's edits are dicts, so every field is optional: the history and the attribution read
 *  the ones they need. */
export interface EditRecord {
  id?: string;
  /** Declared by the proposer; the loop re-tags it with the classified one. */
  component?: string | null;
  hypothesis?: string | null;
  /** RRSI's older name for the hypothesis. */
  mechanism?: string | null;
  targets_mode?: string | null;
  /** The tasks the edit should move. */
  predicted_affected?: readonly unknown[] | null;
  retroactive_check?: string;
  why_not_lower_lever?: string;
  trigger_condition?: string;
  regression_risk?: string;
}

export interface Candidate {
  variant: string;
  edits: EditRecord[];
  /** Its evaluation; none when it did not reach one. */
  ev?: EvalResult;
  /** Why it did not reach one: no_proposal, invalid_proposal, critic_reject, smoke_fail or eval_invalid. */
  gate_failure?: string;
  detail?: string;
  /** The candidate's workflow file, and its hash. */
  file?: string;
  hash?: string;
}

export interface Decision {
  variant: string;
  admissible: boolean;
  reason: string;
  S?: number;
  C?: number | null;
  delta_S?: number;
  delta_C?: number;
  novelty: number;
  guards: string[];
}

/** The components of a candidate's edits, leaving out the edits with none. */
export function candidateComponents(c: Candidate): string[] {
  return c.edits.flatMap((e) => (e.component ? [e.component] : []));
}

/** Python's `f"{x:+.{digits}f}"`: the sign always, then `digits` decimals. */
const signed = (x: number, digits: number): string => `${x < 0 || Object.is(x, -0) ? "-" : "+"}${fixed(Math.abs(x), digits)}`;

/** The cost rule c of Algorithm 2, line 5: whether it holds, and the reason with the numbers. */
export function costRule(dS: number, dC: number, nov: number, delta: number, cfg: EvolveConfig): [boolean, string] {
  if (dS > delta) {
    const budget = cfg.beta0 + cfg.beta1 * dS;
    const ok = dC <= budget;
    return [ok, `gain ${signed(dS, 4)} > delta ${fixed(delta, 4)}; cost change ${signed(dC, 3)} ${ok ? "<=" : ">"} ` +
      `budget ${fixed(budget, 3)} (beta0 ${cfg.beta0} + beta1 ${cfg.beta1} * dS)`];
  }
  const shaped = cfg.w_s * dS - cfg.w_c * dC + cfg.w_n * nov;
  const ok = shaped > 0;
  return [ok, `gain ${signed(dS, 4)} within delta ${fixed(delta, 4)}; shaped ` +
    `${cfg.w_s}*dS - ${cfg.w_c}*dC + ${cfg.w_n}*nu = ${signed(shaped, 4)} ${ok ? ">" : "<="} 0 (nu=${nov})`];
}

/** The decision on one candidate. `guards` are the domain guards it violates, if any: non-compensatory, whatever its score. */
export function judge(
  cand: Candidate, incumbent: EvalResult, S_star: number, delta: number, cfg: EvolveConfig,
  incumbentCounts: Partial<Record<string, number>>, guards: readonly string[] = [],
): Decision {
  const ev = cand.ev;
  if (!ev) return { variant: cand.variant, admissible: false, reason: cand.gate_failure || "not evaluated", novelty: 0, guards: [] };
  const dS = ev.S - incumbent.S;
  const dC = relativeCostChange(ev.C, incumbent.C);
  const nov = novelty(candidateComponents(cand), incumbentCounts);
  const d: Decision = {
    variant: cand.variant, admissible: false, reason: "", S: ev.S, C: ev.C, delta_S: dS, delta_C: dC, novelty: nov, guards: [...guards],
  };
  if (ev.S < S_star - delta) {
    d.reason = `below noise-adjusted floor: S' ${fixed(ev.S, 4)} < S* ${fixed(S_star, 4)} - delta ${fixed(delta, 4)}`;
    return d;
  }
  const [ok, why] = costRule(dS, dC, nov, delta, cfg);
  if (!ok) {
    d.reason = `cost rule failed: ${why}`;
    return d;
  }
  if (guards.length > 0) {
    d.reason = `domain guard violated: ${guards.join("; ")}`;
    return d;
  }
  d.admissible = true;
  d.reason = `admissible: ${why}`;
  return d;
}

/** Judges every candidate; the winner is the admissible one with the highest S' (the first of them on a tie), or null. `guardFn`
 *  returns the guards a candidate's evaluation violates; it is called only for candidates that have one. */
export function selectRound(
  cands: readonly Candidate[], incumbent: EvalResult, S_star: number, delta: number, cfg: EvolveConfig,
  incumbentCounts: Partial<Record<string, number>>, guardFn?: (incumbent: EvalResult, cand: EvalResult) => string[],
): { winner: Candidate | null; decisions: Decision[] } {
  const decisions = cands.map((c) => judge(c, incumbent, S_star, delta, cfg, incumbentCounts, guardFn && c.ev ? guardFn(incumbent, c.ev) : []));
  let winner: Candidate | null = null;
  let best = 0;
  for (let i = 0; i < cands.length; i++) {
    const d = decisions[i];
    if (!d.admissible) continue;
    const S = d.S as number; // an admissible decision has an evaluation
    if (winner === null || S > best) { // strictly: on a tie the first one stays, as Python's max does
      winner = cands[i];
      best = S;
    }
  }
  return { winner, decisions };
}
