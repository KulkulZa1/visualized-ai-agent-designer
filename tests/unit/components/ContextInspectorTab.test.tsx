import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextInspectorTab } from "@/components/config-panel/tabs/ContextInspectorTab";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";

const { createSnapshot } = vi.hoisted(() => ({ createSnapshot: vi.fn(async () => ({})) }));
vi.mock("@/services/context-builder/snapshotService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/context-builder/snapshotService")>()),
  createSnapshot,
  listSnapshotsForNode: vi.fn(async () => []),
}));

beforeEach(() => {
  createSnapshot.mockClear();
  useWorkflowStore.getState().reset();
  useWorkspaceStore.setState({ workspacePath: "/ws" });
});

describe("ContextInspectorTab", () => {
  it("previews the context without persisting a snapshot just because the tab was opened", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));

    render(<ContextInspectorTab nodeId="n1" />);

    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
