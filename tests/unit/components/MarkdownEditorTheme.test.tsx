import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkspaceStore } from "@/store/workspaceStore";

// Separate from MarkdownEditor.test.tsx, whose tests watch the real editor load.
vi.mock("@/components/editor/monacoLocal", () => ({
  default: ({ value, theme }: { value: string; theme?: string }) => (
    <pre data-testid="editor" data-theme={theme}>{value}</pre>
  ),
}));

describe("MarkdownEditor theme", () => {
  it("uses Monaco's dark theme, like the rest of the app", async () => {
    useWorkspaceStore.setState({ workspacePath: "/ws" });
    mockInvokeHandler("read_workspace_file", () => "# Notes");

    render(<MarkdownEditor path="notes.md" />);

    expect((await screen.findByTestId("editor")).getAttribute("data-theme")).toBe("vs-dark");
  });
});
