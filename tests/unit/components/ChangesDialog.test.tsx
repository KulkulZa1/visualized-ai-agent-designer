import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { ChangesDialog } from "@/components/execution/ChangesDialog";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkspaceStore } from "@/store/workspaceStore";

vi.mock("@/components/editor/monacoLocal", () => ({
  default: () => null,
  DiffEditor: ({ original, modified, theme }: { original: string; modified: string; theme?: string }) => (
    <pre data-testid="diff" data-theme={theme}>{`${original}|${modified}`}</pre>
  ),
}));

beforeEach(() => {
  useWorkspaceStore.setState({ workspacePath: "/ws" });
  useExecutionStore.setState({
    currentRun: {
      id: "run-1", workflowName: "W", startedAt: 0, status: "done", agents: {}, workspacePath: "/ws",
      changes: [
        { path: "src/a.ts", before: "a\nb\n", after: "a\nB\nc\n", agents: ["Coder"], edits: 2 },
        { path: "src/new.ts", before: null, after: "x\n", agents: ["Helper"], edits: 1 },
      ],
    },
  });
});

describe("ChangesDialog", () => {
  it("lists the changed files with their line counts and shows a diff", async () => {
    render(<ChangesDialog onClose={() => {}} />);

    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("+2 −1")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    expect((await screen.findByTestId("diff")).textContent).toBe("a\nb\n|a\nB\nc\n");

    fireEvent.click(screen.getByText("src/new.ts"));
    expect((await screen.findByTestId("diff")).textContent).toBe("|x\n");
  });

  it("shows the diff in Monaco's dark theme, like the rest of the app", async () => {
    render(<ChangesDialog onClose={() => {}} />);

    expect((await screen.findByTestId("diff")).getAttribute("data-theme")).toBe("vs-dark");
  });

  it("reverts a file and drops it from the list", async () => {
    const written: Record<string, string> = {};
    mockInvokeHandler("read_workspace_file", () => "a\nB\nc\n");
    mockInvokeHandler("write_workspace_file", (args) => {
      const a = args as { relativePath: string; content: string };
      written[a.relativePath] = a.content;
    });
    mockInvokeHandler("write_audit_entry", () => undefined);
    render(<ChangesDialog onClose={() => {}} />);

    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]); });

    expect(written).toEqual({ "src/a.ts": "a\nb\n" });
    expect(useExecutionStore.getState().currentRun?.changes?.map((c) => c.path)).toEqual(["src/new.ts"]);
  });

  // The paths are relative to the folder the run worked in. Another folder open now has files of
  // its own under the same names, and would get this run's old content.
  describe("with another folder open than the one the run worked in", () => {
    const COMMANDS = ["read_workspace_file", "write_workspace_file", "delete_workspace_file", "write_audit_entry"];
    let calls: string[];

    beforeEach(() => {
      calls = [];
      for (const command of COMMANDS) mockInvokeHandler(command, () => { calls.push(command); return "a\nB\nc\n"; });
      useWorkspaceStore.setState({ workspacePath: "/ws-y" }); // the run worked in /ws
    });

    it("reverts nothing, and says where the changes were made", async () => {
      render(<ChangesDialog onClose={() => {}} />);

      await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]); });

      expect(calls).toEqual([]); // nothing was read, written or deleted
      expect(screen.getByText("These changes were made in /ws. Open that folder to revert them.")).toBeTruthy();
      expect(useExecutionStore.getState().currentRun?.changes?.map((c) => c.path)).toEqual(["src/a.ts", "src/new.ts"]);
    });

    it("does not revert all of them either", async () => {
      render(<ChangesDialog onClose={() => {}} />);

      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Revert all" })); });

      expect(calls).toEqual([]);
      expect(screen.getByText("These changes were made in /ws. Open that folder to revert them.")).toBeTruthy();
      expect(useExecutionStore.getState().currentRun?.changes).toHaveLength(2);
    });

    it("still shows the diffs", async () => {
      render(<ChangesDialog onClose={() => {}} />);

      expect((await screen.findByTestId("diff")).textContent).toBe("a\nb\n|a\nB\nc\n");
      fireEvent.click(screen.getByText("src/new.ts"));
      expect((await screen.findByTestId("diff")).textContent).toBe("|x\n");
    });

    it("reverts again once the run's own folder is open", async () => {
      const written: Record<string, string> = {};
      mockInvokeHandler("write_workspace_file", (args) => {
        const a = args as { workspacePath: string; relativePath: string; content: string };
        written[`${a.workspacePath}:${a.relativePath}`] = a.content;
      });
      render(<ChangesDialog onClose={() => {}} />);
      await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]); });
      expect(written).toEqual({});

      act(() => { useWorkspaceStore.setState({ workspacePath: "/ws" }); });
      await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]); });

      expect(written).toEqual({ "/ws:src/a.ts": "a\nb\n" });
    });
  });
});
