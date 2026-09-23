import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkflow } from "@/hooks/useWorkflow";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useAuditStore } from "@/store/auditStore";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";

let saved: Array<{ relativePath: string }> = [];

beforeEach(() => {
  saved = [];
  useAuditStore.setState({ entries: [] });
  useWorkspaceStore.setState({ workspacePath: "/ws" });
  useWorkflowStore.getState().reset();
  useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
  useWorkflowStore.getState().updateMeta({ name: "My Flow" });
  mockInvokeHandler("save_workflow", (args) => {
    saved.push(args as { relativePath: string });
    return undefined;
  });
});

describe("useWorkflow.save", () => {
  it("refuses to write a workflow that fails validation and records the failure", async () => {
    useWorkflowStore.getState().updateMeta({ version: "1.1" }); // schema requires semver

    const { result } = renderHook(() => useWorkflow());
    await act(async () => {
      await expect(result.current.save("flow.harness.yaml")).rejects.toThrow();
    });

    expect(saved).toEqual([]);
    expect(useAuditStore.getState().entries.some((e) => !e.success && /Save failed/.test(e.details ?? ""))).toBe(true);
  });
});

describe("Ctrl+S", () => {
  it("saves a never-saved workflow under the same default name as the Save button", async () => {
    renderHook(() => useKeyboardShortcuts());

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(saved.map((s) => s.relativePath)).toEqual(["my-flow.harness.yaml"]);
  });
});
