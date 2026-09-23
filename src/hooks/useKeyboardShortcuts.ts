import { useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { defaultWorkflowFileName, useWorkflow } from "@/hooks/useWorkflow";

export function useKeyboardShortcuts() {
  const filePath = useWorkflowStore((s) => s.filePath);
  const workflowName = useWorkflowStore((s) => s.meta.name);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const { save } = useWorkflow();

  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!workspacePath) return;
        // Same validated save as the Save button, including its default file name.
        const relative = filePath
          ? filePath.replace(workspacePath, "").replace(/^[\\/]/, "")
          : defaultWorkflowFileName(workflowName);
        await save(relative).catch((err) => console.error("Save failed:", err));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [save, filePath, workflowName, workspacePath]);
}
