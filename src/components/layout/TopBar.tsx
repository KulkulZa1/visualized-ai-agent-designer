import { useStore } from "zustand";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useWorkflow } from "@/hooks/useWorkflow";
import { useExecutionStore } from "@/store/executionStore";
import { useUIStore } from "@/store/uiStore";
import type { AgentRun } from "@/types/execution";

interface TopBarProps {
  onOpenGenerate: () => void;
  onOpenPalette:  () => void;
  onOpenExamples: () => void;
  onOpenPermissions: () => void;
  onRun: () => void;
  onOpenSettings: () => void;
  onOpenHelp?: () => void;
}

const Sep = () => (
  <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }}/>
);

function RunProgress({ agents, total }: { agents: Record<string, AgentRun>; total: number }) {
  const values = Object.values(agents);
  const done = values.filter((a) => a.status === "done" || a.status === "error").length;
  const running = values.filter((a) => a.status === "running").length;
  return (
    <span style={{ color: "var(--accent)", fontWeight: 600 }}>
      ● {done + running}/{total} agents
    </span>
  );
}

const Btn = ({ children, primary, small, onClick, title, style: s = {} }: {
  children: React.ReactNode; primary?: boolean; small?: boolean;
  onClick?: () => void; title?: string; style?: React.CSSProperties;
}) => (
  <button onClick={onClick} title={title} style={{
    height: small ? 24 : 26, padding: small ? "0 9px" : "0 12px",
    border: "none", borderRadius: 5, cursor: "pointer",
    background: primary ? "var(--accent)" : "var(--surface-3)",
    color: primary ? "#1a1207" : "var(--text)",
    fontSize: 12, fontWeight: primary ? 600 : 500,
    fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 5,
    ...s,
  }}>{children}</button>
);

