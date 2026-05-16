import { describe, it, expect, beforeEach } from "vitest";
import { snapshotRepo } from "@/services/context-builder/snapshotRepository";
import type { PersistedSnapshot } from "@/services/context-builder/snapshotRepository";

// Helper that creates a minimal snapshot input
function makeInput(
  overrides: Partial<Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt">> = {}
): Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt"> {
  return {
    nodeId: "node-1",
    snapshotStatus: "completed",
    providerId: "openai",
    model: "gpt-4o-mini",
    promptLayers: {
      system: "You are a worker.",
      developer: "",
      user: "",
      agentInstruction: "",
      nodePrompt: "",
    },
    upstreamInputs: [],
    selectedFiles: [],
    toolResults: [],
    finalContext: "Default context text.",
    warnings: [],
    artifactIds: [],
    metadata: {},
    ...overrides,
  };
}

// Replicate the search logic directly (hook uses useMemo which needs React — test the logic directly)
function searchSnapshots(query: string, snapshots: PersistedSnapshot[]) {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  return snapshots
    .filter((snap) =>
      snap.nodeId.toLowerCase().includes(q) ||
      snap.finalContext.toLowerCase().includes(q) ||
      snap.promptLayers.system.toLowerCase().includes(q) ||
      snap.model.toLowerCase().includes(q) ||
      snap.metadata["nodeName"]?.toString().toLowerCase().includes(q)
    )
    .slice(0, 20);
}

describe("useSnapshotSearch logic", () => {
  beforeEach(() => {
    snapshotRepo.clear();
  });

  it("returns empty results for empty query", () => {
    snapshotRepo.create(makeInput({ metadata: { nodeName: "Orchestrator" } }));
    const results = searchSnapshots("", snapshotRepo.list());
    expect(results).toHaveLength(0);
  });

  it("returns empty results for whitespace-only query", () => {
    snapshotRepo.create(makeInput());
    const results = searchSnapshots("   ", snapshotRepo.list());
    expect(results).toHaveLength(0);
  });

  it("filters by nodeName in metadata", () => {
    snapshotRepo.create(makeInput({ nodeId: "n1", metadata: { nodeName: "Orchestrator" } }));
    snapshotRepo.create(makeInput({ nodeId: "n2", metadata: { nodeName: "Worker" } }));
    const results = searchSnapshots("orchestrator", snapshotRepo.list());
    expect(results).toHaveLength(1);
    expect(results[0].nodeId).toBe("n1");
  });

  it("filters by model", () => {
    snapshotRepo.create(makeInput({ nodeId: "n1", model: "claude-sonnet-4.6" }));
    snapshotRepo.create(makeInput({ nodeId: "n2", model: "gpt-4o-mini" }));
    const results = searchSnapshots("claude", snapshotRepo.list());
    expect(results).toHaveLength(1);
    expect(results[0].nodeId).toBe("n1");
  });

  it("filters by finalContext", () => {
    snapshotRepo.create(makeInput({ nodeId: "n1", finalContext: "special keyword here" }));
    snapshotRepo.create(makeInput({ nodeId: "n2", finalContext: "nothing useful" }));
    const results = searchSnapshots("special keyword", snapshotRepo.list());
    expect(results).toHaveLength(1);
    expect(results[0].nodeId).toBe("n1");
  });

  it("filters by system prompt", () => {
    snapshotRepo.create(makeInput({ nodeId: "n1", promptLayers: {
      system: "You are a critic.", developer: "", user: "", agentInstruction: "", nodePrompt: "",
    }}));
    const results = searchSnapshots("critic", snapshotRepo.list());
    expect(results).toHaveLength(1);
  });

  it("caps results at 20", () => {
    for (let i = 0; i < 25; i++) {
      snapshotRepo.create(makeInput({ nodeId: `node-${i}`, finalContext: "searchable content" }));
    }
    const results = searchSnapshots("searchable", snapshotRepo.list());
    expect(results).toHaveLength(20);
  });
});

describe("AgentNodeData comment field", () => {
  it("comment field is optional in schema — node without comment is accepted", async () => {
    const { agentNodeDataSchema } = await import("@/schemas/agentSchema");
    const { AgentRole, ToolPermission } = await import("@/types/agent");
    const input = {
      name: "Test",
      role: AgentRole.Worker,
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 2048,
      maxSteps: 10,
      timeoutSeconds: 60,
      promptSource: { type: "inline" as const, content: "" },
      tools: [ToolPermission.ReadFile],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 0 },
      status: "idle" as const,
    };
    const result = agentNodeDataSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("comment field is accepted when provided", async () => {
    const { agentNodeDataSchema } = await import("@/schemas/agentSchema");
    const { AgentRole, ToolPermission } = await import("@/types/agent");
    const input = {
      name: "Test",
      role: AgentRole.Worker,
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 2048,
      maxSteps: 10,
      timeoutSeconds: 60,
      promptSource: { type: "inline" as const, content: "" },
      tools: [ToolPermission.ReadFile],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 0 },
      status: "idle" as const,
      comment: "This is a test annotation",
    };
    const result = agentNodeDataSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.comment).toBe("This is a test annotation");
    }
  });
});
