// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The noise band delta of `harness evolve` (rrsi/calibrate.py, Sec. stability-aware acceptance): how far S moves between two
 * independent evaluations of the SAME workflow. With R ≥ 2 evaluations of the base workflow the null difference is observed
 * directly; with one, the standard error of S is bootstrapped over the trials within each task, and the null difference of two
 * independent evaluations has standard deviation √2·se. Either way
 *
 *     delta = z · sd(null ΔS),   z = 2 by default,
 *
 * so an unchanged workflow clears the floor S* − delta about 97.5% of the time, and a gain must exceed the band before the cost
 * rule treats it as real.
 */
import { pooled, roundTo, type EvalResult } from "@/evolve/measure";

/** A small seeded PRNG (mulberry32). The draws differ from Python's `random.Random(seed)`; a given seed is still deterministic. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The standard deviation of `values`, population (ddof 0, Python's `pstdev`) or sample (ddof 1, `stdev`). Constant values give
 *  exactly 0, as Python's exact arithmetic does: a plain two-pass sum would give about 1e-17 for 0.1, 0.1, 0.1. */
function stdev(values: readonly number[], ddof: 0 | 1): number {
  if (values.length <= ddof || values.every((v) => v === values[0])) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squares = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(squares / (values.length - ddof));
}

/** se(S) by resampling the trials within each task, weights respected. */
export function bootstrapSe(ev: EvalResult, reps = 2000, seed = 7): number {
  const rng = mulberry32(seed);
  const tasks = Object.values(ev.per_task).filter((tr) => tr.rewards.length > 0);
  const vals: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    let num = 0;
    let den = 0;
    for (const tr of tasks) {
      const n = tr.rewards.length;
      for (let j = 0; j < n; j++) {
        const i = Math.floor(rng() * n); // Python's randrange(n)
        num += tr.rewards[i] * tr.weights[i];
        den += tr.weights[i];
      }
    }
    vals.push(den !== 0 ? num / den : 0);
  }
  return vals.length > 1 ? stdev(vals, 0) : 0;
}

/** What `calibration.json` holds. */
export interface Calibration {
  delta: number;
  z: number;
  /** The sd of the null ΔS that delta is built from: the repeats' when there are two or more and they differ, else the bootstrap's. */
  sd_null: number;
  /** The bootstrap's sd of the null ΔS, whether or not it was the one used. */
  sd_null_bootstrap: number;
  se_bootstrap: number;
  method: string;
  n_evals: number;
  k: number;
  n_tasks: number;
  S_base: number;
  C_base: number | null;
  /** With two or more evaluations: each one's S, and the largest difference between two. */
  S_per_eval?: number[];
  max_abs_diff?: number;
}

/** delta from one or more evaluations of the base workflow. Throws when there is none. */
export function calibrate(evals: readonly EvalResult[], z = 2.0, reps = 2000): Calibration {
  if (evals.length === 0) throw new Error("no base evaluations");
  let sdNull = 0;
  let method = "bootstrap over trials of one base evaluation";
  let observed: Pick<Calibration, "S_per_eval" | "max_abs_diff"> = {};
  if (evals.length >= 2) {
    const scores = evals.map((e) => e.S);
    const diffs = scores.flatMap((a, i) => scores.slice(i + 1).map((b) => Math.abs(a - b)));
    sdNull = stdev(scores, 1) * Math.SQRT2;
    method = "repeated base evaluations";
    observed = { S_per_eval: scores, max_abs_diff: Math.max(...diffs) };
  }
  const pooledEv = pooled(evals);
  const se = bootstrapSe(pooledEv, reps);
  const sdBoot = Math.SQRT2 * se * Math.sqrt(pooledEv.k / evals[0].k);
  // With repeated evaluations prefer the direct observation, unless it is degenerate.
  const sdUse = evals.length >= 2 && sdNull > 0 ? sdNull : sdBoot;
  return {
    delta: roundTo(z * sdUse, 6), z, sd_null: roundTo(sdUse, 6), sd_null_bootstrap: roundTo(sdBoot, 6), se_bootstrap: roundTo(se, 6),
    method, n_evals: evals.length, k: evals[0].k, n_tasks: Object.keys(pooledEv.per_task).length, S_base: roundTo(evals[0].S, 6),
    C_base: evals[0].C, ...observed,
  };
}
