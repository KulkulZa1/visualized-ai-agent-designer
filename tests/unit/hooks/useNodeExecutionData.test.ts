import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useNodeExecutionData } from "@/hooks/useNodeExecutionData";
import { useExecutionStore } from "@/store/executionStore";

beforeEach(() => {
  useExecutionStore.setState({ currentRun: null, isRunning: false });
  const run = useExecutionStore.getState();
  run.startRun("Fix the sum bug", "run-1");
  run.updateAgent("agent-0", { agentName: "Coder", status: "done", output: "fixed sum.mjs" });
  run.finishRun("done");
});

describe("useNodeExecutionData", () => {
  it("gives a node's result from the last run", () => {
    const { result } = renderHook(() => useNodeExecutionData("agent-0"));

    expect(result.current).toMatchObject({ agentName: "Coder", output: "fixed sum.mjs" });
  });

  // Another workflow's nodes reuse the ids (agent-0, ...): its Inspector, canvas nodes and
  // App's activity panel all read through here, and must not get the last run's result.
  it("gives no result for the same node id once another workflow is opened, though the run is kept", () => {
    const { result } = renderHook(() => useNodeExecutionData("agent-0"));

    act(() => { useExecutionStore.getState().clearRun(); });

    expect(result.current).toBeNull();
    expect(useExecutionStore.getState().currentRun?.status).toBe("done");
  });

  it("gives nothing without a node or a run", () => {
    expect(renderHook(() => useNodeExecutionData(null)).result.current).toBeNull();
    act(() => { useExecutionStore.setState({ currentRun: null }); });
    expect(renderHook(() => useNodeExecutionData("agent-0")).result.current).toBeNull();
  });
});
