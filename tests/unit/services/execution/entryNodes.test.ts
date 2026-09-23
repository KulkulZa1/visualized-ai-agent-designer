import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import { entryAgentIds } from "@/services/execution/entryNodes";
import { makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";

const node = (id: string, role: AgentRole) => makeDefaultAgentNode(id, role, { x: 0, y: 0 });
const edge = (source: string, target: string, edgeKind?: string): Edge =>
  ({ id: `${source}->${target}`, source, target, data: { edgeKind } });

describe("entryAgentIds", () => {
  it("looks through hook and memory nodes to find the agents that receive the user's task", () => {
    const nodes = [
      node("sentinel", AgentRole.Hook), node("planner", AgentRole.Orchestrator),
      node("log", AgentRole.Memory), node("writer", AgentRole.Worker),
    ];
    const edges = [edge("sentinel", "planner"), edge("planner", "log"), edge("log", "writer")];

    expect([...entryAgentIds(nodes, edges)]).toEqual(["planner"]);
  });

  it("ignores feedback edges and tolerates cycles through non-agent nodes", () => {
    const nodes = [node("a", AgentRole.Worker), node("b", AgentRole.Critic), node("m", AgentRole.Memory)];
    const edges = [edge("a", "b"), edge("b", "a", "feedback"), edge("m", "m")];

    expect([...entryAgentIds(nodes, edges)]).toEqual(["a"]);
  });
});
