// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The edit history L_t and the summaries computed from it (rrsi/history.py):
 *
 *     L_t = {(t_i, l_i, h_i, d_i, ΔS_i, ΔC_i, a_i) : i ≤ n_t}                    Eq. (history)
 *     T_t = {l_i : i ≤ n_t}                                                       the tried components
 *     g_t(l) = max{ΔS_i : l_i = l, t − t_i ≤ n_prune},  max(∅) = −∞               Eq. (yield)
 *     U_t = K \ T_t,   σ_t = 1[S_t − S_{t−w} ≤ delta]                             Eq. (explore)
 *     B_t = {l ∈ T_t : g_t(l) ≤ 0}                                                Eq. (prune)
 *
 * history.jsonl has one record per EDIT. A candidate that bundles n edits (n ≤ b_t) has one measurement (ΔS, ΔC, a) and every
 * edit of the bundle carries it: as b_t anneals to 1, a record becomes evidence about a single component. A candidate dropped
 * before a measurement (critic reject, smoke fail, invalid evaluation) is recorded with delta_S null and enters neither T_t nor g_t.
 */
import { isComponent, K, type Component } from "@/evolve/components";
import { appendJsonl, readJsonl } from "@/evolve/jsonl";
import { roundTo } from "@/evolve/measure";
import type { EditRecord } from "@/evolve/selection";

/** One line of history.jsonl. The BASELINE record has no edit (edit_id null). */
export interface HistoryRecord {
  t: number;
  variant?: string;
  edit_id?: string | null;
  component?: string | null;
  hypothesis?: string | null;
  targets_mode?: string | null;
  predicted_affected?: readonly unknown[] | null;
  /** The path of the candidate's change file. */
  diff?: string | null;
  delta_S?: number | null;
  delta_C?: number | null;
  accepted?: boolean;
  /** ACCEPTED, REJECTED or LOST for a measured candidate; BASELINE; or the gate failure that dropped it. */
  outcome?: string;
  S?: number | null;
  C?: number | null;
  /** The number of edits in the candidate. */
  bundle?: number;
  detail?: string;
  /** ISO 8601. */
  ts?: string;
}

/** A record with a measurement and a known component: it counts in T_t and g_t. */
export type MeasuredRecord = HistoryRecord & { component: Component; delta_S: number };

/** An accepted edit, as the prune set and the incumbent's counts see it. */
export interface AcceptedEdit {
  t: number;
  edit_id: string | null;
  hypothesis: string | null;
  delta_S: number | null;
}

export interface PruneEntry {
  component: Component;
  /** g_t of the component, rounded to 5 places; null when nothing is recent (−∞). */
  recent_best_gain: number | null;
  /** The machinery to remove: the component's accepted edits. */
  accepted_edits_in_incumbent: AcceptedEdit[];
}

// The keys of a record that the proposer sees, and how many records without a measurement it keeps: a wall of aborts is a
// feedback loop, not evidence.
const RENDER_KEYS = ["t", "variant", "edit_id", "component", "hypothesis", "targets_mode", "delta_S", "delta_C", "accepted", "outcome", "bundle", "detail"] as const;
export type RenderedRecord = Pick<HistoryRecord, (typeof RENDER_KEYS)[number]>;
const UNMEASURED_KEPT = 4;

const perComponent = <T>(value: (c: Component) => T): Record<Component, T> => Object.fromEntries(K.map((c) => [c, value(c)])) as Record<Component, T>;
const stamped = (rec: HistoryRecord): HistoryRecord => (rec.ts === undefined ? { ...rec, ts: new Date().toISOString() } : { ...rec });
const isMeasured = (r: HistoryRecord): r is MeasuredRecord => r.delta_S !== undefined && r.delta_S !== null && isComponent(r.component);

/** The history of a run: a JSONL file, read whole by every summary. */
export class History {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  // ── storage ─────────────────────────────────────────────────────────────────

  records(): HistoryRecord[] {
    return readJsonl(this.path) as HistoryRecord[];
  }

  /** Appends a record, with a timestamp (ISO 8601) when it has none. */
  append(rec: HistoryRecord): void {
    appendJsonl(this.path, [stamped(rec)]);
  }

  /**
   * Writes the records of one candidate H', one per edit, in one write. With no edits there is one record, for an edit C1 with no
   * component. S and the deltas are rounded to 6 places and C to 1; the detail is cut to 600 characters. A measurement or a
   * diff that is null or undefined (a candidate that was never evaluated) is written as null.
   */
  appendCandidate(
    t: number, variant: string, edits: readonly EditRecord[], outcome: string, delta_S: number | null | undefined,
    delta_C: number | null | undefined, accepted: boolean, S: number | null | undefined, C: number | null | undefined,
    diff: string | null | undefined, detail = "",
  ): void {
    const rounded = (x: number | null | undefined, digits: number) => (x === null || x === undefined ? null : roundTo(x, digits));
    const list: readonly EditRecord[] = edits.length > 0 ? edits : [{ id: "C1", component: null, hypothesis: null }];
    appendJsonl(this.path, list.map((e) => stamped({
      t, variant, edit_id: e.id ?? null, component: e.component ?? null, hypothesis: (e.hypothesis || e.mechanism) ?? null,
      targets_mode: e.targets_mode ?? null, predicted_affected: e.predicted_affected ?? null, diff: diff ?? null,
      delta_S: rounded(delta_S, 6), delta_C: rounded(delta_C, 6), accepted: Boolean(accepted), outcome,
      S: rounded(S, 6), C: rounded(C, 1), bundle: edits.length,
      detail: detail ? [...detail].slice(0, 600).join("") : "", // by characters, not UTF-16 units: no emoji is cut in half
    })));
  }

