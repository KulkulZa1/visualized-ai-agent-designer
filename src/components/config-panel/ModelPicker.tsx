/**
 * ModelPicker — unified provider + model selector.
 *
 * Keeps the selected provider in LOCAL component state so two pickers on the
 * same page (primary + fallback) don't step on each other.
 * Live-fetched model lists are cached in the global modelStore so a fetch
 * performed for one picker is immediately available to another.
 */
import { useState, useEffect, useCallback } from "react";
import {
  PROVIDERS, PROVIDER_MAP, inferProvider,
  type ModelInfo, type ProviderId,
} from "@/utils/modelRegistry";
import { useModelStore } from "@/store/modelStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";

const MONO = '"JetBrains Mono", ui-monospace, monospace';

// ── live-fetch helpers (same logic as useModelRegistry) ──────────────────────

interface OllamaTagsResponse { models: { name: string; details?: { parameter_size?: string; family?: string } }[] }
interface OpenRouterModelsResponse { data: { id: string; name: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] }

async function fetchOllamaModels(endpoint: string): Promise<ModelInfo[]> {
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json: OllamaTagsResponse = await res.json();
  return (json.models ?? []).map((m) => ({
    id: m.name,
    label: m.name + (m.details?.parameter_size ? ` (${m.details.parameter_size})` : ""),
    contextK: 128,
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
      costInPerMtok:  m.pricing?.prompt      ? parseFloat(m.pricing.prompt)      * 1_000_000 : undefined,
      costOutPerMtok: m.pricing?.completion  ? parseFloat(m.pricing.completion)  * 1_000_000 : undefined,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── component ────────────────────────────────────────────────────────────────

export interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
  /** When true: smaller font, no detail chip — suitable for the fallback slot */
  compact?: boolean;
}

export function ModelPicker({ value, onChange, compact = false }: ModelPickerProps) {
  const [provider, setProvider] = useState<ProviderId>(() => inferProvider(value || ""));

  // Global cache (read + write)
  const liveModels    = useModelStore((s) => s.liveModels);
  const loading       = useModelStore((s) => s.loading);
  const error         = useModelStore((s) => s.error);
  const setLiveModels = useModelStore((s) => s.setLiveModels);
  const setLoading    = useModelStore((s) => s.setLoading);
  const setError      = useModelStore((s) => s.setError);
  const clearLive     = useModelStore((s) => s.clearLiveModels);

  // Re-infer provider when value changes externally (e.g. switching selected node)
  useEffect(() => {
    if (value) setProvider(inferProvider(value));
  }, [value]);

  const providerDef = PROVIDER_MAP[provider];
  const models: ModelInfo[] = liveModels[provider] ?? providerDef?.defaultModels ?? [];
  const isLoading = loading[provider] ?? false;
  const loadError = error[provider] ?? null;
  const hasLive   = !!liveModels[provider];
  const canFetch  = !!providerDef?.apiEndpoint;

  const handleProviderSelect = (id: ProviderId) => {
    setProvider(id);
    if (id === "custom") return;
    // Auto-select the first model of the new provider if current value doesn't belong
    const avail = liveModels[id] ?? PROVIDER_MAP[id]?.defaultModels ?? [];
    if (avail.length > 0 && !avail.find((m) => m.id === value)) {
      onChange(avail[0].id);
    }
  };

  const fetchLive = useCallback(async () => {
    if (!providerDef?.apiEndpoint) return;
    setLoading(provider, true);
    setError(provider, null);
    try {
      let fetched: ModelInfo[];
      if (provider === "ollama") fetched = await fetchOllamaModels(providerDef.apiEndpoint);
      else if (provider === "openrouter") fetched = await fetchOpenRouterModels(providerDef.apiEndpoint);
      else throw new Error(`No live fetch for "${provider}"`);
      if (fetched.length === 0) throw new Error("No models returned — is the service running?");
      setLiveModels(provider, fetched);
    } catch (e) {
      setError(provider, e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(provider, false);
    }
  }, [provider, providerDef, setLoading, setError, setLiveModels]);

  const selectedInfo = models.find((m) => m.id === value);
  const chipSz = compact ? 10 : 11;
  const inputSz = compact ? 11 : 12;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 5 : 7 }}>

      {/* ── Provider chips ────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {PROVIDERS.map((p) => (
          <button key={p.id} onClick={() => handleProviderSelect(p.id)} style={{
            padding: compact ? "2px 7px" : "3px 9px",
            border: "none", borderRadius: 99, cursor: "pointer",
            fontSize: chipSz, fontFamily: "inherit",
            background: provider === p.id ? `${p.logoColor}22` : "var(--surface-3)",
            color:      provider === p.id ? p.logoColor          : "var(--muted)",
            outline:    provider === p.id ? `1px solid ${p.logoColor}55` : "none",
            fontWeight: provider === p.id ? 600 : 400,
            transition: "all 80ms",
          }}>{p.label}</button>
        ))}
      </div>

      {/* ── Live-fetch status bar ──────────────────────────────────────── */}
      {canFetch && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: loadError ? "var(--red)" : "var(--hint)", flex: 1 }}>
            {isLoading  ? "Fetching models…"
            : loadError ? `⚠ ${loadError}`
            : hasLive   ? `${models.length} models from API`
            :             `${models.length} defaults · click to load live`}
          </span>
          <button
            onClick={isLoading ? undefined : (hasLive ? () => { clearLive(provider); void fetchLive(); } : () => void fetchLive())}
            disabled={isLoading}
            style={{
              padding: "2px 8px", border: "none", borderRadius: 4,
              cursor: isLoading ? "default" : "pointer",
              background: "var(--surface-3)",
              color: isLoading ? "var(--hint)" : "var(--accent)",
              fontSize: 10, fontFamily: "inherit",
            }}>
            {isLoading ? "Loading…" : hasLive ? "Refresh" : "Load from API"}
          </button>
        </div>
      )}

      {/* ── Ollama Cloud hint ─────────────────────────────────────────── */}
      {provider === "ollama-cloud" && (
        <div style={{ fontSize: 10, color: "var(--hint)", display: "flex", alignItems: "center", gap: 4 }}>
          <NodeIcon name="lock" size={10}/>
          Requires OLLAMA_API_KEY — set in <span style={{ fontFamily: MONO }}>Settings → Auth Token</span>
        </div>
      )}

      {/* ── Model input ───────────────────────────────────────────────── */}
      {provider === "custom" ? (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter any model ID  (e.g. my-org/my-model)"
          style={{
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 4, padding: "6px 8px", color: "var(--text)",
            fontSize: inputSz, fontFamily: MONO, outline: "none", width: "100%",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 4, padding: "6px 8px", color: "var(--text)",
            fontSize: inputSz, fontFamily: "inherit", outline: "none", width: "100%",
            boxSizing: "border-box",
          }}>
          <option value="">— no model —</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          {/* Keep the current value selectable even if it's not in the list */}
          {value && !models.find((m) => m.id === value) && (
            <option value={value}>{value} (custom)</option>
          )}
        </select>
      )}

      {/* ── Model detail chip (full mode only) ───────────────────────── */}
      {selectedInfo && !compact && (
        <div style={{
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 4, padding: "5px 10px",
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px",
          fontSize: 10, color: "var(--muted)", fontFamily: MONO,
        }}>
          <span style={{ color: "var(--text)" }}>{selectedInfo.contextK}k ctx</span>
          {selectedInfo.costInPerMtok !== undefined && (
            <span>{selectedInfo.costInPerMtok === 0 ? "free" : `$${selectedInfo.costInPerMtok}/Mtok in`}</span>
          )}
          {selectedInfo.costOutPerMtok !== undefined && (
            <span>${selectedInfo.costOutPerMtok}/Mtok out</span>
          )}
          {selectedInfo.tags?.map((t) => (
            <span key={t} style={{
              background: "var(--surface-3)", borderRadius: 99,
              padding: "1px 6px", fontSize: 9, color: "var(--hint)",
            }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}
