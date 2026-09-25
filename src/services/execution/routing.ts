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

/**
 * Try to extract a routing key from a gateway's text output.
 * Looks for JSON `{"route":"X"}`, `{"target":"X"}`, `{"domain":"X"}`, `{"verdict":"X"}`.
 */
export function parseGatewayRoute(text: string): string | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const val = obj.route ?? obj.target ?? obj.domain ?? obj.verdict ?? obj.action ?? null;
      if (typeof val === "string" && val.trim()) return val.trim().toLowerCase();
    } catch { /* fall through */ }
  }
  const kvMatch = text.match(/(?:route|target|domain|verdict|action)\s*[":]\s*"?([a-zA-Z0-9_-]+)"?/i);
  if (kvMatch) return kvMatch[1].toLowerCase();
  return null;
}

/** Verdicts a node's output states: the parsed route and its leading word ("REVISE — …"). */
function statedVerdicts(text: string): string[] {
  const route = parseGatewayRoute(text);
  const leading = /^[\s*_#>`"'(-]*([A-Za-z][\w-]*)/.exec(text)?.[1]?.toLowerCase();
  return [route, leading].filter((v): v is string => Boolean(v));
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