  /** Whether the round t already has a record for the variant: a resumed round skips what it wrote. */
  has(t: number, variant: string): boolean {
    return this.records().some((r) => r.t === t && r.variant === variant);
  }

  // ── summaries ───────────────────────────────────────────────────────────────

  /** The records with a measurement and a component in K. */
  measured(): MeasuredRecord[] {
    return this.records().filter(isMeasured);
  }

  /** T_t: the components with at least one measured edit. */
  tried(): Set<Component> {
    return new Set(this.measured().map((r) => r.component));
  }

  /** The edits per component that were shipped at all, measured or not. */
  attempted(): Record<Component, number> {
    const counts = perComponent(() => 0);
    for (const r of this.records()) if (isComponent(r.component) && r.edit_id) counts[r.component]++;
    return counts;
  }

  /** The machinery in the incumbent, per component: the accepted edits. */
  acceptedEdits(): Record<Component, AcceptedEdit[]> {
    const out = perComponent((): AcceptedEdit[] => []);
    for (const r of this.records()) {
      if (r.accepted && isComponent(r.component)) {
        out[r.component].push({ t: r.t, edit_id: r.edit_id ?? null, hypothesis: r.hypothesis ?? null, delta_S: r.delta_S ?? null });
      }
    }
    return out;
  }

  incumbentComponentCounts(): Record<Component, number> {
    const accepted = this.acceptedEdits();
    return perComponent((c) => accepted[c].length);
  }

  /** g_t(l) for every tried component: the best delta_S within the window; −∞ when nothing is recent. */
  yieldG(t: number, n_prune: number): Partial<Record<Component, number>> {
    const measured = this.measured();
    const g: Partial<Record<Component, number>> = {};
    for (const r of measured) g[r.component] = -Infinity;
    for (const r of measured) if (t - r.t <= n_prune) g[r.component] = Math.max(g[r.component] as number, r.delta_S);
    return g;
  }

  /** B_t: the tried components with g ≤ 0, alphabetically, each with the accepted machinery to remove. */
  pruneSet(t: number, n_prune: number): PruneEntry[] {
    const g = this.yieldG(t, n_prune);
    const accepted = this.acceptedEdits();
    const entries: PruneEntry[] = [];
    for (const component of (Object.keys(g) as Component[]).sort()) {
      const gain = g[component] as number;
      if (gain <= 0) {
        entries.push({
          component, recent_best_gain: gain === -Infinity ? null : roundTo(gain, 5), accepted_edits_in_incumbent: accepted[component],
        });
      }
    }
    return entries;
  }

  // ── for the prompts ─────────────────────────────────────────────────────────

  /**
   * A compact view of the last `n` records for the proposer, oldest first, without their null or missing values. Measured outcomes
   * dominate: of the records without a measurement, only the most recent 4 are kept.
   */
  render(n = 40): RenderedRecord[] {
    const records = this.records();
    const kept: HistoryRecord[] = [];
    let unmeasured = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.delta_S === undefined || r.delta_S === null) {
        unmeasured++;
        if (unmeasured > UNMEASURED_KEPT) continue;
      }
      kept.push(r);
      if (kept.length >= n) break;
    }
    return kept.reverse().map((r) =>
      Object.fromEntries(RENDER_KEYS.filter((key) => r[key] !== undefined && r[key] !== null).map((key) => [key, r[key]])) as RenderedRecord);
  }
}

// ── explore ───────────────────────────────────────────────────────────────────

/** σ_t = 1[S_t − S_{t−w} ≤ delta]: 1 when the trajectory has not moved by more than the band over the last w rounds; 0 while fewer
 *  than w rounds exist. */
export function stallFlag(trajectory: readonly number[], t: number, w: number, delta: number): 0 | 1 {
  if (t < w || t >= trajectory.length) return 0;
  return trajectory[t] - trajectory[t - w] <= delta ? 1 : 0;
}

export interface Exploration {
  sigma: number;
  /** U_t: the components of K with no measured edit, in K's order. */
  untried: Component[];
  m_draft: number;
  /** What the proposer is told. */
  text: string;
}

/** E_t = (σ_t, U_t, m_draft), with the text handed to the proposer. `t` is RRSI's argument; the text does not use it. */
export function exploration(_t: number, stall: number, tried: ReadonlySet<string>, m_draft: number): Exploration {
  const untried = K.filter((c) => !tried.has(c));
  const list = JSON.stringify(untried);
  let text: string;
  if (stall !== 0 && untried.length > 0) {
    text = `STALL: the incumbent has not moved by more than the noise band over the last rounds (sigma_t = 1). ${m_draft} candidate ` +
      `slot(s) this round are RESERVED for exploratory edits on components the run has never exercised: ${list}. A variant ` +
      "holding a reserved slot must put at least one edit on one of those components.";
  } else if (untried.length > 0) {
    text = `Components not yet exercised in this run: ${list}. Not mandatory this round (sigma_t = 0), but evidence about them ` +
      "is still missing.";
  } else {
    text = "Every component in K has been exercised at least once.";
  }
  return { sigma: stall, untried, m_draft, text };
}
