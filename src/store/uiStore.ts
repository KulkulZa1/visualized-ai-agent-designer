import { create } from "zustand";

interface EditorTab {
  path: string;
  isDirty: boolean;
}

interface UIState {
  selectedNodeId: string | null;
  activePanelTab: string;
  openEditorTabs: EditorTab[];
  activeEditorPath: string | null;
  configPanelCollapsed: boolean;
  sidebarCollapsed: boolean;
  uiMode: "atelier" | "observatory";
}

interface UIActions {
  selectNode: (nodeId: string | null) => void;
  setActivePanelTab: (tab: string) => void;
  openEditorFile: (path: string) => void;
  closeEditorFile: (path: string) => void;
  markEditorDirty: (path: string, dirty: boolean) => void;
  setActiveEditorPath: (path: string | null) => void;
  toggleConfigPanel: () => void;
  toggleSidebar: () => void;
  setUiMode: (mode: "atelier" | "observatory") => void;
}

export const useUIStore = create<UIState & UIActions>()((set) => ({
  selectedNodeId: null,
  activePanelTab: "role",
  openEditorTabs: [],
  activeEditorPath: null,
  configPanelCollapsed: false,
  sidebarCollapsed: false,
  uiMode: "atelier",

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  setActivePanelTab: (tab) => set({ activePanelTab: tab }),

  openEditorFile: (path) =>
    set((state) => {
      const exists = state.openEditorTabs.some((t) => t.path === path);
      if (exists) return { activeEditorPath: path };
      return {
        openEditorTabs: [...state.openEditorTabs, { path, isDirty: false }],
        activeEditorPath: path,
      };
    }),

  closeEditorFile: (path) =>
    set((state) => {
      const remaining = state.openEditorTabs.filter((t) => t.path !== path);
      const nextActive =
        state.activeEditorPath === path
          ? (remaining.at(-1)?.path ?? null)
          : state.activeEditorPath;
      return { openEditorTabs: remaining, activeEditorPath: nextActive };
    }),

  markEditorDirty: (path, dirty) =>
    set((state) => ({
      openEditorTabs: state.openEditorTabs.map((t) =>
        t.path === path ? { ...t, isDirty: dirty } : t
      ),
    })),

  setActiveEditorPath: (path) => set({ activeEditorPath: path }),

  toggleConfigPanel: () =>
    set((state) => ({ configPanelCollapsed: !state.configPanelCollapsed })),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setUiMode: (mode) => set({ uiMode: mode }),
}));
