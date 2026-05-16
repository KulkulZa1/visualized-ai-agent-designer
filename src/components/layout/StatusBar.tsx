import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";

export function StatusBar() {
  const isDirty       = useWorkflowStore((s) => s.isDirty);
  const meta          = useWorkflowStore((s) => s.meta);
  const nodes         = useWorkflowStore((s) => s.nodes);
  const nodeCount     = nodes.length;
  const edgeCount     = useWorkflowStore((s) => s.edges.length);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const roleCounts: Partial<Record<AgentRole, number>> = {};
  for (const n of nodes) {
    roleCounts[n.data.role] = (roleCounts[n.data.role] ?? 0) + 1;
  }
  const roleLabel = (role: AgentRole, label: string) => {
    const count = roleCounts[role];
    return count ? `${count} ${label}${count !== 1 ? "s" : ""}` : null;
  };
  const roleParts = [
    roleLabel(AgentRole.Orchestrator, "orchestrator"),
    roleLabel(AgentRole.Worker, "worker"),
    roleLabel(AgentRole.Critic, "critic"),
    roleLabel(AgentRole.Gateway, "gateway"),
    roleLabel(AgentRole.Memory, "memory"),
    roleLabel(AgentRole.Hook, "hook"),
    roleLabel(AgentRole.Aggregator, "aggregator"),
    roleLabel(AgentRole.ToolCaller, "tool caller"),
  ].filter(Boolean);
  const roleStats = roleParts.join(" · ");

  return (
    <footer style={{
      gridArea: "bottom" as const,
      display: "flex", alignItems: "center", gap: 20, padding: "0 14px",
      background: "var(--surface)", borderTop: "1px solid var(--border)",
      height: 26, flexShrink: 0, fontSize: 11, color: "var(--hint)",
    }}>
      {/* Save state */}
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: isDirty ? "var(--accent)" : "var(--green)",
          boxShadow: isDirty ? "none" : "0 0 4px var(--green)",
        }}/>
        {isDirty ? "Unsaved" : "Saved"}
      </span>

      <span>{meta.name}</span>
      <span>{nodeCount} node{nodeCount !== 1 ? "s" : ""} · {edgeCount} connection{edgeCount !== 1 ? "s" : ""}</span>
      {roleStats && <span style={{ color: "var(--muted)" }}>{roleStats}</span>}

      {workspacePath && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, opacity: 0.6,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>
          {workspacePath}
        </span>
      )}

      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ padding: "1px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700,
          background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent)" }}>
          Phase 5 · Execution Engine
        </span>
      </span>
    </footer>
  );
}
