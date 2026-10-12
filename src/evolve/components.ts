// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The components of a workflow, K (rrsi/components.py, adapted). RRSI's K names the kinds of change to a code harness; for a
 * workflow, K is the set of things an operation can change, and K_STR the ones that add machinery (a memory key, a tool, an
 * agent) rather than change text or a constant. An edit's component is the most structural one among its operations. RRSI's
 * regex classification of a diff is not ported: the proposer's operations say what changed.
 */

/** In this order: it is the order of "untried" in the exploration text. */
export const K = ["prompt", "config", "control_flow", "context_mgmt", "memory", "client_tool", "subagent"] as const;
export type Component = (typeof K)[number];

/** The structural components. */
export const K_STR: readonly Component[] = ["memory", "client_tool", "subagent"];

/** The most structural first: an edit's component is the first of these that one of its operations has. */
export const PRECEDENCE: readonly Component[] = ["subagent", "memory", "client_tool", "control_flow", "context_mgmt", "config", "prompt"];

export function isComponent(x: unknown): x is Component {
  return typeof x === "string" && (K as readonly string[]).includes(x);
}

/** The first of PRECEDENCE that is in `components`; null for none. */
export function mostStructural(components: readonly string[]): Component | null {
  return PRECEDENCE.find((c) => components.includes(c)) ?? null;
}

/** ν: the number of distinct structural components in `editComponents` that the incumbent has no accepted edit on. It only ever
 *  breaks a tie inside the noise band. */
export function novelty(editComponents: readonly string[], incumbentCounts: Partial<Record<string, number>>): number {
  let count = 0;
  for (const c of new Set(editComponents)) if (isComponent(c) && K_STR.includes(c) && (incumbentCounts[c] ?? 0) === 0) count++;
  return count;
}
