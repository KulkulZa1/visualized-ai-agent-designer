import { NodeIcon } from "@/components/nodes/NodeIcon";
import { ToolPermission, TOOL_RISK } from "@/types/agent";
import { useWorkflowStore } from "@/store/workflowStore";
import { ROLE_META } from "@/utils/nodeColors";
import { buildPermissionMatrix, getPermissionSummary } from "@/utils/permissionMatrix";
import type { CSSProperties } from "react";

interface PermissionMatrixProps {
  onClose: () => void;
}

const ALL_TOOLS = Object.values(ToolPermission);
const RISK_COLOR = { low: "var(--green)", medium: "var(--accent)", high: "var(--red)" };

const TOOL_DESCRIPTIONS: Partial<Record<ToolPermission, string>> = {
  [ToolPermission.WriteFile]: "Write and edit files in the workspace (fs.write and edit_file). Agents with this tool can modify any workspace file.",
  [ToolPermission.FsAppend]: "Append to files in the workspace.",
  [ToolPermission.Bash]: "Run shell commands in the workspace. You approve each command (once, or for the rest of the run) before it runs.",
  [ToolPermission.SubagentDispatch]: "Spawn subagents — high blast radius. Requires audit trail.",
  [ToolPermission.Git]: "Run git commands in the workspace.",
  [ToolPermission.Test]: "Run test suites and report results.",
  [ToolPermission.WebFetch]: "Fetch content from URLs.",
};
const MONO = '"JetBrains Mono", ui-monospace, monospace';

