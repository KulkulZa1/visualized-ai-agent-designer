/**
 * useModelRegistry — manages provider selection and live model fetching.
 *
 * Live API endpoints:
 *   Ollama:     GET http://localhost:11434/api/tags
 *               → { models: [{ name: "llama3.2", size: 2000000000, ... }] }
 *
 *   OpenRouter: GET https://openrouter.ai/api/v1/models
 *               → { data: [{ id: "...", name: "...", context_length: ... }] }
 *
 * No API key is needed for either listing endpoint.
 * Inference calls need keys — those are handled at runtime, not here.
 */
import { useCallback } from "react";
import { useModelStore } from "@/store/modelStore";
import {
  PROVIDERS, PROVIDER_MAP, inferProvider,
  type ModelInfo,
} from "@/utils/modelRegistry";

// ── Ollama response shape ────────────────────────────────────────────────────
interface OllamaModel {
  name: string;
  size?: number;
  details?: { parameter_size?: string; family?: string };
}
interface OllamaTagsResponse { models: OllamaModel[] }

// ── OpenRouter response shape ────────────────────────────────────────────────
interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  description?: string;
}
interface OpenRouterModelsResponse { data: OpenRouterModel[] }

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchOllamaModels(endpoint: string): Promise<ModelInfo[]> {
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json: OllamaTagsResponse = await res.json();
  return (json.models ?? []).map((m) => ({
    id: m.name,
    label: m.name + (m.details?.parameter_size ? ` (${m.details.parameter_size})` : ""),
    contextK: 128, // Ollama doesn't report context in the tags endpoint
    tags: m.details?.family ? [m.details.family] : undefined,
  }));
}

async function fetchOpenRouterModels(endpoint: string): Promise<ModelInfo[]> {
  const res = await fetch(endpoint, {
    headers: { "HTTP-Referer": "https://harness-studio.local", "X-Title": "Harness Studio" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const json: OpenRouterModelsResponse = await res.json();
  return (json.data ?? [])
    .map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
      contextK: m.context_length ? Math.round(m.context_length / 1000) : 128,
      costInPerMtok:  m.pricing?.prompt     ? parseFloat(m.pricing.prompt)     * 1_000_000 : undefined,
      costOutPerMtok: m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : undefined,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useModelRegistry() {
  const selectedProvider = useModelStore((s) => s.selectedProvider);
  const liveModels       = useModelStore((s) => s.liveModels);
  const loading          = useModelStore((s) => s.loading);
  const error            = useModelStore((s) => s.error);
  const setProvider      = useModelStore((s) => s.setProvider);
  const setLiveModels    = useModelStore((s) => s.setLiveModels);
  const setLoading       = useModelStore((s) => s.setLoading);
  const setError         = useModelStore((s) => s.setError);
  const clearLiveModels  = useModelStore((s) => s.clearLiveModels);

  const providerDef = PROVIDER_MAP[selectedProvider];

  /** All models for the current provider: live (if loaded) or defaults. */
  const models: ModelInfo[] =
    liveModels[selectedProvider] ??
    providerDef?.defaultModels ??
    [];

  const isLoading = loading[selectedProvider] ?? false;
  const loadError = error[selectedProvider] ?? null;
  const hasLive   = !!liveModels[selectedProvider];

  /** Fetch live model list for the current provider. */
  const fetchLive = useCallback(async () => {
    const provider = PROVIDER_MAP[selectedProvider];
    if (!provider?.apiEndpoint) return; // no live endpoint for this provider

    setLoading(selectedProvider, true);
    setError(selectedProvider, null);
    try {
      let fetched: ModelInfo[];
      if (selectedProvider === "ollama") {
        fetched = await fetchOllamaModels(provider.apiEndpoint);
      } else if (selectedProvider === "openrouter") {
        fetched = await fetchOpenRouterModels(provider.apiEndpoint);
      } else {
        throw new Error(`No live fetch implementation for ${selectedProvider}`);
      }
      if (fetched.length === 0) {
        throw new Error("No models returned — is the service running?");
      }
      setLiveModels(selectedProvider, fetched);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(selectedProvider, msg);
    } finally {
      setLoading(selectedProvider, false);
    }
  }, [selectedProvider, setLoading, setError, setLiveModels]);

  /** Refresh (clear cached + re-fetch). */
  const refresh = useCallback(() => {
    clearLiveModels(selectedProvider);
    fetchLive();
  }, [selectedProvider, clearLiveModels, fetchLive]);

  return {
    providers: PROVIDERS,
    selectedProvider,
    providerDef,
    models,
    isLoading,
    loadError,
    hasLive,
    setProvider,
    fetchLive,
    refresh,
    inferProvider,
  };
}
