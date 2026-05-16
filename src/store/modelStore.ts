/**
 * modelStore — tracks which provider is selected and which models
 * have been loaded from live APIs (Ollama, OpenRouter).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderId, ModelInfo } from "@/utils/modelRegistry";

interface ModelStoreState {
  /** Currently selected provider (per-user preference, persisted) */
  selectedProvider: ProviderId;
  /** Models loaded from live APIs — keyed by provider ID */
  liveModels: Partial<Record<ProviderId, ModelInfo[]>>;
  /** Whether a live-fetch is in progress */
  loading: Partial<Record<ProviderId, boolean>>;
  /** Last fetch error per provider */
  error: Partial<Record<ProviderId, string>>;
}

interface ModelStoreActions {
  setProvider: (id: ProviderId) => void;
  setLiveModels: (provider: ProviderId, models: ModelInfo[]) => void;
  setLoading: (provider: ProviderId, loading: boolean) => void;
  setError: (provider: ProviderId, err: string | null) => void;
  clearLiveModels: (provider: ProviderId) => void;
}

export const useModelStore = create<ModelStoreState & ModelStoreActions>()(
  persist(
    (set) => ({
      selectedProvider: "anthropic",
      liveModels: {},
      loading: {},
      error: {},

      setProvider: (id) => set({ selectedProvider: id }),

      setLiveModels: (provider, models) =>
        set((s) => ({ liveModels: { ...s.liveModels, [provider]: models } })),

      setLoading: (provider, loading) =>
        set((s) => ({ loading: { ...s.loading, [provider]: loading } })),

      setError: (provider, err) =>
        set((s) => ({
          error: { ...s.error, [provider]: err ?? undefined },
        })),

      clearLiveModels: (provider) =>
        set((s) => {
          const next = { ...s.liveModels };
          delete next[provider];
          return { liveModels: next };
        }),
    }),
    {
      name: "model-store",
      partialize: (s) => ({ selectedProvider: s.selectedProvider }),
    }
  )
);
