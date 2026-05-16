import { useState } from "react";
import { getSmoothStepPath, EdgeLabelRenderer, BaseEdge } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";

const EDGE_STYLES = {
  dataflow: { stroke: "rgba(255,255,255,0.28)", strokeWidth: 1.25, dash: "" },
  memory:   { stroke: "#b88bd9",                strokeWidth: 1.25, dash: "4 3" },
  control:  { stroke: "#9097a3",                strokeWidth: 1.0,  dash: "4 3" },
  feedback: { stroke: "#e07575",                strokeWidth: 1.5,  dash: "" },
} as const;

export function DataFlowEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, label, selected,
  style: _style, type,
}: EdgeProps) {
  const edgeType = (type as keyof typeof EDGE_STYLES | undefined) ?? "dataflow";
  const s = EDGE_STYLES[edgeType] ?? EDGE_STYLES.dataflow;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 12,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((label as string) ?? "");
  const updateEdgeLabel = useWorkflowStore((s) => s.updateEdgeLabel);

  const strokeColor = selected ? "#e5a142" : s.stroke;
  const markerId = `arr-${edgeType}${selected ? "-sel" : ""}`;

  function commitEdit() {
    updateEdgeLabel(id, draft);
    setEditing(false);
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: selected ? s.strokeWidth + 0.75 : s.strokeWidth,
          strokeDasharray: s.dash,
          markerEnd: `url(#${markerId})`,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            position: "absolute",
            pointerEvents: "all",
          }}
        >
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }}
              style={{
                width: 100, fontSize: 10,
                border: "1px solid var(--accent)", borderRadius: 3,
                padding: "2px 4px", background: "var(--surface-2)",
                color: "var(--text)", fontFamily: "inherit",
              }}
            />
          ) : (label || selected) ? (
            <div
              onDoubleClick={() => { setDraft((label as string) ?? ""); setEditing(true); }}
              style={{
                fontSize: 10,
                background: "#0e0f13",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 3,
                padding: "2px 6px",
                color: "#9097a3",
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                whiteSpace: "nowrap",
                cursor: "text",
              }}
            >
              {(label as string) || "(no label)"}
            </div>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Shared SVG <defs> block — rendered once in WorkflowCanvas. */
export function EdgeDefs() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }}>
      <defs>
        {/* data-flow */}
        <marker id="arr-dataflow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="rgba(255,255,255,0.3)"/>
        </marker>
        {/* memory */}
        <marker id="arr-memory" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#b88bd9"/>
        </marker>
        {/* control */}
        <marker id="arr-control" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#9097a3"/>
        </marker>
        {/* feedback */}
        <marker id="arr-feedback" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#e07575"/>
        </marker>
        {/* selected */}
        <marker id="arr-dataflow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#e5a142"/>
        </marker>
        <marker id="arr-memory-sel"   viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#e5a142"/>
        </marker>
        <marker id="arr-control-sel"  viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#e5a142"/>
        </marker>
        <marker id="arr-feedback-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#e5a142"/>
        </marker>
      </defs>
    </svg>
  );
}
