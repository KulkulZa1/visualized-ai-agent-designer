import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useExecutionStore } from "@/store/executionStore";
import { SUGGESTED_OLLAMA_MODELS } from "@/utils/providerConfig";
import { DEFAULT_PROVIDER_CATALOG } from "@/services/model-providers/providerCatalog";
import type { ProviderConfig } from "@/types/modelProvider";
import { ProviderRegistrySection } from "@/components/layout/ProviderRegistrySection";

interface SettingsPanelProps {
  onClose: () => void;
}

type TestState = "idle" | "testing" | "ok" | "error";
type LlmProvider = "openai" | "anthropic" | "ollama" | "auto";

const MONO = '"JetBrains Mono", monospace';

interface ProviderHealth {
  ok: boolean;
  provider: string;
  latency_ms: number;
  message: string;
  model_available: boolean;
  pull_command: string | null;
}

function KeyRow({
  label, placeholder, hint, value, onChange,
  testState, testError, onTest, onSave,
}: {
  label: string; placeholder: string; hint: string;
  value: string; onChange: (v: string) => void;
  testState: TestState; testError: string;
  onTest: () => void; onSave: () => void;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
        {label}
      </label>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", boxSizing: "border-box",
          padding: "7px 10px", borderRadius: 6, fontSize: 12,
          border: `1px solid ${value ? "var(--border-md)" : "var(--border)"}`,
          background: "var(--surface-3)", color: "var(--text)", fontFamily: MONO,
        }}
      />
      <div style={{ fontSize: 11, color: "var(--hint)", marginTop: 4 }}>{hint}</div>
      {value && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
          <button onClick={onTest} disabled={testState === "testing"} style={{
            padding: "4px 10px", border: "1px solid var(--border-md)", borderRadius: 4,
            background: "var(--surface-3)", color: "var(--text)",
            cursor: testState === "testing" ? "default" : "pointer",
            fontSize: 11, fontWeight: 500, fontFamily: "inherit",
          }}>
            {testState === "testing" ? "Testing…" : "Test"}
          </button>
          <button onClick={onSave} style={{
            padding: "4px 12px", border: "none", borderRadius: 4,
            background: "var(--accent)", color: "#1a1207",
            cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit",
          }}>
            Save
          </button>
          {testState === "ok" && (
            <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 500 }}>✓ Connected</span>
          )}
          {testState === "error" && (
            <div style={{
              fontSize: 11, color: "var(--red)", padding: "4px 8px", borderRadius: 4,
              background: "rgba(224,117,117,0.1)", maxWidth: 260, wordBreak: "break-word",
            }}>
              ✕ {testError || "Unknown error"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderBadge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "accent" | "green" }) {
  const color = tone === "accent" ? "var(--accent)" : tone === "green" ? "var(--green)" : "var(--muted)";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 6px",
      borderRadius: 3,
      background: tone === "accent" ? "var(--accent-soft)" : "var(--surface-3)",
      color,
      fontSize: 10,
      fontFamily: MONO,
    }}>
      {children}
    </span>
  );
}

function ProviderRegistryRow({ provider }: { provider: ProviderConfig }) {
  const capabilityCount = Object.values(provider.capabilities).filter(Boolean).length;
  return (
    <div style={{
      padding: "8px 10px",
      border: "1px solid var(--border)",
      borderRadius: 6,
      background: "var(--surface-3)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: provider.enabled ? "var(--green)" : "var(--hint)",
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{provider.name}</div>
          <div style={{ fontSize: 10, color: "var(--hint)", fontFamily: MONO }}>
            {provider.type} 쨌 {provider.apiKeyRef ?? "no credential ref"}
          </div>
        </div>
        <ProviderBadge tone={provider.isLocal ? "green" : "accent"}>
          {provider.isLocal ? "local" : provider.securityLevel}
        </ProviderBadge>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7 }}>
        <ProviderBadge>{capabilityCount}/4 caps</ProviderBadge>
        {provider.capabilities.streaming && <ProviderBadge>stream</ProviderBadge>}
        {provider.capabilities.toolCalling && <ProviderBadge>tools</ProviderBadge>}
        {provider.capabilities.modelListing && <ProviderBadge>models</ProviderBadge>}
        {provider.defaultModel && <ProviderBadge>{provider.defaultModel}</ProviderBadge>}
      </div>
    </div>
  );
}

