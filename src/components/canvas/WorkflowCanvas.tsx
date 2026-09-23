import { useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import { EmptyCanvasHero } from "./EmptyCanvasHero";
import "@xyflow/react/dist/style.css";
import { useWorkflowStore } from "@/store/workflowStore";
import { useUIStore } from "@/store/uiStore";
import { OrchestratorNode } from "@/components/nodes/OrchestratorNode";
import { WorkerNode }       from "@/components/nodes/WorkerNode";
import { CriticNode }       from "@/components/nodes/CriticNode";
import { ToolCallerNode }   from "@/components/nodes/ToolCallerNode";
import { MemoryNode }       from "@/components/nodes/MemoryNode";
import { GatewayNode }      from "@/components/nodes/GatewayNode";
import { HookNode }         from "@/components/nodes/HookNode";
import { AggregatorNode }   from "@/components/nodes/AggregatorNode";
import { DataFlowEdge, EdgeDefs } from "./edges/DataFlowEdge";
import { AgentRole } from "@/types/agent";
import { MINIMAP_COLORS } from "@/utils/nodeColors";
import type { AgentNode } from "@/types/workflow";
import type { NodeChange, EdgeChange, Connection, Node } from "@xyflow/react";

const nodeTypes: NodeTypes = {
  orchestrator: OrchestratorNode,
  worker:       WorkerNode,
  critic:       CriticNode,
  tool_caller:  ToolCallerNode,
  memory:       MemoryNode,
  gateway:      GatewayNode,
  hook:         HookNode,
  aggregator:   AggregatorNode,
};

const edgeTypes: EdgeTypes = {
  dataflow: DataFlowEdge,
  memory:   DataFlowEdge,
  control:  DataFlowEdge,
  feedback: DataFlowEdge,
};

export function WorkflowCanvas() {
  const nodes          = useWorkflowStore((s) => s.nodes);
  const edges          = useWorkflowStore((s) => s.edges);
  const onNodesChange  = useWorkflowStore((s) => s.onNodesChange);
  const onEdgesChange  = useWorkflowStore((s) => s.onEdgesChange);
  const onConnect      = useWorkflowStore((s) => s.onConnect);
  const selectNode     = useUIStore((s) => s.selectNode);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => onNodesChange(changes as NodeChange<AgentNode>[]),
    [onNodesChange]
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => onEdgesChange(changes),
    [onEdgesChange]
  );
  const handleConnect = useCallback(
    (connection: Connection) => onConnect(connection),
    [onConnect]
  );
  const handlePaneClick = useCallback(() => selectNode(null), [selectNode]);
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => selectNode(node.id),
    [selectNode]
  );

  const isEmpty = nodes.length === 0;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {isEmpty && <EmptyCanvasHero />}
      <EdgeDefs />
      <ReactFlow
        nodes={nodes.map((n) => ({
          ...n,
          type: n.data.role,
          selected: n.id === selectedNodeId,
        }))}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneClick={handlePaneClick}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        deleteKeyCode="Delete"
        minZoom={0.15}
        maxZoom={2}
        defaultEdgeOptions={{ type: "dataflow" }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="rgba(255,255,255,0.04)"
          style={{ background: "#0e0f13" }}
        />
        <Controls showInteractive={false} />
        {!isEmpty && (
          <MiniMap
            nodeColor={(node) => {
              const data = node.data as { role: AgentRole; status?: string };
              if (data.status === "running") return "rgba(229,161,66,0.8)";
              if (data.status === "done")    return "rgba(95,191,127,0.7)";
              if (data.status === "error")   return "rgba(224,117,117,0.7)";
              return MINIMAP_COLORS[data.role] ?? "#5d6473";
            }}
            nodeStrokeWidth={0}
            zoomable
            pannable
          />
        )}
      </ReactFlow>
    </div>
  );
}
