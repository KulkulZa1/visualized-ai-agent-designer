import { useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { saveWorkflow } from "@/ipc/tauriCommands";

export function useKeyboardShortcuts() {
  const toWorkflowDef = useWorkflowStore((s) => s.toWorkflowDef);
  const markClean = useWorkflowStore((s) => s.markClean);
  const filePath = useWorkflowStore((s) => s.filePath);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!workspacePath || !filePath) return;
        const relative = filePath.replace(workspacePath, "").replace(/^[\\/]/, "");
        try {
          await saveWorkflow(workspacePath, relative, toWorkflowDef());
          markClean(filePath);
        } catch (err) {
          console.error("Save failed:", err);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toWorkflowDef, markClean, filePath, workspacePath]);
}
