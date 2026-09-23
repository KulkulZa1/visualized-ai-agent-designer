import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentActivityPanel } from "@/components/execution/AgentActivityPanel";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";

beforeEach(() => {
  useWorkflowStore.getState().reset();
  useExecutionStore.setState({ currentRun: null, isRunning: false });
});

describe("AgentActivityPanel", () => {
  it("renders nothing instead of crashing when its node is removed while it is open", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    const { container } = render(<AgentActivityPanel nodeId="n1" onClose={() => {}} />);
    expect(container.textContent).toContain("Worker");

    act(() => { useWorkflowStore.getState().removeNode("n1"); });

    expect(container.innerHTML).toBe("");
  });
});
