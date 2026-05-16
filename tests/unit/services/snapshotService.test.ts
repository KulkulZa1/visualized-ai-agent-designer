import { vi, describe, beforeEach, it, expect } from "vitest";
import { snapshotRepo } from "@/services/context-builder/snapshotRepository";
import { createSnapshot, listSnapshotsForNode } from "@/services/context-builder/snapshotService";
import type { ExecutionContextSnapshot } from "@/types/inspection";

// Mock Tauri so FileSnapshotRepository doesn't error when workspacePath is set
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(nodeId = "node-svc"): ExecutionContextSnapshot {
  return {
    nodeId,
    nodeName: "ServiceNode",
    status: "idle",
    providerId: "openai",
    model: "gpt-4o-mini",
    prompt: {
      staticPrompt: "Do the task.",
      systemPrompt: "You are an agent.",
      developerNotes: "",
      userPrompt: "[preview]",
    },
    finalContext: {
      previewLabel: "Preview",
      content: "Assembled context.",
      tokenEstimate: 20,
      warnings: [],
    },
    inputs: {
      upstreamOutputs: [],
      userInput: "[preview]",
      toolResults: [],
    },
    tools: { allowedTools: [] },
    files: { selectedFiles: [] },
    outputStream: { isStreaming: false, content: "" },
    artifacts: [],
    debugInfo: { providerId: "openai", model: "gpt-4o-mini", localOnly: false, notes: [] },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("snapshotService — in-memory fallback (no workspacePath)", () => {
  beforeEach(() => {
    snapshotRepo.clear();
  });

  it("createSnapshot stores a snapshot in-memory when workspacePath is null", async () => {
    const ctx = makeCtx("node-a");
    const snap = await createSnapshot(ctx, { workspacePath: null, snapshotStatus: "mock" });

    expect(snap.id).toBeTruthy();
    expect(snap.nodeId).toBe("node-a");
    expect(snap.snapshotStatus).toBe("mock");

    // Should be retrievable from in-memory repo
    expect(snapshotRepo.getById(snap.id)).toBeDefined();
  });

  it("createSnapshot stores a snapshot in-memory when workspacePath is undefined", async () => {
    const ctx = makeCtx("node-b");
    const snap = await createSnapshot(ctx, { snapshotStatus: "completed" });
    expect(snap.snapshotStatus).toBe("completed");
    expect(snapshotRepo.getById(snap.id)).toBeDefined();
  });

  it("createSnapshot merges extra metadata", async () => {
    const ctx = makeCtx("node-c");
    const snap = await createSnapshot(ctx, {
      snapshotStatus: "failed",
      metadata: { error: "something went wrong" },
    });
    expect(snap.metadata["error"]).toBe("something went wrong");
  });

  it("listSnapshotsForNode returns empty array from in-memory when no snapshots exist", async () => {
    const result = await listSnapshotsForNode("node-none");
    expect(result).toEqual([]);
  });

  it("listSnapshotsForNode returns created snapshots for the node", async () => {
    const ctx = makeCtx("node-list");
    await createSnapshot(ctx, { snapshotStatus: "completed" });
    await createSnapshot(ctx, { snapshotStatus: "mock" });

    const result = await listSnapshotsForNode("node-list");
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.nodeId === "node-list")).toBe(true);
  });
});
