import { describe, it, expect, beforeEach } from "vitest";
import { useExecutionStore } from "@/store/executionStore";

beforeEach(() => {
  // Reset by re-setting relevant fields to defaults
  useExecutionStore.setState({ continueOnError: true, currentRun: null, isRunning: false });
});

describe("executionStore — continueOnError", () => {
  it("initializes continueOnError to true", () => {
    expect(useExecutionStore.getState().continueOnError).toBe(true);
  });

  it("setContinueOnError sets to false", () => {
    useExecutionStore.getState().setContinueOnError(false);
    expect(useExecutionStore.getState().continueOnError).toBe(false);
  });

  it("setContinueOnError can be toggled back to true", () => {
    useExecutionStore.getState().setContinueOnError(false);
    useExecutionStore.getState().setContinueOnError(true);
    expect(useExecutionStore.getState().continueOnError).toBe(true);
  });
});

describe("executionStore — file changes", () => {
  it("records changes on the current run and forgets reverted files", () => {
    useExecutionStore.getState().startRun("W");
    useExecutionStore.getState().recordFileChange("a.ts", "v1", "v2", "Coder");
    useExecutionStore.getState().recordFileChange("b.ts", null, "new", "Coder");
    useExecutionStore.getState().forgetFileChange("a.ts");
    expect(useExecutionStore.getState().currentRun?.changes).toEqual([
      { path: "b.ts", before: null, after: "new", agents: ["Coder"], edits: 1 },
    ]);
  });

  it("ignores changes when there is no run", () => {
    useExecutionStore.getState().recordFileChange("a.ts", "v1", "v2", "Coder");
    expect(useExecutionStore.getState().currentRun).toBeNull();
  });
});
