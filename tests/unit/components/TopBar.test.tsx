import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "@/components/layout/TopBar";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";

const noop = vi.fn();
const renderTopBar = () => render(
  <TopBar onOpenGenerate={noop} onOpenPalette={noop} onOpenExamples={noop}
    onOpenPermissions={noop} onRun={noop} onOpenSettings={noop} />,
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
});
