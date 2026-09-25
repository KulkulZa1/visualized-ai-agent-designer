/**
 * revertChanges — undo a run's change to one file (Changes dialog).
 * A modified file gets its content from before the run back; a file the run
 * created is deleted. A file that changed again after the agent's last write
 * (by the user or a command) is only overwritten with `force`.
 */
import { isNotFound } from "@/services/execution/toolExecutor";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { FileChange } from "@/types/execution";

export type RevertOutcome = "reverted" | "changed-since";

export async function revertChange(
  change: FileChange, workspacePath: string, invoke: InvokeFn, force = false,
): Promise<RevertOutcome> {
  const file = { workspacePath, relativePath: change.path };
  let current: string | null;
  try {
    current = await invoke<string>("read_workspace_file", file);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    current = null;
  }
  if (current !== change.after && !force) return "changed-since";
  if (change.before !== null) {
    await invoke<void>("write_workspace_file", { ...file, content: change.before });
  } else if (current !== null) {
    await invoke<void>("delete_workspace_file", file);
  }
  return "reverted";
}
