import { useUIStore } from "@/store/uiStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { ROLE_META } from "@/utils/nodeColors";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { RoleTab }   from "./tabs/RoleTab";
import { PromptTab } from "./tabs/PromptTab";
import { ToolsTab }  from "./tabs/ToolsTab";
import { HooksTab }  from "./tabs/HooksTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { ContextInspectorTab } from "./tabs/ContextInspectorTab";
import { AgentOutputPanel } from "@/components/execution/AgentOutputPanel";

const TABS = ["role","prompt","tools","hooks","memory","context"] as const;
type Tab = typeof TABS[number];

export function ConfigPanel() {
  const selectedId     = useUIStore((s) => s.selectedNodeId);
  const activePanelTab = useUIStore((s) => s.activePanelTab) as Tab;
  const setTab         = useUIStore((s) => s.setActivePanelTab);
  const node           = useWorkflowStore((s) => s.nodes.find((n) => n.id === selectedId));

  return (
    <div style={{
      gridArea: "right" as const, background: "var(--surface)",
      borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden",
      resize: "horizontal", minWidth: 240, maxWidth: 600,
    }}>

      {!node && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          color: "var(--hint)", fontSize: 12, gap: 12, padding: 24 }}>
          <span style={{ fontSize: 32 }}>◆</span>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>
              No node selected
            </div>
            <div style={{ fontSize: 11, color: "var(--hint)", lineHeight: 1.5 }}>
              Click any node on the canvas to inspect<br/>
              its role, prompt, tools, hooks, and context.
            </div>
          </div>
          <div style={{ fontSize: 10, color: "var(--hint)", fontFamily: "var(--font-mono)" }}>
            Ctrl+Shift+E to load a harness
          </div>
        </div>
      )}

      {node && (() => {
        const meta = ROLE_META[node.data.role];
        return (
          <>
            {/* Node header */}
            <div style={{ padding: "12px 14px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: meta.bgAlpha,
                  color: meta.tint, display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <NodeIcon name={meta.icon} size={15} color={meta.tint}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.name}</div>
                  <div style={{ fontSize: 10, color: "var(--hint)", fontFamily: "var(--font-mono)",
                    textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {meta.label} · {node.id}
                  </div>
                </div>
                <button title="History" style={{ width: 26, height: 26, border: "none", borderRadius: 4,
                  background: "transparent", color: "var(--hint)", cursor: "pointer",
                  display: "grid", placeItems: "center" }}>
                  <NodeIcon name="history" size={13}/>
                </button>
              </div>

              {/* Tab bar */}
              <div style={{ display: "flex" }}>
                {TABS.map((t) => (
                  <button key={t} onClick={() => setTab(t)} style={{
                    padding: "7px 10px", border: "none", background: "transparent",
                    fontFamily: "inherit", cursor: "pointer",
                    color: activePanelTab === t ? "var(--text)" : "var(--muted)",
                    borderBottom: activePanelTab === t ? "2px solid var(--accent)" : "2px solid transparent",
                    marginBottom: -1, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em",
                  }}>{t}</button>
                ))}
              </div>
            </div>

            {/* Tab body */}
            <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
              {activePanelTab === "role"   && <RoleTab   nodeId={node.id}/>}
              {activePanelTab === "prompt" && <PromptTab nodeId={node.id}/>}
              {activePanelTab === "tools"  && <ToolsTab  nodeId={node.id}/>}
              {activePanelTab === "hooks"  && <HooksTab  nodeId={node.id}/>}
              {activePanelTab === "memory" && <MemoryTab nodeId={node.id}/>}
              {activePanelTab === "context" && <ContextInspectorTab nodeId={node.id}/>}
            </div>

            {/* Execution output for the selected node */}
            <AgentOutputPanel nodeId={node.id}/>
          </>
        );
      })()}
    </div>
  );
}
