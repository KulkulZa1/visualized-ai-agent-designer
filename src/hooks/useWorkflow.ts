import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuditStore } from "@/store/auditStore";
import { saveWorkflow, loadWorkflow } from "@/ipc/tauriCommands";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { diffWorkflows } from "@/utils/workflowDiff";

export function useWorkflow() {
  const toWorkflowDef = useWorkflowStore((s) => s.toWorkflowDef);
  const loadWorkflowState = useWorkflowStore((s) => s.loadWorkflow);
  const markClean = useWorkflowStore((s) => s.markClean);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const setLastHarnessPath = useWorkspaceStore((s) => s.setLastHarnessPath);
  const addEntry = useAuditStore((s) => s.addEntry);

  async function save(relativePath: string) {
    if (!workspacePath) throw new Error("No workspace open");
    const prevDef = toWorkflowDef();
    const validated = workflowDefSchema.parse(prevDef);
    await saveWorkflow(workspacePath, relativePath, validated);
    markClean(`${workspacePath}/${relativePath}`);
    setLastHarnessPath(relativePath);
    const diff = diffWorkflows(prevDef, validated);
    addEntry({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action: "workflow_saved",
      path: relativePath,
      details: `Saved: ${diff.summary}`,
      success: true,
    });
  }

  async function load(relativePath: string) {
    if (!workspacePath) throw new Error("No workspace open");
    const raw = await loadWorkflow(workspacePath, relativePath);
    const validated = workflowDefSchema.parse(raw);
    loadWorkflowState(validated);
    markClean(`${workspacePath}/${relativePath}`);
  }

  return { save, load };
}
