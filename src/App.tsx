import { useState, useEffect, useCallback } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { TopBar }         from "@/components/layout/TopBar";
import { Sidebar }        from "@/components/layout/Sidebar";
import { StatusBar }      from "@/components/layout/StatusBar";
import { CanvasToolbar }  from "@/components/canvas/CanvasToolbar";
import { WorkflowCanvas } from "@/components/canvas/WorkflowCanvas";
import { ConfigPanel }    from "@/components/config-panel/ConfigPanel";
import { EditorArea }     from "@/components/editor/EditorTab";
import { AuditStrip }     from "@/components/layout/AuditStrip";
import { GeneratePanel }  from "@/components/generate/GeneratePanel";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ExamplePicker }  from "@/components/palette/ExamplePicker";
import { PermissionMatrix } from "@/components/permissions/PermissionMatrix";
import { RunPanel }       from "@/components/execution/RunPanel";
import { SettingsPanel }  from "@/components/layout/SettingsPanel";
import { KeyboardHelp }   from "@/components/layout/KeyboardHelp";
import { SnapshotSearchPanel } from "@/components/palette/SnapshotSearchPanel";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useWorkflowExecution } from "@/hooks/useWorkflowExecution";
import { useUIStore } from "@/store/uiStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStore } from "zustand";
import { loadWorkflow } from "@/ipc/tauriCommands";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { EXAMPLES, useExamples } from "@/hooks/useExamples";

type Modal = "generate" | "palette" | "examples" | "permissions" | null;

function AppInner() {
  useKeyboardShortcuts();
  const openEditorTabs = useUIStore((s) => s.openEditorTabs);
  const hasEditor = openEditorTabs.length > 0;
  const [modal, setModal] = useState<Modal>(null);
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSnapshotSearch, setShowSnapshotSearch] = useState(false);

  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const selectNode = useUIStore((s) => s.selectNode);
  const uiMode = useUIStore((s) => s.uiMode);
  const { undo, redo } = useStore(useWorkflowStore.temporal, (s) => ({ undo: s.undo, redo: s.redo }));

  const { executeWorkflow } = useWorkflowExecution();
  const { loadExample } = useExamples();

  // Session restore: silently load last harness on mount
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const lastHarnessPath = useWorkspaceStore((s) => s.lastHarnessPath);
  const loadWorkflowState = useWorkflowStore((s) => s.loadWorkflow);
  const markClean = useWorkflowStore((s) => s.markClean);

  useEffect(() => {
    if (!workspacePath || !lastHarnessPath) return;
    loadWorkflow(workspacePath, lastHarnessPath)
      .then((raw) => {
        const validated = workflowDefSchema.parse(raw);
        loadWorkflowState(validated);
        markClean(`${workspacePath}/${lastHarnessPath}`);
      })
      .catch((err) => console.warn("[session-restore] failed:", err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRun() {
    setShowRunPanel(true);
    executeWorkflow().catch(console.error);
  }

  // Global keyboard: ⌘K / Ctrl+K → command palette
  const handleGlobalKey = useCallback((e: KeyboardEvent) => {
    const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(
      (document.activeElement?.tagName ?? "")
    );

    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      setModal((m) => m === "palette" ? null : "palette");
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "g") {
      e.preventDefault();
      setModal((m) => m === "generate" ? null : "generate");
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "e") {
      e.preventDefault();
      setModal((m) => m === "examples" ? null : "examples");
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      setModal((m) => m === "permissions" ? null : "permissions");
    }
    // Ctrl+Shift+E — load EXAMPLES[4] (harness-studio-project) directly
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      loadExample(EXAMPLES[4]);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      setShowHelp((v) => !v);
    }
    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault();
      redo();
    }
    // Duplicate selected node
    if ((e.ctrlKey || e.metaKey) && e.key === "d" && selectedNodeId) {
      e.preventDefault();
      useWorkflowStore.getState().duplicateNode(selectedNodeId);
    }
    // Delete selected node
    if (e.key === "Delete" && selectedNodeId && !isTyping) {
      useWorkflowStore.getState().removeNode(selectedNodeId);
      selectNode(null);
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setShowSnapshotSearch((v) => !v);
    }
    if (e.key === "Escape") { setModal(null); setShowSettings(false); setShowHelp(false); setShowSnapshotSearch(false); }
  }, [loadExample, undo, redo, selectedNodeId, selectNode]);

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [handleGlobalKey]);

  return (
    <div className={uiMode === "observatory" ? "observatory" : ""} style={{
      display: "grid",
      gridTemplateRows: "40px 1fr auto 26px",
      gridTemplateColumns: "224px 1fr 320px",
      gridTemplateAreas: `
        "top    top    top"
        "left   center right"
        "bottom bottom bottom"
        "status status status"
      `,
      width: "100vw", height: "100vh", overflow: "hidden",
    }}>
      <TopBar
        onOpenGenerate={() => setModal("generate")}
        onOpenPalette={() => setModal("palette")}
        onOpenExamples={() => setModal("examples")}
        onOpenPermissions={() => setModal("permissions")}
        onRun={handleRun}
        onOpenSettings={() => setShowSettings(true)}
        onOpenHelp={() => setShowHelp(true)}
      />
      <Sidebar />

      {/* Center: canvas + optional editor split */}
      <div style={{ gridArea: "center", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <CanvasToolbar />
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <WorkflowCanvas />
          </div>
          {hasEditor && (
            <div style={{ height: 260, flexShrink: 0, borderTop: "1px solid var(--border)" }}>
              <EditorArea />
            </div>
          )}
        </div>
      </div>

      <ConfigPanel />
      <AuditStrip />
      <StatusBar />

      {/* Run panel (slides in from right) */}
      {showRunPanel && <RunPanel onClose={() => setShowRunPanel(false)}/>}

      {/* Settings modal */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)}/>}

      {/* Keyboard help modal */}
      {showHelp && <KeyboardHelp onClose={() => setShowHelp(false)}/>}

      {/* Snapshot search */}
      {showSnapshotSearch && <SnapshotSearchPanel onClose={() => setShowSnapshotSearch(false)}/>}

      {/* Modals */}
      {modal === "generate" && <GeneratePanel  onClose={() => setModal(null)}/>}
      {modal === "palette"  && <CommandPalette onClose={() => setModal(null)} onOpenGenerate={() => setModal("generate")} onOpenPermissions={() => setModal("permissions")}/>}
      {modal === "examples" && <ExamplePicker  onClose={() => setModal(null)}/>}
      {modal === "permissions" && <PermissionMatrix onClose={() => setModal(null)}/>}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <AppInner />
    </ReactFlowProvider>
  );
}
