import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { AgentRole } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import { validateWorkflow } from "@/utils/validateWorkflow";

function node(id: string, role: AgentRole = AgentRole.Worker): AgentNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      name: id,
      role,
      model: role === AgentRole.Hook || role === AgentRole.Memory ? "" : "qwen2.5-coder:7b",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 5,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: role === AgentRole.Hook || role === AgentRole.Memory ? "" : "Do work." },
      tools: [],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 16000 },
      status: "idle",
    },
  };
}

function edge(source: string, target: string, edgeKind: "dataflow" | "feedback" = "dataflow"): Edge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    data: { edgeKind },
  };
}

describe("validateWorkflow", () => {
  it("does not report a cycle for feedback edges stored in edge data", () => {
    const nodes = [node("A"), node("B")];
    const result = validateWorkflow(nodes, [
      edge("A", "B"),
      edge("B", "A", "feedback"),
    ]);

    expect(result.errors.some((err) => err.kind === "cycle")).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("reports a cycle for non-feedback loops", () => {
    const nodes = [node("A"), node("B")];
    const result = validateWorkflow(nodes, [
      edge("A", "B"),
      edge("B", "A"),
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((err) => err.kind === "cycle")).toBe(true);
  });
});
