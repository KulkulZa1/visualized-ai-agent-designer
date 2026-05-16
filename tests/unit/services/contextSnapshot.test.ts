import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { AgentRole, ToolPermission, type AgentNodeData } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import { MOCK_ARTIFACTS } from "@/services/artifact-manager/mockArtifacts";
import { buildContextSnapshot } from "@/services/context-builder/contextSnapshot";

function node(id: string, overrides: Partial<AgentNodeData> = {}): AgentNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      name: id,
      role: AgentRole.Worker,
      model: "gpt-4o-mini",
      temperature: 0.4,
      maxTokens: 1024,
      maxSteps: 5,
      timeoutSeconds: 60,
      promptSource: { type: "inline", content: "Summarize the upstream result." },
      tools: [ToolPermission.ReadFile],
      memoryRead: ["project-state"],
      memoryWrite: ["summary"],
      tokens: { used: 0, budget: 4096 },
      status: "idle",
      description: "Writes a concise report",
      ...overrides,
    },
  };
}

describe("context snapshot", () => {
  it("separates prompt, final context, inputs, tools, files, stream, artifacts, and debug info", () => {
    const upstream = node("upstream", {
      promptSource: { type: "inline", content: "Collect facts." },
    });
    const selected = node("selected");
    const edges: Edge[] = [
      { id: "e1", source: "upstream", target: "selected" },
    ];

    const snapshot = buildContextSnapshot({
      node: selected,
      nodes: [upstream, selected],
      edges,
      agentRun: {
        agentId: "selected",
        agentName: "selected",
        status: "running",
        output: "partial stream",
        startedAt: 100,
      },
      artifacts: MOCK_ARTIFACTS,
    });

    expect(snapshot.nodeId).toBe("selected");
    expect(snapshot.prompt.staticPrompt).toContain("Summarize the upstream result");
    expect(snapshot.finalContext.previewLabel).toMatch(/preview/i);
    expect(snapshot.inputs.upstreamOutputs[0].nodeId).toBe("upstream");
    expect(snapshot.tools.allowedTools).toEqual([ToolPermission.ReadFile]);
    expect(snapshot.files.selectedFiles).toEqual([]);
    expect(snapshot.outputStream.content).toContain("partial stream");
    expect(snapshot.artifacts.every((artifact) => artifact.sourceNodeId === "selected")).toBe(true);
    expect(snapshot.debugInfo.providerId).toBe("openai");
  });

  it("mock artifacts include required metadata for preview and future persistence", () => {
    for (const artifact of MOCK_ARTIFACTS) {
      expect(artifact.id).toBeTruthy();
      expect(artifact.title).toBeTruthy();
      expect(artifact.sourceNodeId).toBeTruthy();
      expect(artifact.type).toBeTruthy();
      expect(artifact.previewMode).toBeTruthy();
      expect(artifact.createdAt).toBeTruthy();
      expect(artifact.updatedAt).toBeTruthy();
      expect(artifact.version).toBeGreaterThan(0);
      expect(["mock", "draft", "persisted", "error"]).toContain(artifact.status);
    }
  });
});
