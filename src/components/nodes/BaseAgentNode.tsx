import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { AgentNodeData } from "@/types/agent";
import { ROLE_META, STATUS_COLORS } from "@/utils/nodeColors";
import { NodeIcon } from "./NodeIcon";

// Design system constants (inline — no Tailwind dependency for nodes)
const SURFACE2 = "#1c1f26";
const SURFACE3 = "#23262f";
const BORDER   = "rgba(255,255,255,0.06)";
const TEXT     = "#e6e7eb";
const MUTED    = "#9097a3";
const HINT     = "#5d6473";
const MONO     = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';
const SANS     = '-apple-system, "Inter", BlinkMacSystemFont, system-ui, sans-serif';

const ACCENT   = "#e5a142";
const GREEN    = "#5fbf7f";
const RED      = "#e07575";
const ORANGE   = "#d97757";

export const BaseAgentNode = memo(function BaseAgentNode({ data, selected }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const meta   = ROLE_META[d.role];
  const status = STATUS_COLORS[d.status ?? "idle"] ?? STATUS_COLORS.idle;
  const pct    = d.tokens.budget > 0 ? d.tokens.used / d.tokens.budget : 0;
  const barColor = pct > 0.8 ? RED : pct > 0.5 ? ACCENT : GREEN;
  const isRunning = d.status === "running";

  return (
    <div
      style={{
        width: 240,
        background: SURFACE2,
        border: `1px solid ${selected ? ACCENT : BORDER}`,
        borderRadius: 8,
        borderLeft: d.status === "running" ? `3px solid ${ACCENT}` :
                    d.status === "done"    ? `3px solid ${GREEN}` :
                    d.status === "error"   ? `3px solid ${RED}` :
                    d.status === "stopped" ? `3px solid ${MUTED}` :
                    `1px solid ${selected ? ACCENT : BORDER}`,
        boxShadow: selected
          ? `0 0 0 3px rgba(229,161,66,0.18), 0 12px 32px rgba(0,0,0,0.5)`
          : d.status === "running"
          ? `0 0 12px rgba(229,161,66,0.2), 0 6px 18px rgba(0,0,0,0.35)`
          : "0 6px 18px rgba(0,0,0,0.35)",
        transition: "border-color 120ms, box-shadow 120ms, border-left 120ms",
        fontFamily: SANS,
        fontSize: 13,
        color: TEXT,
        userSelect: "none",
        position: "relative",
      }}
    >
      {/* Left port */}
      <Handle type="target" position={Position.Left}
        style={{ left: -5, top: 54, width: 10, height: 10, borderRadius: "50%",
          background: "#0e0f13", border: `2px solid ${meta.tint}`, zIndex: 1 }}/>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8,
        padding: "10px 12px 8px", borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ width: 22, height: 22, borderRadius: 5, background: meta.bgAlpha,
          color: meta.tint, display: "grid", placeItems: "center", flexShrink: 0 }}>
          <NodeIcon name={meta.icon} size={12} color={meta.tint}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name || "Unnamed"}</div>
          <div style={{ fontSize: 10, color: HINT, fontFamily: MONO,
            letterSpacing: "0.04em", textTransform: "uppercase" }}>{meta.label}</div>
        </div>
        {/* Status dot */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: status.dot, flexShrink: 0 }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%", background: status.dot,
            boxShadow: isRunning ? `0 0 8px ${status.dot}` : "none",
            animation: isRunning ? "pulse-running 1.4s infinite" : "none",
          }}/>
          {status.label}
        </div>
      </div>

      {/* Prompt preview — 3-line clamp, monospace */}
      {d.promptSource.type === "inline" && d.promptSource.content && (
        <div style={{ padding: "8px 12px 6px", fontSize: 11, lineHeight: 1.45,
          color: MUTED, fontFamily: MONO,
          display: "-webkit-box", WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical", overflow: "hidden",
          height: 50 }}>
          {d.promptSource.content}
        </div>
      )}
      {d.promptSource.type === "file" && (
        <div style={{ padding: "8px 12px 6px", fontSize: 11, color: HINT, fontFamily: MONO }}>
          📄 {d.promptSource.path || "no file set"}
        </div>
      )}

      {/* Footer: model (+ fallback) + tools */}
      <div style={{ padding: "6px 12px 8px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {d.model
            ? <div style={{ fontSize: 10, color: MUTED, display: "inline-flex", alignItems: "center",
                gap: 3, fontFamily: MONO }}>
                <NodeIcon name="cpu" size={10} color={MUTED}/>{d.model}
              </div>
            : <div style={{ fontSize: 10, color: HINT, fontFamily: MONO }}>no model</div>
          }
          {/* Fallback model badge */}
          {d.fallback?.model && (
            <div style={{ fontSize: 9, display: "inline-flex", alignItems: "center", gap: 3,
              fontFamily: MONO, color: "#7c9eff", opacity: 0.85 }}>
              <span style={{ fontSize: 8 }}>↳</span>
              {d.fallback.model}
              <span style={{ fontSize: 8, padding: "0 3px", borderRadius: 2,
                background: "rgba(124,158,255,0.12)", color: "#7c9eff" }}>
                {d.fallback.trigger === "rate_limit" ? "RL" :
                 d.fallback.trigger === "timeout" ? "TO" : "ERR"}
              </span>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {d.tools.slice(0, 3).map((t, i) => (
            <span key={i} style={{ fontSize: 9, padding: "2px 5px", borderRadius: 3,
              background: SURFACE3, color: MUTED, fontFamily: MONO }}>{t}</span>
          ))}
          {d.tools.length > 3 && (
            <span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 3,
              background: SURFACE3, color: HINT }}>+{d.tools.length - 3}</span>
          )}
        </div>
      </div>

      {/* Token budget bar */}
      {d.tokens.budget > 0 && (
        <div style={{ padding: "0 12px 8px", display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ flex: 1, height: 3, background: SURFACE3, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, pct * 100)}%`,
              background: barColor, transition: "width 300ms" }}/>
          </div>
          <span style={{ fontSize: 9, color: HINT, fontFamily: MONO, minWidth: 72, textAlign: "right" }}>
            {(d.tokens.used / 1000).toFixed(1)}k / {(d.tokens.budget / 1000).toFixed(0)}k
          </span>
        </div>
      )}

      {/* Hook chips */}
      {(d.preHook || d.postHook) && (
        <div style={{ padding: "0 10px 10px", display: "flex", gap: 4, flexWrap: "wrap" }}>
          {d.preHook && (
            <span style={{ fontSize: 9, padding: "2px 6px 2px 4px", borderRadius: 99,
              background: "rgba(217,119,87,0.12)", color: ORANGE,
              display: "inline-flex", alignItems: "center", gap: 3, fontFamily: MONO }}>
              <NodeIcon name="shield" size={9} color={ORANGE}/>
              {d.preHook.path.split("/").at(-1) ?? d.preHook.path}
            </span>
          )}
          {d.postHook && (
            <span style={{ fontSize: 9, padding: "2px 6px 2px 4px", borderRadius: 99,
              background: "rgba(217,119,87,0.12)", color: ORANGE,
              display: "inline-flex", alignItems: "center", gap: 3, fontFamily: MONO }}>
              <NodeIcon name="shield" size={9} color={ORANGE}/>
              {d.postHook.path.split("/").at(-1) ?? d.postHook.path}
            </span>
          )}
        </div>
      )}

      {/* Comment/annotation */}
      {d.comment && (
        <div style={{
          padding: "4px 12px 6px",
          fontSize: 10, fontStyle: "italic",
          color: "var(--accent)", lineHeight: 1.4,
          borderTop: `1px solid rgba(229,161,66,0.15)`,
          background: "rgba(229,161,66,0.04)",
        }}>
          {d.comment.slice(0, 100)}{d.comment.length > 100 ? "…" : ""}
        </div>
      )}

      {/* Gateway condition badge */}
      {d.condition && (
        <div style={{ padding: "0 10px 10px" }}>
          <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3,
            background: "rgba(124,158,255,0.12)", color: "#7c9eff", fontFamily: MONO }}>
            if {d.condition}
          </span>
        </div>
      )}

      {/* Right port */}
      <Handle type="source" position={Position.Right}
        style={{ right: -5, top: 54, width: 10, height: 10, borderRadius: "50%",
          background: "#0e0f13", border: `2px solid ${meta.tint}`, zIndex: 1 }}/>
    </div>
  );
});
