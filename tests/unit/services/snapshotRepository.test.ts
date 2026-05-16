import { describe, beforeEach, expect, it } from "vitest";
import {
  snapshotRepo,
  snapshotFromContextSnapshot,
  type PersistedSnapshot,
  type SnapshotStatus,
} from "@/services/context-builder/snapshotRepository";
import type { ExecutionContextSnapshot } from "@/types/inspection";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt">> = {}
): Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt"> {
  return {
    nodeId: "node-1",
    snapshotStatus: "draft",
    providerId: "openai",
    model: "gpt-4o-mini",
    promptLayers: {
      system: "You are a worker.",
      developer: "dev notes",
      user: "[preview]",
      agentInstruction: "Do the task.",
      nodePrompt: "Do the task.",
    },
    upstreamInputs: [],
    selectedFiles: [],
    toolResults: [],
    finalContext: "System: You are a worker.",
    tokenEstimate: 10,
    warnings: [],
    artifactIds: [],
    metadata: {},
    ...overrides,
  };
}

function makeContextSnapshot(nodeId = "node-x"): ExecutionContextSnapshot {
  return {
    nodeId,
    nodeName: "My Node",
    status: "idle",
    providerId: "anthropic",
    model: "claude-haiku-4.5",
    prompt: {
      staticPrompt: "Static instruction.",
      systemPrompt: "You are an agent.",
      developerNotes: "Some notes.",
      userPrompt: "[preview user]",
    },
    finalContext: {
      previewLabel: "Preview",
      content: "Final assembled context.",
      tokenEstimate: 42,
      warnings: ["This is mock data."],
    },
    inputs: {
      upstreamOutputs: [
        { nodeId: "up-1", nodeName: "Upstream", output: "upstream output text" },
      ],
      userInput: "[preview]",
      toolResults: ["tool result A"],
    },
    tools: { allowedTools: [] },
    files: { selectedFiles: ["src/main.ts"] },
    outputStream: { isStreaming: false, content: "output here" },
    artifacts: [
      {
        id: "art-1",
        title: "Report",
        type: "markdown",
        sourceNodeId: nodeId,
        content: "# Report",
        previewMode: "rendered",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
        status: "mock",
      },
    ],
    debugInfo: {
      providerId: "anthropic",
      model: "claude-haiku-4.5",
      localOnly: false,
      notes: ["read-only in this slice"],
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("SnapshotRepository", () => {
  beforeEach(() => {
    snapshotRepo.clear();
  });

  it("create gives a new snapshot with generated id and ISO timestamps", () => {
    const snap = snapshotRepo.create(makeInput());
    expect(snap.id).toBeTruthy();
    expect(snap.id.length).toBeGreaterThan(4);
    expect(snap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.nodeId).toBe("node-1");
    expect(snap.snapshotStatus).toBe("draft");
  });

  it("create assigns unique ids for distinct snapshots", () => {
    const a = snapshotRepo.create(makeInput());
    const b = snapshotRepo.create(makeInput({ nodeId: "node-2" }));
    expect(a.id).not.toBe(b.id);
  });

  it("getById returns the snapshot after creation", () => {
    const snap = snapshotRepo.create(makeInput());
    const found = snapshotRepo.getById(snap.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(snap.id);
    expect(found!.nodeId).toBe("node-1");
  });

  it("getById returns undefined for unknown id", () => {
    expect(snapshotRepo.getById("nonexistent")).toBeUndefined();
  });

  it("list returns all snapshots newest-first by createdAt", async () => {
    const a = snapshotRepo.create(makeInput({ nodeId: "node-a" }));
    // Ensure different timestamps by forcing a tiny offset
    await new Promise((r) => setTimeout(r, 2));
    const b = snapshotRepo.create(makeInput({ nodeId: "node-b" }));

    const all = snapshotRepo.list();
    expect(all).toHaveLength(2);
    // newest first: b was created after a
    expect(all[0].id).toBe(b.id);
    expect(all[1].id).toBe(a.id);
  });

  it("listByNodeId filters correctly", () => {
    snapshotRepo.create(makeInput({ nodeId: "alpha" }));
    snapshotRepo.create(makeInput({ nodeId: "beta" }));
    snapshotRepo.create(makeInput({ nodeId: "alpha" }));

    const alphas = snapshotRepo.listByNodeId("alpha");
    expect(alphas).toHaveLength(2);
    expect(alphas.every((s) => s.nodeId === "alpha")).toBe(true);

    const betas = snapshotRepo.listByNodeId("beta");
    expect(betas).toHaveLength(1);
    expect(betas[0].nodeId).toBe("beta");
  });

  it("listByWorkflowId filters correctly", () => {
    snapshotRepo.create(makeInput({ workflowId: "wf-1" }));
    snapshotRepo.create(makeInput({ workflowId: "wf-2" }));
    snapshotRepo.create(makeInput({ workflowId: "wf-1" }));

    expect(snapshotRepo.listByWorkflowId("wf-1")).toHaveLength(2);
    expect(snapshotRepo.listByWorkflowId("wf-2")).toHaveLength(1);
    expect(snapshotRepo.listByWorkflowId("wf-3")).toHaveLength(0);
  });

  it("update changes patch fields and sets updatedAt", async () => {
    const snap = snapshotRepo.create(makeInput());
    const originalUpdatedAt = snap.updatedAt;

    await new Promise((r) => setTimeout(r, 2));

    const updated = snapshotRepo.update(snap.id, {
      snapshotStatus: "completed",
      finalContext: "new context",
    });

    expect(updated).toBeDefined();
    expect(updated!.snapshotStatus).toBe("completed");
    expect(updated!.finalContext).toBe("new context");
    expect(updated!.nodeId).toBe("node-1"); // unchanged
    expect(updated!.id).toBe(snap.id); // id preserved
    expect(updated!.createdAt).toBe(snap.createdAt); // createdAt preserved
    expect(updated!.updatedAt).not.toBe(originalUpdatedAt); // updatedAt changed
  });

  it("update returns undefined for unknown id", () => {
    expect(snapshotRepo.update("ghost", { snapshotStatus: "failed" })).toBeUndefined();
  });

  it("remove returns true and removes the snapshot", () => {
    const snap = snapshotRepo.create(makeInput());
    expect(snapshotRepo.remove(snap.id)).toBe(true);
    expect(snapshotRepo.getById(snap.id)).toBeUndefined();
    expect(snapshotRepo.list()).toHaveLength(0);
  });

  it("remove returns false for unknown id", () => {
    expect(snapshotRepo.remove("no-such-id")).toBe(false);
  });

  it("exportJson / importJson round-trip preserves all snapshots", () => {
    snapshotRepo.create(makeInput({ nodeId: "n1", finalContext: "ctx A" }));
    snapshotRepo.create(makeInput({ nodeId: "n2", finalContext: "ctx B" }));

    const json = snapshotRepo.exportJson();
    snapshotRepo.clear();
    expect(snapshotRepo.list()).toHaveLength(0);

    snapshotRepo.importJson(json);
    const restored = snapshotRepo.list();
    expect(restored).toHaveLength(2);
    const nodeIds = new Set(restored.map((s) => s.nodeId));
    expect(nodeIds.has("n1")).toBe(true);
    expect(nodeIds.has("n2")).toBe(true);
  });

  it("importJson throws on non-array JSON", () => {
    expect(() => snapshotRepo.importJson('{"id":"x"}')).toThrow(TypeError);
  });

  it("importJson throws when items lack required fields", () => {
    expect(() =>
      snapshotRepo.importJson('[{"id":"x","nodeId":"n"}]')
    ).toThrow(TypeError);
  });

  it("clear empties the store", () => {
    snapshotRepo.create(makeInput());
    snapshotRepo.create(makeInput());
    snapshotRepo.clear();
    expect(snapshotRepo.list()).toHaveLength(0);
  });

  it("PersistedSnapshot does not have an apiKey field", () => {
    const snap = snapshotRepo.create(makeInput());
    // The shape must never carry a raw API key field
    expect(Object.prototype.hasOwnProperty.call(snap, "apiKey")).toBe(false);
    const keys = Object.keys(snap);
    expect(keys).not.toContain("apiKey");
  });

  it("accepts mock, draft, and completed as valid snapshotStatus values", () => {
    const statuses: SnapshotStatus[] = ["mock", "draft", "completed"];
    for (const status of statuses) {
      const snap = snapshotRepo.create(makeInput({ snapshotStatus: status }));
      expect(snap.snapshotStatus).toBe(status);
    }
  });
});

describe("snapshotFromContextSnapshot", () => {
  it("maps ExecutionContextSnapshot fields to PersistedSnapshot shape", () => {
    const ctx = makeContextSnapshot("node-42");
    const result = snapshotFromContextSnapshot(ctx, {
      workflowId: "wf-99",
      runId: "run-1",
      snapshotStatus: "mock",
    });

    expect(result.nodeId).toBe("node-42");
    expect(result.workflowId).toBe("wf-99");
    expect(result.runId).toBe("run-1");
    expect(result.snapshotStatus).toBe("mock");
    expect(result.providerId).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-4.5");
    expect(result.promptLayers.system).toBe("You are an agent.");
    expect(result.promptLayers.developer).toBe("Some notes.");
    expect(result.upstreamInputs).toHaveLength(1);
    expect(result.upstreamInputs[0].nodeId).toBe("up-1");
    expect(result.selectedFiles).toEqual(["src/main.ts"]);
    expect(result.toolResults).toEqual(["tool result A"]);
    expect(result.finalContext).toBe("Final assembled context.");
    expect(result.tokenEstimate).toBe(42);
    expect(result.warnings).toEqual(["This is mock data."]);
    expect(result.artifactIds).toEqual(["art-1"]);
    expect(result.metadata["nodeName"]).toBe("My Node");
  });

  it("defaults snapshotStatus to draft when opts is omitted", () => {
    const ctx = makeContextSnapshot("node-7");
    const result = snapshotFromContextSnapshot(ctx);
    expect(result.snapshotStatus).toBe("draft");
    expect(result.workflowId).toBeUndefined();
    expect(result.runId).toBeUndefined();
  });
});
