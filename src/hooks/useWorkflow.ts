import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { saveWorkflow, loadWorkflow } from "@/ipc/tauriCommands";
import { workflowDefSchema } from "@/schemas/workflowSchema";

export function useWorkflow() {
  const toWorkflowDef = useWorkflowStore((s) => s.toWorkflowDef);
  const loadWorkflowState = useWorkflowStore((s) => s.loadWorkflow);
  const markClean = useWorkflowStore((s) => s.markClean);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const setLastHarnessPath = useWorkspaceStore((s) => s.setLastHarnessPath);

  async function save(relativePath: string) {
    if (!workspacePath) throw new Error("No workspace open");
    const def = toWorkflowDef();
    const validated = workflowDefSchema.parse(def);
    await saveWorkflow(workspacePath, relativePath, validated);
    markClean(`${workspacePath}/${relativePath}`);
    setLastHarnessPath(relativePath);
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
