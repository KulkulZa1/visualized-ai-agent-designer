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

  it("lists the node's sub-agents with status, task, time, tool calls and report", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Orchestrator, { x: 0, y: 0 }));
    const now = Date.now();
    useExecutionStore.setState({
      currentRun: {
        id: "run-1", workflowName: "W", startedAt: now, status: "running",
        agents: {
          n1: {
            agentId: "n1", agentName: "Lead", status: "running", startedAt: now,
            subAgents: [
              { id: "sub-1", name: "noteA", task: "Read notes/a.md and report its main point.", tools: ["read_file"],
                status: "done", startedAt: now, finishedAt: now + 4200, output: "Delivery times fell 18%.", toolCalls: 1 },
              { id: "sub-2", name: "noteB", task: "Read notes/b.md.", tools: ["read_file"], status: "running", startedAt: now },
              { id: "sub-3", name: "noteC", task: "Read notes/c.md.", tools: [], status: "error", startedAt: now,
                finishedAt: now + 1000, error: "Error: timed out" },
            ],
          },
        },
      },
      isRunning: true,
    });

    const { container } = render(<AgentActivityPanel nodeId="n1" onClose={() => {}} />);
    const text = container.textContent ?? "";

    expect(text).toContain("Sub-agents (3)");
    expect(text).toContain("noteA");
    expect(text).toContain("Read notes/a.md and report its main point.");
    expect(text).toContain("Delivery times fell 18%.");
    expect(text).toContain("1 tool call");
    expect(text).toContain("4.2s");
    expect(text).toContain("noteB");
    expect(text).toContain("Error: timed out");
  });

  it("shows a stopped helper in grey, without an error box", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Orchestrator, { x: 0, y: 0 }));
    const now = Date.now();
    useExecutionStore.setState({
      currentRun: {
        id: "r", workflowName: "W", startedAt: now, status: "cancelled",
        agents: {
          n1: {
            agentId: "n1", agentName: "Lead", status: "stopped", startedAt: now,
            subAgents: [{ id: "sub-1", name: "H", task: "t", tools: [], status: "stopped",
              startedAt: now, finishedAt: now + 500 }],
          },
        },
      },
      isRunning: false,
    });

    const { getAllByText, container } = render(<AgentActivityPanel nodeId="n1" onClose={() => {}} />);

    // The node's header status and the helper's status both read "stopped", in grey.
    for (const label of getAllByText("stopped")) expect(label.style.color).toBe("var(--hint)");
    expect(container.querySelectorAll("pre")).toHaveLength(0);
  });

  it("labels a node stopped by the user as Stopped, not skipped by a gateway", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    const now = Date.now();
    useExecutionStore.setState({
      currentRun: {
        id: "r", workflowName: "W", startedAt: now, status: "cancelled",
        agents: { n1: { agentId: "n1", agentName: "n1", status: "stopped", startedAt: now, finishedAt: now + 900 } },
      },
      isRunning: false,
    });

    const { getByText, container } = render(<AgentActivityPanel nodeId="n1" onClose={() => {}} />);

    expect(getByText("■ Stopped").style.color).toBe("var(--hint)");
    expect(container.textContent).not.toContain("Skipped by gateway");
    expect(container.textContent).not.toContain("Run the workflow to see output here");
  });

  it("shows no sub-agent section for a node without helpers", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    useExecutionStore.setState({
      currentRun: {
        id: "r", workflowName: "W", startedAt: Date.now(), status: "running",
        agents: { n1: { agentId: "n1", agentName: "n1", status: "done", output: "ok" } },
      },
      isRunning: true,
    });
    const { container } = render(<AgentActivityPanel nodeId="n1" onClose={() => {}} />);
    expect(container.textContent).not.toContain("Sub-agents");
  });
});
