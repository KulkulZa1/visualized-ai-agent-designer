import { describe, it, expect } from "vitest";
import { diffWorkflows } from "@/utils/workflowDiff";
import type { WorkflowDef } from "@/types/workflow";

function makeWorkflow(agentNames: string[], connectionCount = 0): WorkflowDef {
  return {
    meta: { name: "Test", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: agentNames.map((name) => ({
      name,
      role: "worker" as never,
      model: "claude-sonnet-4.6",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 20,
      timeoutSeconds: 300,
      promptSource: { type: "inline" as const, content: "" },
      tools: [],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 16000 },
      status: "idle" as const,
    })),
    connections: Array.from({ length: connectionCount }, (_, i) => ({
      id: `edge-${i}`,
      sourceAgentId: "a",
      targetAgentId: "b",
    })),
    executionSettings: { maxParallel: 4, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  };
}

describe("diffWorkflows", () => {
  it("returns 'No changes' when workflows are identical", () => {
    const wf = makeWorkflow(["Alpha", "Beta"]);
    const result = diffWorkflows(wf, wf);
    expect(result.summary).toBe("No changes");
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
    expect(result.edgeChanges).toBe(0);
  });

  it("detects added agent", () => {
    const before = makeWorkflow(["Alpha"]);
    const after  = makeWorkflow(["Alpha", "Beta"]);
    const result = diffWorkflows(before, after);
    expect(result.added).toContain("Beta");
    expect(result.summary).toContain("+1 agents");
  });

  it("detects removed agent", () => {
    const before = makeWorkflow(["Alpha", "Beta"]);
    const after  = makeWorkflow(["Alpha"]);
    const result = diffWorkflows(before, after);
    expect(result.removed).toContain("Beta");
    expect(result.summary).toContain("-1 agents");
  });

  it("detects changed agent", () => {
    const before = makeWorkflow(["Alpha"]);
    const after  = makeWorkflow(["Alpha"]);
    after.agents[0].model = "claude-opus-4.6";
    const result = diffWorkflows(before, after);
    expect(result.changed).toContain("Alpha");
    expect(result.summary).toContain("~1 changed");
  });

  it("reports edge count difference", () => {
    const before = makeWorkflow(["Alpha"], 2);
    const after  = makeWorkflow(["Alpha"], 5);
    const result = diffWorkflows(before, after);
    expect(result.edgeChanges).toBe(3);
    expect(result.summary).toContain("3 edge Δ");
  });
});
