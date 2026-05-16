import { describe, it, expect } from "vitest";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { AgentRole, ToolPermission } from "@/types/agent";

const validWorkflow = {
  meta: {
    name: "Test Workflow",
    version: "1.0.0",
    description: "A test workflow",
    projectRoot: "/test/project",
    createdAt: "2026-05-09T00:00:00Z",
    updatedAt: "2026-05-09T00:00:00Z",
  },
  agents: [
    {
      name: "Orchestrator",
      role: AgentRole.Orchestrator,
      model: "claude-sonnet-4.6",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 20,
      timeoutSeconds: 300,
      promptSource: { type: "inline" as const, content: "You are an orchestrator." },
      tools: [ToolPermission.ReadFile],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 32000 },
      status: "idle" as const,
    },
  ],
  connections: [],
  executionSettings: {
    maxParallel: 4,
    timeoutSeconds: 300,
    retryOnFailure: false,
    maxRetries: 0,
  },
  nodePositions: { "agent-1": { x: 100, y: 100 } },
};

describe("workflowDefSchema", () => {
  it("accepts a valid workflow", () => {
    const result = workflowDefSchema.safeParse(validWorkflow);
    expect(result.success).toBe(true);
  });

  it("rejects missing workflow name", () => {
    const bad = { ...validWorkflow, meta: { ...validWorkflow.meta, name: "" } };
    const result = workflowDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects invalid semver version", () => {
    const bad = { ...validWorkflow, meta: { ...validWorkflow.meta, version: "1.0" } };
    const result = workflowDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects temperature out of range", () => {
    const bad = {
      ...validWorkflow,
      agents: [{ ...validWorkflow.agents[0], temperature: 3 }],
    };
    const result = workflowDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects invalid agent role", () => {
    const bad = {
      ...validWorkflow,
      agents: [{ ...validWorkflow.agents[0], role: "invalid_role" }],
    };
    const result = workflowDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts file-reference prompt source", () => {
    const withFilePrompt = {
      ...validWorkflow,
      agents: [
        {
          ...validWorkflow.agents[0],
          promptSource: { type: "file" as const, path: "agents/orchestrator.md" },
        },
      ],
    };
    const result = workflowDefSchema.safeParse(withFilePrompt);
    expect(result.success).toBe(true);
  });

  it("accepts hook environment variables", () => {
    const withHookEnv = {
      ...validWorkflow,
      agents: [
        {
          ...validWorkflow.agents[0],
          preHook: {
            path: ".harness/hooks/path_scope.py",
            requireConsent: false,
            env: { MAX_ITER: "3", MODE: "verify" },
          },
        },
      ],
    };
    const result = workflowDefSchema.safeParse(withHookEnv);
    expect(result.success).toBe(true);
  });

  it("rejects maxParallel below 1", () => {
    const bad = {
      ...validWorkflow,
      executionSettings: { ...validWorkflow.executionSettings, maxParallel: 0 },
    };
    const result = workflowDefSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