function ProviderRegistryPreview() {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: "block", marginBottom: 8, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
        Provider Registry Preview
      </label>
      <div style={{
        marginBottom: 8,
        padding: "7px 9px",
        borderRadius: 5,
        border: "1px solid rgba(229,161,66,0.2)",
        background: "var(--accent-dim)",
        color: "var(--accent)",
        fontSize: 11,
        fontWeight: 600,
      }}>
        Mock registry only - live adapters and secure storage are planned.
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {DEFAULT_PROVIDER_CATALOG.map((provider) => (
          <ProviderRegistryRow key={provider.id} provider={provider} />
        ))}
      </div>
    </div>
  );
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const {
    apiKey, setApiKey,
    openaiApiKey, setOpenaiApiKey,
    llmProvider, setLlmProvider,
    ollamaBaseUrl, setOllamaBaseUrl,
    ollamaModel, setOllamaModel,
    continueOnError, setContinueOnError,
  } = useExecutionStore();

  const [anthropicDraft, setAnthropicDraft] = useState(apiKey);
  const [openaiDraft,    setOpenaiDraft]    = useState(openaiApiKey);
  const [ollamaUrlDraft, setOllamaUrlDraft] = useState(ollamaBaseUrl);
  const [ollamaModelDraft, setOllamaModelDraft] = useState(ollamaModel);

  const [anthropicTest, setAnthropicTest] = useState<TestState>("idle");
  const [openaiTest,    setOpenaiTest]    = useState<TestState>("idle");
  const [ollamaTest,    setOllamaTest]    = useState<TestState>("idle");

  const [anthropicErr, setAnthropicErr] = useState("");
  const [openaiErr,    setOpenaiErr]    = useState("");
  const [ollamaMsg,    setOllamaMsg]    = useState("");
  const [ollamaPull,   setOllamaPull]   = useState<string | null>(null);

  async function testAnthropic() {
    setAnthropicTest("testing"); setAnthropicErr("");
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: "anthropic",
        apiKey: anthropicDraft.trim(),
        baseUrl: "",
        model: "",
      });
      setAnthropicTest(h.ok ? "ok" : "error");
      setAnthropicErr(h.message);
    } catch (e) { setAnthropicTest("error"); setAnthropicErr(String(e)); }
  }

  async function testOpenAI() {
    setOpenaiTest("testing"); setOpenaiErr("");
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: "openai",
        apiKey: openaiDraft.trim(),
        baseUrl: "",
        model: "",
      });
      setOpenaiTest(h.ok ? "ok" : "error");
      setOpenaiErr(h.message);
    } catch (e) { setOpenaiTest("error"); setOpenaiErr(String(e)); }
  }

  async function testOllama() {
    setOllamaTest("testing"); setOllamaMsg(""); setOllamaPull(null);
    try {
      const h = await invoke<ProviderHealth>("check_provider_health", {
        provider: "ollama",
        apiKey: "",
        baseUrl: ollamaUrlDraft.trim(),
        model: ollamaModelDraft.trim(),
      });
      setOllamaTest(h.ok ? "ok" : "error");
      setOllamaMsg(h.message);
      setOllamaPull(h.pull_command);
    } catch (e) {
      setOllamaTest("error");
      setOllamaMsg(String(e));
    }
  }

  const providerModes: { value: LlmProvider; label: string }[] = [
    { value: "auto",      label: "Auto" },
    { value: "openai",    label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "ollama",    label: "Ollama" },
  ];

  function saveAll() {
    setOpenaiApiKey(openaiDraft.trim());
    setApiKey(anthropicDraft.trim());
    setOllamaBaseUrl(ollamaUrlDraft.trim());
    setOllamaModel(ollamaModelDraft.trim());
    onClose();
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: 60, zIndex: 200, fontFamily: "inherit",
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 480, background: "var(--surface-2)",
          border: "1px solid var(--border-md)", borderRadius: 12,
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)", overflow: "hidden",
          marginBottom: 40,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", padding: "14px 18px",
          borderBottom: "1px solid var(--border)",
        }}>
          <NodeIcon name="cog" size={16} color="var(--accent)" style={{ marginRight: 10 }}/>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>Settings — API Keys &amp; Providers</span>
          <button onClick={onClose} style={{
            width: 26, height: 26, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}>
            <NodeIcon name="x" size={14}/>
          </button>
        </div>

        <div style={{ padding: "18px 18px 6px" }}>
          {/* ── Provider mode ─────────────────────────────────────────────── */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", marginBottom: 8, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              LLM Provider Mode
            </label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {providerModes.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setLlmProvider(value)}
                  style={{
                    padding: "5px 14px", borderRadius: 5, fontSize: 12, fontWeight: 500,
                    fontFamily: "inherit", cursor: "pointer",
                    border: llmProvider === value ? "none" : "1px solid var(--border-md)",
                    background: llmProvider === value ? "var(--accent)" : "var(--surface-3)",
                    color: llmProvider === value ? "#1a1207" : "var(--text)",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--hint)", marginTop: 6 }}>
              Auto = each agent uses its configured model and provider. Ollama = override ALL agents to local Ollama.
            </div>
          </div>

          <ProviderRegistryPreview />

          <div style={{ height: 1, background: "var(--border)", margin: "0 0 20px" }}/>

          {/* ── OpenAI ────────────────────────────────────────────────────── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
            padding: "6px 10px", borderRadius: 6, background: "var(--accent-soft)",
            border: "1px solid rgba(229,161,66,0.25)",
          }}>
            <NodeIcon name="play" size={12} color="var(--accent)"/>
            <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
              GPT-5.5 is the primary model for this harness
            </span>
          </div>

          <KeyRow
            label="OpenAI API Key  (GPT-5.5 · Primary)"
            placeholder="sk-..."
            hint="Used for GPT-5.5-xHigh / High / Mid agents. Stored in localStorage only."
            value={openaiDraft}
            onChange={setOpenaiDraft}
            testState={openaiTest}
            testError={openaiErr}
            onTest={testOpenAI}
            onSave={() => { setOpenaiApiKey(openaiDraft.trim()); }}
          />

          <div style={{ height: 1, background: "var(--border)", margin: "0 0 20px" }}/>

          {/* ── Anthropic ─────────────────────────────────────────────────── */}
          <KeyRow
            label="Anthropic API Key  (Claude · Visual Inspector fallback)"
            placeholder="sk-ant-..."
            hint="Used for Visual Inspector (claude-sonnet-4.6) and Claude-only agents."
            value={anthropicDraft}
            onChange={setAnthropicDraft}
            testState={anthropicTest}
            testError={anthropicErr}
            onTest={testAnthropic}
            onSave={() => { setApiKey(anthropicDraft.trim()); }}
          />

          <div style={{ height: 1, background: "var(--border)", margin: "0 0 20px" }}/>

          {/* ── Ollama ────────────────────────────────────────────────────── */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              Ollama — Local Fallback
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input
                type="text"
                value={ollamaUrlDraft}
                onChange={(e) => setOllamaUrlDraft(e.target.value)}
                placeholder="http://localhost:11434"
                style={{
                  flex: 1, padding: "7px 10px", borderRadius: 6, fontSize: 12,
                  border: "1px solid var(--border-md)",
                  background: "var(--surface-3)", color: "var(--text)", fontFamily: MONO,
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={testOllama}
                disabled={ollamaTest === "testing"}
                style={{
                  padding: "6px 12px", border: "1px solid var(--border-md)", borderRadius: 5,
                  background: "var(--surface-3)", color: "var(--text)",
                  cursor: ollamaTest === "testing" ? "default" : "pointer",
                  fontSize: 11, fontWeight: 500, fontFamily: "inherit", flexShrink: 0,
                }}
              >
                {ollamaTest === "testing" ? "Testing…" : "Test"}
              </button>
            </div>

            {/* Model input */}
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", marginBottom: 4, fontSize: 11, color: "var(--hint)" }}>
                Model
              </label>
              <input
                type="text"
                value={ollamaModelDraft}
                onChange={(e) => setOllamaModelDraft(e.target.value)}
                placeholder="qwen2.5-coder:7b"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "6px 10px", borderRadius: 5, fontSize: 12,
                  border: "1px solid var(--border-md)",
                  background: "var(--surface-3)", color: "var(--text)", fontFamily: MONO,
                }}
              />
            </div>

            {/* Suggested chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "var(--hint)", alignSelf: "center" }}>Suggested:</span>
              {SUGGESTED_OLLAMA_MODELS.map((m) => (
                <button
                  key={m}
                  onClick={() => setOllamaModelDraft(m)}
                  style={{
                    padding: "2px 8px", borderRadius: 4, fontSize: 11,
                    border: "1px solid var(--border)", background: "var(--surface-3)",
                    color: "var(--text)", cursor: "pointer", fontFamily: MONO,
                  }}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Install hint */}
            <div style={{ fontSize: 11, color: "var(--hint)" }}>
              Install: <code style={{ fontFamily: MONO, background: "var(--surface-3)", padding: "1px 4px", borderRadius: 3 }}>
                ollama pull {ollamaModelDraft || "qwen2.5-coder:7b"}
              </code>
            </div>

            {/* Test result */}
            {ollamaTest === "ok" && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--green)", fontWeight: 500 }}>
                ✓ {ollamaMsg}
                {ollamaPull && (
                  <div style={{ color: "var(--hint)", marginTop: 4 }}>
                    Run: <code style={{ fontFamily: MONO }}>{ollamaPull}</code>
                  </div>
                )}
              </div>
            )}
            {ollamaTest === "error" && (
              <div style={{
                marginTop: 8, fontSize: 11, color: "var(--red)",
                padding: "6px 8px", borderRadius: 4, background: "rgba(224,117,117,0.1)",
                wordBreak: "break-word",
              }}>
                ✕ {ollamaMsg || "Ollama not reachable. Start with: ollama serve"}
                {ollamaPull && (
                  <div style={{ marginTop: 4 }}>
                    Run: <code style={{ fontFamily: MONO }}>{ollamaPull}</code>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Execution behavior ────────────────────────────────────────── */}
          <div style={{ height: 1, background: "var(--border)", margin: "12px 0 20px" }}/>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", marginBottom: 8, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              Execution
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
                style={{ accentColor: "var(--accent)", width: 14, height: 14 }}
              />
              <span style={{ fontSize: 12 }}>Continue workflow on agent error</span>
            </label>
            <div style={{ fontSize: 11, color: "var(--hint)", marginTop: 4, marginLeft: 24 }}>
              When unchecked, the workflow stops immediately on any agent error.
            </div>
          </div>
        </div>

        {/* Provider Registry — collapsible read-only section */}
        <ProviderRegistrySection />

        {/* Footer */}
        <div style={{ padding: "12px 18px 16px", display: "flex", justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)" }}>
          <button onClick={saveAll} style={{
            padding: "7px 18px", border: "none", borderRadius: 5,
            background: "var(--accent)", color: "#1a1207",
            cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          }}>
            Save all &amp; close
          </button>
        </div>
      </div>
    </div>
  );
}
