import { describe, it, expect } from "vitest";
import { serializeWorkflow, deserializeWorkflow } from "@/utils/yamlSerializer";
import { AgentRole, ToolPermission } from "@/types/agent";
import type { WorkflowDef } from "@/types/workflow";

const sample: WorkflowDef = {
  meta: {
    name: "Round-trip Test",
    version: "1.0.0",
    description: "Test workflow",
    projectRoot: "/test",
    createdAt: "2026-05-09T00:00:00Z",
    updatedAt: "2026-05-09T00:00:00Z",
  },
  agents: [
    {
      name: "Main Orchestrator",
      role: AgentRole.Orchestrator,
      model: "claude-sonnet-4.6",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 20,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: "You are an orchestrator." },
      tools: [ToolPermission.ReadFile, ToolPermission.Bash],
      memoryRead: ["context"],
      memoryWrite: ["result"],
      tokens: { used: 0, budget: 32000 },
      status: "idle",
    },
  ],
  connections: [{ id: "e1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
  executionSettings: { maxParallel: 4, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
  nodePositions: { "agent-0": { x: 100, y: 100 } },
};

describe("yamlSerializer", () => {
  it("roundtrip preserves all fields", () => {
    const yaml = serializeWorkflow(sample);
    const restored = deserializeWorkflow(yaml);
    expect(restored.meta.name).toBe(sample.meta.name);
    expect(restored.agents[0].role).toBe(AgentRole.Orchestrator);
    expect(restored.agents[0].tools).toContain(ToolPermission.ReadFile);
    expect(restored.agents[0].memoryRead).toEqual(["context"]);
    expect(restored.nodePositions["agent-0"]).toEqual({ x: 100, y: 100 });
  });

  it("serializes to a non-empty YAML string", () => {
    const yaml = serializeWorkflow(sample);
    expect(yaml).toContain("Round-trip Test");
    expect(yaml).toContain("orchestrator");
  });

  it("preserves connections array", () => {
    const yaml = serializeWorkflow(sample);
    const restored = deserializeWorkflow(yaml);
    expect(restored.connections[0].id).toBe("e1");
  });

  it("preserves token budget", () => {
    const yaml = serializeWorkflow(sample);
    const restored = deserializeWorkflow(yaml);
    expect(restored.agents[0].tokens.budget).toBe(32000);
  });
});
