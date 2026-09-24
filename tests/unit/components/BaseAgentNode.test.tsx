import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { BaseAgentNode } from "@/components/nodes/BaseAgentNode";
import { makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole, type AgentNodeData } from "@/types/agent";

function renderNode(status: AgentNodeData["status"]) {
  const node = makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 });
  const props = {
    id: "n1", type: "worker", data: { ...node.data, status }, selected: false, dragging: false,
    zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
    draggable: true, selectable: true, deletable: true,
  } as unknown as NodeProps;
  return render(<ReactFlowProvider><BaseAgentNode {...props} /></ReactFlowProvider>);
}

describe("BaseAgentNode", () => {
  it("shows a node stopped by the run as stopped, with a grey left accent", () => {
    const { getByText, container } = renderNode("stopped");
    expect(getByText("stopped")).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).style.borderLeft).toMatch(/^3px solid/);
  });

  it("keeps an idle node's plain border", () => {
    const { getByText, container } = renderNode("idle");
    expect(getByText("idle")).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).style.borderLeft).toMatch(/^1px solid/);
  });
});
