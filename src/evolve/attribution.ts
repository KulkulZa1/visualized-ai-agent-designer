// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The attribution of a measured candidate (rrsi/loop.py, `attribute`): per edit, what it predicted against what the evaluation
 * found. The rows are what the proposer sees as its scoreboard. This only computes them; the loop appends them to attribution.jsonl.
 */
import { roundTo, taskMean, type EvalResult } from "@/evolve/measure";
import type { EditRecord } from "@/evolve/selection";

/** The most unpredicted regressions listed in a row. */
const MAX_REGRESSIONS = 12;

export interface AttributionRow {
  t: number;
  variant: string;
  edit_id: string | null;
  component: string | null;
  /** Cut to 160 characters. */
  hypothesis: string | null;
  /** The predicted tasks that both evaluations ran. */
  n_predicted: number;
  /** Of those, the ones whose mean rose. */
  predicted_hit: string[];
  /** predicted_hit over n_predicted, to 2 places; null when nothing is predicted. */
  hit_rate: number | null;
  /** Tasks whose mean fell by at least 1/k and that no one predicted. */
  unpredicted_regressions: string[];
}

/**
 * One row per edit of the candidate whose evaluation is `cand`, against the incumbent's `inc`. `k` is the trials per task: a task
 * regressed when its mean fell by at least 1/k, the loss of one trial. A task is looked up as its own key, never an inherited one,
 * since the proposer's `predicted_affected` is model output.
 */
export function attribute(
  t: number, variant: string, edits: readonly EditRecord[], inc: EvalResult, cand: EvalResult, k: number,
): AttributionRow[] {
  const threshold = 1 / Math.max(1, k);
  const ran = (id: string) => Object.hasOwn(inc.per_task, id) && Object.hasOwn(cand.per_task, id);
  const drops = Object.keys(inc.per_task).filter((id) => ran(id) && taskMean(cand.per_task[id]) - taskMean(inc.per_task[id]) <= -threshold);
  return edits.map((e) => {
    const pred = (e.predicted_affected ?? []).map(String).filter(ran);
    const hits = pred.filter((id) => taskMean(cand.per_task[id]) > taskMean(inc.per_task[id]));
    return {
      t, variant, edit_id: e.id ?? null, component: e.component ?? null,
      hypothesis: e.hypothesis === undefined || e.hypothesis === null ? null : [...String(e.hypothesis)].slice(0, 160).join(""),
      n_predicted: pred.length, predicted_hit: hits, hit_rate: pred.length > 0 ? roundTo(hits.length / pred.length, 2) : null,
      unpredicted_regressions: drops.filter((id) => !pred.includes(id)).slice(0, MAX_REGRESSIONS),
    };
  });
}
