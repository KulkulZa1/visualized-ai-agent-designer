import { create } from "zustand";

interface EditorTab {
  path: string;
  isDirty: boolean;
  /** Edited text not yet saved; survives switching tabs. */
  unsaved?: string;
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
  setEditorBuffer: (path: string, content: string) => void;
  /** After `savedContent` was written: clean, unless the text changed meanwhile. */
  markEditorSaved: (path: string, savedContent: string) => void;
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

  setEditorBuffer: (path, content) =>
    set((state) => ({
      openEditorTabs: state.openEditorTabs.map((t) =>
        t.path === path ? { ...t, isDirty: true, unsaved: content } : t
      ),
    })),

  markEditorSaved: (path, savedContent) =>
    set((state) => ({
      openEditorTabs: state.openEditorTabs.map((t) => {
        if (t.path !== path) return t;
        // Text typed while the save was in flight is still unsaved.
        if (t.unsaved !== undefined && t.unsaved !== savedContent) return t;
        return { path: t.path, isDirty: false };
      }),
    })),

  setActiveEditorPath: (path) => set({ activeEditorPath: path }),

  toggleConfigPanel: () =>
    set((state) => ({ configPanelCollapsed: !state.configPanelCollapsed })),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setUiMode: (mode) => set({ uiMode: mode }),
}));
