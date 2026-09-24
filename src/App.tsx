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
import { AgentActivityPanel }  from "@/components/execution/AgentActivityPanel";
import { WorkflowInputDialog }  from "@/components/execution/WorkflowInputDialog";
import { CommandConsentDialog } from "@/components/execution/CommandConsentDialog";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ExamplePicker }  from "@/components/palette/ExamplePicker";
import { PermissionMatrix } from "@/components/permissions/PermissionMatrix";
import { RunPanel }       from "@/components/execution/RunPanel";
import { SettingsPanel }  from "@/components/layout/SettingsPanel";
import { QuickStartGuide } from "@/components/layout/QuickStartGuide";
import { WorkflowWizard } from "@/components/wizard/WorkflowWizard";
import { GuidePanel } from "@/components/guide/GuidePanel";
import { SnapshotSearchPanel } from "@/components/palette/SnapshotSearchPanel";
import { WorkflowMetaEditor } from "@/components/palette/WorkflowMetaEditor";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useWorkflowExecution } from "@/hooks/useWorkflowExecution";
import { useUIStore } from "@/store/uiStore";
import { useWorkspaceStore, openWorkspaceFolder } from "@/store/workspaceStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useStore } from "zustand";
import { listWorkspaceFiles, loadWorkflow } from "@/ipc/tauriCommands";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { EXAMPLES, useExamples } from "@/hooks/useExamples";
import { ErrorToast } from "@/components/ui/ErrorToast";

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
  const [showMetaEditor, setShowMetaEditor] = useState(false);
  const [showActivityPanel, setShowActivityPanel] = useState(false);
  const [showRunInput, setShowRunInput] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const selectNode = useUIStore((s) => s.selectNode);
  const uiMode = useUIStore((s) => s.uiMode);
  const currentRun = useExecutionStore((s) => s.currentRun);
  const isRunning  = useExecutionStore((s) => s.isRunning);
  // Auto-show when the node is actively running
  const selectedNodeIsRunning =
    isRunning && selectedNodeId !== null &&
    currentRun?.agents[selectedNodeId]?.status === "running";
  // Keep visible after run completes if the selected node has output
  const selectedNodeHasOutput =
    !isRunning && selectedNodeId !== null &&
    (currentRun?.agents[selectedNodeId]?.output?.length ?? 0) > 0;
  const undo = useStore(useWorkflowStore.temporal, (s) => s.undo);
  const redo = useStore(useWorkflowStore.temporal, (s) => s.redo);

  const { executeWorkflow } = useWorkflowExecution();
  const { loadExample } = useExamples();

  // Session restore: silently load last harness on mount
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const lastHarnessPath = useWorkspaceStore((s) => s.lastHarnessPath);
  const loadWorkflowState = useWorkflowStore((s) => s.loadWorkflow);
  const markClean = useWorkflowStore((s) => s.markClean);

  useEffect(() => {
    if (!workspacePath) return;
    listWorkspaceFiles(workspacePath)
      .then((tree) => useWorkspaceStore.getState().setFileTree(tree))
      .catch((err) => console.warn("[session-restore] file tree failed:", err));
    if (!lastHarnessPath) return;
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
    setShowRunInput(true);   // open preflight dialog; run starts after user confirms
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
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e" && !isTyping) {
      e.preventDefault();
      loadExample(EXAMPLES[4]);
    }
    // Ctrl+Shift+O — open a workspace folder (advertised on the first-run screen)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void openWorkspaceFolder();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      setShowHelp((v) => !v);
    }
    // Ctrl+Shift+W — Workflow Wizard (Create from Goal)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      setShowWizard((v) => !v);
    }
    // Undo / Redo — leave text undo alone while typing in an input or editor
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z" && !isTyping) {
      e.preventDefault();
      undo();
    }
    // With Shift held, e.key is "Z" — compare case-insensitively
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key.toLowerCase() === "z")) && !isTyping) {
      e.preventDefault();
      redo();
    }
    // Duplicate selected node
    if ((e.ctrlKey || e.metaKey) && e.key === "d" && selectedNodeId && !isTyping) {
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
    // Ctrl+I — toggle agent activity panel for selected node
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i" && !e.shiftKey) {
      e.preventDefault();
      setShowActivityPanel((v) => !v);
    }
    if (e.key === "Escape") {
      setModal(null); setShowSettings(false); setShowHelp(false);
      setShowSnapshotSearch(false); setShowActivityPanel(false);
      setShowWizard(false); setShowGuide(false);
    }
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
        onOpenMetaEditor={() => setShowMetaEditor(true)}
        onOpenWizard={() => setShowWizard(true)}
      />
      <Sidebar />

      {/* Center: canvas + optional editor split + agent activity panel */}
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
          {/* Agent activity panel — shows during run, persists after, or when explicitly opened */}
          {selectedNodeId && (selectedNodeIsRunning || selectedNodeHasOutput || showActivityPanel) && (
            <div style={{ height: 260, flexShrink: 0, borderTop: "2px solid var(--accent)" }}>
              <AgentActivityPanel
                nodeId={selectedNodeId}
                onClose={() => setShowActivityPanel(false)}
              />
            </div>
          )}
        </div>
      </div>

      <ConfigPanel />
      <AuditStrip />
      <StatusBar />

      {/* Workflow input dialog — preflight before every run */}
      {showRunInput && (
        <WorkflowInputDialog
          onCancel={() => setShowRunInput(false)}
          onStart={(config) => {
            setShowRunInput(false);
            setShowRunPanel(true);
            executeWorkflow(config, (msg) => setErrorMsg(msg)).catch(console.error);
          }}
        />
      )}

      {/* Run panel (slides in from right) */}
      {showRunPanel && <RunPanel onClose={() => setShowRunPanel(false)}/>}

      {/* An agent's shell command waiting for approval */}
      <CommandConsentDialog />

      {/* Settings modal */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)}/>}

      {/* Error toast — replaces alert() for workflow errors */}
      {errorMsg && <ErrorToast message={errorMsg} onDismiss={() => setErrorMsg(null)}/>}

      {/* Quick Start Guide (replaces old KeyboardHelp) */}
      {showHelp && <QuickStartGuide onClose={() => setShowHelp(false)}/>}

      {/* Workflow Wizard — Create from Goal (Ctrl+Shift+W) */}
      {showWizard && <WorkflowWizard onClose={() => setShowWizard(false)}/>}

      {/* Floating Guide Assistant (always available) */}
      <GuidePanel
        open={showGuide}
        onToggle={() => setShowGuide((v) => !v)}
      />

      {/* Snapshot search */}
      {showSnapshotSearch && <SnapshotSearchPanel onClose={() => setShowSnapshotSearch(false)}/>}

      {/* Workflow metadata editor */}
      {showMetaEditor && <WorkflowMetaEditor onClose={() => setShowMetaEditor(false)}/>}

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
