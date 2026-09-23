import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileTreeEntry } from "@/types/filesystem";
import { listWorkspaceFiles, openWorkspaceDialog } from "@/ipc/tauriCommands";

interface WorkspaceState {
  workspacePath: string | null;
  fileTree: FileTreeEntry[];
  recentWorkspaces: string[];
  isLoading: boolean;
  lastHarnessPath: string;
}

interface WorkspaceActions {
  setWorkspacePath: (path: string) => void;
  setFileTree: (tree: FileTreeEntry[]) => void;
  setLoading: (loading: boolean) => void;
  addRecentWorkspace: (path: string) => void;
  clearWorkspace: () => void;
  setLastHarnessPath: (p: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>()(
  persist(
    (set) => ({
      workspacePath: null,
      fileTree: [],
      recentWorkspaces: [],
      isLoading: false,
      lastHarnessPath: localStorage.getItem("harness_last_path") ?? "",

      setWorkspacePath: (path) =>
        set((state) => {
          const recent = [path, ...state.recentWorkspaces.filter((r) => r !== path)].slice(0, 10);
          return { workspacePath: path, recentWorkspaces: recent, fileTree: [] };
        }),

      setFileTree: (tree) => set({ fileTree: tree }),

      setLoading: (isLoading) => set({ isLoading }),

      addRecentWorkspace: (path) =>
        set((state) => ({
          recentWorkspaces: [path, ...state.recentWorkspaces.filter((r) => r !== path)].slice(0, 10),
        })),

      clearWorkspace: () => set({ workspacePath: null, fileTree: [] }),

      setLastHarnessPath: (p) => {
        localStorage.setItem("harness_last_path", p);
        set({ lastHarnessPath: p });
      },
    }),
    {
      name: "workspace-storage",
      // workspacePath is persisted so the last session (workspace + harness) restores on start.
      partialize: (state) => ({ recentWorkspaces: state.recentWorkspaces, workspacePath: state.workspacePath }),
    }
  )
);

/** Ask the user for a folder, make it the workspace and load its file tree.
 *  Shared by the sidebar folder button and the Ctrl+Shift+O shortcut. */
export async function openWorkspaceFolder(): Promise<void> {
  const path = await openWorkspaceDialog();
  if (!path) return;
  const { setWorkspacePath, setFileTree, setLoading } = useWorkspaceStore.getState();
  setLoading(true);
  try {
    setWorkspacePath(path);
    setFileTree(await listWorkspaceFiles(path));
  } catch (e) {
    console.error(e);
  } finally {
    setLoading(false);
  }
}
