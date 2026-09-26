import { useMemo } from "react";
import { useStore } from "zustand";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { defaultWorkflowFileName, useWorkflow } from "@/hooks/useWorkflow";
import { useExecutionStore } from "@/store/executionStore";
import { useUIStore } from "@/store/uiStore";
import type { AgentRun } from "@/types/execution";
import { validateWorkflow } from "@/utils/validateWorkflow";
import { modShortcut } from "@/utils/shortcuts";

interface TopBarProps {
  onOpenGenerate: () => void;
  onOpenPalette:  () => void;
  onOpenExamples: () => void;
  onOpenPermissions: () => void;
  onRun: () => void;
  onOpenSettings: () => void;
  onOpenHelp?: () => void;
  onOpenMetaEditor?: () => void;
  onOpenWizard?: () => void;
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

export function TopBar({ onOpenGenerate, onOpenPalette, onOpenExamples, onOpenPermissions, onRun, onOpenSettings, onOpenHelp, onOpenMetaEditor, onOpenWizard }: TopBarProps) {
  const meta      = useWorkflowStore((s) => s.meta);
  const isDirty   = useWorkflowStore((s) => s.isDirty);
  const filePath  = useWorkflowStore((s) => s.filePath);
  const nodes     = useWorkflowStore((s) => s.nodes);
  const edges     = useWorkflowStore((s) => s.edges);
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const isValid   = useMemo(() => validateWorkflow(nodes, edges).valid, [nodes, edges]);
  const workspace = useWorkspaceStore((s) => s.workspacePath);
  const { save }  = useWorkflow();
  const isRunning   = useExecutionStore((s) => s.isRunning);
  const currentRun  = useExecutionStore((s) => s.currentRun);
  const apiKey      = useExecutionStore((s) => s.apiKey);
  const openaiApiKey = useExecutionStore((s) => s.openaiApiKey);
  const llmProvider = useExecutionStore((s) => s.llmProvider);
  const uiMode    = useUIStore((s) => s.uiMode);
  const setUiMode = useUIStore((s) => s.setUiMode);

  // Warn (but don't disable) if the active provider has no key configured.
  const noKeyWarning: string | null = (() => {
    if (llmProvider === "ollama") return null;
    if (llmProvider === "ollama-cloud") return "Ollama Cloud uses OLLAMA_API_KEY from the environment; test it in Settings.";
    if (llmProvider === "openai" && !openaiApiKey) return "No OpenAI key set — open Settings to add one.";
    if (llmProvider === "anthropic" && !apiKey) return "No Anthropic key set — open Settings to add one.";
    if (llmProvider === "auto" && !openaiApiKey && !apiKey) return "No API keys set — open Settings to add one (or switch to Ollama).";
    return null;
  })();

  // Each selector must return a stable primitive/function to avoid useSyncExternalStore loops.
  const undo    = useStore(useWorkflowStore.temporal, (s) => s.undo);
  const redo    = useStore(useWorkflowStore.temporal, (s) => s.redo);
  const canUndo = useStore(useWorkflowStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useWorkflowStore.temporal, (s) => s.futureStates.length > 0);

  const workspaceName = workspace?.split(/[\\/]/).at(-1) ?? "no workspace";
  const relPath = filePath
    ? filePath.replace(workspace ?? "", "").replace(/^[\\/]/, "")
    : null;

  const handleSave = () => {
    if (!workspace) return;
    const name = relPath ?? defaultWorkflowFileName(meta.name);
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
      <span
        onClick={onOpenMetaEditor}
        title="Edit workflow metadata"
        style={{
          fontSize: 12, fontWeight: 500, maxWidth: 200,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          cursor: onOpenMetaEditor ? "pointer" : "default",
        }}
      >
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
            <span style={{ color: isValid ? "var(--green)" : "var(--red)" }}>● {isValid ? "valid" : "invalid"}</span>
          </>
        )}
        <Sep/>
      </div>

      {/* Command palette */}
      <Btn small onClick={onOpenPalette} title="Command palette (Ctrl+K)"
        style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--hint)" }}>
        {modShortcut("K")}
      </Btn>

      {/* Help / Quick Start */}
      <Btn small onClick={onOpenHelp} title="Help & Quick Start (Ctrl+/)"
        style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--hint)", minWidth: 26 }}>
        ?
      </Btn>

      {/* Wizard — Create from Goal */}
      {onOpenWizard && (
        <Btn small onClick={onOpenWizard} title="Create from Goal — recommend workflow + provider (Ctrl+Shift+W)"
          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
          ★ Create from Goal
        </Btn>
      )}

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
      <Btn
        primary
        onClick={onRun}
        title={noKeyWarning ?? "Run workflow"}
        style={{ opacity: isRunning ? 0.7 : 1, position: "relative" }}
      >
        {noKeyWarning && !isRunning && (
          <span style={{
            position: "absolute", top: -3, right: -3,
            width: 8, height: 8, borderRadius: "50%",
            background: "#f59e0b", border: "1.5px solid var(--surface)",
          }} />
        )}
        <NodeIcon name={isRunning ? "history" : "play"} size={12}/> {isRunning ? "Running…" : "Run"}
      </Btn>
    </header>
  );
}
