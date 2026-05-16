import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileTreeEntry } from "@/types/filesystem";

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
      partialize: (state) => ({ recentWorkspaces: state.recentWorkspaces }),
    }
  )
);
