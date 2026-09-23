import { useReactFlow } from "@xyflow/react";
import { AgentRole } from "@/types/agent";
import { ROLE_META } from "@/utils/nodeColors";
import { useWorkflowStore, makeDefaultAgentNode, nextNodeId } from "@/store/workflowStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { applyDagreLayout } from "@/utils/autoLayout";
import { validateWorkflow } from "@/utils/validateWorkflow";
import { ValidationPanel } from "./ValidationPanel";
import type { ValidationResult } from "@/types/workflow";
import { useEffect, useState } from "react";

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
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [showPanel,  setShowPanel]  = useState(false);

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
    setValidation(result);
    // Always open the panel — valid shows success, errors/warnings show details
    setShowPanel(true);
  }

  // Ctrl+L auto-layout and Ctrl+. validate (also sent by the command palette).
  // Re-subscribed each render so the handlers see the current graph.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "");
      if (typing) return;
      if (e.key.toLowerCase() === "l") { e.preventDefault(); handleLayout(); }
      else if (e.key === ".") { e.preventDefault(); handleValidate(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const errorCount   = validation ? validation.errors.length : 0;
  const warningCount = validation ? validation.warnings.length : 0;
  const stateColor   = validation
    ? (errorCount > 0 ? "var(--red)" : warningCount > 0 ? "var(--accent)" : "var(--green)")
    : "var(--muted)";
  const badgeLabel   = validation
    ? (errorCount > 0
        ? `✕ ${errorCount} error${errorCount !== 1 ? "s" : ""}`
        : warningCount > 0
          ? `⚠ ${warningCount} issue${warningCount !== 1 ? "s" : ""}`
          : "✓ valid")
    : null;

  return (
    <>
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

        {/* Validation result badge — clickable to reopen the panel */}
        {badgeLabel && (
          <button
            onClick={() => setShowPanel(true)}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "2px 8px", borderRadius: 4, marginRight: 4,
              border: `1px solid ${stateColor}22`,
              background: `${stateColor}11`,
              cursor: "pointer", fontSize: 11, color: stateColor,
              fontFamily: "inherit",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: stateColor, flexShrink: 0 }}/>
            {badgeLabel}
          </button>
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

      {/* Validation details modal */}
      {showPanel && validation && (
        <ValidationPanel
          result={validation}
          onClose={() => setShowPanel(false)}
        />
      )}
    </>
  );
}