export function PermissionMatrix({ onClose }: PermissionMatrixProps) {
  const nodes = useWorkflowStore((s) => s.nodes);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const rows = buildPermissionMatrix(nodes.map((node) => node.data));
  const summary = getPermissionSummary(nodes.map((node) => node.data));

  const toggleTool = (nodeId: string, tool: ToolPermission) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const tools = node.data.tools.includes(tool)
      ? node.data.tools.filter((item) => item !== tool)
      : [...node.data.tools, tool];
    updateNodeData(nodeId, { tools });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.62)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-start",
      justifyContent: "center", paddingTop: 48, zIndex: 260, fontFamily: "inherit",
    }} onClick={onClose}>
      <div style={{
        width: "min(1180px, calc(100vw - 48px))",
        maxHeight: "84vh", overflow: "hidden", display: "flex", flexDirection: "column",
        background: "var(--surface-2)", border: "1px solid var(--border-md)",
        borderRadius: 10, boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
      }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px",
          borderBottom: "1px solid var(--border)" }}>
          <NodeIcon name="shield" size={16} color="var(--orange)" />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Permission Matrix</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              Node by tool grants, risk level, and hook gate coverage.
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {([
            ["nodes", summary.nodeCount],
            ["grants", summary.grantedCount],
            ["high risk", summary.highRiskNodeCount],
            ["ungated", summary.ungatedHighRiskNodeCount],
          ] as const).map(([label, value]) => (
            <div key={label} style={{ padding: "4px 8px", borderRadius: 5,
              background: "var(--surface-3)", border: "1px solid var(--border)", minWidth: 72 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: label === "ungated" && value ? "var(--red)" : "var(--text)" }}>
                {value}
              </div>
              <div style={{ fontSize: 9, color: "var(--hint)", textTransform: "uppercase" }}>{label}</div>
            </div>
          ))}
          <button onClick={onClose} style={{ width: 28, height: 28, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer", display: "grid", placeItems: "center" }}>
            <NodeIcon name="x" size={14} />
          </button>
        </div>

        {(() => {
          const bashNodes = nodes.filter((n) => n.data.tools.includes(ToolPermission.Bash));
          if (bashNodes.length === 0) return null;
          return (
            <div style={{ margin: "8px 12px 0", padding: "7px 10px", borderRadius: 6,
              background: "rgba(224,117,117,0.12)", border: "1px solid rgba(224,117,117,0.35)",
              fontSize: 11, color: "var(--red)", display: "flex", gap: 6, alignItems: "flex-start" }}>
              <NodeIcon name="alert-triangle" size={13} color="var(--red)" />
              <span>
                <strong>{bashNodes.length} node{bashNodes.length > 1 ? "s list" : " lists"} the bash tool:</strong>{" "}
                {bashNodes.map((n) => n.data.name).join(", ")}.
                Each new command they want to run waits for your approval (once, or for the rest of the run) and then runs with your permissions (no sandbox).
              </span>
            </div>
          );
        })()}
        {nodes.length === 0 ? (
          <div style={{ padding: 24, color: "var(--hint)", fontSize: 12 }}>
            Load or create a workflow to inspect permissions.
          </div>
        ) : (
          <div style={{ overflow: "auto", padding: 12 }}>
            <table style={{ borderCollapse: "separate", borderSpacing: 0, minWidth: 1040, width: "100%" }}>
              <thead>
                <tr>
                  <th style={headCell({ left: 0, minWidth: 230 })}>Node</th>
                  <th style={headCell({ left: 230, minWidth: 126 })}>Gate</th>
                  {ALL_TOOLS.map((tool) => (
                    <th key={tool} title={TOOL_DESCRIPTIONS[tool] ? `${tool} — ${TOOL_DESCRIPTIONS[tool]}` : `${tool} (${TOOL_RISK[tool]})`} style={{
                      ...cellBase,
                      width: 38, minWidth: 38, maxWidth: 38, textAlign: "center",
                      color: RISK_COLOR[TOOL_RISK[tool]], fontSize: 9,
                      writingMode: "vertical-rl", transform: "rotate(180deg)", height: 120,
                    }}>
                      {tool}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {nodes.map((node, index) => {
                  const row = rows[index];
                  const meta = ROLE_META[node.data.role];
                  const needsGate = row.ungatedHighRiskTools.length > 0;
                  return (
                    <tr key={node.id}>
                      <td style={bodyCell({ left: 0, minWidth: 230 })}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <div style={{ width: 24, height: 24, borderRadius: 6, background: meta.bgAlpha,
                            color: meta.tint, display: "grid", placeItems: "center", flexShrink: 0 }}>
                            <NodeIcon name={meta.icon} size={13} color={meta.tint} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden",
                              textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.name}</div>
                            <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--hint)" }}>
                              {node.id} - {row.grantedCount} grants
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={bodyCell({ left: 230, minWidth: 126 })}>
                        {needsGate ? (
                          // Hooks on agent nodes are not run during workflow runs, so no
                          // hook can gate these tools; only removing the permission helps.
                          <span style={{ fontSize: 10, color: "var(--red)" }}
                            title="Hooks on agent nodes are not run during workflow runs; remove the permission to reduce risk.">
                            no runtime gate
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: row.hasHookGate ? "var(--green)" : "var(--hint)" }}>
                            {row.hasHookGate ? "gated" : "not needed"}
                          </span>
                        )}
                      </td>
                      {ALL_TOOLS.map((tool) => {
                        const on = node.data.tools.includes(tool);
                        const risk = TOOL_RISK[tool];
                        return (
                          <td key={tool} style={{ ...cellBase, textAlign: "center" }}>
                            <button
                              title={`${node.data.name}: ${tool}`}
                              onClick={() => toggleTool(node.id, tool)}
                              style={{
                                width: 22, height: 22, borderRadius: 5, cursor: "pointer",
                                border: `1px solid ${on ? RISK_COLOR[risk] : "var(--border)"}`,
                                background: on ? `${RISK_COLOR[risk]}26` : "transparent",
                                color: on ? RISK_COLOR[risk] : "var(--hint)",
                                display: "grid", placeItems: "center",
                              }}
                            >
                              {on && <NodeIcon name="check" size={12} color={RISK_COLOR[risk]} stroke={2.4} />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const cellBase: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  borderRight: "1px solid var(--border)",
  background: "var(--surface-2)",
  padding: 6,
};

function headCell(opts: { left: number; minWidth: number }): CSSProperties {
  return {
    ...cellBase,
    position: "sticky",
    top: 0,
    left: opts.left,
    zIndex: 4,
    minWidth: opts.minWidth,
    textAlign: "left",
    color: "var(--muted)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };
}

function bodyCell(opts: { left: number; minWidth: number }): CSSProperties {
  return {
    ...cellBase,
    position: "sticky",
    left: opts.left,
    zIndex: 3,
    minWidth: opts.minWidth,
    background: "var(--surface)",
  };
}
