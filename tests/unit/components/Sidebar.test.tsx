import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "@/components/layout/Sidebar";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import type { FileTreeEntry } from "@/types/filesystem";

const file = (path: string): FileTreeEntry => ({ name: path.split("/").at(-1)!, path, isDirectory: false });

beforeEach(() => {
  useWorkflowStore.getState().reset();
  useWorkspaceStore.setState({
    workspacePath: "/ws",
    isLoading: false,
    fileTree: [
      file("AGENTS.md"),
      { name: "src", path: "src", isDirectory: true, children: [
        { name: "lib", path: "src/lib", isDirectory: true, children: [file("src/lib/sum.mjs")] },
      ] },
    ],
  });
});

describe("Sidebar files", () => {
  it("filters the file tree by name, opening the folders that hold matches", () => {
    render(<Sidebar />);
    expect(screen.queryByText("sum.mjs")).toBeNull(); // src/lib starts closed

    fireEvent.change(screen.getByPlaceholderText("search files"), { target: { value: "SUM" } });

    expect(screen.getByText("sum.mjs")).toBeTruthy();
    expect(screen.queryByText("AGENTS.md")).toBeNull();
  });

  it("says when no file matches", () => {
    render(<Sidebar />);

    fireEvent.change(screen.getByPlaceholderText("search files"), { target: { value: "nope" } });

    expect(screen.getByText("No files match")).toBeTruthy();
  });

  it("re-reads the workspace folder with the Refresh button", async () => {
    mockInvokeHandler("list_workspace_files", () => [file("AGENTS.md"), file("new.txt")]);
    render(<Sidebar />);

    await act(async () => { fireEvent.click(screen.getByTitle("Refresh files")); });

    expect(await screen.findByText("new.txt")).toBeTruthy();
  });
});
