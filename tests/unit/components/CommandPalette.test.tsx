import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { CanvasToolbar } from "@/components/canvas/CanvasToolbar";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useUIStore } from "@/store/uiStore";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";

function Shortcuts() {
  useKeyboardShortcuts();
  return null;
}

// Like the app: closing unmounts the palette (and its focused search input).
function PaletteHost() {
  const [open, setOpen] = useState(true);
  return open
    ? <CommandPalette onClose={() => setOpen(false)} onOpenGenerate={vi.fn()} onOpenPermissions={vi.fn()} />
    : null;
}

const openPalette = () => render(
  <ReactFlowProvider>
    <Shortcuts />
    <CanvasToolbar />
    <PaletteHost />
  </ReactFlowProvider>,
);

beforeEach(() => {
  useWorkspaceStore.setState({ workspacePath: "/ws" });
  useUIStore.setState({ openEditorTabs: [], activeEditorPath: null });
  useWorkflowStore.getState().reset();
  useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
  useWorkflowStore.getState().updateMeta({ name: "My Flow" });
});

describe("CommandPalette actions", () => {
  it("'Save workflow' actually saves", async () => {
    const saved: string[] = [];
    mockInvokeHandler("save_workflow", (args) => {
      saved.push((args as { relativePath: string }).relativePath);
      return undefined;
    });
    openPalette();

    await act(async () => {
      fireEvent.click(screen.getByText("Save workflow"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(saved).toEqual(["my-flow.harness.yaml"]);
  });

  it("'Validate graph' shows the validation results", async () => {
    openPalette();

    await act(async () => {
      fireEvent.click(screen.getByText("Validate graph"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText("Workflow Validation")).toBeTruthy();
  });

  it("'Open CLAUDE.md' opens the file in the editor", () => {
    openPalette();

    act(() => { fireEvent.click(screen.getByText("Open CLAUDE.md")); });

    expect(useUIStore.getState().activeEditorPath).toBe("CLAUDE.md");
  });

  it("labels shortcuts with Ctrl outside macOS", () => {
    openPalette();

    expect(screen.getByText("Ctrl+S")).toBeTruthy();
    expect(screen.queryByText(/⌘/)).toBeNull();
  });
});

describe("canvas shortcuts", () => {
  it("Ctrl+. does not validate (open a modal) while the user is typing in a field", () => {
    render(
      <ReactFlowProvider>
        <input data-testid="field" />
        <CanvasToolbar />
      </ReactFlowProvider>,
    );
    screen.getByTestId("field").focus();

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true })); });

    expect(screen.queryByText("Workflow Validation")).toBeNull();
  });
});