export function TopBar({ onOpenGenerate, onOpenPalette, onOpenExamples, onOpenPermissions, onRun, onOpenSettings, onOpenHelp }: TopBarProps) {
  const meta      = useWorkflowStore((s) => s.meta);
  const isDirty   = useWorkflowStore((s) => s.isDirty);
  const filePath  = useWorkflowStore((s) => s.filePath);
  const nodeCount = useWorkflowStore((s) => s.nodes.length);
  const edgeCount = useWorkflowStore((s) => s.edges.length);
  const workspace = useWorkspaceStore((s) => s.workspacePath);
  const { save }  = useWorkflow();
  const isRunning   = useExecutionStore((s) => s.isRunning);
  const currentRun  = useExecutionStore((s) => s.currentRun);
  const uiMode    = useUIStore((s) => s.uiMode);
  const setUiMode = useUIStore((s) => s.setUiMode);

  const { undo, redo, pastStates, futureStates } = useStore(
    useWorkflowStore.temporal,
    (s) => ({ undo: s.undo, redo: s.redo, pastStates: s.pastStates, futureStates: s.futureStates }),
  );
  const canUndo = pastStates.length > 0;
  const canRedo = futureStates.length > 0;

  const workspaceName = workspace?.split(/[\\/]/).at(-1) ?? "no workspace";
  const relPath = filePath
    ? filePath.replace(workspace ?? "", "").replace(/^[\\/]/, "")
    : null;

  const handleSave = () => {
    if (!workspace) return;
    const name = relPath ?? `${meta.name.toLowerCase().replace(/\s+/g, "-")}.harness.yaml`;
    save(name).catch(console.error);
  };

  return (
    <header style={{
      gridArea: "top" as const,
      display: "flex", alignItems: "center",
      padding: "0 14px", gap: 8,
      background: "var(--surface)", borderBottom: "1px solid var(--border)",
      height: 40, flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ width: 18, height: 18, borderRadius: 4, background: "var(--accent)",
        display: "grid", placeItems: "center", color: "#1a1207",
        fontSize: 10, fontWeight: 800, flexShrink: 0 }}>H</div>

      {/* UI Mode toggle */}
      <button
        onClick={() => setUiMode(uiMode === "atelier" ? "observatory" : "atelier")}
        title={`Switch to ${uiMode === "atelier" ? "Observatory" : "Atelier"} mode`}
        style={{
          width: 20, height: 20, borderRadius: "50%", border: "none",
          background: "var(--accent-soft)", color: "var(--accent)",
          fontSize: 10, fontWeight: 700, cursor: "pointer",
          display: "grid", placeItems: "center", flexShrink: 0,
        }}>
        {uiMode === "atelier" ? "A" : "O"}
      </button>
      <span style={{ fontSize: 9, color: "var(--hint)", marginLeft: -4 }}>[beta]</span>

      {/* Breadcrumb */}
      <span style={{ fontSize: 12, color: "var(--muted)" }}>harness-studio</span>
      <span style={{ color: "var(--hint)", fontSize: 12 }}>/</span>
      <span style={{ fontSize: 12 }}>{workspaceName}</span>
      <span style={{ color: "var(--hint)", fontSize: 12 }}>/</span>
      <span style={{ fontSize: 12, fontWeight: 500, maxWidth: 200,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {relPath ?? meta.name}
      </span>
      {isDirty && <span style={{ fontSize: 10, color: "var(--accent)" }}>● unsaved</span>}

      {/* Phase badge */}
      <div style={{ padding: "2px 9px", borderRadius: 99, fontSize: 10, fontWeight: 700,
        background: "var(--accent-soft)", color: "var(--accent)",
        border: "1px solid rgba(229,161,66,0.3)", letterSpacing: "0.03em", flexShrink: 0 }}>
        Phase 5 · Execution Engine
      </div>

      <div style={{ flex: 1 }}/>

      {/* Stats */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)" }}>
        <span onClick={canUndo ? () => undo() : undefined} title="Undo (Ctrl+Z)"
          style={{ cursor: canUndo ? "pointer" : "not-allowed", opacity: canUndo ? 1 : 0.35, display: "flex" }}>
          <NodeIcon name="undo" size={13}/>
        </span>
        <span onClick={canRedo ? () => redo() : undefined} title="Redo (Ctrl+Y)"
          style={{ cursor: canRedo ? "pointer" : "not-allowed", opacity: canRedo ? 1 : 0.35, display: "flex" }}>
          <NodeIcon name="redo" size={13}/>
        </span>
        <Sep/>
        {isRunning && currentRun ? (
          <RunProgress agents={currentRun.agents} total={nodeCount} />
        ) : (
          <>
            <span><b style={{ color: "var(--text)" }}>{nodeCount}</b> nodes</span>
            <span><b style={{ color: "var(--text)" }}>{edgeCount}</b> edges</span>
            <span style={{ color: "var(--green)" }}>● valid</span>
          </>
        )}
        <Sep/>
      </div>

      {/* ⌘K */}
      <Btn small onClick={onOpenPalette} title="Command palette (Ctrl+K)"
        style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--hint)" }}>
        ⌘K
      </Btn>

      {/* Help */}
      <Btn small onClick={onOpenHelp} title="Keyboard shortcuts (Ctrl+?)"
        style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--hint)", minWidth: 26 }}>
        ?
      </Btn>

      {/* Examples */}
      <Btn small onClick={onOpenExamples} title="Load an example workflow (Ctrl+E)">
        <NodeIcon name="folder" size={12}/> Examples
      </Btn>

      {/* Generate */}
      <Btn small onClick={onOpenGenerate} title="Generate files (Ctrl+G)">
        <NodeIcon name="grid" size={12}/> Generate
      </Btn>

      {/* Permissions */}
      <Btn small onClick={onOpenPermissions} title="Permission matrix (Ctrl+Shift+P)">
        <NodeIcon name="shield" size={12}/> Permissions
      </Btn>

      <Sep/>

      {/* Settings */}
      <Btn small onClick={onOpenSettings} title="Settings (API key)">
        <NodeIcon name="cog" size={12}/>
      </Btn>

      <Sep/>

      {/* Save / Run */}
      <Btn onClick={handleSave} title="Save (Ctrl+S)">
        <NodeIcon name="save" size={12}/> Save
      </Btn>
      <Btn primary onClick={onRun} title="Run workflow" style={{ opacity: isRunning ? 0.7 : 1 }}>
        <NodeIcon name={isRunning ? "history" : "play"} size={12}/> {isRunning ? "Running…" : "Run"}
      </Btn>
    </header>
  );
}
