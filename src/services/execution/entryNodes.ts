/**
 * entryNodes — which agents receive the user's task for a run.
 *
 * Hook and Memory nodes never pass the task on, so they are transparent: an agent
 * is an entry agent when no other agent feeds it, directly or through hook/memory
 * nodes. Feedback edges (revision loops) are ignored.
 */

import type { Edge } from "@xyflow/react";
import type { AgentNode } from "@/types/workflow";
import { AgentRole } from "@/types/agent";

function isAgent(role: AgentRole): boolean {
  return role !== AgentRole.Memory && role !== AgentRole.Hook;
}

function isFeedbackEdge(edge: Edge): boolean {
  return (edge.data as { edgeKind?: string } | undefined)?.edgeKind === "feedback" || edge.type === "feedback";
}

export function entryAgentIds(nodes: AgentNode[], edges: Edge[]): Set<string> {
  const forwardEdges = edges.filter((e) => !isFeedbackEdge(e));
  const roleOf = new Map(nodes.map((n) => [n.id, n.data.role]));

  const hasAgentUpstream = (id: string, seen: Set<string>): boolean =>
    forwardEdges.some((e) => {
      if (e.target !== id || seen.has(e.source)) return false;
      seen.add(e.source);
      const role = roleOf.get(e.source);
      return role !== undefined && (isAgent(role) || hasAgentUpstream(e.source, seen));
    });

  return new Set(
    nodes
      .filter((n) => isAgent(n.data.role) && !hasAgentUpstream(n.id, new Set()))
      .map((n) => n.id),
  );
}
