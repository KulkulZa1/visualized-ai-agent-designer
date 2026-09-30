import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { RunPanel } from "@/components/execution/RunPanel";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";

vi.mock("@/components/editor/monacoLocal", () => ({
  default: () => null,
  DiffEditor: () => <pre data-testid="diff" />,
}));

beforeEach(() => {
  useExecutionStore.setState({
    currentRun: {
      id: "run-1", workflowName: "W", startedAt: 0, status: "done", agents: {},
      changes: [{ path: "a.ts", before: "1", after: "2", agents: ["A"], edits: 1 }],
    },
    isRunning: false,
  });
});

describe("RunPanel", () => {
  it("opens the Changes dialog from the changed-file count", async () => {
    render(<RunPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Changes \(1\)/ }));
    expect(screen.getByRole("dialog", { name: /Changes/ })).toBeTruthy();

    // The dialog's diff editor is React.lazy. findBy* waits with React's act environment off, so
    // the load resolves inside the test instead of after it as an update outside act().
    await screen.findByTestId("diff");
  });

  it("still says that no agent has run yet for a run that has not reported one", () => {
    useExecutionStore.setState({
      currentRun: { id: "run-2", workflowName: "W", startedAt: 0, status: "running", agents: {} },
      isRunning: true,
    });
    render(<RunPanel onClose={() => {}} />);

    expect(screen.getByText("No agents have run yet.")).toBeTruthy();
  });
});

describe("RunPanel after another workflow is opened", () => {
  const otherWorkflow = () => ({
    meta: { name: "Other", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: [makeDefaultAgentNode("x", AgentRole.Worker, { x: 0, y: 0 }).data],
    connections: [],
    executionSettings: { maxParallel: 2, timeoutSeconds: 60, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  });
  const openOtherWorkflow = () => act(() => { useWorkflowStore.getState().loadWorkflow(otherWorkflow()); });

  // The last run: two agents, one changed file.
  beforeEach(() => {
    const now = Date.now();
    useExecutionStore.setState({ currentRun: null, isRunning: false });
    const run = useExecutionStore.getState();
    run.startRun("Fix the sum bug", "run-1", "/ws");
    run.updateAgent("agent-0", { agentName: "Coder", status: "done", startedAt: now, finishedAt: now + 500, output: "fixed" });
    run.updateAgent("agent-1", { agentName: "Reviewer", status: "done", startedAt: now + 500, finishedAt: now + 900 });
    run.recordFileChange("src/sum.mjs", "a\n", "b\n", "Coder");
    run.finishRun("done");
    useWorkspaceStore.setState({ workspacePath: "/ws" });
  });

  it("still offers the run's Changes, and the dialog lists its file", async () => {
    render(<RunPanel onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /Changes \(1\)/ })).toBeTruthy();

    openOtherWorkflow();

    fireEvent.click(screen.getByRole("button", { name: /Changes \(1\)/ }));
    const dialog = screen.getByRole("dialog", { name: /Changes/ });
    expect(within(dialog).getByText("src/sum.mjs")).toBeTruthy();
    expect(within(dialog).getByText("Coder")).toBeTruthy();
    await screen.findByTestId("diff");
  });

  it("still reverts the run's file, which is still on disk", async () => {
    const written: Record<string, string> = {};
    mockInvokeHandler("read_workspace_file", () => "b\n"); // as the agent left it
    mockInvokeHandler("write_workspace_file", (args) => {
      const a = args as { relativePath: string; content: string };
      written[a.relativePath] = a.content;
    });
    mockInvokeHandler("write_audit_entry", () => undefined);
    render(<RunPanel onClose={() => {}} />);
    openOtherWorkflow();
    fireEvent.click(screen.getByRole("button", { name: /Changes \(1\)/ }));
    const dialog = screen.getByRole("dialog", { name: /Changes/ });
    await screen.findByTestId("diff"); // the lazy diff editor loads inside the test

    await act(async () => { fireEvent.click(within(dialog).getAllByRole("button", { name: "Revert" })[0]); });

    expect(written).toEqual({ "src/sum.mjs": "a\n" });
    expect(useExecutionStore.getState().currentRun?.changes).toEqual([]);
  });

  // Run in /ws, open another folder, load a workflow from it: the kept changes are paths in /ws.
  it("does not revert into the other folder that was opened: it has files of its own under those names", async () => {
    const calls: string[] = [];
    for (const command of ["read_workspace_file", "write_workspace_file", "delete_workspace_file", "write_audit_entry"]) {
      mockInvokeHandler(command, () => { calls.push(command); return "b\n"; });
    }
    render(<RunPanel onClose={() => {}} />);
    act(() => { useWorkspaceStore.setState({ workspacePath: "/ws-y" }); });
    openOtherWorkflow();
    fireEvent.click(screen.getByRole("button", { name: /Changes \(1\)/ }));
    const dialog = screen.getByRole("dialog", { name: /Changes/ });
    await screen.findByTestId("diff");

    await act(async () => { fireEvent.click(within(dialog).getAllByRole("button", { name: "Revert" })[0]); });

    expect(calls).toEqual([]);
    expect(within(dialog).getByText("These changes were made in /ws. Open that folder to revert them.")).toBeTruthy();
    expect(useExecutionStore.getState().currentRun?.changes).toHaveLength(1);
  });

  it("labels the kept run with its own workflow and status", () => {
    render(<RunPanel onClose={() => {}} />);

    openOtherWorkflow();

    expect(screen.getByText("Fix the sum bug")).toBeTruthy();
    expect(screen.getByText("DONE")).toBeTruthy();
  });

  it("shows none of the run's agents or timeline on the new workflow, and does not claim no agent ran", () => {
    render(<RunPanel onClose={() => {}} />);
    // The run's agents (in the list and on the timeline) are there before.
    expect(screen.getAllByText("Coder")).toHaveLength(2);
    expect(screen.getAllByText("Reviewer")).toHaveLength(2);
    expect(screen.getByText("Timeline")).toBeTruthy();

    openOtherWorkflow();

    expect(screen.queryByText("Coder")).toBeNull();
    expect(screen.queryByText("Reviewer")).toBeNull();
    expect(screen.queryByText("Timeline")).toBeNull();
    expect(screen.queryByText("No agents have run yet.")).toBeNull();
    expect(screen.getByText("Agent results were cleared when another workflow was opened.")).toBeTruthy();
  });
});
