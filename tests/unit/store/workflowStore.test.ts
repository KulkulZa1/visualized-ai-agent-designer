import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore, makeDefaultAgentNode } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";
import type { Edge } from "@xyflow/react";

beforeEach(() => {
  useWorkflowStore.getState().reset();
});

describe("workflowStore", () => {
  it("starts clean with no nodes or edges", () => {
    const { nodes, edges, isDirty } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(isDirty).toBe(false);
  });

  it("addNode sets isDirty and increases node count", () => {
    const node = makeDefaultAgentNode("n1", AgentRole.Orchestrator, { x: 0, y: 0 });
    useWorkflowStore.getState().addNode(node);
    const { nodes, isDirty } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(1);
    expect(isDirty).toBe(true);
  });

  it("removeNode deletes node and connected edges", () => {
    const store = useWorkflowStore.getState();
    store.addNode(makeDefaultAgentNode("n1", AgentRole.Orchestrator, { x: 0, y: 0 }));
    store.addNode(makeDefaultAgentNode("n2", AgentRole.Worker, { x: 200, y: 0 }));
    store.onConnect({ source: "n1", target: "n2", sourceHandle: null, targetHandle: null });
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
    useWorkflowStore.getState().removeNode("n1");
    const { nodes, edges } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });

  it("updateNodeData mutates node data and sets isDirty", () => {
    const store = useWorkflowStore.getState();
    store.addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    store.markClean("/test/workflow.yaml");
    expect(useWorkflowStore.getState().isDirty).toBe(false);
    useWorkflowStore.getState().updateNodeData("n1", { name: "My Worker" });
    const { nodes, isDirty } = useWorkflowStore.getState();
    expect(nodes[0].data.name).toBe("My Worker");
    expect(isDirty).toBe(true);
  });

  it("markClean clears isDirty and sets filePath", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    useWorkflowStore.getState().markClean("/some/path.yaml");
    const { isDirty, filePath } = useWorkflowStore.getState();
    expect(isDirty).toBe(false);
    expect(filePath).toBe("/some/path.yaml");
  });

  it("loadWorkflow replaces state and clears dirty flag", () => {
    useWorkflowStore.getState().addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);

    useWorkflowStore.getState().loadWorkflow({
      meta: { name: "Loaded", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
      agents: [],
      connections: [],
      executionSettings: { maxParallel: 2, timeoutSeconds: 60, retryOnFailure: false, maxRetries: 0 },
      nodePositions: {},
    });

    const { nodes, isDirty } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(0);
    expect(isDirty).toBe(false);
  });

  it("loadWorkflow preserves connection label and kind in edge data", () => {
    useWorkflowStore.getState().loadWorkflow({
      meta: { name: "Loaded", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
      agents: [
        makeDefaultAgentNode("a", AgentRole.Gateway, { x: 0, y: 0 }).data,
        makeDefaultAgentNode("b", AgentRole.Worker, { x: 200, y: 0 }).data,
      ],
      connections: [{
        id: "edge-1",
        sourceAgentId: "agent-0",
        targetAgentId: "agent-1",
        label: "approved",
        edgeKind: "control",
      }],
      executionSettings: { maxParallel: 2, timeoutSeconds: 60, retryOnFailure: false, maxRetries: 0 },
      nodePositions: {},
    });

    const edge = useWorkflowStore.getState().edges[0];
    expect(edge.label).toBe("approved");
    expect(edge.type).toBe("control");
    expect(edge.data).toEqual({ label: "approved", edgeKind: "control" });
  });

  it("toWorkflowDef serializes current state", () => {
    const store = useWorkflowStore.getState();
    store.addNode(makeDefaultAgentNode("n1", AgentRole.Orchestrator, { x: 10, y: 20 }));
    const def = store.toWorkflowDef();
    expect(def.agents).toHaveLength(1);
    expect(def.nodePositions["n1"]).toEqual({ x: 10, y: 20 });
  });

  it("toWorkflowDef serializes label and kind from edge data", () => {
    const store = useWorkflowStore.getState();
    store.addNode(makeDefaultAgentNode("n1", AgentRole.Gateway, { x: 0, y: 0 }));
    store.addNode(makeDefaultAgentNode("n2", AgentRole.Worker, { x: 200, y: 0 }));
    useWorkflowStore.setState({
      edges: [{
        id: "edge-1",
        source: "n1",
        target: "n2",
        data: { label: "approved", edgeKind: "feedback" },
      } as Edge],
    });

    const def = useWorkflowStore.getState().toWorkflowDef();

    expect(def.connections[0]).toMatchObject({
      id: "edge-1",
      sourceAgentId: "n1",
      targetAgentId: "n2",
      label: "approved",
      edgeKind: "feedback",
    });
  });

  describe("updateEdgeLabel", () => {
    it("updates label of an existing edge and sets isDirty", () => {
      const store = useWorkflowStore.getState();
      store.addNode(makeDefaultAgentNode("n1", AgentRole.Orchestrator, { x: 0, y: 0 }));
      store.addNode(makeDefaultAgentNode("n2", AgentRole.Worker, { x: 200, y: 0 }));
      store.onConnect({ source: "n1", target: "n2", sourceHandle: null, targetHandle: null });
      store.markClean("/test/workflow.yaml");

      const edgeId = useWorkflowStore.getState().edges[0].id;
      useWorkflowStore.getState().updateEdgeLabel(edgeId, "my-label");

      const { edges, isDirty } = useWorkflowStore.getState();
      expect(edges[0].label).toBe("my-label");
      expect(isDirty).toBe(true);
    });

    it("is a no-op when edge id does not exist", () => {
      const store = useWorkflowStore.getState();
      store.addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
      expect(() => store.updateEdgeLabel("nonexistent", "label")).not.toThrow();
    });
  });

  describe("duplicateNode", () => {
    it("creates a new node with offset position and (copy) name", () => {
      const store = useWorkflowStore.getState();
      store.addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 100, y: 200 }));
      store.duplicateNode("n1");
      const { nodes } = useWorkflowStore.getState();
      expect(nodes).toHaveLength(2);
      const copy = nodes[1];
      expect(copy.data.name).toBe("Worker (copy)");
      expect(copy.position.x).toBe(140);
      expect(copy.position.y).toBe(240);
    });

    it("resets tokens.used to 0 on duplicate", () => {
      const store = useWorkflowStore.getState();
      const node = makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 });
      node.data.tokens = { used: 500, budget: 40000 };
      store.addNode(node);
      store.duplicateNode("n1");
      const { nodes } = useWorkflowStore.getState();
      const copy = nodes[1];
      expect(copy.data.tokens.used).toBe(0);
      expect(copy.data.tokens.budget).toBe(40000);
    });

    it("is a no-op when nodeId does not exist", () => {
      const store = useWorkflowStore.getState();
      store.addNode(makeDefaultAgentNode("n1", AgentRole.Worker, { x: 0, y: 0 }));
      expect(() => store.duplicateNode("nonexistent")).not.toThrow();
      expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    });
  });
});
