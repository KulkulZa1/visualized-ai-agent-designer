import type { Edge } from "@xyflow/react";
import type { AgentNode, ExecutionSettings, WorkflowDef, WorkflowMeta } from "@/types/workflow";

/** What a run executes: the workflow's agents as canvas nodes, its edges and settings. */
export interface WorkflowGraph {
  nodes: AgentNode[];
  edges: Edge[];
  meta: WorkflowMeta;
  executionSettings: ExecutionSettings;
}

/** A saved workflow as a graph. Agents are named by list position ("agent-<i>"),
 *  which is how the saved connections refer to them. */
export function defToGraph(def: WorkflowDef): WorkflowGraph {
  return {
    meta: def.meta,
    executionSettings: def.executionSettings,
    edges: def.connections.map((c) => ({
      id: c.id,
      source: c.sourceAgentId,
      target: c.targetAgentId,
      label: c.label,
      type: c.edgeKind ?? "dataflow",
      data: {
        label: c.label,
        edgeKind: c.edgeKind ?? "dataflow",
      },
    })),
    nodes: def.agents.map((agent, i) => {
      const pos = def.nodePositions[`agent-${i}`] ?? { x: i * 240, y: 120 };
      return { id: `agent-${i}`, type: "agent", position: pos, data: agent } satisfies AgentNode;
    }),
  };
}
