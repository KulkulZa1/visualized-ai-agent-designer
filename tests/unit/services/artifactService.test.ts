import { vi, describe, beforeEach, it, expect } from "vitest";
import { persistArtifact, loadArtifact, artifactExists, getPersistedArtifactPaths } from "@/services/artifact-manager/artifactService";
import type { Artifact } from "@/types/inspection";

// ── Mock Tauri invoke ─────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE = "/workspace";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-001",
    title: "Test Report",
    type: "markdown",
    sourceNodeId: "node-src",
    content: "# Test\nContent here.",
    previewMode: "rendered",
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    version: 1,
    status: "mock",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("persistArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls write_workspace_file with the correct path pattern", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const artifact = makeArtifact();
    const path = await persistArtifact(artifact, WORKSPACE);

    expect(path).toBe(".harness/artifacts/node-src/art-001.md");
    expect(mockInvoke).toHaveBeenCalledWith("write_workspace_file", {
      workspacePath: WORKSPACE,
      relativePath: ".harness/artifacts/node-src/art-001.md",
      content: artifact.content,
    });
  });

  it("uses .json extension for json type artifacts", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const artifact = makeArtifact({ id: "art-002", type: "json", sourceNodeId: "node-b" });
    const path = await persistArtifact(artifact, WORKSPACE);
    expect(path).toBe(".harness/artifacts/node-b/art-002.json");
  });

  it("uses .yaml extension for yaml type artifacts", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const artifact = makeArtifact({ id: "art-003", type: "yaml", sourceNodeId: "node-c" });
    const path = await persistArtifact(artifact, WORKSPACE);
    expect(path).toBe(".harness/artifacts/node-c/art-003.yaml");
  });

  it("falls back to .md for unrecognized types", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    // "log" type is not one of json/yaml/html → falls back to md
    const artifact = makeArtifact({ id: "art-004", type: "log" as Artifact["type"], sourceNodeId: "node-d" });
    const path = await persistArtifact(artifact, WORKSPACE);
    expect(path).toBe(".harness/artifacts/node-d/art-004.md");
  });
});

describe("loadArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls read_workspace_file and returns the content", async () => {
    mockInvoke.mockResolvedValueOnce("# Loaded content");
    const content = await loadArtifact(".harness/artifacts/node-x/a.md", WORKSPACE);
    expect(content).toBe("# Loaded content");
    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_file", {
      workspacePath: WORKSPACE,
      relativePath: ".harness/artifacts/node-x/a.md",
    });
  });
});

describe("artifactExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the file can be read", async () => {
    mockInvoke.mockResolvedValueOnce("content");
    expect(await artifactExists(".harness/artifacts/node-x/a.md", WORKSPACE)).toBe(true);
  });

  it("returns false when the file read throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("not found"));
    expect(await artifactExists(".harness/artifacts/node-x/missing.md", WORKSPACE)).toBe(false);
  });
});

describe("getPersistedArtifactPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns paths of artifacts persisted in this module session", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const a1 = makeArtifact({ id: "paths-001", sourceNodeId: "node-p" });
    const a2 = makeArtifact({ id: "paths-002", type: "json", sourceNodeId: "node-p" });
    await persistArtifact(a1, WORKSPACE);
    await persistArtifact(a2, WORKSPACE);
    const paths = getPersistedArtifactPaths();
    expect(paths).toContain(".harness/artifacts/node-p/paths-001.md");
    expect(paths).toContain(".harness/artifacts/node-p/paths-002.json");
  });

  it("returns an array (not a Set)", async () => {
    const paths = getPersistedArtifactPaths();
    expect(Array.isArray(paths)).toBe(true);
  });
});
