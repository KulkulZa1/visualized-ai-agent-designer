import { ToolPermission, TOOL_RISK } from "@/types/agent";
import { useWorkflowStore } from "@/store/workflowStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { Sec } from "../shared";

const RISK_COLOR = { low: "var(--green)", medium: "var(--accent)", high: "var(--red)" };

const ALL_TOOLS = Object.values(ToolPermission);

export function ToolsTab({ nodeId }: { nodeId: string }) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const upd  = useWorkflowStore((s) => s.updateNodeData);
  if (!node) return null;
  const { tools } = node.data;

  const toggle = (t: ToolPermission) => {
    const next = tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t];
    upd(nodeId, { tools: next });
  };

  return (
    <div>
      <div style={{ marginBottom: 10, padding: "8px 10px",
        background: "rgba(217,119,87,0.07)", border: "1px solid rgba(217,119,87,0.2)",
        borderRadius: 5, fontSize: 11, color: "var(--orange)",
        display: "flex", gap: 8, alignItems: "flex-start" }}>
        <NodeIcon name="shield" size={13} style={{ marginTop: 1, flexShrink: 0 }}/>
        Grant only tools this node needs. Fewer permissions = smaller attack surface.
      </div>

      <Sec title={`Permitted tools · ${tools.length} / ${ALL_TOOLS.length}`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {ALL_TOOLS.map((t) => {
            const on   = tools.includes(t);
            const risk = TOOL_RISK[t] ?? "low";
            const rc   = RISK_COLOR[risk];
            return (
              <label key={t} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "5px 6px",
                borderRadius: 4, cursor: "pointer",
                background: on ? "var(--accent-soft)" : "transparent",
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                  background: on ? "var(--accent)" : "transparent",
                  border: `1px solid ${on ? "var(--accent)" : "var(--border-md)"}`,
                  display: "grid", placeItems: "center", color: "#1a1207",
                }}>
                  {on && <NodeIcon name="check" size={10} color="#1a1207" stroke={2.5}/>}
                </span>
                <input type="checkbox" checked={on} onChange={() => toggle(t)} style={{ display: "none" }}/>
                <span style={{ fontSize: 12, flex: 1, fontFamily: "var(--font-mono)",
                  color: on ? "var(--text)" : "var(--muted)" }}>{t}</span>
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3,
                  background: `${rc}18`, color: rc }}>{risk}</span>
              </label>
            );
          })}
        </div>
      </Sec>
    </div>
  );
}
