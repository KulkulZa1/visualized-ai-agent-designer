import { FolderOpen, Clock } from "lucide-react";
import { openWorkspaceDialog, listWorkspaceFiles } from "@/ipc/tauriCommands";
import { useWorkspaceStore } from "@/store/workspaceStore";
import type { FileTreeEntry } from "@/types/filesystem";

export function WorkspaceSelector() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);
  const setFileTree = useWorkspaceStore((s) => s.setFileTree);
  const setLoading = useWorkspaceStore((s) => s.setLoading);

  async function loadWorkspace(path: string) {
    setLoading(true);
    try {
      setWorkspacePath(path);
      const tree: FileTreeEntry[] = await listWorkspaceFiles(path);
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to load workspace:", err);
    } finally {
      setLoading(false);
    }
  }

  async function openDialog() {
    const path = await openWorkspaceDialog();
    if (path) await loadWorkspace(path);
  }

  return (
    <div className="p-3 border-b border-gray-200">
      <button
        onClick={openDialog}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <FolderOpen size={15} className="text-blue-500" />
        {workspacePath ? (
          <span className="truncate text-xs text-left flex-1">{workspacePath.split(/[\\/]/).at(-1)}</span>
        ) : (
          <span className="text-gray-500">Open workspace folder…</span>
        )}
      </button>

      {recentWorkspaces.length > 0 && !workspacePath && (
        <div className="mt-2">
          <p className="text-xs text-gray-400 flex items-center gap-1 mb-1"><Clock size={10} /> Recent</p>
          {recentWorkspaces.slice(0, 5).map((p) => (
            <button
              key={p}
              onClick={() => loadWorkspace(p)}
              className="w-full text-left px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 rounded truncate"
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
