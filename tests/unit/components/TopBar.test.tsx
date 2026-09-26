import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "@/components/layout/TopBar";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";

const noop = vi.fn();
const renderTopBar = () => render(
  <TopBar onOpenGenerate={noop} onOpenPalette={noop} onOpenExamples={noop}
    onOpenPermissions={noop} onRun={noop} onOpenSettings={noop} onOpenWizard={noop} />,
);

beforeEach(() => {
  useWorkflowStore.getState().reset();
});

describe("TopBar", () => {
  it("reports an invalid workflow instead of a hard-coded 'valid' badge", () => {
    const store = useWorkflowStore.getState();
    store.addNode(makeDefaultAgentNode("a", AgentRole.Worker, { x: 0, y: 0 }));
    store.addNode(makeDefaultAgentNode("b", AgentRole.Critic, { x: 200, y: 0 }));
    store.onConnect({ source: "a", target: "b", sourceHandle: null, targetHandle: null });
    store.onConnect({ source: "b", target: "a", sourceHandle: null, targetHandle: null }); // cycle

    renderTopBar();

    expect(screen.getByText(/invalid/)).toBeTruthy();
  });

  // The window can be 1,024 px wide (tauri.conf.json minWidth): the bar must fit it.
  describe("in a narrow window", () => {
    it("never shrinks Save and Run", () => {
      renderTopBar();

      expect(screen.getByText("Save").closest("button")?.style.flexShrink).toBe("0");
      expect(screen.getByText("Run").closest("button")?.style.flexShrink).toBe("0");
    });

    it("can hide the secondary buttons' labels, which their titles repeat", () => {
      renderTopBar();

      for (const label of ["Create from Goal", "Examples", "Generate", "Permissions"]) {
        expect(screen.getByText(label).className).toBe("topbar-label");
      }
    });

    it("has no development phase badge", () => {
      renderTopBar();

      expect(screen.queryByText(/Phase 5/)).toBeNull();
    });
  });

  it("labels the command palette shortcut with Ctrl outside macOS", () => {
    renderTopBar();

    expect(screen.getByText("Ctrl+K")).toBeTruthy();
    expect(screen.queryByText(/⌘/)).toBeNull();
  });
});
