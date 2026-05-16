import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/store/workspaceStore";

beforeEach(() => {
  localStorage.clear();
  // Reset lastHarnessPath between tests by re-reading from cleared localStorage
  useWorkspaceStore.setState({ lastHarnessPath: "" });
});

describe("workspaceStore — lastHarnessPath", () => {
  it("defaults to empty string when localStorage has no entry", () => {
    useWorkspaceStore.setState({ lastHarnessPath: localStorage.getItem("harness_last_path") ?? "" });
    expect(useWorkspaceStore.getState().lastHarnessPath).toBe("");
  });

  it("setLastHarnessPath updates state and writes to localStorage", () => {
    useWorkspaceStore.getState().setLastHarnessPath(".harness/my-workflow.harness.yaml");
    expect(useWorkspaceStore.getState().lastHarnessPath).toBe(".harness/my-workflow.harness.yaml");
    expect(localStorage.getItem("harness_last_path")).toBe(".harness/my-workflow.harness.yaml");
  });

  it("reads lastHarnessPath from localStorage when present", () => {
    localStorage.setItem("harness_last_path", ".harness/restored.harness.yaml");
    useWorkspaceStore.setState({ lastHarnessPath: localStorage.getItem("harness_last_path") ?? "" });
    expect(useWorkspaceStore.getState().lastHarnessPath).toBe(".harness/restored.harness.yaml");
  });

  it("setLastHarnessPath overwrites an existing value", () => {
    useWorkspaceStore.getState().setLastHarnessPath("first.yaml");
    useWorkspaceStore.getState().setLastHarnessPath("second.yaml");
    expect(useWorkspaceStore.getState().lastHarnessPath).toBe("second.yaml");
    expect(localStorage.getItem("harness_last_path")).toBe("second.yaml");
  });
});
