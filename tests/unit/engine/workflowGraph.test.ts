import { describe, it, expect } from "vitest";
import { defToGraph } from "@/engine/workflowGraph";
import { useWorkflowStore } from "@/store/workflowStore";
import { deserializeWorkflow } from "@/utils/yamlSerializer";
import { EXAMPLES } from "@/hooks/useExamples";
import { AgentRole, type AgentNodeData } from "@/types/agent";
import type { WorkflowDef } from "@/types/workflow";

function agent(name: string): AgentNodeData {
  return {
    name, role: AgentRole.Worker, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024,
    maxSteps: 5, timeoutSeconds: 300, promptSource: { type: "inline", content: "Do it." }, tools: [],
    memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 16000 }, status: "idle",
  };
}

describe("defToGraph", () => {
  it("names agents by list position, as connections do, and keeps each connection's label and kind", () => {
    const def: WorkflowDef = {
      meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
      agents: [agent("Writer"), agent("Reviewer")],
      connections: [
        { id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1", label: "draft" },
        { id: "c2", sourceAgentId: "agent-1", targetAgentId: "agent-0", label: "revise", edgeKind: "feedback" },
      ],
      executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
      nodePositions: { "agent-0": { x: 5, y: 6 } },
    };

    const graph = defToGraph(def);

    expect(graph.nodes.map((n) => [n.id, n.type, n.position, n.data.name])).toEqual([
      ["agent-0", "agent", { x: 5, y: 6 }, "Writer"],
      ["agent-1", "agent", { x: 240, y: 120 }, "Reviewer"], // no saved position: laid out in a row
    ]);
    expect(graph.edges).toEqual([
      { id: "c1", source: "agent-0", target: "agent-1", label: "draft", type: "dataflow",
        data: { label: "draft", edgeKind: "dataflow" } },
      { id: "c2", source: "agent-1", target: "agent-0", label: "revise", type: "feedback",
        data: { label: "revise", edgeKind: "feedback" } },
    ]);
    expect(graph.meta).toBe(def.meta);
    expect(graph.executionSettings).toBe(def.executionSettings);
  });

  it.each(EXAMPLES.map((ex) => [ex.name, ex.yaml] as const))(
    "round-trips the %s example through the store's toWorkflowDef",
    (_name, yaml) => {
      const def = deserializeWorkflow(yaml);
      const graph = defToGraph(def);
      useWorkflowStore.setState(graph);

      const saved = useWorkflowStore.getState().toWorkflowDef();

      expect(saved.agents).toEqual(def.agents);
      expect(defToGraph(saved)).toEqual(graph);
    },
  );
});
