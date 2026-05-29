/**
 * SettingsPanel — API keys, provider configuration, and model selection.
 *
 * Design goals:
 * - One section per provider with consistent layout
 * - Single "Test & Refresh" action: tests connection then auto-fetches models
 * - Inline status next to each section header (no floating toasts)
 * - Ollama shows both installed models (from server) and a curated catalog
 * - OpenAI / Anthropic model chips copy the ID to clipboard for node config
 */
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useExecutionStore } from "@/store/executionStore";
import {
  DEFAULT_OLLAMA_CLOUD_BASE_URL,
  isOllamaCloudUrl,
  isRemoteOllamaUrl,
  type LlmProvider,
} from "@/utils/providerConfig";
import { ProviderRegistrySection } from "@/components/layout/ProviderRegistrySection";
import {
  OLLAMA_CATALOG,
  OLLAMA_CLOUD_API_URL,
  catalogOnly,
  type OllamaModelEntry,
} from "@/utils/ollamaCatalog";

// ── Constants ─────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", monospace';

const TAG_COLOR: Record<string, string> = {
  code:   "var(--green)",
  reason: "var(--purple)",
  embed:  "var(--blue)",
  chat:   "var(--muted)",
  vision: "var(--accent)",
};

// ── Types ────────────────────────────────────────────────────────────────────

type TestState = "idle" | "testing" | "ok" | "error";
type FetchState = "idle" | "fetching" | "ok" | "error";

interface ProviderHealth {
  ok: boolean;
  provider: string;
  latency_ms: number;
  message: string;
  model_available: boolean;
  pull_command: string | null;
}

/** True for any non-localhost, non-loopback URL. */
function isRemoteUrl(url: string): boolean {
  return isRemoteOllamaUrl(url);
}

// ── Tiny design system ────────────────────────────────────────────────────────

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{
    fontSize: 11, fontWeight: 700, letterSpacing: "0.07em",
    textTransform: "uppercase", color: "var(--muted)", marginBottom: 12,
  }}>{children}</div>
);

const Divider = () => (
  <div style={{ height: 1, background: "var(--border)", margin: "18px 0" }}/>
);

