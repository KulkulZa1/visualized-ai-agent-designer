import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { AgentRole } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import { applyDagreLayout } from "@/utils/autoLayout";

function node(id: string): AgentNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      name: id,
      role: AgentRole.Worker,
      model: "qwen2.5-coder:7b",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 5,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: "Do work." },
      tools: [],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 16000 },
      status: "idle",
    },
  };
}

function edge(source: string, target: string, edgeKind: "dataflow" | "feedback"): Edge {
  return {
    id: `${source}-${target}-${edgeKind}`,
    source,
    target,
    data: { edgeKind },
  };
}

describe("applyDagreLayout", () => {
  it("uses edge.data.edgeKind to reverse feedback edges for layout", () => {
    const laidOut = applyDagreLayout(
      [node("A"), node("B")],
      [
        edge("A", "B", "dataflow"),
        edge("B", "A", "feedback"),
      ],
      "LR",
    );

    const a = laidOut.find((n) => n.id === "A")!;
    const b = laidOut.find((n) => n.id === "B")!;
    expect(a.position.x).toBeLessThan(b.position.x);
  });
});
