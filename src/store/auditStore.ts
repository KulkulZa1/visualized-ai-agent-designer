import { create } from "zustand";
import type { AuditEntry } from "@/types/audit";

interface AuditState {
  entries: AuditEntry[];
  maxEntries: number;
}

interface AuditActions {
  addEntry: (entry: AuditEntry) => void;
  clearEntries: () => void;
}

export const useAuditStore = create<AuditState & AuditActions>()((set) => ({
  entries: [],
  maxEntries: 500,

  addEntry: (entry) =>
    set((state) => ({
      entries: [entry, ...state.entries].slice(0, state.maxEntries),
    })),

  clearEntries: () => set({ entries: [] }),
}));
