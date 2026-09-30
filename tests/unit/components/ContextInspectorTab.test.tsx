import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextInspectorTab } from "@/components/config-panel/tabs/ContextInspectorTab";
import { useExecutionStore } from "@/store/executionStore";
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
  it("previews the context without persisting a snapshot just because the tab was opened", async () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));

    // SnapshotHistory loads its list in an effect and sets state when that resolves. Render inside
    // an async act() so that update settles in the act scope rather than after render() returns.
    await act(async () => { render(<ContextInspectorTab nodeId="n1" />); });

    expect(createSnapshot).not.toHaveBeenCalled();
  });

  // Node ids are places in the file: the next workflow's first node is agent-0 too.
  it("shows nothing of the last run on another workflow's node once that workflow is opened", async () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("agent-0", AgentRole.Worker, { x: 0, y: 0 }));
    useExecutionStore.setState({ currentRun: null, isRunning: false });
    const run = useExecutionStore.getState();
    run.startRun("Fix the sum bug", "run-1");
    run.updateAgent("agent-0", { agentName: "Coder", status: "done", output: "fixed sum.mjs", startedAt: 1, finishedAt: 2 });
    run.finishRun("done");
    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<ContextInspectorTab nodeId="agent-0" />)); });
    expect(container.textContent).toContain("Current run");
    expect(container.textContent).toContain("fixed sum.mjs");

    act(() => {
      useWorkflowStore.getState().loadWorkflow({
        meta: { name: "Other", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
        agents: [makeDefaultAgentNode("x", AgentRole.Worker, { x: 0, y: 0 }).data],
        connections: [],
        executionSettings: { maxParallel: 2, timeoutSeconds: 60, retryOnFailure: false, maxRetries: 0 },
        nodePositions: {},
      });
    });

    expect(container.textContent).not.toContain("Current run");
    expect(container.textContent).not.toContain("fixed sum.mjs");
  });
});
