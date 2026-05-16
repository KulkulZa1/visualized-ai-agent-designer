import { useReactFlow } from "@xyflow/react";
import { AgentRole } from "@/types/agent";
import { ROLE_META } from "@/utils/nodeColors";
import { useWorkflowStore, makeDefaultAgentNode, nextNodeId } from "@/store/workflowStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { applyDagreLayout } from "@/utils/autoLayout";
import { validateWorkflow } from "@/utils/validateWorkflow";
import { useState } from "react";

const TOOLBAR_ROLES: AgentRole[] = [
  AgentRole.Orchestrator,
  AgentRole.Gateway,
  AgentRole.Worker,
  AgentRole.Critic,
  AgentRole.Memory,
  AgentRole.Hook,
  AgentRole.Aggregator,
  AgentRole.ToolCaller,
];

export function CanvasToolbar() {
  const addNode   = useWorkflowStore((s) => s.addNode);
  const nodes     = useWorkflowStore((s) => s.nodes);
  const edges     = useWorkflowStore((s) => s.edges);
  const { setNodes, fitView } = useReactFlow();
  const [validation, setValidation] = useState<{ valid: boolean; count: number } | null>(null);

  function handleAdd(role: AgentRole) {
    const col = nodes.length % 4;
    const row = Math.floor(nodes.length / 4);
    addNode(makeDefaultAgentNode(nextNodeId(), role, { x: 100 + col * 300, y: 100 + row * 240 }));
  }

  function handleLayout() {
    const laid = applyDagreLayout(nodes, edges, "LR");
    setNodes(laid.map((n) => ({ ...n, type: n.data.role })));
    setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 50);
  }

  function handleValidate() {
    const result = validateWorkflow(nodes, edges);
    setValidation({ valid: result.valid, count: result.errors.length + result.warnings.length });
    setTimeout(() => setValidation(null), 4000);
  }

  const stateColor = validation
    ? validation.valid ? "var(--green)" : "var(--red)"
    : "var(--muted)";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      padding: "5px 12px", background: "var(--surface)",
      borderBottom: "1px solid var(--border)", flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, color: "var(--hint)", marginRight: 4 }}>Add:</span>

      {TOOLBAR_ROLES.map((role) => {
        const meta = ROLE_META[role];
        return (
          <button key={role} onClick={() => handleAdd(role)} title={`Add ${meta.label}`} style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "3px 9px", borderRadius: 5, border: "1px dashed var(--border-md)",
            background: "transparent", cursor: "pointer", fontFamily: "inherit",
            fontSize: 11, color: "var(--muted)", transition: "all 120ms",
          }}
          onMouseEnter={(e) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.style.borderColor = meta.tint;
            b.style.color = meta.tint;
            b.style.background = meta.bgAlpha;
          }}
          onMouseLeave={(e) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.style.borderColor = "var(--border-md)";
            b.style.color = "var(--muted)";
            b.style.background = "transparent";
          }}>
            <span style={{ fontSize: 12 }}>{meta.glyph}</span>
            {meta.label}
          </button>
        );
      })}

      <div style={{ flex: 1 }}/>

      {/* Validation indicator */}
      {validation && (
        <span style={{ fontSize: 11, color: stateColor, marginRight: 6,
          display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: stateColor }}/>
          {validation.valid
            ? "valid"
            : `${validation.count} issue${validation.count !== 1 ? "s" : ""}`}
        </span>
      )}

      <button title="Validate graph (Ctrl+.)" onClick={handleValidate} style={{
        padding: "3px 9px", borderRadius: 5, border: "1px solid var(--border)",
        background: "transparent", cursor: "pointer", fontSize: 11,
        color: "var(--muted)", fontFamily: "inherit",
        display: "flex", alignItems: "center", gap: 5,
      }}>
        <NodeIcon name="check" size={12}/> Validate
      </button>

      <button title="Auto-layout (Ctrl+L)" onClick={handleLayout} style={{
        padding: "3px 9px", borderRadius: 5, border: "1px solid var(--border)",
        background: "transparent", cursor: "pointer", fontSize: 11,
        color: "var(--muted)", fontFamily: "inherit",
        display: "flex", alignItems: "center", gap: 5,
      }}>
        <NodeIcon name="grid" size={12}/> Auto-layout
      </button>
    </div>
  );
}