const Hint = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 10, color: "var(--hint)", marginTop: 4 }}>{children}</div>
);

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ state, message, latency }: {
  state: TestState; message?: string; latency?: number;
}) {
  if (state === "idle") return null;
  if (state === "testing") return (
    <span style={{ fontSize: 10, color: "var(--hint)", display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ animation: "pulse 1s infinite" }}>●</span> Testing…
    </span>
  );
  if (state === "ok") return (
    <span style={{ fontSize: 10, color: "var(--green)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
      ● Connected {latency ? `· ${latency}ms` : ""}
    </span>
  );
  return (
    <span style={{
      fontSize: 10, color: "var(--red)", fontWeight: 600,
      maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }} title={message}>✕ {message || "Failed"}</span>
  );
}

// ── API key input row ─────────────────────────────────────────────────────────

function KeyInput({
  value, onChange, placeholder, onEnter,
}: {
  value: string; onChange: (v: string) => void;
  placeholder: string; onEnter?: () => void;
}) {
  return (
    <input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
      placeholder={placeholder}
      autoComplete="off"
      style={{
        width: "100%", boxSizing: "border-box",
        padding: "8px 11px", borderRadius: 6, fontSize: 12,
        border: `1px solid ${value ? "var(--border-md)" : "var(--border)"}`,
        background: "var(--bg)", color: "var(--text)", fontFamily: MONO,
        outline: "none", transition: "border-color 0.15s",
      }}
    />
  );
}

// ── Action buttons ────────────────────────────────────────────────────────────

const Btn = ({ children, onClick, disabled, primary, small }: {
  children: React.ReactNode; onClick?: () => void;
  disabled?: boolean; primary?: boolean; small?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      padding: small ? "4px 10px" : "6px 14px",
      border: primary ? "none" : "1px solid var(--border-md)",
      borderRadius: 5, cursor: disabled ? "default" : "pointer",
      background: primary ? "var(--accent)" : "var(--surface-3)",
      color: primary ? "#1a1207" : disabled ? "var(--hint)" : "var(--text)",
      fontSize: 11, fontWeight: primary ? 700 : 500, fontFamily: "inherit",
      opacity: disabled ? 0.6 : 1,
      whiteSpace: "nowrap" as const,
    }}
  >{children}</button>
);

// ── Model chip grid ────────────────────────────────────────────────────────────

function ModelGrid({
  installed, catalog, activeModel, onSelect,
  copyOnly, fetchState, onRefresh,
  showCatalogFilter = "",
}: {
  installed: string[];
  catalog?: OllamaModelEntry[];
  activeModel?: string;
  onSelect: (m: string) => void;
  copyOnly?: boolean;
  fetchState: FetchState;
  onRefresh: () => void;
  showCatalogFilter?: string;
}) {
  const [copied, setCopied]     = useState("");
  const [showAll, setShowAll]   = useState(false);
  const [catFilter, setCatFilter] = useState(showCatalogFilter);

  function handleClick(m: string) {
    if (copyOnly) {
      navigator.clipboard.writeText(m).catch(() => {});
      setCopied(m);
      setTimeout(() => setCopied(""), 2000);
    } else {
      onSelect(m);
    }
  }

  const chipStyle = (id: string, isInstalled: boolean): React.CSSProperties => ({
    padding: "3px 9px", borderRadius: 4, fontSize: 11, fontFamily: MONO,
    cursor: "pointer", whiteSpace: "nowrap",
    border: activeModel === id ? "1px solid var(--accent)"
      : isInstalled ? "1px solid var(--green-dim, rgba(95,191,127,0.3))"
      : "1px solid var(--border)",
    background: activeModel === id ? "var(--accent-soft)"
      : isInstalled ? "rgba(95,191,127,0.06)"
      : "var(--surface-3)",
    color: copied === id ? "var(--green)"
      : activeModel === id ? "var(--accent)"
      : isInstalled ? "var(--green)"
      : "var(--text)",
  });

  // Curated catalog filtered by search
  const filteredCatalog = catalog?.filter((m) => {
    if (!catFilter) return true;
    if (catFilter === "free") return m.free === true;
    const q = catFilter.toLowerCase();
    return m.id.toLowerCase().includes(q)
      || m.family.toLowerCase().includes(q)
      || m.tags.some((t) => t.includes(q));
  }) ?? [];
  const visibleCatalog = showAll ? filteredCatalog : filteredCatalog.slice(0, 18);

  return (
    <div style={{ marginTop: 10 }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {installed.length > 0 && (
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: "0.06em", color: "var(--green)" }}>
            ● {installed.length} installed
          </span>
        )}
        {fetchState === "fetching" && (
          <span style={{ fontSize: 10, color: "var(--hint)" }}>Loading…</span>
        )}
        {fetchState === "error" && (
          <span style={{ fontSize: 10, color: "var(--red)" }}>Failed to fetch ·{" "}
            <button onClick={onRefresh} style={{ color: "var(--accent)", background: "none",
              border: "none", cursor: "pointer", padding: 0, fontSize: 10 }}>retry</button>
          </span>
        )}
        <button onClick={onRefresh} title="Refresh model list"
          disabled={fetchState === "fetching"}
          style={{ marginLeft: "auto", background: "transparent", border: "none",
            color: "var(--hint)", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>
          ↻
        </button>
        {copyOnly && installed.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--hint)" }}>click to copy ID</span>
        )}
      </div>

      {/* Installed models */}
      {installed.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {installed.map((m) => (
            <button key={m} onClick={() => handleClick(m)} title={copyOnly ? `Copy "${m}"` : `Use ${m}`}
              style={chipStyle(m, true)}>
              {copied === m ? "✓ copied" : m}
            </button>
          ))}
        </div>
      )}

      {/* Catalog section (Ollama only) */}
      {catalog && catalog.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, marginTop: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.06em", color: "var(--muted)" }}>
              Available to pull / run
            </span>
            <input
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              placeholder="filter…"
              style={{
                padding: "2px 7px", borderRadius: 3, fontSize: 11,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontFamily: "inherit", width: 90,
              }}
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {visibleCatalog.map((m) => (
              <button
                key={m.id}
                onClick={() => handleClick(m.id)}
                title={`${m.label} · ${m.size}\nTags: ${m.tags.join(", ")}\nClick to use`}
                style={{
                  ...chipStyle(m.id, false),
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                {m.tags.map((t) => (
                  <span key={t} style={{ width: 4, height: 4, borderRadius: "50%",
                    background: TAG_COLOR[t] ?? "var(--muted)", flexShrink: 0 }}/>
                ))}
                {copied === m.id ? "✓ copied" : m.id}
                <span style={{ fontSize: 9, color: "var(--hint)", marginLeft: 1 }}>{m.size}</span>
                {m.free && (
                  <span style={{ fontSize: 8, padding: "0 4px", borderRadius: 3,
                    background: "rgba(95,191,127,0.15)", color: "var(--green)",
                    border: "1px solid rgba(95,191,127,0.3)", lineHeight: "14px" }}>free</span>
                )}
              </button>
            ))}
            {filteredCatalog.length > 18 && (
              <button onClick={() => setShowAll((v) => !v)} style={{
                padding: "3px 9px", borderRadius: 4, fontSize: 11, border: "1px dashed var(--border)",
                background: "transparent", color: "var(--hint)", cursor: "pointer", fontFamily: "inherit",
              }}>
                {showAll ? "Show less" : `+${filteredCatalog.length - 18} more`}
              </button>
            )}
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 5, flexWrap: "wrap" }}>
            {[
              { label: "●  code",   filter: "code"   },
              { label: "●  reason", filter: "reason" },
              { label: "●  chat",   filter: "chat"   },
              { label: "●  embed",  filter: "embed"  },
            ].map(({ label, filter }) => (
              <button key={filter} onClick={() => setCatFilter(catFilter === filter ? "" : filter)}
                style={{
                  padding: "1px 7px", borderRadius: 99, fontSize: 10, border: "1px solid var(--border)",
                  background: catFilter === filter ? "var(--surface-3)" : "transparent",
                  color: catFilter === filter ? TAG_COLOR[filter] : "var(--hint)",
                  cursor: "pointer", fontFamily: "inherit",
                }}>{label}</button>
            ))}
            <button onClick={() => {
              void OLLAMA_CATALOG; // referenced for import
              setCatFilter(catFilter === "free" ? "" : "free");
            }}
              style={{
                padding: "1px 7px", borderRadius: 99, fontSize: 10, border: "1px solid var(--border)",
                background: catFilter === "free" ? "rgba(95,191,127,0.12)" : "transparent",
                color: catFilter === "free" ? "var(--green)" : "var(--hint)",
                cursor: "pointer", fontFamily: "inherit",
              }}>☁ free cloud</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Collapsible model list ────────────────────────────────────────────────────

function ModelDropdown({
  label, count, children,
}: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{
        cursor: "pointer", fontSize: 11, color: "var(--muted)",
        userSelect: "none", listStyle: "none",
        display: "flex", alignItems: "center", gap: 6, padding: "3px 0",
      }}>
        <span style={{ fontSize: 9 }}>▶</span>
        {label}
        <span style={{
          padding: "1px 6px", borderRadius: 99, fontSize: 10,
          background: "var(--surface-3)", color: "var(--hint)", border: "1px solid var(--border)",
        }}>{count}</span>
      </summary>
      <div style={{ paddingTop: 8 }}>{children}</div>
    </details>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    apiKey, setApiKey,
    openaiApiKey, setOpenaiApiKey,
    ollamaApiKey, setOllamaApiKey,
    customApiUrl, setCustomApiUrl,
    customApiKey, setCustomApiKey,
    customApiModel, setCustomApiModel,
    llmProvider, setLlmProvider,
    ollamaBaseUrl, setOllamaBaseUrl,
    ollamaModel, setOllamaModel,
    continueOnError, setContinueOnError,
  } = useExecutionStore();

  // ── Drafts ──────────────────────────────────────────────────────────────────
  const [openaiDraft,      setOpenaiDraft]      = useState(openaiApiKey);
  const [anthropicDraft,   setAnthropicDraft]   = useState(apiKey);
  const [ollamaUrlDraft,   setOllamaUrlDraft]   = useState(ollamaBaseUrl);
  const [ollamaKeyDraft,   setOllamaKeyDraft]   = useState(ollamaApiKey);
  const [ollamaModelDraft, setOllamaModelDraft] = useState(ollamaModel);
  // Custom OpenAI-compatible endpoint — backed by executionStore
  const [customUrl,   setCustomUrl]   = useState(customApiUrl);
  const [customKey,   setCustomKey]   = useState(customApiKey);
  const [customModel, setCustomModel] = useState(customApiModel);
  const [customTest, setCustomTest] = useState<TestState>("idle");
  const [customLatency, setCustomLatency] = useState(0);
  const [customErr,  setCustomErr]  = useState("");
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customFetch, setCustomFetch] = useState<FetchState>("idle");

  // ── Test state ───────────────────────────────────────────────────────────────
  const [openaiTest,    setOpenaiTest]    = useState<TestState>("idle");
  const [anthropicTest, setAnthropicTest] = useState<TestState>("idle");
  const [ollamaTest,    setOllamaTest]    = useState<TestState>("idle");
  const [openaiLatency,    setOpenaiLatency]    = useState(0);
  const [anthropicLatency, setAnthropicLatency] = useState(0);
  const [ollamaLatency,    setOllamaLatency]    = useState(0);
  const [openaiErr,     setOpenaiErr]     = useState("");
  const [anthropicErr,  setAnthropicErr]  = useState("");
  const [ollamaErr,     setOllamaErr]     = useState("");
  const [ollamaPull,    setOllamaPull]    = useState<string | null>(null);

  // ── Model state ──────────────────────────────────────────────────────────────
  const [openaiModels,    setOpenaiModels]    = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const [ollamaInstalled, setOllamaInstalled] = useState<string[]>([]);

  const [openAiFetch,    setOpenAiFetch]    = useState<FetchState>("idle");
  const [anthropicFetch, setAnthropicFetch] = useState<FetchState>("idle");
  const [ollamaFetch,    setOllamaFetch]    = useState<FetchState>("idle");

  // ── Fetch helpers ────────────────────────────────────────────────────────────

  const fetchOpenAIModels = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setOpenAiFetch("fetching");
    try {
      const models = await invoke<string[]>("list_provider_models", {
        provider: "openai", apiKey: key.trim(), baseUrl: "",
      });
      setOpenaiModels(models);
      setOpenAiFetch("ok");
    } catch { setOpenAiFetch("error"); }
  }, []);

  const fetchAnthropicModels = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setAnthropicFetch("fetching");
    try {
      const models = await invoke<string[]>("list_provider_models", {
        provider: "anthropic", apiKey: key.trim(), baseUrl: "",
      });
      setAnthropicModels(models);
      setAnthropicFetch("ok");
    } catch { setAnthropicFetch("error"); }
  }, []);

  const fetchCustomModels = useCallback(async (url: string, key: string) => {
    if (!url.trim()) return;
    setCustomFetch("fetching");
    try {
      const models = await invoke<string[]>("list_provider_models", {
        provider: "openai-compatible", apiKey: key.trim(), baseUrl: url.trim(),
      });
      setCustomModels(models);
      setCustomFetch("ok");
    } catch { setCustomFetch("error"); }
  }, []);

  const fetchOllamaModels = useCallback(async (url: string, key: string) => {
    setOllamaFetch("fetching");
    const isCloud = llmProvider === "ollama-cloud" || isOllamaCloudUrl(url) || isRemoteUrl(url);
    try {
      const models = await invoke<string[]>("list_provider_models", {
        provider: isCloud ? "ollama-cloud" : "ollama",
        apiKey: key.trim(),
        baseUrl: url.trim(),
      });
      setOllamaInstalled(models);
      setOllamaFetch("ok");
    } catch (e) {
      setOllamaFetch("error");
      console.warn("[ollama models]", e);
    }
  }, [llmProvider]);

  // ── Test (health check + auto-fetch models) ──────────────────────────────────

  async function testOpenAI() {
    setOpenaiTest("testing"); setOpenaiErr("");
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: "openai", apiKey: openaiDraft.trim(), baseUrl: "", model: "",
      });
      setOpenaiTest(h.ok ? "ok" : "error");
      setOpenaiLatency(h.latency_ms);
      setOpenaiErr(h.ok ? "" : h.message);
      if (h.ok) fetchOpenAIModels(openaiDraft);
    } catch (e) { setOpenaiTest("error"); setOpenaiErr(String(e)); }
  }

  async function testAnthropic() {
    setAnthropicTest("testing"); setAnthropicErr("");
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: "anthropic", apiKey: anthropicDraft.trim(), baseUrl: "", model: "",
      });
      setAnthropicTest(h.ok ? "ok" : "error");
      setAnthropicLatency(h.latency_ms);
      setAnthropicErr(h.ok ? "" : h.message);
      if (h.ok) fetchAnthropicModels(anthropicDraft);
    } catch (e) { setAnthropicTest("error"); setAnthropicErr(String(e)); }
  }

  async function testCustom() {
    if (!customUrl.trim()) return;
    setCustomTest("testing"); setCustomErr("");
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: "openai-compatible", apiKey: customKey.trim(), baseUrl: customUrl.trim(), model: customModel.trim(),
      });
      setCustomTest(h.ok ? "ok" : "error");
      setCustomLatency(h.latency_ms);
      setCustomErr(h.ok ? "" : h.message);
      if (h.ok) fetchCustomModels(customUrl, customKey);
    } catch (e) { setCustomTest("error"); setCustomErr(String(e)); }
  }

  async function testOllama() {
    setOllamaTest("testing"); setOllamaErr(""); setOllamaPull(null);
    const isCloud = llmProvider === "ollama-cloud" || isRemoteOllamaUrl(ollamaUrlDraft);
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: isCloud ? "ollama-cloud" : "ollama",
        apiKey: ollamaKeyDraft.trim(),
        baseUrl: ollamaUrlDraft.trim(),
        model: ollamaModelDraft.trim(),
      });
      setOllamaTest(h.ok ? "ok" : "error");
      setOllamaLatency(h.latency_ms);
      setOllamaErr(h.ok ? "" : h.message);
      setOllamaPull(h.pull_command);
      if (h.ok) fetchOllamaModels(ollamaUrlDraft, ollamaKeyDraft);
    } catch (e) { setOllamaTest("error"); setOllamaErr(String(e)); }
  }

  function saveAll() {
    setOpenaiApiKey(openaiDraft.trim());
    setApiKey(anthropicDraft.trim());
    setOllamaApiKey(ollamaKeyDraft.trim());
    setOllamaBaseUrl(ollamaUrlDraft.trim());
    setOllamaModel(ollamaModelDraft.trim());
    setCustomApiUrl(customUrl.trim());
    setCustomApiKey(customKey.trim());
    setCustomApiModel(customModel.trim() || "gpt-4o-mini");
    onClose();
  }

  const providerModes: { value: LlmProvider; label: string; hint: string }[] = [
    { value: "auto",              label: "Auto",         hint: "Use each node's configured provider" },
    { value: "openai",            label: "OpenAI",       hint: "Force all agents to OpenAI" },
    { value: "anthropic",         label: "Anthropic",    hint: "Force all agents to Anthropic" },
    { value: "ollama",            label: "Ollama",       hint: "Force all agents to local Ollama" },
    { value: "ollama-cloud",      label: "Ollama Cloud", hint: "Force all agents to Ollama Cloud" },
    { value: "openai-compatible", label: "Custom",       hint: `Force all agents to custom endpoint (${customUrl || "not configured"})` },
  ];

  const ollamaCatalog = catalogOnly(ollamaInstalled);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: 48, zIndex: 200,
        fontFamily: "inherit", overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: "96vw",
          background: "var(--surface-2)", border: "1px solid var(--border-md)",
          borderRadius: 14, boxShadow: "0 32px 90px rgba(0,0,0,0.7)",
          overflow: "hidden", marginBottom: 48,
        }}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{
          display: "flex", alignItems: "center", padding: "14px 20px",
          borderBottom: "1px solid var(--border)", background: "var(--surface)",
        }}>
          <NodeIcon name="cog" size={16} color="var(--accent)" style={{ marginRight: 10 }}/>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>Provider Settings</span>
          <button onClick={onClose} style={{
            width: 26, height: 26, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}>
            <NodeIcon name="x" size={13}/>
          </button>
        </div>

        <div style={{ padding: "20px", maxHeight: "76vh", overflowY: "auto" }}>

          {/* ── Active provider mode ──────────────────────────────────────── */}
          <SectionTitle>Active Provider Mode</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5, marginBottom: 8 }}>
            {providerModes.map(({ value, label, hint }) => (
              <button
                key={value}
                onClick={() => setLlmProvider(value)}
                title={hint}
                style={{
                  padding: "7px 4px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                  fontFamily: "inherit", cursor: "pointer", textAlign: "center",
                  border: llmProvider === value ? "none" : "1px solid var(--border-md)",
                  background: llmProvider === value ? "var(--accent)" : "var(--surface-3)",
                  color: llmProvider === value ? "#1a1207" : "var(--text)",
                  transition: "all 0.12s",
                }}
              >{label}</button>
            ))}
          </div>
          <Hint>
            <strong>Auto</strong> uses each node's model setting.
            Force modes override all agents for this run.
          </Hint>

          <Divider />

          {/* ── OpenAI ────────────────────────────────────────────────────── */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <SectionTitle>OpenAI</SectionTitle>
            <StatusBadge state={openaiTest} message={openaiErr} latency={openaiLatency}/>
          </div>

          <KeyInput
            value={openaiDraft}
            onChange={setOpenaiDraft}
            placeholder="sk-..."
            onEnter={testOpenAI}
          />
          <Hint>GPT-5.5-xHigh / High / Mid models. Stored in localStorage only — never committed to disk.</Hint>

          {openaiDraft && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <Btn onClick={testOpenAI} disabled={openaiTest === "testing"}>
                {openaiTest === "testing" ? "Testing…" : "▶ Test connection"}
              </Btn>
              <Btn onClick={() => fetchOpenAIModels(openaiDraft)} disabled={openAiFetch === "fetching"}>
                {openAiFetch === "fetching" ? "Loading…" : "↻ Models"}
              </Btn>
              <Btn primary onClick={() => setOpenaiApiKey(openaiDraft.trim())} small>Save</Btn>
            </div>
          )}

          {openaiTest === "error" && (
            <div style={{
              marginTop: 8, padding: "7px 10px", borderRadius: 5,
              background: "rgba(224,117,117,0.08)", border: "1px solid rgba(224,117,117,0.25)",
              fontSize: 11, color: "var(--red)", wordBreak: "break-word",
            }}>✕ {openaiErr}</div>
          )}

          <ModelDropdown label="Available models" count={openaiModels.length}>
            <ModelGrid
              installed={openaiModels}
              activeModel=""
              onSelect={() => {}}
              copyOnly
              fetchState={openAiFetch}
              onRefresh={() => fetchOpenAIModels(openaiDraft)}
            />
          </ModelDropdown>

          <Divider />

          {/* ── Anthropic ─────────────────────────────────────────────────── */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <SectionTitle>Anthropic / Claude</SectionTitle>
            <StatusBadge state={anthropicTest} message={anthropicErr} latency={anthropicLatency}/>
          </div>

          <KeyInput
            value={anthropicDraft}
            onChange={setAnthropicDraft}
            placeholder="sk-ant-..."
            onEnter={testAnthropic}
          />
          <Hint>Visual Inspector (claude-sonnet-4.x) and Claude-only agents. Stored in localStorage only.</Hint>

          {anthropicDraft && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <Btn onClick={testAnthropic} disabled={anthropicTest === "testing"}>
                {anthropicTest === "testing" ? "Testing…" : "▶ Test connection"}
              </Btn>
              <Btn onClick={() => fetchAnthropicModels(anthropicDraft)} disabled={anthropicFetch === "fetching"}>
                {anthropicFetch === "fetching" ? "Loading…" : "↻ Models"}
              </Btn>
              <Btn primary onClick={() => setApiKey(anthropicDraft.trim())} small>Save</Btn>
            </div>
          )}

          {anthropicTest === "error" && (
            <div style={{
              marginTop: 8, padding: "7px 10px", borderRadius: 5,
              background: "rgba(224,117,117,0.08)", border: "1px solid rgba(224,117,117,0.25)",
              fontSize: 11, color: "var(--red)", wordBreak: "break-word",
            }}>✕ {anthropicErr}</div>
          )}

          <ModelDropdown label="Available models" count={anthropicModels.length}>
            <ModelGrid
              installed={anthropicModels}
              activeModel=""
              onSelect={() => {}}
              copyOnly
              fetchState={anthropicFetch}
              onRefresh={() => fetchAnthropicModels(anthropicDraft)}
            />
          </ModelDropdown>

          <Divider />

          {/* ── Ollama ────────────────────────────────────────────────────── */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <SectionTitle>Ollama — Local or Cloud</SectionTitle>
            <StatusBadge state={ollamaTest} message={ollamaErr} latency={ollamaLatency}/>
          </div>

          {/* Endpoint URL */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              type="text"
              value={ollamaUrlDraft}
              onChange={(e) => setOllamaUrlDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && testOllama()}
              placeholder="http://localhost:11434"
              style={{
                flex: 1, padding: "8px 11px", borderRadius: 6, fontSize: 12,
                border: "1px solid var(--border-md)",
                background: "var(--bg)", color: "var(--text)", fontFamily: MONO,
                outline: "none",
              }}
            />
            <Btn onClick={testOllama} disabled={ollamaTest === "testing"}>
              {ollamaTest === "testing" ? "Testing…" : "▶ Test"}
            </Btn>
            <Btn onClick={() => fetchOllamaModels(ollamaUrlDraft, ollamaKeyDraft)} disabled={ollamaFetch === "fetching"}>
              {ollamaFetch === "fetching" ? "…" : "↻ Models"}
            </Btn>
          </div>
          {/* Quick presets */}
          <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--hint)" }}>Presets:</span>
            <button
              onClick={() => { setOllamaUrlDraft("http://localhost:11434"); }}
              style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontFamily: MONO,
                border: "1px solid var(--border)", background: "var(--surface-3)", color: "var(--muted)", cursor: "pointer" }}
            >localhost:11434</button>
            <button
              onClick={() => {
                setOllamaUrlDraft(OLLAMA_CLOUD_API_URL);
                setLlmProvider("ollama-cloud");
                setOllamaModelDraft("gemma4:31b-cloud");
              }}
              style={{ padding: "2px 10px", borderRadius: 4, fontSize: 10, fontFamily: MONO,
                border: "1px solid rgba(95,191,127,0.5)", background: "rgba(95,191,127,0.1)",
                color: "var(--green)", cursor: "pointer", fontWeight: 600 }}
              title="Sets URL → api.ollama.com, provider → Ollama Cloud, model → gemma4:31b-cloud"
            >☁ gemma4:31b-cloud</button>
          </div>

          {/* Cloud setup callout — shown when Ollama Cloud is configured */}
          {(llmProvider === "ollama-cloud" || isOllamaCloudUrl(ollamaUrlDraft)) && (
            <div style={{
              marginTop: 8, padding: "9px 12px", borderRadius: 6,
              background: "rgba(95,191,127,0.06)", border: "1px solid rgba(95,191,127,0.25)",
              fontSize: 11, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 700, color: "var(--green)", marginBottom: 4 }}>
                ☁ Ollama Cloud setup
              </div>
              <ol style={{ margin: "0 0 0 16px", padding: 0, color: "var(--text)" }}>
                <li>Get a key at <code style={{ fontFamily: MONO }}>ollama.com/settings</code></li>
                <li>Paste it in <strong>Auth Token</strong> below → <strong>Save</strong></li>
                <li>Click <strong>▶ Test</strong> — should show <em>"gemma4:31b-cloud will stream on-demand"</em></li>
                <li>Set Provider Mode → <strong>Ollama Cloud</strong></li>
                <li>Click <strong>▶ Run</strong> on any workflow</li>
              </ol>
              <div style={{ marginTop: 6, color: "var(--hint)" }}>
                Key stored in <code style={{ fontFamily: MONO }}>localStorage</code> only.
                Never written to disk or workflow files.
                Alternatively: <code style={{ fontFamily: MONO }}>OLLAMA_API_KEY</code> env var.
              </div>
            </div>
          )}

          <Hint>
            Local: <code style={{ fontFamily: MONO }}>http://localhost:11434</code> ·
            Remote: any <code style={{ fontFamily: MONO }}>https://host:port</code> ·
            Cloud: <code style={{ fontFamily: MONO }}>{DEFAULT_OLLAMA_CLOUD_BASE_URL}</code>
          </Hint>

          {/* Auth token — shown for remote and cloud */}
          {(llmProvider === "ollama-cloud" || isRemoteUrl(ollamaUrlDraft)) && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5, display: "flex", gap: 6, alignItems: "center" }}>
                Auth Token
                {isOllamaCloudUrl(ollamaUrlDraft) && (
                  <span style={{ fontSize: 10, color: "var(--accent)", background: "var(--accent-soft)",
                    padding: "1px 6px", borderRadius: 3 }}>required for ollama.com</span>
                )}
                {!isOllamaCloudUrl(ollamaUrlDraft) && (
                  <span style={{ fontSize: 10, color: "var(--hint)" }}>optional — for authenticated endpoints</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={ollamaKeyDraft}
                  onChange={(e) => setOllamaKeyDraft(e.target.value)}
                  placeholder="Bearer token / API key"
                  autoComplete="off"
                  style={{
                    flex: 1, padding: "8px 11px", borderRadius: 6, fontSize: 12,
                    border: `1px solid ${ollamaKeyDraft
                      ? "var(--border-md)"
                      : isOllamaCloudUrl(ollamaUrlDraft) ? "var(--accent)" : "var(--border)"}`,
                    background: "var(--bg)", color: "var(--text)", fontFamily: MONO, outline: "none",
                  }}
                />
                <Btn primary onClick={() => setOllamaApiKey(ollamaKeyDraft.trim())} small>Save</Btn>
              </div>
              <Hint>Or set env <code style={{ fontFamily: MONO }}>OLLAMA_API_KEY</code></Hint>
            </div>
          )}

          {/* Test feedback */}
          {ollamaTest === "error" && (
            <div style={{
              marginTop: 8, padding: "7px 10px", borderRadius: 5,
              background: "rgba(224,117,117,0.08)", border: "1px solid rgba(224,117,117,0.25)",
              fontSize: 11, color: "var(--red)", wordBreak: "break-word",
            }}>
              ✕ {ollamaErr || "Not reachable — run `ollama serve` or check the URL"}
              {ollamaPull && (
                <div style={{ marginTop: 4, color: "var(--hint)" }}>
                  Install model: <code style={{ fontFamily: MONO }}>{ollamaPull}</code>
                </div>
              )}
            </div>
          )}

          {/* Active model input */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5 }}>
              Active model
              <span style={{ color: "var(--hint)" }}> — type any model name or click below to select</span>
            </div>
            <input
              type="text"
              value={ollamaModelDraft}
              onChange={(e) => setOllamaModelDraft(e.target.value)}
              placeholder="qwen2.5-coder:7b"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 11px", borderRadius: 6, fontSize: 12,
                border: "1px solid var(--border-md)",
                background: "var(--bg)", color: "var(--text)", fontFamily: MONO, outline: "none",
              }}
            />
          </div>

          {/* Installed models — collapsed until fetched */}
          <ModelDropdown
            label={ollamaInstalled.length ? "Installed models" : "Models"}
            count={ollamaInstalled.length}
          >
            <ModelGrid
              installed={ollamaInstalled}
              activeModel={ollamaModelDraft}
              onSelect={setOllamaModelDraft}
              fetchState={ollamaFetch}
              onRefresh={() => fetchOllamaModels(ollamaUrlDraft, ollamaKeyDraft)}
            />
          </ModelDropdown>

          {/* Catalog — collapsed by default */}
          <details style={{ marginTop: 6 }}>
            <summary style={{
              cursor: "pointer", fontSize: 11, color: "var(--muted)",
              userSelect: "none", listStyle: "none",
              display: "flex", alignItems: "center", gap: 6, padding: "3px 0",
            }}>
              <span style={{ fontSize: 9 }}>▶</span>
              Ollama model catalog
              <span style={{
                padding: "1px 6px", borderRadius: 99, fontSize: 10,
                background: "var(--surface-3)", color: "var(--hint)", border: "1px solid var(--border)",
              }}>{ollamaCatalog.length}</span>
              <span style={{ fontSize: 10, color: "var(--hint)", marginLeft: 4 }}>
                click to pull / run
              </span>
            </summary>
            <div style={{ paddingTop: 8 }}>
              <ModelGrid
                installed={[]}
                catalog={ollamaCatalog}
                activeModel={ollamaModelDraft}
                onSelect={setOllamaModelDraft}
                fetchState="idle"
                onRefresh={() => {}}
              />
            </div>
          </details>

          {ollamaPull && ollamaTest === "ok" && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--hint)" }}>
              Pull command: <code style={{ fontFamily: MONO, background: "var(--surface-3)",
                padding: "1px 5px", borderRadius: 3 }}>{ollamaPull}</code>
            </div>
          )}

          <Divider />

          {/* ── Custom OpenAI-compatible endpoint ─────────────────────── */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <SectionTitle>Custom Endpoint <span style={{ fontWeight: 400, textTransform: "none", fontSize: 10 }}>(OpenAI-compatible)</span></SectionTitle>
            <StatusBadge state={customTest} message={customErr} latency={customLatency}/>
          </div>

          <input
            type="text"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && testCustom()}
            placeholder="https://your-server.com/v1"
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "8px 11px", borderRadius: 6, fontSize: 12,
              border: "1px solid var(--border-md)",
              background: "var(--bg)", color: "var(--text)", fontFamily: MONO, outline: "none",
              marginBottom: 6,
            }}
          />
          <KeyInput
            value={customKey}
            onChange={setCustomKey}
            placeholder="API key (if required)"
            onEnter={testCustom}
          />
          {/* Model name — required for execution */}
          <div style={{ marginTop: 6 }}>
            <label style={{ fontSize: 11, color: "var(--muted)", display: "block", marginBottom: 4 }}>
              Model name <span style={{ color: "var(--hint)" }}>— used when this provider is active</span>
            </label>
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="gpt-4o-mini  /  mistral  /  llama3.1:8b"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 11px", borderRadius: 6, fontSize: 12,
                border: `1px solid ${customModel ? "var(--border-md)" : "var(--accent)"}`,
                background: "var(--bg)", color: "var(--text)",
                fontFamily: MONO, outline: "none",
              }}
            />
          </div>
          <Hint>LM Studio, vLLM, Groq, Together, Fireworks, or any OpenAI-compatible server.</Hint>

          {customUrl && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <Btn onClick={testCustom} disabled={customTest === "testing"}>
                {customTest === "testing" ? "Testing…" : "▶ Test connection"}
              </Btn>
              <Btn onClick={() => fetchCustomModels(customUrl, customKey)} disabled={customFetch === "fetching"}>
                {customFetch === "fetching" ? "Loading…" : "↻ Models"}
              </Btn>
              <Btn primary onClick={() => {
                setCustomApiUrl(customUrl.trim());
                setCustomApiKey(customKey.trim());
                setCustomApiModel(customModel.trim() || "gpt-4o-mini");
              }} small>Save</Btn>
            </div>
          )}

          {customTest === "error" && (
            <div style={{
              marginTop: 8, padding: "7px 10px", borderRadius: 5,
              background: "rgba(224,117,117,0.08)", border: "1px solid rgba(224,117,117,0.25)",
              fontSize: 11, color: "var(--red)", wordBreak: "break-word",
            }}>✕ {customErr}</div>
          )}

          <ModelDropdown label="Available models" count={customModels.length}>
            <ModelGrid
              installed={customModels}
              activeModel=""
              onSelect={() => {}}
              copyOnly
              fetchState={customFetch}
              onRefresh={() => fetchCustomModels(customUrl, customKey)}
            />
          </ModelDropdown>

          <Divider />

          {/* ── Execution ─────────────────────────────────────────────────── */}
          <SectionTitle>Execution Behavior</SectionTitle>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={continueOnError}
              onChange={(e) => setContinueOnError(e.target.checked)}
              style={{ accentColor: "var(--accent)", width: 14, height: 14 }}
            />
            <div>
              <div style={{ fontSize: 12 }}>Continue on agent error</div>
              <Hint>Skip failing agents and continue with the rest of the workflow.</Hint>
            </div>
          </label>
        </div>

        {/* Provider registry */}
        <ProviderRegistrySection />

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: 8,
          padding: "12px 20px", borderTop: "1px solid var(--border)",
          background: "var(--surface)",
        }}>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={saveAll}>Save all &amp; close</Btn>
        </div>
      </div>
    </div>
  );
}
