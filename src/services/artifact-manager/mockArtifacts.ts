import type { Artifact } from "@/types/inspection";

const now = "2026-05-17T00:00:00.000Z";

export const MOCK_ARTIFACTS: Artifact[] = [
  {
    id: "artifact-selected-report",
    title: "Execution context report",
    type: "markdown",
    sourceNodeId: "selected",
    content: "# Execution context report\n\nMock artifact preview for the selected node. Persistence is not implemented yet.",
    previewMode: "rendered",
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: "mock",
  },
  {
    id: "artifact-selected-payload",
    title: "Final model payload",
    type: "json",
    sourceNodeId: "selected",
    content: "{\n  \"note\": \"Mock payload only; live execution capture is planned.\"\n}",
    previewMode: "code",
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: "mock",
  },
  {
    id: "artifact-orchestrator-log",
    title: "Run log excerpt",
    type: "log",
    sourceNodeId: "orchestrator",
    content: "[mock] Agent selected, context assembled, waiting for execution trace persistence.",
    previewMode: "log",
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: "mock",
  },
];

export function artifactsForNode(nodeId: string): Artifact[] {
  return MOCK_ARTIFACTS.filter((artifact) => artifact.sourceNodeId === nodeId);
}
