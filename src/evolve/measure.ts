// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * An evaluation as RRSI's selection reads it (rrsi/evaluate.py, Eq. estimate): per task, the trials' rewards, weights, token
 * totals and missing count; and the pooled score S and cost C. A missing trial (a crash, a timeout) is a reward of 0 with its
 * full weight, never an absent slot, so a candidate cannot look better by destroying the trials it finds hard.
 * `fromReport` reads one from the report of `harness eval` (src/cli/evalReport.ts).
 */
import { z } from "zod";

export interface TaskResult {
  /** One per trial; a missing trial is 0. */
  rewards: number[];
  /** One per trial: the task's weight. */
  weights: number[];
  /** Each trial's token total; null for a trial with no count. */
  tokens: Array<number | null>;
  missing: number;
}

export interface EvalResult {
  job: string;
  /** Trials per task. */
  k: number;
  per_task: Record<string, TaskResult>;
  /** The pooled score: Σ reward·weight over Σ weight, over every trial. */
  S: number;
  /** The mean of the token totals above 0; null when no trial has one. */
  C: number | null;
  /** Tasks × k. */
  n_expected: number;
  missing: number;
}

/**
 * Python's `format(x, f".{digits}f")`: `x` rounded to `digits` decimals as text. Like Python it rounds the exact binary value, and
 * an exact half goes to the even digit. `toFixed` sends an exact half up, so it writes 0.28125 as 0.2813 where Python writes 0.2812;
 * and `Math.round(x * 10 ** digits)` rounds 5e-7 up to 1e-6, although 5e-7 is a hair under the half.
 */
export function fixed(x: number, digits: number): string {
  const text = x.toFixed(digits);
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return text;
  const exact = Math.abs(x).toFixed(100); // the decimal expansion of a double ends, and all of it is here
  const cut = exact.indexOf(".") + 1 + digits;
  if (!/^50*$/.test(exact.slice(cut))) return text; // not an exact half
  const down = exact.slice(0, digits === 0 ? cut - 1 : cut); // the half cut off, toward zero
  return Number(down[down.length - 1]) % 2 === 0 ? `${x < 0 ? "-" : ""}${down}` : text;
}

/** Python's `round(x, digits)`, for the numbers written to the history and the calibration (see `fixed`). Never -0. */
export function roundTo(x: number, digits: number): number {
  const rounded = Number(fixed(x, digits));
  return rounded === 0 ? 0 : rounded;
}

/** The weighted mean reward of a task's trials; 0 when the weights sum to 0. */
export function taskMean(tr: TaskResult): number {
  const weight = tr.weights.reduce((sum, w) => sum + w, 0);
  if (weight === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < Math.min(tr.rewards.length, tr.weights.length); i++) weighted += tr.rewards[i] * tr.weights[i];
  return weighted / weight;
}

/** Folds the per-task trial records into S and C, as RRSI's `aggregate` does. `k` is the trials planned per task. */
export function aggregate(job: string, k: number, perTask: Record<string, TaskResult>): EvalResult {
  let num = 0;
  let den = 0;
  let missing = 0;
  const counted: number[] = [];
  const tasks = Object.values(perTask);
  for (const tr of tasks) {
    for (let i = 0; i < Math.min(tr.rewards.length, tr.weights.length); i++) {
      num += tr.rewards[i] * tr.weights[i];
      den += tr.weights[i];
    }
    for (const total of tr.tokens) if (typeof total === "number" && total > 0) counted.push(total);
    missing += tr.missing;
  }
  return {
    job, k, per_task: perTask, S: den !== 0 ? num / den : 0,
    C: counted.length > 0 ? counted.reduce((sum, t) => sum + t, 0) / counted.length : null,
    n_expected: tasks.length * k, missing,
  };
}

/** ΔC = (C' − C_t) / C_t; 0 when either side has no token count. */
export function relativeCostChange(cCand: number | null, cInc: number | null): number {
  if (cCand === null || cCand === 0 || cInc === null || cInc === 0) return 0;
  return (cCand - cInc) / cInc;
}

/** The trials of several evaluations of the same workflow, as one evaluation: k and the missing counts add up. */
export function pooled(evals: readonly EvalResult[]): EvalResult {
  const per = new Map<string, TaskResult>();
  for (const ev of evals) {
    for (const [id, tr] of Object.entries(ev.per_task)) {
      let p = per.get(id);
      if (p === undefined) {
        p = { rewards: [], weights: [], tokens: [], missing: 0 };
        per.set(id, p);
      }
      p.rewards = p.rewards.concat(tr.rewards); // concat, not push(...): no argument limit, and the inputs are never aliased
      p.weights = p.weights.concat(tr.weights);
      p.tokens = p.tokens.concat(tr.tokens);
      p.missing += tr.missing;
    }
  }
  return aggregate("pooled", evals.reduce((sum, ev) => sum + ev.k, 0), Object.fromEntries(per));
}

// Only what is read. The report is written by `harness eval`, not by the user, so other fields are allowed.
const reportSchema = z.object({
  status: z.string(),
  k: z.number().int().min(1),
  n_expected: z.number().int().min(0).optional(),
  per_task: z.record(z.string(), z.object({
    weight: z.number(),
    rewards: z.array(z.number()),
    tokens: z.array(z.number().nullable()),
    missing: z.number().int().min(0),
  })),
});

const MAX_SHAPE_PROBLEMS = 5;

/**
 * The evaluation in a `harness eval` report.json (`raw` is the parsed file), recomputed from the trials with `aggregate`. A report
 * is invalid, and the reason says why, when it is not in the report's shape, when its status is not `done`, or when its `n_expected`
 * is not the tasks it lists times k: S over fewer tasks than the run had would not be the S of the run.
 */
export function fromReport(job: string, raw: unknown): { ev: EvalResult } | { invalid: string } {
  const checked = reportSchema.safeParse(raw);
  if (!checked.success) {
    const issues = checked.error.issues;
    const shown = issues.slice(0, MAX_SHAPE_PROBLEMS).map((issue) => `${issue.path.map(String).join(".") || "report"}: ${issue.message}`);
    const more = issues.length > shown.length ? `; and ${issues.length - shown.length} more` : "";
    return { invalid: `not a harness eval report: ${shown.join("; ")}${more}` };
  }
  const report = checked.data;
  if (report.status !== "done") return { invalid: `the eval did not finish: its status is "${report.status}", not "done"` };
  const listed = Object.keys(report.per_task).length;
  if (report.n_expected !== undefined && report.n_expected !== listed * report.k) {
    const missing = report.n_expected > listed * report.k ? ": a task is missing from per_task" : "";
    return { invalid: `the report expects ${report.n_expected} trials but lists ${listed} task${listed === 1 ? "" : "s"} of ${report.k}${missing}` };
  }
  const per = Object.entries(report.per_task).map(([id, task]): [string, TaskResult] => [id, {
    rewards: task.rewards, weights: task.rewards.map(() => task.weight), tokens: task.tokens, missing: task.missing,
  }]);
  return { ev: aggregate(job, report.k, Object.fromEntries(per)) };
}

/** An evaluation with more missing trials than `frac` of the expected ones is invalid. */
export function tooManyMissing(ev: EvalResult, frac: number): boolean {
  return ev.missing > frac * ev.n_expected;
}
