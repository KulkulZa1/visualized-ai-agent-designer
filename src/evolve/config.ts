// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The parameters of `harness evolve` (rrsi/config.py, the method's part and the engineering knobs a run needs). The symbols and
 * the names of the keys are RRSI's, so they are the same in a user's `--config` file and in the run's saved pins. The schema is
 * strict: an unknown key is an error, where RRSI keeps it in `notes`.
 *
 * Units. S is a fraction in [0, 1]; C is the mean policy tokens per trial; ΔC is relative, so beta0 = 0.10 means "10% more
 * tokens for free" and beta1 = 40 means "each +1 point of S buys +40%".
 */
import { z } from "zod";

export interface EvolveConfig {
  /** Rounds, t = 0..T-1. */
  T: number;
  /** Trials per task in each evaluation. */
  k: number;
  /** Candidates per round. */
  m: number;
  /** Bounds of the edit budget b_t. */
  b_min: number;
  b_max: number;
  /** The stall window. */
  w: number;
  /** Candidate slots reserved for exploration when stalled. */
  m_draft: number;
  /** The noise band; null: measured from the base workflow. */
  delta: number | null;
  /** When measured: delta = delta_z · sd(null ΔS). */
  delta_z: number;
  /** Evaluations of the base workflow for the band; 1 means a bootstrap over the trials of one. */
  calibrate: number;
  /** The cost rule for a gaining candidate: ΔC ≤ beta0 + beta1·ΔS. */
  beta0: number;
  beta1: number;
  /** The shaped rule within the band: w_s·ΔS − w_c·ΔC + w_n·ν > 0. */
  w_s: number;
  w_c: number;
  w_n: number;
  /** The window of the yield summary. */
  n_prune: number;
  /** Proposer retries after a check or the critic says no. */
  repair_rounds: number;
  /** An evaluation with more missing trials than this share of the expected ones is invalid. */
  invalid_missing_frac: number;
  /** The failing and the passing traces shown to the proposer. */
  n_fail_traces: number;
  n_success_traces: number;
}

/** RRSI's defaults (rrsi/config.py), with the engineering knobs lowered for local models. */
export const DEFAULT_CONFIG: Readonly<EvolveConfig> = Object.freeze({
  T: 20, k: 2, m: 2, b_min: 1, b_max: 4, w: 3, m_draft: 1,
  delta: null, delta_z: 2.0, calibrate: 1,
  beta0: 0.10, beta1: 40, w_s: 100, w_c: 15, w_n: 0.5, n_prune: 4,
  repair_rounds: 2, invalid_missing_frac: 0.15, n_fail_traces: 4, n_success_traces: 2,
});

// The bounds. The cross-key ones (b_min ≤ b_max, m_draft ≤ m) are checked in configFromJson, after the overrides.
const int = (min: number, max?: number) => (max === undefined ? z.number().int().min(min) : z.number().int().min(min).max(max));
const configSchema: z.ZodType<EvolveConfig> = z.strictObject({
  T: int(1, 1000),
  k: int(1, 1000),
  m: int(1, 8), // the variants are labelled A..H, as RRSI's VARIANT_LABELS
  b_min: int(1),
  b_max: int(1, 20),
  w: int(1),
  m_draft: int(0),
  delta: z.number().min(0).nullable(),
  delta_z: z.number().positive(),
  calibrate: int(1, 100),
  beta0: z.number(),
  beta1: z.number(),
  w_s: z.number(),
  w_c: z.number(),
  w_n: z.number(),
  n_prune: int(0),
  repair_rounds: int(0, 10),
  invalid_missing_frac: z.number().min(0).max(1),
  n_fail_traces: int(0, 50),
  n_success_traces: int(0, 50),
});

/**
 * The defaults, then the file's keys (`raw`, the parsed `--config` file; `{}` when there is none), then the overrides, checked
 * together. An override whose value is `undefined` is ignored, as RRSI's `load` ignores `None`; one that is `null` (only `delta`
 * can be) is applied. An unknown key, a value out of its bounds and a cross-key conflict are errors that name the keys.
 */
export function configFromJson(raw: unknown, overrides: Partial<EvolveConfig>): { config: EvolveConfig } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "the config must be a JSON object" };
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(raw as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) merged[key] = value;

  const checked = configSchema.safeParse(merged);
  if (!checked.success) {
    const problems = checked.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => `unknown key "${key}"`) : [`${issue.path.map(String).join(".")}: ${issue.message}`]);
    return { error: problems.join("\n") };
  }
  const config = checked.data;
  const problems: string[] = [];
  if (config.b_min > config.b_max) problems.push(`b_min (${config.b_min}) must not be above b_max (${config.b_max})`);
  if (config.m_draft > config.m) problems.push(`m_draft (${config.m_draft}) must not be above m (${config.m})`);
  return problems.length > 0 ? { error: problems.join("\n") } : { config };
}

/** The keys whose values differ between two configs, in the config's order; the loop reports a pin mismatch with it. */
export function configDiff(a: EvolveConfig, b: EvolveConfig): Array<keyof EvolveConfig> {
  return (Object.keys(DEFAULT_CONFIG) as Array<keyof EvolveConfig>).filter((key) => a[key] !== b[key]);
}
