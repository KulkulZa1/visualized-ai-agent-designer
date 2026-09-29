/**
 * routing — where a node's output sends the run next.
 *
 * Gateways: `parseGatewayRoute` picks the route the scheduler follows.
 * Feedback edges: a node's verdict fires the feedback edges it names; the run
 * loop then re-runs the path from each fired edge's target back to that node,
 * at most MAX_REVISION_ROUNDS times per node per run.
 */

import type { Edge } from "@xyflow/react";

export const MAX_REVISION_ROUNDS = 2;

type EdgeData = { label?: string; edgeKind?: string };

function isFeedbackEdge(edge: Edge): boolean {
  return (edge.data as EdgeData | undefined)?.edgeKind === "feedback" || edge.type === "feedback";
}

function edgeLabel(edge: Edge): string {
  const dataLabel = (edge.data as EdgeData | undefined)?.label;
  const label = typeof dataLabel === "string" ? dataLabel : typeof edge.label === "string" ? edge.label : "";
  return label.trim().toLowerCase();
}

/** Index of the `}` that closes the `{` at `start`, skipping braces inside JSON strings
 *  (and the quotes they escape); -1 when it never closes. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++; // the next character is escaped
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** The JSON objects in `text`, in order. Braces in prose or code around them are skipped. */
function jsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const starts = /\{(?=\s*["}])/g; // a JSON object opens with `{` and then a key or `}`
  // Characters we may scan in all. Ordinary replies use a fraction of it; a runaway one
  // (thousands of `{"` that never close) would otherwise take quadratic time.
  let budget = 32 * text.length;
  for (let m = starts.exec(text); m && budget > 0; m = starts.exec(text)) {
    const end = closingBrace(text, m.index);
    budget -= (end < 0 ? text.length : end + 1) - m.index;
    if (end < 0) continue;
    try {
      found.push(JSON.parse(text.slice(m.index, end + 1)));
      starts.lastIndex = end + 1; // whatever is nested in this object is part of it
    } catch { /* not JSON: an object may still sit inside these braces */ }
  }
  return found;
}

/**
 * Try to extract a routing key from a gateway's (or reviewer's) text output.
 * Looks for JSON `{"route":"X"}`, `{"target":"X"}`, `{"domain":"X"}`, `{"verdict":"X"}` or
 * `{"action":"X"}` anywhere in the text and uses the last object that carries one, then for
 * a `route: X` / `verdict: X` keyword.
 */
export function parseGatewayRoute(text: string): string | null {
  const objects = jsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    const val = obj.route ?? obj.target ?? obj.domain ?? obj.verdict ?? obj.action;
    if (typeof val === "string" && val.trim()) return val.trim().toLowerCase();
  }
  const kvMatch = text.match(/(?:route|target|domain|verdict|action)\s*[":]\s*"?([a-zA-Z0-9_-]+)"?/i);
  if (kvMatch) return kvMatch[1].toLowerCase();
  return null;
}

/** Verdicts that close a review without asking for changes: what the example reviewers
 *  answer with besides REVISE. */
const CLOSING_VERDICTS = new Set(["approved", "pass", "escalate"]);

/** Verdicts a node's output states: the parsed route and its leading word ("REVISE — …").
 *  A reply that opens with a closing verdict has stated it, so a keyword later on
 *  ("APPROVED. Optional follow-up action: revise the headline") does not add a revision.
 *  Any other leading word stays open to a later keyword: "REVISE — target: rust-fix" says which
 *  of several feedback edges to fire. */
function statedVerdicts(text: string): string[] {
  const leading = /^[\s*_#>`"'(-]*([A-Za-z][\w-]*)/.exec(text)?.[1]?.toLowerCase();
  if (leading && CLOSING_VERDICTS.has(leading)) return [leading];
  return [parseGatewayRoute(text), leading].filter((v): v is string => Boolean(v));
}

/** The feedback edges out of `sourceId` that its output fires: those whose label the
 *  verdict names exactly, or all of them on a plain "revise". */
export function firedFeedbackEdges(sourceId: string, output: string, edges: Edge[]): Edge[] {
  const feedback = edges.filter((e) => e.source === sourceId && isFeedbackEdge(e));
  if (feedback.length === 0) return [];
  const said = statedVerdicts(output);
  const named = feedback.filter((e) => edgeLabel(e) !== "" && said.includes(edgeLabel(e)));
  if (named.length > 0) return named;
  return said.includes("revise") ? feedback : [];
}

/** Nodes to re-run for a revision: each target plus every node on a forward path from
 *  a target back to `sourceId`, in dependency order, without the source itself. */
export function revisionPath(targets: string[], sourceId: string, edges: Edge[]): string[] {
  const forward = edges.filter((e) => !isFeedbackEdge(e));
  const reach = (starts: string[], next: (id: string) => string[]) => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length > 0) {
      for (const n of next(queue.shift()!)) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    return seen;
  };
  const downstream = reach(targets, (id) => forward.filter((e) => e.source === id).map((e) => e.target));
  const upstream = reach([sourceId], (id) => forward.filter((e) => e.target === id).map((e) => e.source));
  const members = new Set([...targets, ...[...downstream].filter((id) => upstream.has(id))]);
  members.delete(sourceId);

  // Dependency order among the members (Kahn).
  const inDegree = new Map([...members].map((id) => [id, 0]));
  for (const e of forward) {
    if (members.has(e.source) && members.has(e.target)) inDegree.set(e.target, inDegree.get(e.target)! + 1);
  }
  const ready = [...members].filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of forward) {
      if (e.source !== id || !members.has(e.target)) continue;
      const left = inDegree.get(e.target)! - 1;
      inDegree.set(e.target, left);
      if (left === 0) ready.push(e.target);
    }
  }
  return order;
}
