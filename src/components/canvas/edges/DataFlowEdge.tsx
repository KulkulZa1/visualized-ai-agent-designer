import { getSmoothStepPath, EdgeLabelRenderer, BaseEdge } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

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

  const strokeColor = selected ? "#e5a142" : s.stroke;
  const markerId = `arr-${edgeType}${selected ? "-sel" : ""}`;

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
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              position: "absolute",
              pointerEvents: "all",
              fontSize: 10,
              background: "#0e0f13",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 3,
              padding: "2px 6px",
              color: "#9097a3",
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              whiteSpace: "nowrap",
            }}
          >
            {label as string}
          </div>
        </EdgeLabelRenderer>
      )}
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
