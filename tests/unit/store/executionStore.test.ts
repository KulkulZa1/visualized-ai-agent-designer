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
