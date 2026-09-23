import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useUIStore } from "@/store/uiStore";

beforeEach(() => {
  useWorkspaceStore.setState({ workspacePath: "/ws" });
});

describe("MarkdownEditor", () => {
  it("shows an error instead of an empty, saveable editor when the file cannot be read", async () => {
    // e.g. a binary or non-UTF-8 file: saving an empty buffer would truncate it.
    mockInvokeHandler("read_workspace_file", () =>
      Promise.reject(new Error("stream did not contain valid UTF-8")));

    render(<MarkdownEditor path="assets/logo.png" />);

    expect(await screen.findByText(/cannot be opened/i)).toBeTruthy();
    expect(screen.queryByText(/Loading editor/i)).toBeNull();
  });
});

describe("MarkdownEditor — unsaved edits", () => {
  it("restores a dirty tab's unsaved text instead of re-reading the file from disk", async () => {
    useUIStore.setState({
      openEditorTabs: [{ path: "a.md", isDirty: true, unsaved: "edited A" }],
      activeEditorPath: "a.md",
    });
    let reads = 0;
    mockInvokeHandler("read_workspace_file", () => { reads++; return "disk A"; });

    render(<MarkdownEditor path="a.md" />);

    expect(await screen.findByText(/Loading editor/i)).toBeTruthy();
    expect(reads).toBe(0);
  });
});
