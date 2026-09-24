import { vi, describe, beforeEach, it, expect } from "vitest";

// ── Mock Tauri invoke ─────────────────────────────────────────────────────────
// vi.mock is hoisted above imports automatically by Vitest.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { FileSnapshotRepository } from "@/services/context-builder/fileSnapshotRepository";
import { snapshotRepo } from "@/services/context-builder/snapshotRepository";
import type { PersistedSnapshot } from "@/services/context-builder/snapshotRepository";

const mockInvoke = vi.mocked(invoke);

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE = "/workspace";

function makeInput(): Omit<PersistedSnapshot, "id" | "createdAt" | "updatedAt"> {
  return {
    nodeId: "node-1",
    snapshotStatus: "completed",
    providerId: "openai",
    model: "gpt-4o-mini",
    promptLayers: { system: "sys", developer: "dev", user: "usr", agentInstruction: "inst", nodePrompt: "np" },
    upstreamInputs: [],
    selectedFiles: [],
    toolResults: [],
    finalContext: "Final context text",
    tokenEstimate: 12,
    warnings: [],
    artifactIds: [],
    metadata: {},
  };
}

function makeSnap(id = "snap-1", nodeId = "node-1"): PersistedSnapshot {
  return {
    ...makeInput(),
    id,
    nodeId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FileSnapshotRepository", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    snapshotRepo.clear();
  });

  it("create writes the snapshot file and updates the index", async () => {
    // Call order in create(): 1) writeOne, 2) readIndex, 3) writeIndex
    // writeOne: void
    mockInvoke.mockResolvedValueOnce(undefined);
    // readIndex: file not found → catch returns {}
    mockInvoke.mockRejectedValueOnce(new Error("not found"));
    // writeIndex: void
    mockInvoke.mockResolvedValueOnce(undefined);

    const repo = new FileSnapshotRepository(WORKSPACE);
    const snap = await repo.create(makeInput());

    expect(snap.id).toBeTruthy();
    expect(snap.nodeId).toBe("node-1");

    // Should have called invoke 3 times: writeOne, readIndex, writeIndex
    expect(mockInvoke).toHaveBeenCalledTimes(3);

    // writeOne call: first invoke
    const writeOneCall = mockInvoke.mock.calls[0];
    expect(writeOneCall[0]).toBe("write_workspace_file");
    expect((writeOneCall[1] as Record<string, unknown>)["relativePath"]).toMatch(
      new RegExp(`\\.harness/snapshots/${snap.id}\\.json`)
    );

    // writeIndex call: third invoke
    const writeIndexCall = mockInvoke.mock.calls[2];
    expect(writeIndexCall[0]).toBe("write_workspace_file");
    expect((writeIndexCall[1] as Record<string, unknown>)["relativePath"]).toBe(
      ".harness/snapshots/index.json"
    );
  });

  it("getById reads the correct path", async () => {
    const snap = makeSnap("abc-123");
    mockInvoke.mockResolvedValueOnce(JSON.stringify(snap));

    const repo = new FileSnapshotRepository(WORKSPACE);
    const result = await repo.getById("abc-123");

    expect(result).toBeDefined();
    expect(result!.id).toBe("abc-123");
    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_file", {
      workspacePath: WORKSPACE,
      relativePath: ".harness/snapshots/abc-123.json",
    });
  });

  it("getById returns undefined when file is missing", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not found"));
    const repo = new FileSnapshotRepository(WORKSPACE);
    expect(await repo.getById("missing")).toBeUndefined();
  });

  it("listByNodeId reads index then loads each snapshot", async () => {
    const snap1 = makeSnap("id-1", "node-A");
    const snap2 = makeSnap("id-2", "node-A");
    const index = { "node-A": ["id-1", "id-2"] };

    mockInvoke
      .mockResolvedValueOnce(JSON.stringify(index)) // readIndex
      .mockResolvedValueOnce(JSON.stringify(snap1)) // getById id-1
      .mockResolvedValueOnce(JSON.stringify(snap2)); // getById id-2

    const repo = new FileSnapshotRepository(WORKSPACE);
    const result = await repo.listByNodeId("node-A");

    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("id-1");
    expect(ids).toContain("id-2");
  });

  it("listByNodeId returns empty array when no index exists", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not found")); // readIndex throws
    const repo = new FileSnapshotRepository(WORKSPACE);
    const result = await repo.listByNodeId("node-X");
    expect(result).toEqual([]);
  });

  it("update reads the existing snap, patches it, and writes back", async () => {
    const snap = makeSnap("upd-1");
    mockInvoke
      .mockResolvedValueOnce(JSON.stringify(snap)) // getById (read existing)
      .mockResolvedValueOnce(undefined);            // writeOne (write updated)

    const repo = new FileSnapshotRepository(WORKSPACE);
    const updated = await repo.update("upd-1", { snapshotStatus: "failed" });

    expect(updated).toBeDefined();
    expect(updated!.snapshotStatus).toBe("failed");
    expect(updated!.id).toBe("upd-1");
    expect(updated!.createdAt).toBe(snap.createdAt);
    expect(updated!.updatedAt).not.toBe(snap.updatedAt);
  });

  it("update returns undefined when snapshot file is missing", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not found")); // getById throws
    const repo = new FileSnapshotRepository(WORKSPACE);
    expect(await repo.update("ghost", { snapshotStatus: "cancelled" })).toBeUndefined();
  });

  it("remove updates the index and marks the snapshot as cancelled", async () => {
    const snap = makeSnap("rem-1", "node-R");
    const index = { "node-R": ["rem-1"] };

    mockInvoke
      .mockResolvedValueOnce(JSON.stringify(index))    // readIndex
      .mockResolvedValueOnce(undefined)                // writeIndex (after removing from index)
      .mockResolvedValueOnce(JSON.stringify(snap))     // getById (in remove, checking existing)
      .mockResolvedValueOnce(JSON.stringify(snap))     // getById (inside update)
      .mockResolvedValueOnce(undefined);               // writeOne (update — mark as cancelled)

    const repo = new FileSnapshotRepository(WORKSPACE);
    const ok = await repo.remove("rem-1", "node-R");
    expect(ok).toBe(true);

    // Verify the index write was called (call index 1)
    const writeIndexCall = mockInvoke.mock.calls[1];
    expect(writeIndexCall[0]).toBe("write_workspace_file");
    const content = JSON.parse(
      (writeIndexCall[1] as Record<string, unknown>)["content"] as string
    );
    expect(content["node-R"]).toEqual([]);
  });
});

describe("FileSnapshotRepository — concurrent creates", () => {
  it("keeps every snapshot in the index when parallel agents finish together", async () => {
    // In-memory disk with async I/O, so index read-modify-write calls interleave.
    const disk = new Map<string, string>();
    mockInvoke.mockImplementation(async (cmd: string, rawArgs?: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const args = rawArgs as { relativePath?: string; content?: string } | undefined;
      const path = String(args?.relativePath);
      if (cmd === "write_workspace_file") { disk.set(path, String(args?.content)); return undefined; }
      if (cmd === "read_workspace_file") {
        if (!disk.has(path)) throw new Error("not found");
        return disk.get(path);
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const repo = new FileSnapshotRepository(WORKSPACE);

    await Promise.all(["a", "b", "c"].map((nodeId) => repo.create({ ...makeInput(), nodeId })));

    for (const nodeId of ["a", "b", "c"]) {
      expect(await repo.listByNodeId(nodeId)).toHaveLength(1);
    }
  });
});
