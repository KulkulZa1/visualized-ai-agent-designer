/**
 * Dagre-based auto-layout for the workflow canvas.
 * Call applyDagreLayout() then pass results to setNodes().
 */
import dagre from "@dagrejs/dagre";
import type { AgentNode } from "@/types/workflow";
import type { Edge } from "@xyflow/react";

const NODE_WIDTH  = 240;
const NODE_HEIGHT = 160;  // approximate node height with token bar
const RANK_SEP    = 80;   // vertical gap between layers
const NODE_SEP    = 40;   // horizontal gap between nodes in same layer

export function applyDagreLayout(
  nodes: AgentNode[],
  edges: Edge[],
  direction: "TB" | "LR" = "LR"   // LR = left-to-right (matches the prototype layout)
): AgentNode[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: RANK_SEP, nodesep: NODE_SEP });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => {
    // feedback edges are reversed for layout purposes to avoid upward arrows
    if (e.type === "feedback") g.setEdge(e.target, e.source);
    else g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}
