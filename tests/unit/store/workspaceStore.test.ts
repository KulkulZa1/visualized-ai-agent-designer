import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore, openWorkspaceFolder, refreshWorkspaceFiles } from "@/store/workspaceStore";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import type { FileTreeEntry } from "@/types/filesystem";
import { act, renderHook } from "@testing-library/react";
import { useWorkflow } from "@/hooks/useWorkflow";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";

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

describe("openWorkspaceFolder", () => {
  it("makes the picked folder the workspace and loads its file tree", async () => {
    mockInvokeHandler("open_workspace_dialog", () => "/picked");
    mockInvokeHandler("list_workspace_files", () => [
      { name: "a.md", path: "a.md", isDirectory: false, children: null },
    ]);

    await openWorkspaceFolder();

    const state = useWorkspaceStore.getState();
    expect(state.workspacePath).toBe("/picked");
    expect(state.fileTree).toHaveLength(1);
    expect(state.isLoading).toBe(false);
  });

  it("does nothing when the dialog is cancelled", async () => {
    useWorkspaceStore.setState({ workspacePath: "/before" });
    mockInvokeHandler("open_workspace_dialog", () => null);

    await openWorkspaceFolder();

    expect(useWorkspaceStore.getState().workspacePath).toBe("/before");
  });
});

describe("refreshWorkspaceFiles", () => {
  const file = (path: string): FileTreeEntry => ({ name: path, path, isDirectory: false });
  const shownPaths = () => useWorkspaceStore.getState().fileTree.map((e) => e.path);
  /** A file listing that answers when the test says so. */
  const listing = () => {
    let answer!: (tree: FileTreeEntry[]) => void;
    const pending = new Promise<FileTreeEntry[]>((resolve) => { answer = resolve; });
    return { pending, answer };
  };

  beforeEach(() => { useWorkspaceStore.setState({ workspacePath: "/ws", fileTree: [] }); });

  // A run's refresh is not awaited, so the next run's can start while it is still listing.
  it("ends with the newest refresh's tree when an older listing comes back last", async () => {
    const [older, newer] = [listing(), listing()];
    const listings = [older.pending, newer.pending];
    mockInvokeHandler("list_workspace_files", () => listings.shift());
    const olderRefresh = refreshWorkspaceFiles();
    const newerRefresh = refreshWorkspaceFiles();

    newer.answer([file("made-by-run-2.txt")]);
    await newerRefresh;
    expect(shownPaths()).toEqual(["made-by-run-2.txt"]);

    older.answer([file("made-by-run-1.txt")]);
    await olderRefresh;
    expect(shownPaths()).toEqual(["made-by-run-2.txt"]);
  });

  it("ends with the newest refresh's tree when the older listing comes back first too", async () => {
    const [older, newer] = [listing(), listing()];
    const listings = [older.pending, newer.pending];
    mockInvokeHandler("list_workspace_files", () => listings.shift());
    const olderRefresh = refreshWorkspaceFiles();
    const newerRefresh = refreshWorkspaceFiles();

    older.answer([file("made-by-run-1.txt")]);
    await olderRefresh;
    newer.answer([file("made-by-run-2.txt")]);
    await newerRefresh;

    expect(shownPaths()).toEqual(["made-by-run-2.txt"]);
  });

  it("applies a refresh that starts after the earlier ones are done", async () => {
    mockInvokeHandler("list_workspace_files", () => [file("first.txt")]);
    await refreshWorkspaceFiles();
    mockInvokeHandler("list_workspace_files", () => [file("second.txt")]);
    await refreshWorkspaceFiles();

    expect(shownPaths()).toEqual(["second.txt"]);
  });

  it("does not put a tree in when another workspace was opened while it listed", async () => {
    const slow = listing();
    mockInvokeHandler("list_workspace_files", () => slow.pending);
    const refresh = refreshWorkspaceFiles();

    useWorkspaceStore.setState({ workspacePath: "/other", fileTree: [file("other.txt")] });
    slow.answer([file("of-ws.txt")]);
    await refresh;

    expect(shownPaths()).toEqual(["other.txt"]);
  });

  it("does nothing without a workspace", async () => {
    let listed = 0;
    mockInvokeHandler("list_workspace_files", () => { listed++; return []; });
    useWorkspaceStore.setState({ workspacePath: null });

    await refreshWorkspaceFiles();

    expect(listed).toBe(0);
  });
});

describe("session restore", () => {
  it("persists the open workspace so it can be restored on the next start", () => {
    useWorkspaceStore.getState().setWorkspacePath("/ws");

    const persisted = JSON.parse(localStorage.getItem("workspace-storage") ?? "{}");
    expect(persisted.state?.workspacePath).toBe("/ws");
  });

  it("remembers the last loaded (not only last saved) workflow", async () => {
    useWorkspaceStore.setState({ workspacePath: "/ws" });
    useWorkflowStore.getState().reset();
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    const def = useWorkflowStore.getState().toWorkflowDef();
    mockInvokeHandler("load_workflow", () => def);

    const { result } = renderHook(() => useWorkflow());
    await act(async () => { await result.current.load("flows/a.harness.yaml"); });

    expect(useWorkspaceStore.getState().lastHarnessPath).toBe("flows/a.harness.yaml");
  });
});
